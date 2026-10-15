import { renderExport } from './render'
import type { ExportRenderJob } from './types'

process.once('disconnect', () => process.exit(0))
process.once('message', async (job: ExportRenderJob) => {
  try {
    process.send?.({ result: await renderExport(job) })
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    process.disconnect()
  }
})
