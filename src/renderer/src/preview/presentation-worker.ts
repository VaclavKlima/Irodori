import {
  renderAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
let beforeSent = -1
let frame: WorkingFrame | undefined
let beforeFrame: WorkingFrame | undefined
let generation = 0
self.onmessage = async (
  event: MessageEvent<{
    frame?: WorkingFrame
    beforeFrame?: WorkingFrame | null
    generation?: number
    parameters?: AdjustmentParameters
  }>,
) => {
  if (event.data.frame) frame = event.data.frame
  if (event.data.beforeFrame !== undefined) beforeFrame = event.data.beforeFrame ?? undefined
  if (event.data.generation !== undefined) generation = event.data.generation
  if (frame && event.data.parameters !== undefined) {
    const parameters = event.data.parameters,
      active = frame,
      baseline = beforeFrame ?? active,
      current = generation
    const bitmap = await createImageBitmap(
      new ImageData(
        renderAdjustments(active.data, parameters, active.transform),
        active.width,
        active.height,
      ),
    )
    const before =
      beforeSent !== current
        ? await createImageBitmap(
            new ImageData(
              renderAdjustments(baseline.data, neutralAdjustments, baseline.transform),
              baseline.width,
              baseline.height,
            ),
          )
        : undefined
    beforeSent = current
    self.postMessage(
      { parameters, bitmap, before, generation: current },
      { transfer: before ? [bitmap, before] : [bitmap] },
    )
  }
}
