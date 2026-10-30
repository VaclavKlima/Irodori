import { open } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { exportGeometry } from '../../shared/export'
import { neutralAdjustments } from '../../shared/adjustments'
import {
  contentHdr,
  adjustHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  SDR_TARGET,
  encodeHdr,
} from '../../shared/hdr'
import { frameByteLength } from '../../shared/preview-frame'
import { srgbTransform } from '../../shared/adjustments'
import { CROP_GEOMETRY_VERSION, cropGeometry, identityCrop } from '../../shared/crop'
import { CROP_FILTER_VERSION } from '../../shared/crop-filter'
import { readHdrStrips } from '../processing/hdr-processing'
import { prepareCropWorkingAsset } from '../processing/crop-preparation'
import { cropFrameReader } from '../processing/crop-frame'
import { halfFloat } from './codec'
import { createExportGpu } from './gpu'
import { rasterLinear } from './raster'
import { resizeLinear } from './resize'
import type { ExportCropDiagnostics, ExportDetailDiagnostics, ExportRenderJob } from './types'
import type { HdrWorkingAsset } from '../../shared/hdr'
import { validateExportCropPolicy } from './crop-policy'
import { prepareCreativeColor } from '../../shared/creative-color'
import { creativeColorActive } from '../../shared/creative-color'
import {
  exportInputMemoryPlan,
  exportRenderMemoryPlan,
  exportSdrEncodePlan,
  requireExportAllocation,
  validateExportAdmission,
  ExportResourceError,
} from '../../shared/export-resources'
import type { ManagedImageBytes } from '../../shared/resource-policy'
import { resolveDetailSettings } from '../processing/detail-identity'
import { validateExportDetailPolicy, exportDetailPolicy } from './detail-policy'
import { prepareExportDetailStage } from './detail'
import { matchesExportWorkingAsset } from './detail-policy'
import { readRasterWorking } from '../processing/detail-preview'
import { exportResizePolicy, validateExportResizePolicy } from './resize-policy'

/** Read and validate one strip ahead while native GPU computation is in flight. */
async function* exportStrips(path: string, asset: HdrWorkingAsset) {
  const iterator = readHdrStrips(path, asset)[Symbol.asyncIterator]()
  const next = () =>
    iterator.next().then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
  let pending = next()
  try {
    while (true) {
      const item = await pending
      if ('error' in item) throw item.error
      if (item.result.done) break
      pending = next()
      yield item.result.value
    }
  } finally {
    await pending
    await iterator.return(undefined)
  }
}

