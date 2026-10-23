import { renderExport } from './render'
import type { ExportRenderJob } from './types'
import { exportProgressOwner, exportWorkerPhases } from './progress'
import type { ExportWorkerProgress } from '../../shared/export'

process.once('disconnect', () => process.exit(0))
process.once('message', async (job: ExportRenderJob) => {
  try {
    const owner = exportProgressOwner(job, performance.timeOrigin + performance.now())
    let sequence = 0
    process.send?.({
      result: await renderExport(job, (phase) => {
        if (!owner || !process.connected) return
        sequence++
        const progress: ExportWorkerProgress = {
          version: 'export-worker-progress-v1',
          exportId: owner.exportId,
          fileIndex: owner.fileIndex,
          photoId: owner.photoId,
          settingsRevision: owner.settingsRevision,
          attemptId: owner.attemptId,
          sequence,
          phase,
          completed: sequence,
          total: exportWorkerPhases(job.hdr).length,
          producedAtEpochMs: performance.timeOrigin + performance.now(),
        }
        process.send?.({ progress })
      }),
    })
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    process.disconnect()
  }
})
