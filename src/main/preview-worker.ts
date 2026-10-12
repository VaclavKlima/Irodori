import { PreviewEngine } from './preview-engine'
import { scanHdr, sampleHdrPixel } from './processing/hdr-processing'
import type { PreviewWorkerRequest, PreviewWorkerResponse } from './preview-types'

function send(message: PreviewWorkerResponse) {
  if (process.connected) process.send?.(message)
}

const engine = new PreviewEngine()
let closing = false
async function close() {
  if (closing) return
  closing = true
  await engine.close()
  process.exit(0)
}
process.on('disconnect', () => {
  void close()
})
process.on('SIGTERM', () => {
  void close()
})
process.on('message', async (data: PreviewWorkerRequest) => {
  if (data.type === 'release') {
    engine.releaseFrame()
    return
  }
  if (data.type === 'close') {
    await close()
    return
  }
  try {
    const result =
      data.type === 'pixel'
        ? await sampleHdrPixel(data.path, data.pixel!)
        : data.type === 'statistics'
          ? data.frame?.hdr
            ? await scanHdr(data.path, data.frame.hdr)
            : await engine.statistics(data.path, data.frame!)
          : data.type === 'thumbnail' || data.type === 'thumbnail-fallback'
            ? await engine.thumbnail(data.path, data.output, data.type === 'thumbnail-fallback')
            : data.type === 'capture-metadata'
              ? await engine.inspectCapture(data.path)
              : data.type === 'metadata'
                ? await engine.inspect(data.path)
                : data.type === 'full'
                  ? await engine.renderFull(
                      data.path,
                      data.output,
                      (stage) => send({ type: 'stage', stage }),
                      data.options,
                    )
                  : await engine.process(data.path, data.output, data.importMode, data.importSeed)
    send({ type: 'result', result })
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
  }
})
