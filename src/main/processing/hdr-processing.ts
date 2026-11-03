import { createHash } from 'node:crypto'
import { copyFile, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { hdrCacheTileSize } from '../../renderer/src/preview/hdr-render-cache'
import { HDR_SOURCE_MIP_POLICY } from '../../renderer/src/preview/hdr-source-cache'
import { neutralAdjustments, srgbTransform } from '../../shared/adjustments'
import {
  adjustHdr,
  contentHdr,
  HDR_ADJUSTMENT_VERSION,
  HDR_OUTPUT_VERSION,
  HDR_RAW_SOURCE_VERSION,
  HDR_SOURCE_VERSION,
  hdrAdjustmentMatrix,
  hdrWhiteBalance,
  luminance,
  outputHdr,
  SENSOR_BLEND_VERSION,
  validateHdrSource,
  type HdrWorkingAsset,
} from '../../shared/hdr'
import {
  hdrFirstSurfaceImage,
  hdrFirstSurfaceMipLevel,
  hdrFirstSurfaceOrientation,
} from '../../shared/hdr-first-surface'
import type { HdrPixel } from '../../shared/hdr-pixel'
import { analyzeHdr, hdrStatistics } from '../../shared/hdr-statistics'
import type { ProcessingOptions } from '../../shared/lens'
import { validateMergeVersion } from '../../shared/merge'
import { frameByteLength } from '../../shared/preview-frame'
import { renderFirstSurface } from '../gpu/hdr-first-surface'
import { createPointGpu } from '../gpu/point-renderer'
import { type FirstSurfaceConsumer, type RawGpuRenderer } from '../gpu/raw-renderer'
import type { RawSource } from '../gpu/raw-source'
import type { HdrRawSourceFactory } from '../native-raw-source'
import type {
  FullPreviewResult,
  HdrFirstSurfaceArtifact,
  HdrFirstSurfaceProgress,
  HdrPixelJob,
  HdrPreparationTimings,
  HdrRawPreparation,
  HdrStatisticsJob,
} from '../preview-types'
import { cameraProfile } from './cameras'
import type { LinearFrame, RawSession } from './contracts'
import { rawDecoder } from './decoders'
import { correctionPlan } from './lens-correction'
import { writeHdrStrip } from './write-hdr-strip'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const gpuPreparationTimingFields = [
  ['initializeMs', 'workerGpuInitializeMs'],
  ['uploadMs', 'workerGpuUploadMs'],
  ['processingMs', 'workerGpuProcessingMs'],
  ['correctionMs', 'workerGpuCorrectionMs'],
  ['displayReadbackMs', 'workerGpuReadbackMs'],
  ['hdrReadbackMapMs', 'workerGpuReadbackMapMs'],
  ['hdrOrientationCopyMs', 'workerGpuOrientationCopyMs'],
] as const
export async function scanHdr(path: string, job: HdrStatisticsJob) {
  const result = hdrStatistics(job.domain, job.target, job.asset)
  for await (const data of readHdrStrips(path, job.asset))
    analyzeHdr(data, job.adjustments, job.asset, job.target, result)
  return result
}

export async function sampleHdrPixel(path: string, job: HdrPixelJob): Promise<HdrPixel> {
  const { asset, x, y, domain, target } = job
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= asset.width ||
    y >= asset.height
  )
    throw new Error('Invalid native pixel coordinates.')
  const stripIndex = Math.floor(y / 64)
  for await (const data of readHdrStrips(path, asset, stripIndex)) {
    const index = ((y - stripIndex * 64) * asset.width + x) * 4
    const adjusted = adjustHdr(
      [data[index], data[index + 1], data[index + 2]],
      job.adjustments,
      hdrAdjustmentMatrix(job.adjustments, asset.whiteBalance) ?? undefined,
    )
    const output = domain === 'output' ? outputHdr(adjusted, target, asset.source) : undefined
    const content = domain === 'content-hdr' ? contentHdr(adjusted, asset.source) : undefined
    const rgb = output?.rgb ?? content?.rgb ?? adjusted
    const relativeLuminance = output?.luminance ?? content?.luminance ?? luminance(adjusted)
    if (!rgb.every(Number.isFinite) || !Number.isFinite(relativeLuminance))
      throw new Error('Invalid HDR pixel result.')
    return {
      width: asset.width,
      height: asset.height,
      x,
      y,
      domain,
      colorSpace: domain === 'output' ? target.colorSpace : 'rec2020',
      referenceWhite: 1,
      rgb,
      alpha: data[index + 3],
      relativeLuminance,
      stopsAboveReferenceWhite: relativeLuminance > 0 ? Math.log2(relativeLuminance) : null,
      target: domain === 'output' ? target : undefined,
    }
  }
  throw new Error('HDR pixel unavailable.')
}

