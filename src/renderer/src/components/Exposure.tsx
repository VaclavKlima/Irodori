import { exposureModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Exposure({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  const parameter = exposureModule.parameters.exposureEv
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Exposure"
      unit="EV"
      value={edits.adjustments.exposureEv}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={2}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(exposureEv) => void edits.change({ exposureEv })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
