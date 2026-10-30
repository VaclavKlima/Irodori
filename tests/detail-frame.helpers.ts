import { srgbTransform, type WorkingFrame } from '../src/shared/adjustments'
import { resolveResourcePolicy } from '../src/shared/resource-policy'
import type { ColorPrimaries } from '../src/shared/color-model'
import type { DetailFrameJob } from '../src/main/processing/detail-frame'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  spatialDetailTile,
  spatialDetailSourceBounds,
} from '../src/shared/spatial-detail'
import { detailWindow } from './spatial-detail.helpers'
import { workingAsset, sha } from './export.helpers'

/** CC0-1.0 synthetic linear frame, including padding outside the borrowed view. */
export function detailFrame(
  width = 259,
  height = 131,
  hdr = false,
  tinyAlpha = false,
): WorkingFrame {
  const backing = new ArrayBuffer(width * height * 16 + 64),
    data = new Float32Array(backing, 32, width * height * 4)
  new Uint8Array(backing).fill(0xa5)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          x === 0 ? -0 : 0.2 + 0.015 * Math.sin(x * 0.63 + y),
          -0.01 + 0.006 * Math.cos(y * 0.91 - x),
          16 + 0.1 * Math.sin(x * 1.27 + y * 0.72),
          x === 0 ? 0 : tinyAlpha && x === 1 && y === 0 ? 2 ** -80 : x % 17 === 0 ? 0.5 : 1,
        ],
        (y * width + x) * 4,
      )
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    source = hdr ? workingAsset(bytes, width, height) : undefined
  if (source) source.url = 'irodori-library://isolated-upstream-fixture'
  return {
    width,
    height,
    data,
    transform: { ...srgbTransform, white: 0.83 },
    identity: 'isolated-upstream-frame',
    cpuSource: {
      photoId: 'isolated-detail-frame',
      cacheId: 'isolated-upstream-cache',
      renderingIdentity: 'isolated-upstream-rendering',
      workingSha256: sha(bytes),
    },
    ...(source ? { hdr: source } : {}),
  }
}
export function detailFrameJob(primaries: ColorPrimaries = 'srgb'): DetailFrameJob {
  return {
    noiseReduction: { version: 1, luminance: 35, chroma: 45 },
    detailSharpening: { version: 1, amount: 40, radius: 1.2, threshold: 50 },
    primaries,
    backend: 'cpu',
    admission: {
      policy: resolveResourcePolicy(
        { version: 1, ramMiB: 2048, vramMiB: 2048 },
        {
          ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
          gpu: { status: 'unknown', reason: 'adapter-unverified' },
        },
        1,
      ),
      reservation: { ramBytes: 123, vramBytes: 456 },
    },
  }
}
export function canonicalDetailFrame(frame: WorkingFrame, job: DetailFrameJob) {
  const noise = compileNoiseReduction(job.noiseReduction),
    sharp = compileDetailSharpening(job.detailSharpening),
    data = new Float32Array(frame.data.length)
  for (let y = 0; y < frame.height; y += 256)
    for (let x = 0; x < frame.width; x += 256) {
      const tile = {
          left: x,
          top: y,
          width: Math.min(256, frame.width - x),
          height: Math.min(256, frame.height - y),
        },
        window = detailWindow(
          frame,
          frame.data,
          spatialDetailSourceBounds(frame, tile, noise, sharp),
        ),
        output = spatialDetailTile(frame, tile, window, noise, sharp, job.primaries)
      for (let row = 0; row < tile.height; row++)
        data.set(
          output.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
          ((row + y) * frame.width + x) * 4,
        )
    }
  return data
}