/** Disk strips keep corrections, presentation and analysis independent of full float copies. */
export async function* readHdrStrips(path: string, asset: HdrWorkingAsset, onlyStrip?: number) {
  validateHdrSource(asset?.source)
  if (
    asset.kind !== 'hdr-working-v1' ||
    asset.source.processing !== 'hdr-v1' ||
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > 512 * 1024 ** 2 ||
    !Array.isArray(asset.strips) ||
    asset.strips.length !== Math.ceil(asset.height / 64) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    asset.strips.some(
      (strip, index) =>
        strip.byteLength !== Math.min(64, asset.height - index * 64) * asset.width * 16 ||
        !/^[a-f0-9]{64}$/.test(strip.sha256),
    ) ||
    (onlyStrip !== undefined &&
      (!Number.isSafeInteger(onlyStrip) || onlyStrip < 0 || onlyStrip >= asset.strips.length))
  )
    throw new Error('Invalid HDR asset.')
  const file = await open(path, 'r')
  const digest = createHash('sha256')
  let offset = (onlyStrip ?? 0) * 64 * asset.width * 16
  try {
    if ((await file.stat()).size !== asset.byteLength) throw new Error('Incomplete HDR asset.')
    const strips = onlyStrip === undefined ? asset.strips : [asset.strips[onlyStrip]]
    for (const strip of strips) {
      const expected = Math.min(64 * asset.width * 16, asset.byteLength - offset)
      if (strip.byteLength !== expected) throw new Error('Invalid HDR strip size.')
      const bytes = Buffer.alloc(expected)
      let read = 0
      while (read < expected) {
        const result = await file.read(bytes, read, expected - read, offset + read)
        if (!result.bytesRead) throw new Error('Incomplete HDR strip.')
        read += result.bytesRead
      }
      if (sha(bytes) !== strip.sha256) throw new Error('Damaged HDR strip.')
      digest.update(bytes)
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      for (let i = 0; i < data.length; i++)
        if (!Number.isFinite(data[i]) || (i % 4 === 3 && (data[i] < 0 || data[i] > 1)))
          throw new Error('Invalid HDR pixels.')
      yield data
      offset += expected
    }
    if (
      onlyStrip === undefined &&
      (offset !== asset.byteLength || digest.digest('hex') !== asset.sha256)
    )
      throw new Error('Damaged HDR asset.')
  } finally {
    await file.close()
  }
}

