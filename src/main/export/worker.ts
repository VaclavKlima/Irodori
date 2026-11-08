import { renderExport } from './render'
import type { ExportRenderJob } from './types'
import { exportProgressOwner, exportWorkerPhases } from './progress'
import type { ExportWorkerProgress } from '../../shared/export'

async function sendTerminal(message: {
  result?: import('./types').ExportRenderResult
  error?: string
}) {
  if (!process.send || !process.connected) throw new Error('Export parent disconnected.')
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()))
  })
}

process.once('disconnect', () => process.exit(0))
process.once('message', async (job: ExportRenderJob) => {
  try {
    const owner = exportProgressOwner(job, performance.timeOrigin + performance.now())
    let sequence = 0
    await sendTerminal({
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
    await sendTerminal({ error: error instanceof Error ? error.message : String(error) }).catch(
      () => {},
    )
  } finally {
    process.disconnect()
  }
})
