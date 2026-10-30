import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FullPreviews, PREVIEW_VERSION } from '../src/main/full-previews'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewProcessor, FullPreviewResult } from '../src/main/preview-types'
import type { DetailPreviewJob } from '../src/main/processing/detail-preview'
import type { CropPreviewJob } from '../src/main/processing/crop-preview'
import type { ProcessingOptions } from '../src/shared/lens'
import { identityCrop } from '../src/shared/crop'
import { detailPreviewFixture } from './detail-preview.helpers'
import { sha } from './export.helpers'

/** CC0-1.0 tiny PNG and synthetic prepared HDR; only the PNG exercises original decoding. */
export async function detailCacheFixture(hdr = false, budget?: number, authored = false) {
  const source = await detailPreviewFixture(hdr, authored),
    root = join(source.root, 'cache'),
    id = sha(source.originalBytes),
    counters = { sources: 0, filters: 0, crops: 0, proofs: 0, sampleHash: '', statisticsHash: '' }
  let options: ProcessingOptions = {
      ...structuredClone(source.job.options),
      noiseReduction: structuredClone(source.job.noiseReduction),
      detailSharpening: structuredClone(source.job.detailSharpening),
      crop: { ...identityCrop },
    },
    beforeDetail: (job: DetailPreviewJob, signal: AbortSignal) => Promise<void> = async () => {},
    beforeCrop: (job: CropPreviewJob, signal: AbortSignal) => Promise<void> = async () => {},
    afterDetail: (result: FullPreviewResult) => FullPreviewResult = (result) => result,
    afterCrop: (result: FullPreviewResult) => FullPreviewResult = (result) => result

  const create = async () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
      processor: FullPreviewProcessor = {
        async renderFull(path, output, signal, selected) {
          if (selected?.workingAsset) {
            counters.proofs++
            return worker.renderPreparedFull(output, selected, signal, 'cpu')
          }
          counters.sources++
          if (!hdr || (authored && !selected?.workingOnly))
            return worker.renderFull(path, output, signal, selected)
          signal.throwIfAborted()
          await copyFile(source.job.asset.path, join(output, 'linear.f32'))
          return {
            width: source.frame.width,
            height: source.frame.height,
            format: 'hdr-working',
            byteLength: 0,
            placeholderBytes: 0,
            sha256: source.job.asset.sha256,
            renderId: `synthetic-prepared-${source.job.asset.sha256}`,
            linear: {
              byteLength: source.job.asset.byteLength,
              sha256: source.job.asset.sha256,
              hdr: structuredClone(source.job.asset.hdr),
              transform: structuredClone(source.job.asset.transform),
            },
            adjustments: selected?.adjustments,
            settingsRevision: selected?.revision,
          }
        },
        async renderPreparedFull(output, selected, signal, backend) {
          counters.proofs++
          return worker.renderPreparedFull(output, selected, signal, backend)
        },
        async prepareDetailPreview(path, output, job, signal) {
          counters.filters++
          await beforeDetail(job, signal)
          signal.throwIfAborted()
          return afterDetail(await worker.prepareDetailPreview(path, output, job, signal))
        },
        async prepareCropPreview(path, output, job, signal) {
          counters.crops++
          await beforeCrop(job, signal)
          signal.throwIfAborted()
          return afterCrop(await worker.prepareCropPreview(path, output, job, signal))
        },
        async whiteBalanceSample(_path, job) {
          counters.sampleHash = job.asset.sha256
          throw new Error('Captured unfiltered synthetic WB source.')
        },
        async hdrStatistics(path, job, signal) {
          counters.statisticsHash = job.asset.sha256
          return worker.hdrStatistics(path, job, signal)
        },
        close: () => worker.close(true),
        releaseFrame: () => worker.releaseFrame(),
      },
      previews = new FullPreviews(
        root,
        (photoId) => (photoId === id ? source.original : undefined),
        processor,
        budget,
        async () => structuredClone(options),
      ),
      admission = async () =>
        structuredClone({ policy: source.job.policy, reservation: source.job.reservation })
    previews.installDetailAdmission(admission)
    previews.installCropAdmission(admission)
    await previews.open()
    return previews
  }
  let previews = await create()
  return {
    source,
    root,
    id,
    counters,
    get previews() {
      return previews
    },
    get options() {
      return options
    },
    change(patch: Partial<ProcessingOptions>) {
      options = { ...options, ...structuredClone(patch), revision: options.revision + 1 }
      previews.settingsChanged(id)
    },
    beforeDetail(work: typeof beforeDetail) {
      beforeDetail = work
    },
    beforeCrop(work: typeof beforeCrop) {
      beforeCrop = work
    },
    afterDetail(work: typeof afterDetail) {
      afterDetail = work
    },
    afterCrop(work: typeof afterCrop) {
      afterCrop = work
    },
    async entries() {
      const directory = join(root, PREVIEW_VERSION)
      return Promise.all(
        (await readdir(directory))
          .filter((name) => !name.startsWith('.tmp-'))
          .map(async (name) => ({
            path: join(directory, name),
            metadata: JSON.parse(await readFile(join(directory, name, 'entry.json'), 'utf8')),
          })),
      )
    },
    async restart() {
      await previews.close()
      previews = await create()
    },
    async damageEntry(path: string, metadata: object) {
      await writeFile(join(path, 'entry.json'), JSON.stringify(metadata))
    },
    async removeEntry(path: string) {
      await rm(path, { recursive: true, force: true })
    },
    async close() {
      await previews.close()
      await source.close()
    },
  }
}
