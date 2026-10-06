import {
  renderAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import { clippingPyramid, imageStatistics } from '../../../shared/statistics'
let frame: WorkingFrame | undefined
self.onmessage = (
  event: MessageEvent<{
    frame?: WorkingFrame
    parameters?: AdjustmentParameters
    generation: number
    identity: string
    masks?: boolean
  }>,
) => {
  const request = event.data
  if (request.frame) {
    frame = request.frame
  }
  if (!frame || !request.parameters) return
  try {
    if (request.masks) {
      const mask = clippingPyramid(
        renderAdjustments(frame.data, request.parameters, frame.transform),
        frame.width,
        frame.height,
      )
      self.postMessage(
        { mask, generation: request.generation, identity: request.identity },
        { transfer: mask.levels.map((level) => level.data.buffer) },
      )
    } else {
      const statistics = imageStatistics(
        renderAdjustments(frame.data, request.parameters, frame.transform),
      )
      self.postMessage({ statistics, generation: request.generation, identity: request.identity })
    }
  } catch (error) {
    self.postMessage({
      error: String(error),
      generation: request.generation,
      identity: request.identity,
    })
  }
  self.postMessage({ done: true, generation: request.generation, identity: request.identity })
}
