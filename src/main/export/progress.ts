import type { ExportWorkerProgress, ExportWorkerPhase } from '../../shared/export'
import type { ExportRenderJob } from './types'

export interface ExportProgressOwner {
  exportId: string
  fileIndex: number
  photoId: string
  settingsRevision: number
  attemptId: string
  hdr: boolean
  startedAtEpochMs: number
}
export const exportWorkerPhases = (hdr: boolean): readonly ExportWorkerPhase[] =>
  hdr
    ? ['rendition-rendered', 'sdr-jpeg-obtained', 'hdr-encoded', 'output-validated-written']
    : ['rendition-rendered', 'sdr-jpeg-obtained', 'output-validated-written']
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export function exportProgressOwner(
  job: ExportRenderJob,
  startedAtEpochMs: number,
): ExportProgressOwner | undefined {
  const identity = job.workerProgressIdentity
  if (!identity) return undefined
  if (
    !uuid.test(identity.exportId) ||
    !uuid.test(identity.attemptId) ||
    !Number.isSafeInteger(identity.fileIndex) ||
    identity.fileIndex < 0 ||
    !/^[a-f0-9]{64}$/.test(job.source.photo.id) ||
    !Number.isSafeInteger(job.source.processing.revision) ||
    job.source.processing.revision < 0
  )
    throw new Error('Invalid internal export progress owner.')
  return {
    ...identity,
    photoId: job.source.photo.id,
    settingsRevision: job.source.processing.revision,
    hdr: job.hdr,
    startedAtEpochMs,
  }
}

/** Fail closed on malformed, stale, reordered, duplicated or foreign observations. */
export function acceptExportWorkerProgress(
  value: unknown,
  owner: ExportProgressOwner,
  previous: ExportWorkerProgress | undefined,
  observedAtEpochMs: number,
): ExportWorkerProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const event = value as ExportWorkerProgress
  const fields = [
    'version',
    'exportId',
    'fileIndex',
    'photoId',
    'settingsRevision',
    'attemptId',
    'sequence',
    'phase',
    'completed',
    'total',
    'producedAtEpochMs',
  ]
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    return undefined
  const phases = exportWorkerPhases(owner.hdr)
  if (
    event.version !== 'export-worker-progress-v1' ||
    event.exportId !== owner.exportId ||
    event.fileIndex !== owner.fileIndex ||
    event.photoId !== owner.photoId ||
    event.settingsRevision !== owner.settingsRevision ||
    event.attemptId !== owner.attemptId ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    event.sequence > phases.length ||
    typeof event.phase !== 'string' ||
    event.sequence !== (previous?.sequence ?? 0) + 1 ||
    event.phase !== phases[event.sequence - 1] ||
    event.completed !== event.sequence ||
    event.total !== phases.length ||
    !Number.isFinite(event.producedAtEpochMs) ||
    event.producedAtEpochMs < owner.startedAtEpochMs ||
    event.producedAtEpochMs > observedAtEpochMs ||
    (previous && event.producedAtEpochMs < previous.producedAtEpochMs)
  )
    return undefined
  return { ...event }
}