/** Native-size exports stream directly to encoder buffers; only actual resizes use a float file. */
export async function exportRenditions(
  job: ExportRenderJob,
  makeGpu = createExportGpu,
  onSdrReady?: (
    rgb: Buffer,
    geometry: ReturnType<typeof exportGeometry>,
    concurrent?: ManagedImageBytes,
  ) => Promise<Buffer>,
) {
  job = structuredClone(job)
  validateExportCropPolicy(job)
  validateExportDetailPolicy(job)
  validateExportResizePolicy(job)
  const started = performance.now()
  const mode = process.env.IRODORI_EXPORT_BACKEND ?? 'auto'
  if (!['auto', 'gpu', 'cpu'].includes(mode)) throw new Error('Invalid export renderer backend.')
  if (job.hdr && !job.source.hdr) throw new Error('HDR export requires a supported HDR source.')
  const a = job.source.processing.adjustments ?? neutralAdjustments,
    detailControls = resolveDetailSettings(job.source.processing),
    cropSettings = structuredClone(job.source.processing.crop ?? identityCrop),
    cropAdmission = job.cropAdmission ? structuredClone(job.cropAdmission) : undefined,
    admission = job.detailAdmission ?? cropAdmission ?? job.resizeAdmission,
    uncroppedAsset = job.source.processing.workingAsset?.hdr,
    channels = job.hdr ? 6 : 3
  if (detailControls.active && !job.detailAdmission)
    throw new Error('Noise reduction/detail export requires a frozen resource admission.')
  if (admission) validateExportAdmission(admission)
  if (job.source.hdr && !uncroppedAsset) throw new Error('HDR working asset was not prepared.')
  const needsPrimary = !job.source.hdr || Boolean(uncroppedAsset?.source.display),
    primaryLease = job.source.hdr ? job.primaryWorkingAsset : job.workingAsset,
    cachedPrimary =
      needsPrimary && primaryLease && matchesExportWorkingAsset(job.source, primaryLease, true)
        ? primaryLease
        : undefined
  const readInput = async () => {
    if (cachedPrimary) {
      if (admission)
        requireExportAllocation(
          exportInputMemoryPlan(cachedPrimary.asset.width, cachedPrimary.asset.height, admission),
        )
      const frame = await readRasterWorking(cachedPrimary.asset, new AbortController().signal)
      return {
        data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
        info: { width: frame.width, height: frame.height },
      }
    }
    const decoder = sharp(job.source.path, {
      limitInputPixels: (512 * 1024 ** 2) / 16,
    }).autoOrient()
    if (admission) {
      const info = await decoder.metadata()
      requireExportAllocation(exportInputMemoryPlan(info.width!, info.height!, admission))
    }
    return decoder
      .toColourspace('scrgb')
      .ensureAlpha()
      .raw({ depth: 'float' })
      .toBuffer({ resolveWithObject: true })
  }
  const filteredPrimary = Boolean(cachedPrimary?.detailSource),
    input = needsPrimary && !filteredPrimary ? await readInput() : undefined
  const sourceWidth = uncroppedAsset?.width ?? cachedPrimary?.asset.width ?? input!.info.width,
    sourceHeight = uncroppedAsset?.height ?? cachedPrimary?.asset.height ?? input!.info.height,
    crop = cropGeometry({ width: sourceWidth, height: sourceHeight }, cropSettings),
    { width, height } = crop
  if (frameByteLength(sourceWidth, sourceHeight) * 4 > 512 * 1024 ** 2)
    throw new Error('This photo exceeds the floating-point export memory limit.')
  if (
    uncroppedAsset &&
    input &&
    (input.info.width !== sourceWidth || input.info.height !== sourceHeight)
  )
    throw new Error('HDR JPEG primary geometry mismatch.')
  if (
    cachedPrimary &&
    (cachedPrimary.asset.width !== sourceWidth || cachedPrimary.asset.height !== sourceHeight)
  )
    throw new Error('Cached primary geometry mismatch.')
  let base = input
    ? new Float32Array(input.data.buffer, input.data.byteOffset, input.data.byteLength / 4)
    : undefined
  const geometry = exportGeometry(width, height, job.options.size),
    original = geometry.width === width && geometry.height === height,
    pixels = geometry.width * geometry.height
  if (!crop.identity && !cropAdmission)
    throw new Error('Crop export requires a frozen resource admission.')
  const originalInputBytes = input?.data.buffer.byteLength ?? 0,
    predictedInputBytes =
      originalInputBytes +
      (filteredPrimary
        ? cachedPrimary!.asset.byteLength
        : detailControls.active && base
          ? sourceWidth * sourceHeight * 16
          : 0),
    memory = admission
      ? exportRenderMemoryPlan(
          {
            width,
            height,
            outWidth: geometry.width,
            outHeight: geometry.height,
            hdr: job.hdr,
            sourceHdr: Boolean(uncroppedAsset),
            gpuAllowed: Boolean(uncroppedAsset && !uncroppedAsset.source.display),
            creative: creativeColorActive(prepareCreativeColor(a)),
            inputBytes: predictedInputBytes,
          },
          admission,
        )
      : undefined
  if (memory) requireExportAllocation(memory.cpu)
  // Source filtering/cropping retires before rendition buffers and the converter are allocated.
  const admitted = admission
    ? {
        policy: admission.policy,
        reservation: {
          ramBytes: admission.reservation.ramBytes + predictedInputBytes,
          vramBytes: admission.reservation.vramBytes,
        },
      }
    : undefined
  const cropDiagnostics: ExportCropDiagnostics | undefined = crop.identity
    ? undefined
    : {
        geometry: crop,
        geometryVersion: CROP_GEOMETRY_VERSION,
        filterVersion: crop.pixelAligned ? 'native-copy-v1' : CROP_FILTER_VERSION,
      }
  let asset = uncroppedAsset,
    workingPath = job.source.processing.workingAsset?.path
  const detailDiagnostics: ExportDetailDiagnostics | undefined = detailControls.active
    ? { policy: { ...exportDetailPolicy } }
    : undefined
  if (detailControls.active) {
    const admission = job.detailAdmission!,
      reserve = (otherBytes: number) => ({
        policy: admission.policy,
        reservation: {
          ramBytes: admission.reservation.ramBytes + otherBytes,
          vramBytes: admission.reservation.vramBytes,
        },
      }),
      signal = new AbortController().signal
    if (asset) {
      const prepared = await prepareExportDetailStage(
        job,
        'working',
        {
          ...job.source.processing.workingAsset!,
          hdr: asset,
        },
        reserve(base?.buffer.byteLength ?? 0),
        signal,
      )
      asset = prepared.asset!.hdr!
      workingPath = prepared.asset!.path
      detailDiagnostics!.working = prepared.diagnostics
    }
    if (base || (needsPrimary && filteredPrimary)) {
      const prepared = await prepareExportDetailStage(
        job,
        'primary',
        filteredPrimary
          ? cachedPrimary!.asset
          : {
              data: base!,
              width: sourceWidth,
              height: sourceHeight,
              transform: srgbTransform,
            },
        reserve(0),
        signal,
      )
      base = prepared.frame!.data
      detailDiagnostics!.primary = prepared.diagnostics
    }
  }
  if (!crop.identity && asset) {
    const result = await prepareCropWorkingAsset(
      workingPath!,
      {
        asset,
        settings: cropSettings,
        backend: mode as 'auto' | 'cpu' | 'gpu',
        ...admitted!,
        reservation: {
          ramBytes: admitted!.reservation.ramBytes,
          vramBytes: admitted!.reservation.vramBytes,
        },
      },
      join(job.directory, 'crop-working.f32'),
      new AbortController().signal,
    )
    asset = result.asset
    workingPath = result.path
    cropDiagnostics!.working = {
      backend: result.backend,
      adapter: result.adapter,
      fallback: result.fallback,
      memory: result.memory,
      cpuTiles: result.cpuTiles,
      gpuTiles: result.gpuTiles,
      precisionRecoveryTiles: result.precisionRecoveryTiles,
    }
  }
  const rgb = Buffer.alloc(pixels * 3),
    half = job.hdr ? new Uint16Array(pixels * 4) : undefined
  const linearPath = join(job.directory, 'rendition.f32'),
    linear = original ? undefined : await open(linearPath, 'wx')
  let contentHeadroom = 1.01
  const quantize = (data: Float32Array, top: number) => {
    for (let i = 0; i < data.length / channels; i++) {
      const dest = top * geometry.width + i
      for (let c = 0; c < 3; c++) {
        rgb[dest * 3 + c] = Math.round(
          encodeHdr(Math.max(0, Math.min(1, data[i * channels + c]))) * 255,
        )
        if (half) {
          const value = Math.max(0, Math.min(10, data[i * channels + 3 + c]))
          contentHeadroom = Math.max(contentHeadroom, value)
          half[dest * 4 + c] = halfFloat(value)
        }
      }
      if (half) half[dest * 4 + 3] = 0x3c00
    }
  }
  const accept = async (data: Float32Array<ArrayBuffer>, top: number) => {
    if (original) quantize(data, top)
    else {
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await linear!.write(
          bytes,
          offset,
          bytes.length - offset,
          top * width * channels * 4 + offset,
        )
        if (!bytesWritten) throw new Error('Cannot write export rendition.')
        offset += bytesWritten
      }
    }
  }
  const cpu = async () => {
    const wb = asset ? (hdrAdjustmentMatrix(a, asset.whiteBalance) ?? undefined) : undefined
    const creative = prepareCreativeColor(a)
    const primary = base
      ? cropFrameReader(
          { data: base, width: sourceWidth, height: sourceHeight, transform: srgbTransform },
          {
            settings: cropSettings,
            admission:
              admission && memory
                ? {
                    policy: admission.policy,
                    reservation: {
                      ramBytes: memory.cpuLive.ramBytes - base.buffer.byteLength,
                      vramBytes: memory.cpuLive.vramBytes,
                    },
                  }
                : admitted,
            backend: mode as 'auto' | 'cpu' | 'gpu',
          },
          new AbortController().signal,
        )
      : undefined
    if (cropDiagnostics && primary)
      cropDiagnostics.primary = {
        ...primary.diagnostics,
        memory: primary.memory,
      }
    try {
      if (asset) {
        let top = 0
        for await (const strip of readHdrStrips(workingPath!, asset)) {
          const authored = primary ? await primary.strips.next() : undefined
          if (authored && (authored.done || authored.value.length !== strip.length))
            throw new Error('HDR JPEG cropped primary geometry mismatch.')
          const primaryStrip = authored?.value
          const data = new Float32Array((strip.length / 4) * channels)
          for (let i = 0; i < strip.length; i += 4) {
            const adjusted = adjustHdr([strip[i], strip[i + 1], strip[i + 2]], a, wb, creative)
            const sdr = primaryStrip
              ? rasterLinear(
                  [primaryStrip[i], primaryStrip[i + 1], primaryStrip[i + 2]],
                  a,
                  creative,
                )
              : outputHdr(adjusted, SDR_TARGET).rgb
            const hdr = job.hdr ? contentHdr(adjusted, asset.source).rgb : undefined
            const alpha = strip[i + 3]
            for (let c = 0; c < 3; c++) {
              data[(i / 4) * channels + c] = sdr[c] * alpha + 1 - alpha
              if (hdr) data[(i / 4) * channels + 3 + c] = hdr[c] * alpha + 1 - alpha
            }
          }
          await accept(data, top)
          top += strip.length / (width * 4)
        }
        if (primary && !(await primary.strips.next()).done)
          throw new Error('Unexpected HDR JPEG primary rows.')
      } else {
        let top = 0
        for await (const strip of primary!.strips) {
          const data = new Float32Array((strip.length / 4) * 3)
          for (let i = 0; i < data.length / 3; i++) {
            const offset = i * 4
            const value = rasterLinear(
              [strip[offset], strip[offset + 1], strip[offset + 2]],
              a,
              creative,
            )
            const alpha = strip[offset + 3]
            for (let c = 0; c < 3; c++) data[i * 3 + c] = value[c] * alpha + 1 - alpha
          }
          await accept(data, top)
          top += strip.length / (width * 4)
        }
      }
    } finally {
      await primary?.strips.return(undefined)
      if (cropDiagnostics && primary)
        cropDiagnostics.primary = {
          ...primary.diagnostics,
          memory: primary.memory,
        }
    }
  }
  let backend: 'gpu' | 'cpu' = 'cpu',
    fallback: string | undefined,
    adapter: string | undefined
  let converter: Awaited<ReturnType<typeof createExportGpu>> | undefined
  let gpuInitializeMs = 0,
    gpuTilesMs = 0,
    gpuPackingMs = 0,
    gpuPeakBytes = 0
  let earlyPrimary: Promise<Buffer> | undefined
  try {
    if (asset && !asset.source.display && mode !== 'cpu') {
      try {
        if (memory && !memory.gpuAccepted)
          throw new ExportResourceError('GPU export exceeds the frozen managed image budgets.')
        const initializeStarted = performance.now()
        converter = await makeGpu(
          width * 64,
          a,
          hdrAdjustmentMatrix(a, asset.whiteBalance) ?? undefined,
          job.hdr,
          original,
          64,
          original && job.hdr ? pixels : 0,
          memory?.gpuLimitBytes,
        )
        gpuInitializeMs = performance.now() - initializeStarted
        gpuPeakBytes = converter.peakBytes
        adapter = converter.adapter
        let top = 0
        for await (const strip of exportStrips(workingPath!, asset)) {
          const tileStarted = performance.now()
          const rendered = await converter.render(strip, top * width)
          gpuTilesMs += performance.now() - tileStarted
          const packingStarted = performance.now()
          if (original) {
            const words = new Uint32Array(
              rendered.data.buffer,
              rendered.data.byteOffset,
              rendered.data.byteLength / 4,
            )
            const count = strip.length / 4,
              stride = job.hdr && !converter.hdrDeferred ? 3 : 1
            for (let i = 0; i < count; i++) {
              const dest = top * width + i,
                packed = words[i * stride]
              rgb[dest * 3] = packed & 255
              rgb[dest * 3 + 1] = (packed >>> 8) & 255
              rgb[dest * 3 + 2] = (packed >>> 16) & 255
              if (half && !converter.hdrDeferred) {
                const rg = words[i * stride + 1],
                  ba = words[i * stride + 2]
                half[dest * 4] = rg & 65535
                half[dest * 4 + 1] = rg >>> 16
                half[dest * 4 + 2] = ba & 65535
                half[dest * 4 + 3] = ba >>> 16
              }
            }
            contentHeadroom = Math.max(contentHeadroom, rendered.headroom)
          } else
            await accept(
              new Float32Array(
                rendered.data.buffer,
                rendered.data.byteOffset,
                rendered.data.byteLength / 4,
              ),
              top,
            )
          top += strip.length / (width * 4)
          gpuPackingMs += performance.now() - packingStarted
        }
        if (converter.hdrDeferred) {
          const concurrent =
              admission && memory
                ? {
                    ramBytes:
                      admission.reservation.ramBytes + memory.retainedBytes + memory.gpuWorkBytes,
                    vramBytes: admission.reservation.vramBytes + converter.peakBytes,
                  }
                : undefined,
            earlyAccepted =
              !admission ||
              !concurrent ||
              exportSdrEncodePlan(geometry.width, geometry.height, {
                policy: admission.policy,
                reservation: concurrent,
              }).accepted
          if (earlyAccepted) earlyPrimary = onSdrReady?.(rgb, geometry, concurrent)
          // A later GPU failure drains and discards this encoding before CPU overwrite.
          void earlyPrimary?.catch(() => {})
          for (let top = 0; top < height; top += 64) {
            const count = width * Math.min(64, height - top),
              started = performance.now()
            const rendered = await converter.finishHdr(top * width, count)
            gpuTilesMs += performance.now() - started
            const packingStarted = performance.now()
            const words = new Uint32Array(
              rendered.data.buffer,
              rendered.data.byteOffset,
              rendered.data.byteLength / 4,
            )
            for (let i = 0; i < count; i++) {
              const dest = top * width + i,
                rg = words[i * 3 + 1],
                ba = words[i * 3 + 2]
              half![dest * 4] = rg & 65535
              half![dest * 4 + 1] = rg >>> 16
              half![dest * 4 + 2] = ba & 65535
              half![dest * 4 + 3] = ba >>> 16
            }
            contentHeadroom = Math.max(contentHeadroom, rendered.headroom)
            gpuPackingMs += performance.now() - packingStarted
          }
        }
        backend = 'gpu'
      } catch (error) {
        await earlyPrimary?.catch(() => {})
        earlyPrimary = undefined
        if (mode === 'gpu') throw error
        fallback = error instanceof Error ? error.message : String(error)
        // A failed tile never publishes partial output; rerender all frozen source pixels.
        contentHeadroom = 1.01
      } finally {
        await converter?.close()
      }
    }
    if (backend === 'cpu') await cpu()
  } finally {
    await linear?.close()
  }
  const renderMs = performance.now() - started
  const resizeStarted = performance.now()
  if (!original)
    await resizeLinear(
      linearPath,
      width,
      height,
      geometry.width,
      geometry.height,
      channels,
      quantize,
    )
  return {
    rgb,
    half,
    geometry,
    contentHeadroom,
    earlyPrimary,
    diagnostics: {
      crop: cropDiagnostics,
      detail: detailDiagnostics,
      resize: original
        ? undefined
        : {
            policy: { ...(job.resizePolicy ?? exportResizePolicy) },
            input: { width, height },
            output: { ...geometry },
            enlarged: geometry.width > width || geometry.height > height,
          },
      renderer: backend,
      adapter,
      rendererFallback: fallback,
      renderMs,
      resizeMs: performance.now() - resizeStarted,
      gpuInitializeMs,
      gpuTilesMs,
      gpuPackingMs,
      gpuPeakBytes,
      memory,
      sourcePreparation: !job.source.hdr && cachedPrimary ? ('preview-cache' as const) : undefined,
    },
  }
}
