import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { FullPreviews } from '../src/main/full-previews'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewProcessor, FullPreviewResult } from '../src/main/preview-types'
import type { CropPreviewJob } from '../src/main/processing/crop-preview'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { processingMetadata } from '../src/main/processing/metadata'
import { fitCrop, identityCrop } from '../src/shared/crop'
import { cropAdmission } from './crop-frame.helpers'
import { workingAsset } from './export.helpers'
import { normalization, profile } from './white-balance-picker.helpers'

export async function cropPreviewFixture(hdr = false) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-preview-')),
    width = 97,
    height = 131,
    data = new Float32Array(width * height * 4),
    path = join(root, hdr ? 'source.arw' : 'source.png')
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([x / 101, y / 137, 4 + x / 97, 1], (y * width + x) * 4)
  const bytes = Buffer.from(data.buffer),
    asset = workingAsset(bytes, width, height)
  asset.whiteBalance = profile
  if (!asset.source.display) asset.source.normalization = normalization
  if (hdr) await writeFile(path, 'Synthetic crop source: no RAW decoder is exercised.')
  else
    await sharp({
      create: { width, height, channels: 4, background: { r: 73, g: 110, b: 152, alpha: 0.5 } },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toFile(path)
  const original = await readFile(path),
    id = createHash('sha256').update(original).digest('hex'),
    native = hdr ? { width, height } : { width: height, height: width }
  let options: ProcessingOptions = {
    processing: hdr ? 'hdr-v1' : 'display-referred-v1',
    metadata: processingMetadata({}, []),
    settings: noLensSettings,
    revision: 0,
    adjustments: { ...neutralAdjustments },
    crop: fitCrop(native, { ...identityCrop, angle: 4.23, width: 0.6, height: 0.65 }),
  }
  const counters = {
    sources: 0,
    renditions: 0,
    crops: 0,
    statisticsWidth: 0,
    sampleWidth: 0,
    sampleHash: '',
  }
  let beforeSource: (signal: AbortSignal) => Promise<void> = async () => {},
    beforeCrop: (job: CropPreviewJob, signal: AbortSignal) => Promise<void> = async () => {}
  const create = async () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
    const processor: FullPreviewProcessor = {
      async renderFull(source, output, signal, selected) {
        if (!selected?.workingAsset) {
          counters.sources++
          await beforeSource(signal)
          signal.throwIfAborted()
          if (hdr) {
            await writeFile(join(output, 'linear.f32'), bytes)
            const frame: FullPreviewResult = {
              width,
              height,
              byteLength: 0,
              format: 'hdr-working',
              placeholderBytes: 0,
              sha256: asset.sha256,
              renderId: `synthetic-base-${asset.sha256}`,
              adjustments: selected?.adjustments,
              settingsRevision: selected?.revision,
              linear: {
                byteLength: bytes.length,
                sha256: asset.sha256,
                hdr: asset,
                transform: srgbTransform,
              },
            }
            return frame
          }
        } else counters.renditions++
        return worker.renderFull(source, output, signal, selected)
      },
      async prepareCropPreview(source, output, job, signal) {
        counters.crops++
        await beforeCrop(job, signal)
        signal.throwIfAborted()
        return worker.prepareCropPreview(source, output, job, signal)
      },
      async hdrStatistics(source, job, signal) {
        counters.statisticsWidth = job.asset.width
        return worker.hdrStatistics(source, job, signal)
      },
      async whiteBalanceSample(source, job, signal) {
        counters.sampleWidth = job.asset.width
        counters.sampleHash = job.asset.sha256
        return worker.whiteBalanceSample(source, job, signal)
      },
      releaseFrame: () => worker.releaseFrame(),
      close: () => worker.close(true),
    }
    const previews = new FullPreviews(
      join(root, 'cache'),
      (candidate) => (candidate === id ? path : undefined),
      processor,
      undefined,
      async () => structuredClone(options),
    )
    previews.installCropAdmission(async () => cropAdmission())
    await previews.open()
    return previews
  }
  let previews = await create()
  return {
    root,
    id,
    path,
    original,
    data,
    bytes,
    asset,
    native,
    counters,
    get options() {
      return options
    },
    get previews() {
      return previews
    },
    change(patch: Partial<ProcessingOptions>, notify = true) {
      options = { ...options, ...patch, revision: options.revision + 1 }
      if (notify) previews.settingsChanged(id)
    },
    beforeSource(work: typeof beforeSource) {
      beforeSource = work
    },
    beforeCrop(work: typeof beforeCrop) {
      beforeCrop = work
    },
    async restart() {
      await previews.close()
      previews = await create()
    },
    async close() {
      await previews.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
