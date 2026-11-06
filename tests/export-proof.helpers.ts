import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { OutputProofs } from '../src/main/export/proofs'
import { decodeOutputProof } from '../src/main/export/proof-decode'
import { exportGeometry, defaultExportOptions } from '../src/shared/export'
import type { OutputProofRequest } from '../src/shared/export-proof'
import type { ExportRenderJob, ExportRenderResult } from '../src/main/export/types'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportJobs } from '../src/main/export/jobs'
import type { ExportSource } from '../src/main/export/types'
import { exportFixture, sha } from './export.helpers'
import { cropAdmission } from './crop-frame.helpers'

export async function proofFixture(
  overrides: {
    render?: (job: ExportRenderJob, signal: AbortSignal) => Promise<ExportRenderResult>
    decode?: ConstructorParameters<typeof OutputProofs>[7]
    admission?: ConstructorParameters<typeof OutputProofs>[4]
    real?: boolean
    source?: ExportSource
  } = {},
) {
  const fixture = await exportFixture()
  await fixture.library.outputProofs.close()
  fixture.library.cropAdmission = async () => cropAdmission()
  const { ExportProcess } = await import('../src/main/export/process')
  if (overrides.source) {
    await fixture.library.exports.close()
    const source = overrides.source
    fixture.library.exports = new ExportJobs(
      fixture.library.exports.store,
      join(fixture.root, 'library'),
      fixture.library.scheduler,
      async (id) => {
        if (id !== source.photo.id) throw new Error('Unknown source')
        return source
      },
      () => true,
      () => {},
      new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ),
      undefined,
      undefined,
      async () => cropAdmission(),
    )
  }
  const renderer = overrides.real
    ? new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js'))
    : {
        render:
          overrides.render ??
          (async (job: ExportRenderJob) => {
            const geometry = exportGeometry(
              job.source.photo.width!,
              job.source.photo.height!,
              job.options.size,
            )
            const path = join(job.directory, 'output.jpg')
            await mkdir(job.directory, { recursive: true })
            await sharp(job.source.path)
              .resize(geometry)
              .withIccProfile('srgb')
              .jpeg({ quality: job.options.quality, chromaSubsampling: '4:4:4' })
              .toFile(path)
            return { path, sha256: sha(await readFile(path)), geometry }
          }),
      }
  const proofs = new OutputProofs(
    join(fixture.root, 'library'),
    fixture.library.exports,
    fixture.library.scheduler,
    async () => undefined,
    overrides.admission ?? (async () => cropAdmission()),
    (bytes) => fixture.library.fullPreviews.reserveOutputProofBytes(bytes),
    renderer,
    overrides.decode ??
      (overrides.real
        ? async (path, directory, job, signal) => {
            const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
            try {
              return await worker.decodeOutputProof(path, directory, job, signal)
            } finally {
              await worker.close(true)
            }
          }
        : decodeOutputProof),
  )
  fixture.library.outputProofs = proofs
  const prepared = overrides.source
    ? await fixture.library.exports.prepare([overrides.source.photo.id])
    : await fixture.library.prepareExport(fixture.photos.map((p) => p.id))
  const request = (
    photoId = overrides.source?.photo.id ?? fixture.photos[0].id,
  ): OutputProofRequest => ({
    preparationId: prepared.id,
    photoId,
    options: structuredClone(defaultExportOptions),
    token: randomUUID(),
  })
  return { ...fixture, proofs, prepared, request }
}

export function interrupted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    if (signal.aborted) reject(signal.reason)
  })
}
