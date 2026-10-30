import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExportRenderJob, ExportSource } from '../src/main/export/types'
import { identity } from '../src/main/export/files'
import { exportCropPolicy } from '../src/main/export/crop-policy'
import { exportDetailPolicy } from '../src/main/export/detail-policy'
import { defaultExportOptions } from '../src/shared/export'
import { workingSourceIdentity } from '../src/main/working-assets'
import { detailPreviewFixture } from './detail-preview.helpers'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'
import { sha, workingAsset } from './export.helpers'

/** CC0-1.0 PNG with optional synthetic HDR descriptor; no RAW/gain-map decoder is used. */
export async function detailExportFixture(hdr = false, authored = false) {
  const f = await detailPreviewFixture(hdr, authored),
    source: ExportSource = {
      path: f.original,
      identity: identity(await lstat(f.original)),
      hdr,
      photo: {
        id: sha(f.originalBytes),
        filename: 'Synthetic.png',
        format: 'PNG',
        width: f.frame.width,
        height: f.frame.height,
        bytes: f.originalBytes.length,
        importedAt: '',
        previewSource: 'image',
        previewUrl: '',
        thumbnailUrl: '',
      },
      processing: {
        ...f.job.options,
        noiseReduction: f.job.noiseReduction,
        detailSharpening: f.job.detailSharpening,
        ...(hdr ? { workingAsset: f.job.asset } : {}),
      },
    },
    job: ExportRenderJob = {
      source,
      directory: await f.directory('export'),
      preparationDirectory: await f.directory('preparation'),
      options: { ...defaultExportOptions, metadata: 'none' },
      hdr,
      cropPolicy: { ...exportCropPolicy },
      detailPolicy: { ...exportDetailPolicy },
      cropAdmission: { policy: f.job.policy, reservation: f.job.reservation },
      detailAdmission: { policy: f.job.policy, reservation: f.job.reservation },
    }
  return {
    ...f,
    source,
    exportJob: job,
    expected: () =>
      canonicalDetailFrame(f.frame, { ...detailFrameJob(hdr ? 'rec2020' : 'srgb'), ...f.job }),
    async hdrReference(data: Float32Array) {
      const path = join(await f.directory('reference'), 'filtered.f32'),
        bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        hashes = workingAsset(bytes, f.frame.width, f.frame.height)
      await writeFile(path, bytes)
      return {
        ...f.job.asset,
        path,
        sha256: hashes.sha256,
        hdr: { ...f.job.asset.hdr!, sha256: hashes.sha256, strips: hashes.strips },
      }
    },
    async originalWorkingBytes() {
      return readFile(f.job.asset.path)
    },
    upstreamLease: () => ({
      identity: workingSourceIdentity(source.photo.id, source.processing),
      asset: f.job.asset,
    }),
  }
}
