import type { AdjustmentParameters } from '../../../shared/adjustments'
import type { DisplayTarget, HdrWorkingAsset } from '../../../shared/hdr'
import {
  analyzeHdr,
  hdrStatistics,
  reduceHdrMask,
  type HdrAnalysisDomain,
} from '../../../shared/hdr-statistics'
import type { NativeHdrMaskOutcome, NativeHdrMaskRequest } from '../../../shared/native-hdr-mask'
import { receiveNativeHdrMask } from './native-mask-receiver'
import { verifyNativeMaskMath } from './native-mask-math'
import { streamHdr } from './hdr-stream'
interface Request {
  parameters: AdjustmentParameters
  target: DisplayTarget
  domain: HdrAnalysisDomain
  generation: number
  masks: boolean
  sampleCount: number
  sampleStatistics: boolean
  /** Present only on the supported Linux route with confirmed history. */
  nativeMask?: Omit<NativeHdrMaskRequest, 'existingOwners'>
}
type Cancellation = { generation: number; maskError?: string }
type Operation = { request: Request } | { cancel: Cancellation }
let asset: HdrWorkingAsset | undefined,
  sample: Float32Array<ArrayBuffer> | undefined,
  draftSample: Float32Array<ArrayBuffer> | undefined,
  latest: Operation | undefined
let running = false,
  active: AbortController | undefined,
  activeGeneration: number | undefined
let latestGeneration = -1
const replies = new Map<
  number,
  (reply: { request?: NativeHdrMaskRequest; result?: NativeHdrMaskOutcome; error?: string }) => void
>()
const released = new Map<number, (error?: string) => void>()
self.onmessage = ({
  data,
}: MessageEvent<{
  asset?: HdrWorkingAsset
  request?: Request
  cancel?: Cancellation
  sample?: Float32Array<ArrayBuffer>
  draftSample?: Float32Array<ArrayBuffer>
  nativeReply?: {
    generation: number
    request?: NativeHdrMaskRequest
    result?: NativeHdrMaskOutcome
    error?: string
  }
  nativeReleased?: { generation: number; error?: string }
}>) => {
  if (data.nativeReply) {
    replies.get(data.nativeReply.generation)?.(data.nativeReply)
    replies.delete(data.nativeReply.generation)
    return
  }
  if (data.nativeReleased) {
    released.get(data.nativeReleased.generation)?.(data.nativeReleased.error)
    released.delete(data.nativeReleased.generation)
    return
  }
  if (data.asset) asset = data.asset
  if (data.sample) {
    sample = data.sample
    draftSample = data.draftSample
  }
  if (data.request && data.request.generation >= latestGeneration) {
    latestGeneration = data.request.generation
    latest = { request: data.request }
    active?.abort()
  }
  if (data.cancel) {
    if (data.cancel.generation >= latestGeneration) {
      latestGeneration = data.cancel.generation
      latest = { cancel: data.cancel }
      active?.abort()
    } else if (data.cancel.generation === activeGeneration) {
      // An older owner may still cancel itself, but cannot erase a newer slot.
      active?.abort()
    }
  }
  if (latest && !running && ('cancel' in latest || (sample && asset))) void run()
}
async function nativeMask(request: Request, asset: HdrWorkingAsset, controller: AbortController) {
  const { generation } = request
  let reply:
    { request?: NativeHdrMaskRequest; result?: NativeHdrMaskOutcome; error?: string } | undefined
  const cancel = () => self.postMessage({ nativeCancel: { generation } })
  controller.signal.addEventListener('abort', cancel, { once: true })
  try {
    verifyNativeMaskMath()
    const pending = new Promise<NonNullable<typeof reply>>((resolve) =>
      replies.set(generation, resolve),
    )
    self.postMessage({ nativeStart: request.nativeMask })
    reply = await pending
    if (reply.error) throw new Error(reply.error)
    controller.signal.throwIfAborted()
    if (!reply.result || !reply.request)
      throw new Error('Native mask admission did not return an outcome.')
    if (reply.result.kind === 'cancelled') return
    if (reply.result.kind === 'mask-declined')
      throw new Error(`Clipping overlay is unavailable: ${reply.result.reason}.`)
    const pyramid = await receiveNativeHdrMask(
      reply.result,
      reply.request,
      asset,
      controller.signal,
    )
    if (!latest && !controller.signal.aborted)
      self.postMessage(
        { mask: pyramid, generation },
        { transfer: pyramid.levels.map((level) => level.data.buffer) },
      )
  } finally {
    controller.signal.removeEventListener('abort', cancel)
    // Main release starts only after fetch/hash/reducer ownership is gone. Its
    // acknowledgement is part of this worker operation, including cancellation.
    const drain = new Promise<void>((resolve, reject) =>
      released.set(generation, (error) => (error ? reject(new Error(error)) : resolve())),
    )
    self.postMessage({ nativeDrained: { generation } })
    await drain
  }
}
async function run() {
  running = true
  try {
    while (latest) {
      const operation = latest
      if ('cancel' in operation) {
        latest = undefined
        self.postMessage({
          done: true,
          canceled: true,
          generation: operation.cancel.generation,
          maskError: operation.cancel.maskError,
        })
        continue
      }
      if (!sample || !asset) break
      const request = operation.request
      latest = undefined
      const controller = new AbortController()
      active = controller
      activeGeneration = request.generation
      let phase: 'statistics' | 'mask' = 'statistics'
      try {
        if (request.sampleStatistics) {
          const selected = request.sampleCount === 8192 ? draftSample! : sample
          const statistics = hdrStatistics(request.domain, request.target, asset, false)
          analyzeHdr(selected, request.parameters, asset, request.target, statistics)
          self.postMessage({
            statistics,
            parameters: request.parameters,
            generation: request.generation,
          })
        }
        if (request.masks) phase = 'mask'
        if (request.masks && request.nativeMask) await nativeMask(request, asset, controller)
        else if (request.masks) {
          // Unsupported platforms retain the unchanged reference path. Linux
          // requests never select this branch after native backend admission.
          const mask = new Uint8Array(asset.width * asset.height)
          const ignored = hdrStatistics(request.domain, request.target, asset)
          for await (const { data, row } of streamHdr(asset, controller.signal)) {
            if (latest || controller.signal.aborted) break
            analyzeHdr(
              data,
              request.parameters,
              asset,
              request.target,
              ignored,
              mask,
              row * asset.width,
            )
          }
          if (!latest && !controller.signal.aborted) {
            const pyramid = reduceHdrMask(mask, asset.width, asset.height)
            self.postMessage(
              { mask: pyramid, generation: request.generation },
              { transfer: pyramid.levels.map((level) => level.data.buffer) },
            )
          }
        }
      } catch (error) {
        if (!controller.signal.aborted)
          self.postMessage({
            error: String(error),
            errorKind: phase,
            generation: request.generation,
          })
      } finally {
        if (active === controller) {
          active = undefined
          activeGeneration = undefined
        }
        self.postMessage({ done: true, generation: request.generation })
      }
    }
  } finally {
    running = false
  }
}
