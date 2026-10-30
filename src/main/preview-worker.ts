import { PreviewEngine } from './preview-engine'
import { scanHdr, sampleHdrPixel } from './processing/hdr-processing'
import { sampleNeutralWhiteBalance } from './processing/white-balance-picker'
import { prepareCropWorkingAsset } from './processing/crop-preparation'
import { prepareCropPreview } from './processing/crop-preview'
import {
  prepareDetailWorkingAsset,
  type DetailPreparationResult,
} from './processing/detail-preparation'
import { prepareDetailPreview } from './processing/detail-preview'
import type { FullPreviewResult } from './preview-types'
import type { PreviewWorkerRequest, PreviewWorkerResponse } from './preview-types'
import { NativeRawSourceClient } from './native-raw-source'

function send(message: PreviewWorkerResponse) {
  if (process.connected) process.send?.(message)
}

const engine = new PreviewEngine()
const nativeRaw = new NativeRawSourceClient((message) => {
  if (!process.connected || !process.send) throw new Error('Preview parent disconnected.')
  process.send(message, (error) => {
    if (error) nativeRaw.close()
  })
})
let closing = false
let detailWork:
  | { controller: AbortController; pending: Promise<DetailPreparationResult | FullPreviewResult> }
  | undefined
async function close() {
  if (closing) return
  closing = true
  const ownedDetail = detailWork
  if (ownedDetail) {
    ownedDetail.controller.abort()
    await ownedDetail.pending.catch(() => undefined)
  }
  nativeRaw.close()
  await engine.close()
  process.exit(0)
}
process.on('disconnect', () => {
  void close()
})
process.on('SIGTERM', () => {
  void close()
})
process.on('message', async (data: PreviewWorkerRequest, handle) => {
  if (
    data.type === 'raw-source-stream' ||
    data.type === 'raw-source-exit' ||
    data.type === 'raw-source-declined'
  ) {
    try {
      nativeRaw.accept(data, handle)
    } catch (error) {
      send({ type: 'error', error: String(error) })
    }
    return
  }
  if (data.type === 'release') {
    engine.releaseFrame()
    return
  }
  if (data.type === 'close') {
    await close()
    return
  }
  try {
    if (data.type === 'prepared-full') {
      if (closing || detailWork) throw new Error('The prepared worker is unavailable or busy.')
      if (!data.options || !data.frame?.preparedBackend)
        throw new Error('Missing prepared preview request.')
      const controller = new AbortController(),
        pending = engine.renderPreparedFull(data.output, data.options, data.frame.preparedBackend),
        owned = { controller, pending }
      detailWork = owned
      try {
        const result = await pending
        if (!closing) send({ type: 'result', result })
      } finally {
        if (detailWork === owned) detailWork = undefined
      }
      return
    }
    if (data.type === 'detail-preview') {
      if (closing || detailWork) throw new Error('The detail worker is unavailable or busy.')
      if (!data.frame?.detailPreview) throw new Error('Missing detail preview request.')
      engine.releaseFrame()
      const controller = new AbortController(),
        pending = prepareDetailPreview(
          data.output,
          data.frame.detailPreview,
          controller.signal,
          (options, backend) => engine.renderPreparedFull(data.output, options, backend),
        ),
        owned = { controller, pending }
      detailWork = owned
      try {
        const result = await pending
        if (!closing) send({ type: 'result', result })
      } finally {
        if (detailWork === owned) detailWork = undefined
      }
      return
    }
    if (data.type === 'detail-working') {
      if (closing || detailWork) throw new Error('The detail worker is unavailable or busy.')
      if (!data.frame?.detail) throw new Error('Missing detail preparation request.')
      engine.releaseFrame()
      const controller = new AbortController(),
        pending = prepareDetailWorkingAsset(
          data.path,
          data.frame.detail,
          data.output,
          controller.signal,
        ),
        owned = { controller, pending }
      detailWork = owned
      try {
        const result = await pending
        if (!closing) send({ type: 'result', result })
      } finally {
        if (detailWork === owned) detailWork = undefined
      }
      return
    }
    if (data.type === 'crop-preview') {
      if (!data.frame?.cropPreview) throw new Error('Missing crop preview request.')
      engine.releaseFrame()
      const result = await prepareCropPreview(
        data.output,
        data.frame.cropPreview,
        new AbortController().signal,
        (options) => engine.renderPreparedFull(data.output, options),
      )
      send({ type: 'result', result })
      return
    }
    if (data.type === 'crop-working') {
      if (!data.frame?.crop) throw new Error('Missing crop preparation request.')
      engine.releaseFrame()
      const result = await prepareCropWorkingAsset(
        data.path,
        data.frame.crop,
        data.output,
        new AbortController().signal,
      )
      send({ type: 'result', result })
      return
    }
    const result =
      data.type === 'warmup'
        ? await engine.prewarmHdr(data.kernel ?? 'linear64')
        : data.type === 'white-balance-sample'
          ? await sampleNeutralWhiteBalance(data.path, data.frame!.whiteBalance!)
          : data.type === 'pixel'
            ? await sampleHdrPixel(data.path, data.pixel!)
            : data.type === 'statistics'
              ? data.frame?.hdr
                ? await scanHdr(data.path, data.frame.hdr)
                : await engine.statistics(data.path, data.frame!)
              : data.type === 'thumbnail' || data.type === 'thumbnail-fallback'
                ? await engine.thumbnail(data.path, data.output, data.type === 'thumbnail-fallback')
                : data.type === 'capture-metadata' || data.type === 'capture-metadata-session'
                  ? await engine.inspectCapture(data.path, data.type === 'capture-metadata-session')
                  : data.type === 'metadata'
                    ? await engine.inspect(data.path)
                    : data.type === 'full'
                      ? await engine.renderFull(
                          data.path,
                          data.output,
                          (stage) => send({ type: 'stage', stage }),
                          data.options,
                          async (progress) => send({ type: 'first-surface', progress }),
                          data.nativeRaw ? () => nativeRaw.prepare(data.nativeRaw!) : undefined,
                          data.nativeRaw,
                        )
                      : await engine.process(
                          data.path,
                          data.output,
                          data.importMode,
                          data.importSeed,
                        )
    send({ type: 'result', result })
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
  }
})
