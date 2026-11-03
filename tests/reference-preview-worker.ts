/** Isolated test/benchmark oracle. Production workers never import this entry. */
import type { PreviewWorkerRequest, PreviewWorkerResponse } from '../src/main/preview-types'
import { ReferencePreviewEngine } from './reference-preview-engine'
const engine = new ReferencePreviewEngine()
const send = (value: PreviewWorkerResponse) => process.send?.(value)
async function close() {
  await engine.close()
  process.exit(0)
}
process.on('disconnect', () => {
  void close()
})
process.on('SIGTERM', () => {
  void close()
})
process.on('message', async (request: PreviewWorkerRequest) => {
  if (request.type === 'close') return close()
  if (request.type === 'release') return
  if (request.type !== 'full')
    return send({ type: 'error', error: 'Unsupported numerical reference request.' })
  try {
    send({
      type: 'result',
      result: await engine.renderFull(
        request.path,
        request.output,
        (stage) => send({ type: 'stage', stage }),
        request.options,
      ),
    })
  } catch (error) {
    send({ type: 'error', error: String(error) })
  }
})
