import type { HdrWorkingAsset } from '../../../shared/hdr'
import { readHdrUploadBytes, validateHdrAsset, validateHdrStrip } from './hdr-stream'
import { collectHdrSample } from './hdr-sample'
let acknowledge: (() => void) | undefined
self.onmessage = ({ data }: MessageEvent<{ asset?: HdrWorkingAsset; ack?: boolean }>) => {
  if (data.ack) acknowledge?.()
  if (data.asset) load(data.asset)
}
function load(asset: HdrWorkingAsset) {
  try {
    validateHdrAsset(asset)
  } catch (error) {
    self.postMessage({ error: String(error) })
    return
  }
  const sample = collectHdrSample(asset)
  const abort = new AbortController()
  const source = readHdrUploadBytes(asset, abort.signal)
  const ready = new Map<number, Awaited<ReturnType<typeof validateHdrStrip>>>()
  let credits = 3,
    reading = 0,
    sending = 0,
    failed = false
  const pump = () => {
    while (credits && reading < asset.strips.length && !failed) {
      credits--
      const index = reading++
      void source
        .next()
        .then((next) => {
          if (next.done || next.value.index !== index) throw new Error('Incomplete HDR source.')
          return validateHdrStrip(asset, index, next.value.bytes, next.value.readMs)
        })
        .then((strip) => {
          if (failed) return
          ready.set(index, strip)
          while (ready.has(sending)) {
            const strip = ready.get(sending)!
            ready.delete(sending++)
            sample.add(strip.data, strip.row)
            self.postMessage(strip, { transfer: [strip.data.buffer] })
          }
          if (sending === asset.strips.length)
            return source
              .next()
              .then(() =>
                self.postMessage(
                  { sample: sample.sample, draftSample: sample.draft, done: true },
                  { transfer: [sample.sample.buffer, sample.draft.buffer] },
                ),
              )
        })
        .catch((error) => {
          failed = true
          abort.abort()
          self.postMessage({ error: String(error) })
        })
    }
  }
  acknowledge = () => {
    credits++
    pump()
  }
  pump()
}
