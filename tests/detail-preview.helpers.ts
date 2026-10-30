import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { neutralAdjustments } from '../src/shared/adjustments'
import { HDR_JPEG_SOURCE_VERSION } from '../src/shared/hdr'
import type { DetailPreviewJob } from '../src/main/processing/detail-preview'
import { detailFrame, detailFrameJob } from './detail-frame.helpers'
import { sha } from './export.helpers'

/** CC0-1.0 synthetic inputs; no user library or real camera metadata. */
export async function detailPreviewFixture(hdr = false, authored = false) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-detail-preview-')),
    width = 19,
    height = 17,
    frame = detailFrame(width, height, hdr),
    original = join(root, 'original.png'),
    engine = new PreviewEngine(undefined, 'cpu'),
    base = join(root, 'base'),
    options = {
      metadata: {
        ...processingMetadata({}, []),
        ...(hdr && authored
          ? { hdrJpeg: { version: 1 as const, state: 'supported' as const, headroom: 4 } }
          : {}),
      },
      settings: { ...noLensSettings },
      revision: 7,
      adjustments: {
        ...structuredClone(neutralAdjustments),
        exposureEv: 0.4,
        contrast: 8,
        saturation: 15,
      },
    }
  await mkdir(base)
  let asset: DetailPreviewJob['asset'], originalBytes: Buffer
  try {
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels.set(
          [
            80 + ((x * 13 + y * 7) % 9) * 3,
            90 + ((x * 3 + y * 11) % 7) * 3,
            110 + ((x * 7 + y * 5) % 11) * 2,
            x === 0 ? 0 : x % 7 === 0 ? 128 : 255,
          ],
          (y * width + x) * 4,
        )
    originalBytes = await sharp(pixels, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer()
    await writeFile(original, originalBytes)
    if (hdr) {
      if (authored) {
        frame.hdr!.source.version = HDR_JPEG_SOURCE_VERSION
        frame.hdr!.source.display = {
          encoding: 'iso-21496-1-jpeg',
          referenceWhiteNits: 203,
          headroom: 4,
        }
      }
      const path = join(base, 'linear.f32')
      await writeFile(
        path,
        new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
      )
      asset = {
        path,
        width,
        height,
        byteLength: frame.data.byteLength,
        sha256: frame.hdr!.sha256,
        transform: frame.transform,
        hdr: frame.hdr,
      }
    } else {
      const result = await engine.renderFull(original, base, undefined, {
          ...options,
          prepareLinear: true,
        }),
        path = join(base, 'linear.f32'),
        bytes = await readFile(path)
      asset = { path, width: result.width, height: result.height, ...result.linear! }
      frame.data = new Float32Array(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength / 4,
      )
      frame.transform = asset.transform
      frame.hdr = undefined
    }
  } finally {
    await engine.close()
  }
  const sourceJob = detailFrameJob(hdr ? 'rec2020' : 'srgb'),
    job: DetailPreviewJob = {
      ...sourceJob.admission!,
      asset,
      sourceIdentity: sha(Buffer.from(`isolated-${hdr}-${authored}-${asset.sha256}`)),
      noiseReduction: { version: 1, luminance: 60, chroma: 50 },
      detailSharpening: { version: 1, amount: 35, radius: 1.2, threshold: 40 },
      options: { ...options, ...(hdr ? { processing: 'hdr-v1' as const } : {}) },
      backend: 'cpu',
      workingOnly: false,
    }
  return {
    root,
    original,
    originalBytes,
    frame,
    job,
    directory: async (name: string) => {
      const path = join(root, name)
      await mkdir(path)
      return path
    },
    close: () => rm(root, { recursive: true, force: true }),
  }
}
