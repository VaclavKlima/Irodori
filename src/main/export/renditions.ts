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
import { readHdrStrips } from '../processing/hdr-processing'
import { halfFloat } from './codec'
import { createExportGpu } from './gpu'
import { rasterLinear } from './raster'
import { resizeLinear } from './resize'
import type { ExportRenderJob } from './types'
import type { HdrWorkingAsset } from '../../shared/hdr'

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
  onSdrReady?: (rgb: Buffer, geometry: ReturnType<typeof exportGeometry>) => Promise<Buffer>,
) {
  const started = performance.now()
  const mode = process.env.LUMA_EXPORT_BACKEND ?? 'auto'
  if (!['auto', 'gpu', 'cpu'].includes(mode)) throw new Error('Invalid export renderer backend.')
  if (job.hdr && !job.source.hdr) throw new Error('HDR export requires a supported HDR source.')
  const a = job.source.processing.adjustments ?? neutralAdjustments,
    asset = job.source.processing.workingAsset?.hdr,
    channels = job.hdr ? 6 : 3
  if (job.source.hdr && !asset) throw new Error('HDR working asset was not prepared.')
  const input =
    !job.source.hdr || asset?.source.display
      ? await sharp(job.source.path, { limitInputPixels: (512 * 1024 ** 2) / 16 })
          .autoOrient()
          .toColourspace('scrgb')
          .ensureAlpha()
          .raw({ depth: 'float' })
          .toBuffer({ resolveWithObject: true })
      : undefined
  const width = asset?.width ?? input!.info.width,
    height = asset?.height ?? input!.info.height
  if (frameByteLength(width, height) * 4 > 512 * 1024 ** 2)
    throw new Error('This photo exceeds the floating-point export memory limit.')
  if (asset && input && (input.info.width !== width || input.info.height !== height))
    throw new Error('HDR JPEG primary geometry mismatch.')
  const base = input
    ? new Float32Array(input.data.buffer, input.data.byteOffset, input.data.byteLength / 4)
    : undefined
  const geometry = exportGeometry(width, height, job.options.size),
    original = geometry.width === width && geometry.height === height,
    pixels = geometry.width * geometry.height,
    rgb = Buffer.alloc(pixels * 3),
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
    if (asset) {
      let top = 0
      for await (const strip of readHdrStrips(job.source.processing.workingAsset!.path, asset)) {
        const data = new Float32Array((strip.length / 4) * channels)
        for (let i = 0; i < strip.length; i += 4) {
          const adjusted = adjustHdr([strip[i], strip[i + 1], strip[i + 2]], a, wb)
          const offset = top * width * 4 + i
          const sdr = base
            ? rasterLinear([base[offset], base[offset + 1], base[offset + 2]], a)
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
    } else {
      for (let top = 0; top < height; top += 64) {
        const data = new Float32Array(width * Math.min(64, height - top) * 3)
        for (let i = 0; i < data.length / 3; i++) {
          const offset = (top * width + i) * 4
          const value = rasterLinear([base![offset], base![offset + 1], base![offset + 2]], a)
          const alpha = base![offset + 3]
          for (let c = 0; c < 3; c++) data[i * 3 + c] = value[c] * alpha + 1 - alpha
        }
        await accept(data, top)
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
        const initializeStarted = performance.now()
        converter = await makeGpu(
          width * 64,
          a,
          hdrAdjustmentMatrix(a, asset.whiteBalance) ?? undefined,
          job.hdr,
          original,
          64,
          original && job.hdr ? pixels : 0,
        )
        gpuInitializeMs = performance.now() - initializeStarted
        gpuPeakBytes = converter.peakBytes
        adapter = converter.adapter
        let top = 0
        for await (const strip of exportStrips(job.source.processing.workingAsset!.path, asset)) {
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
          earlyPrimary = onSdrReady?.(rgb, geometry)
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
        converter?.close()
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
      renderer: backend,
      adapter,
      rendererFallback: fallback,
      renderMs,
      resizeMs: performance.now() - resizeStarted,
      gpuInitializeMs,
      gpuTilesMs,
      gpuPackingMs,
      gpuPeakBytes,
    },
  }
}
