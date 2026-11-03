import { halfFloat } from '../src/main/export/codec'
import type { createExportGpu } from '../src/main/export/gpu'
import { exportRenditions } from '../src/main/export/renditions'
import { prepareCreativeColor } from '../src/shared/creative-color'
import {
  adjustHdr,
  contentHdr,
  HDR_SOURCE_VERSION,
  matrixRgb,
  outputHdr,
  REC2020_TO_SRGB,
  SDR_TARGET,
} from '../src/shared/hdr'
import { rasterLinear } from './raster-reference'

/** Test-only scalar oracle for the selected scene-linear GPU stage. Reference
 * mathematics never becomes an application runtime override or recovery path. */
export const createExportReference: typeof createExportGpu = async (
  _capacity,
  adjustments,
  whiteBalance,
  hdr,
  packed,
  _workgroup,
  _retained,
  _makeRenderer,
  options,
) => {
  const creative = prepareCreativeColor(adjustments)
  return {
    adapter: 'test-only-independent-reference',
    hdrDeferred: false,
    peakBytes: 0,
    async render(pixels, _top, primary) {
      const count = pixels.length / 4,
        channels = hdr ? 6 : 3,
        data = Buffer.alloc(count * (packed ? (hdr ? 12 : 4) : channels * 4)),
        words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4),
        floats = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
      let headroom = 1.01
      for (let i = 0; i < count; i++) {
        const at = i * 4,
          alpha = pixels[at + 3],
          rgb = adjustHdr(
            [pixels[at], pixels[at + 1], pixels[at + 2]],
            adjustments,
            whiteBalance,
            creative,
          ),
          domain = options?.domain ?? 'scene-linear',
          sdrBase =
            domain === 'scene-linear'
              ? outputHdr(rgb, SDR_TARGET).rgb
              : domain === 'raster' || primary
                ? rasterLinear([...(primary ?? pixels).subarray(at, at + 3)], adjustments, creative)
                : matrixRgb(REC2020_TO_SRGB, rgb).map((v) => Math.max(0, Math.min(1, v))),
          sdr = sdrBase.map((v) => v * alpha + 1 - alpha),
          content = hdr
            ? domain === 'authored-hdr'
              ? rgb.map((v) => Math.min(10, Math.max(0, v) * alpha + 1 - alpha))
              : contentHdr(rgb, { version: HDR_SOURCE_VERSION } as Parameters<
                  typeof contentHdr
                >[1]).rgb.map((v) => v * alpha + 1 - alpha)
            : undefined
        if (content) headroom = Math.max(headroom, ...content)
        if (packed) {
          const codes = sdr.map((v) =>
              Math.round(
                Math.min(
                  1,
                  Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
                ) * 255,
              ),
            ),
            slot = i * (hdr ? 3 : 1)
          words[slot] = codes[0] | (codes[1] << 8) | (codes[2] << 16)
          if (content) {
            words[slot + 1] = halfFloat(content[0]) | (halfFloat(content[1]) << 16)
            words[slot + 2] = halfFloat(content[2]) | (halfFloat(1) << 16)
          }
        } else {
          floats.set(sdr, i * channels)
          if (content) floats.set(content, i * channels + 3)
        }
      }
      return { data, headroom }
    },
    async finishHdr() {
      throw new Error('The independent reference never defers HDR.')
    },
    async close() {},
  }
}
export function exportRenditionsReference(job: Parameters<typeof exportRenditions>[0]) {
  return exportRenditions(job, createExportReference)
}