async function prepare(
  path: string,
  output: string,
  options: ProcessingOptions,
  gpu: Pick<RawGpuRenderer, 'render' | 'releaseFrame'> &
    Partial<Pick<RawGpuRenderer, 'mergeDevice' | 'failure'>>,
  backend: string,
  onFirstSurface?: (progress: HdrFirstSurfaceProgress) => Promise<void>,
  rawSource?: HdrRawSourceFactory,
  rawPreparation?: HdrRawPreparation,
) {
  if (!['auto', 'gpu'].includes(backend))
    throw new Error('The CPU RAW preparation override was retired.')
  const started = performance.now()
  const timings: HdrPreparationTimings = {}
  const decoder = rawDecoder(path)
  if (!decoder) throw new Error('HDR processing requires a verified Sony RAW.')
  let session: RawSession | undefined
  let sourceBackend: 'wasm-libraw' | 'native-rust-rows' = 'wasm-libraw'
  const wasmSession = async () => {
    if (!session) {
      const opening = performance.now()
      session = await decoder.open(path)
      timings.workerDecoderOpenMs = performance.now() - opening
      if (!session.metadata.hdrEligible)
        throw new Error('HDR processing is unavailable for this RAW mode.')
      sourceBackend = 'wasm-libraw'
    }
    return session
  }
  let frame: LinearFrame
  let gpuPlan: ReturnType<typeof correctionPlan> | undefined
  let gpuStarted: number | undefined
  let firstSurface: HdrFirstSurfaceArtifact | undefined
  let firstSurfaceDecline: string | undefined
  let profile: ReturnType<typeof cameraProfile>
  try {
    const native = rawSource ? await rawSource() : null
    let source: RawSource | null
    if (native) {
      source = native.source
      profile = cameraProfile(native.make, native.model)
      sourceBackend = 'native-rust-rows'
      timings.workerNativeRawSourceMs = native.timings.sourceMs
      timings.workerNativeRawValidateMs = native.timings.validateMs
      timings.workerNativeRawReceiveMs = native.timings.receiveMs
      timings.workerDecoderOpenMs = native.timings.openMs
      timings.workerUnpackMs = native.timings.unpackMs
      timings.workerSensorSourceMs = native.timings.validateMs
    } else {
      const active = await wasmSession()
      profile = cameraProfile(active.metadata.make, active.metadata.model)
      const unpacking = performance.now()
      active.unpack()
      timings.workerUnpackMs = performance.now() - unpacking
      const extracting = performance.now()
      source = active.gpuSource(true)
      timings.workerSensorSourceMs = performance.now() - extracting
    }
    if (source?.normalization) {
      try {
        const planning = performance.now()
        gpuPlan = correctionPlan(
          source.width,
          source.height,
          options.metadata.lensProfile,
          options.settings,
        )
        timings.workerCorrectionPlanMs = performance.now() - planning
        const baseEstimatedRamBytes =
          source.pixels.byteLength * 3 +
          gpuPlan.width * gpuPlan.height * 16 +
          Math.ceil((gpuPlan.width * 16) / 256) * 256 * 64
        let firstConsumer: FirstSurfaceConsumer | undefined
        if (options.firstSurface && onFirstSurface) {
          const preparation = options.firstSurface
          const signal = new AbortController().signal
          firstConsumer = {
            signal,
            // Copied sensor source, decoder source/upload allowance, full F32 destination and readback strip.
            baseEstimatedRamBytes,
            capture: async (borrow) => {
              const image = hdrFirstSurfaceImage(borrow, borrow.flip)
              const level = hdrFirstSurfaceMipLevel(image, preparation.viewport)
              const result = await renderFirstSurface(
                borrow,
                {
                  ...preparation,
                  image,
                  view: preparation.view.fit
                    ? {
                        fit: true,
                        x: preparation.view.x,
                        y: preparation.view.y,
                        scale: Math.min(
                          1,
                          preparation.viewport.width / image.width,
                          preparation.viewport.height / image.height,
                        ),
                      }
                    : preparation.view,
                  whiteBalance: hdrWhiteBalance(options.metadata.whiteBalance),
                  sourceIdentity: {
                    processing: 'hdr-v1',
                    adjustmentVersion: HDR_ADJUSTMENT_VERSION,
                    outputVersion: HDR_OUTPUT_VERSION,
                    mipPolicy: HDR_SOURCE_MIP_POLICY,
                    arithmetic: 'reference',
                    tileSize: hdrCacheTileSize(image.width, image.height),
                    ...(borrow.flip !== 0 && level === 0
                      ? {}
                      : {
                          orientation: hdrFirstSurfaceOrientation(borrow, borrow.flip, level),
                        }),
                    sourceVersion: HDR_RAW_SOURCE_VERSION,
                    highlightBlend: SENSOR_BLEND_VERSION,
                    normalization: structuredClone(source.normalization!),
                    lensProfile: structuredClone(options.metadata.lensProfile),
                    settings: structuredClone(options.settings),
                    decoder: `${decoder.id}-${decoder.version}`,
                    camera: structuredClone(profile),
                    correction: {
                      width: gpuPlan!.width,
                      height: gpuPlan!.height,
                      left: gpuPlan!.left,
                      top: gpuPlan!.top,
                      applied: gpuPlan!.applied,
                      lutSha256: createHash('sha256')
                        .update(
                          Buffer.from(
                            gpuPlan!.lut.buffer,
                            gpuPlan!.lut.byteOffset,
                            gpuPlan!.lut.byteLength,
                          ),
                        )
                        .digest('hex'),
                    },
                  },
                },
                signal,
              )
              if (result.status === 'declined') {
                firstSurfaceDecline = result.reason
                await onFirstSurface({ status: 'declined', reason: result.reason })
                return
              }
              const firstFile = await open(join(output, 'first.rgba16'), 'wx')
              try {
                await writeHdrStrip(firstFile, result.bytes, 0)
              } finally {
                await firstFile.close()
              }
              firstSurface = {
                identity: result.identity,
                width: result.width,
                height: result.height,
                byteLength: result.byteLength,
                sha256: result.sha256,
                programHashes: result.programHashes,
                timings: result.timings,
              }
              await onFirstSurface({ status: 'ready', artifact: firstSurface })
            },
          }
        } else if (options.firstSurface) firstSurfaceDecline = 'first-surface-callback-unavailable'
        gpuStarted = performance.now()
        const rendered = await gpu.render(
          source,
          gpuPlan,
          neutralAdjustments,
          true,
          false,
          undefined,
          undefined,
          firstConsumer,
          rawPreparation ? { ...rawPreparation, baseEstimatedRamBytes } : undefined,
        )
        timings.workerGpuTotalMs = performance.now() - gpuStarted
        for (const [sourceKey, outputKey] of gpuPreparationTimingFields) {
          const value = rendered.timings?.[sourceKey]
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
            timings[outputKey] = value
        }
        if (!rendered.working || !rendered.hdrPrepared) throw new Error('GPU HDR data unavailable.')
        frame = {
          data: rendered.working.data,
          width: rendered.width,
          height: rendered.height,
          flip: 0,
          matrix: [],
          normalization: source.normalization,
        }
      } catch (error) {
        if (gpuStarted !== undefined && timings.workerGpuTotalMs === undefined)
          timings.workerGpuTotalMs = performance.now() - gpuStarted
        if (firstSurface) {
          firstSurfaceDecline = 'gpu-preparation-failed'
          await onFirstSurface?.({ status: 'declined', reason: firstSurfaceDecline }).catch(
            () => undefined,
          )
        }
        throw error
      }
    } else throw new Error('GPU source preparation is unavailable for this RAW recording mode.')
  } finally {
    const closing = performance.now()
    session?.close()
    timings.workerDecoderCloseMs = performance.now() - closing
    const releasing = performance.now()
    gpu.releaseFrame()
    timings.workerGpuReleaseMs = performance.now() - releasing
  }
  if (options.firstSurface && !firstSurface && !firstSurfaceDecline)
    firstSurfaceDecline = 'native-first-surface-unavailable'
  if (!frame.normalization || !profile) throw new Error('Missing HDR normalization.')
  const normal = frame.normalization
  // Capture scale is fixed at 1; image contents never determine exposure.
  normal.referenceWhite = 1
  const plan = { ...gpuPlan!, width: frame.width, height: frame.height }
  const width = frame.flip & 4 ? plan.height : plan.width,
    height = frame.flip & 4 ? plan.width : plan.height
  const byteLength = frameByteLength(width, height) * 4
  if (byteLength > 512 * 1024 ** 2 || frame.data.byteLength + width * 64 * 16 > 384 * 1024 ** 2)
    throw new Error('This photo exceeds the HDR processing memory limit.')
  const asset: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength,
    sha256: '',
    strips: [],
    whiteBalance: hdrWhiteBalance(options.metadata.whiteBalance),
    source: {
      version: HDR_SOURCE_VERSION,
      highlightBlend: SENSOR_BLEND_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      normalization: normal,
      decoder: `${decoder.id}-${decoder.version}`,
      cameraProfile: `${profile.id}-${profile.version}`,
      orientation: 'applied-once',
    },
  }
  const openingNative = performance.now()
  const file = await open(join(output, 'linear.f32'), 'wx')
  timings.workerNativeOpenMs = performance.now() - openingNative
  const digest = createHash('sha256')
  timings.workerNativeWriteMs = 0
  timings.workerNativeWholeHashMs = 0
  timings.workerNativeStripHashMs = 0
  try {
    for (let top = 0; top < height; top += 64) {
      const count = Math.min(64, height - top)
      const data = frame.data.subarray(top * width * 4, (top + count) * width * 4)
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      const writing = performance.now()
      await writeHdrStrip(file, bytes, top * width * 16)
      timings.workerNativeWriteMs += performance.now() - writing
      const hashingWhole = performance.now()
      digest.update(bytes)
      timings.workerNativeWholeHashMs += performance.now() - hashingWhole
      const hashingStrip = performance.now()
      asset.strips.push({ byteLength: bytes.byteLength, sha256: sha(bytes) })
      timings.workerNativeStripHashMs += performance.now() - hashingStrip
    }
    const hashingWhole = performance.now()
    asset.sha256 = digest.digest('hex')
    timings.workerNativeWholeHashMs += performance.now() - hashingWhole
  } finally {
    const closingNative = performance.now()
    await file.close()
    timings.workerNativeCloseMs = performance.now() - closingNative
  }
  timings.workerPreparationMs = performance.now() - started
  return {
    asset,
    backend: 'gpu' as const,
    applied: plan.applied,
    timings,
    sourceBackend,
    firstSurface,
    firstSurfaceDecline,
  }
}

export async function renderHdr(
  path: string,
  output: string,
  options: ProcessingOptions,
  gpu: Pick<RawGpuRenderer, 'render' | 'releaseFrame'> &
    Partial<Pick<RawGpuRenderer, 'mergeDevice' | 'failure'>>,
  backend: string,
  onFirstSurface?: (progress: HdrFirstSurfaceProgress) => Promise<void>,
  rawSource?: HdrRawSourceFactory,
  rawPreparation?: HdrRawPreparation,
): Promise<FullPreviewResult> {
  const start = performance.now()
  if (options.metadata.mergeMaster)
    validateMergeVersion(options.metadata.mergeMaster.recipe?.version)
  const cached = options.workingAsset?.hdr
  const prepared = cached
    ? undefined
    : await prepare(path, output, options, gpu, backend, onFirstSurface, rawSource, rawPreparation)
  const asset = prepared?.asset ?? cached!
  validateHdrSource(asset.source)
  const sourceVersion = asset.source.highlightBlend ? HDR_RAW_SOURCE_VERSION : HDR_SOURCE_VERSION
  const sourcePath = prepared ? join(output, 'linear.f32') : options.workingAsset!.path
  const permanentCopy = !!(
    cached &&
    options.metadata.mergeMaster &&
    (options.workingOnly || options.prepareLinear)
  )
  if (permanentCopy) await copyFile(sourcePath, join(output, 'linear.f32'))
  const adjustments = options.adjustments ?? neutralAdjustments
  if (options.workingOnly)
    return {
      firstSurface: prepared?.firstSurface,
      firstSurfaceDecline: prepared?.firstSurfaceDecline,
      width: asset.width,
      height: asset.height,
      format: 'hdr-working',
      byteLength: 0,
      sha256: asset.sha256,
      placeholderBytes: 0,
      linear: {
        byteLength: asset.byteLength,
        sha256: asset.sha256,
        transform: srgbTransform,
        hdr: asset,
      },
      adjustments,
      settingsRevision: options.revision,
      appliedCorrections: prepared?.applied,
      renderId: `${sourceVersion}-${asset.sha256}`,
      diagnostics: {
        clock: 'worker-performance',
        backend: prepared?.backend ?? 'cpu',
        sourceBackend: prepared?.sourceBackend,
        timings: { ...prepared?.timings, totalMs: performance.now() - start },
      },
    }
  const wb = hdrAdjustmentMatrix(adjustments, asset.whiteBalance) ?? undefined
  const file = await open(join(output, 'full.rgba'), 'wx')
  const proofStarted = performance.now()
  let converter: Awaited<ReturnType<typeof createPointGpu>> | undefined
  const digest = createHash('sha256')
  const ratio = Math.min(1, 96 / Math.max(asset.width, asset.height))
  const thumbWidth = Math.max(1, Math.round(asset.width * ratio)),
    thumbHeight = Math.max(1, Math.round(asset.height * ratio))
  const thumb = Buffer.alloc(thumbWidth * thumbHeight * 4)
  let top = 0,
    proofGpuStrips = 0
  try {
    if (!gpu.mergeDevice) throw new Error('The shared GPU proof capability is unavailable.')
    const mergeDevice = gpu.mergeDevice.bind(gpu)
    converter = await createPointGpu(
      asset.width * 64,
      adjustments,
      wb,
      false,
      true,
      64,
      0,
      undefined,
      { domain: asset.source.display ? 'authored-hdr' : 'scene-linear', preserveAlpha: true },
      () => ({
        mergeDevice,
        close: () => undefined,
        get failure() {
          return gpu.failure
        },
      }),
    )
    for await (const strip of readHdrStrips(sourcePath, asset)) {
      const data = (await converter.render(strip)).data
      proofGpuStrips++
      digest.update(data)
      await file.writeFile(data)
      for (let row = 0; row < strip.length / (asset.width * 4); row++) {
        const py = Math.floor(((top + row) * thumbHeight) / asset.height)
        if (top + row !== Math.floor(((py + 0.5) * asset.height) / thumbHeight)) continue
        for (let x = 0; x < thumbWidth; x++) {
          const from = (row * asset.width + Math.floor(((x + 0.5) * asset.width) / thumbWidth)) * 4
          data.copy(thumb, (py * thumbWidth + x) * 4, from, from + 4)
        }
      }
      top += strip.length / (asset.width * 4)
    }
  } finally {
    await file.close()
    await converter?.close()
  }
  const placeholder = await sharp(thumb, {
    raw: { width: thumbWidth, height: thumbHeight, channels: 4 },
  })
    .withIccProfile('srgb')
    .png()
    .toBuffer()
  await writeFile(join(output, 'placeholder.png'), placeholder)
  return {
    width: asset.width,
    height: asset.height,
    format: 'rgba8-srgb',
    byteLength: asset.width * asset.height * 4,
    sha256: digest.digest('hex'),
    placeholderBytes: placeholder.byteLength,
    linear:
      prepared || permanentCopy
        ? {
            byteLength: asset.byteLength,
            sha256: asset.sha256,
            transform: srgbTransform,
            hdr: asset,
          }
        : undefined,
    adjustments,
    settingsRevision: options.revision,
    appliedCorrections: prepared?.applied,
    renderId: `${sourceVersion}-${HDR_ADJUSTMENT_VERSION}-${HDR_OUTPUT_VERSION}-${JSON.stringify(adjustments)}`,
    diagnostics: {
      clock: 'worker-performance',
      backend: prepared?.backend ?? 'cpu',
      proofBackend: 'gpu',
      proofGpuStrips,
      proofCpuStrips: 0,
      timings: {
        ...prepared?.timings,
        totalMs: performance.now() - start,
        proofMs: performance.now() - proofStarted,
      },
    },
  }
}
