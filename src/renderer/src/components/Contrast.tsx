import { contrastModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Contrast({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  const parameter = contrastModule.parameters.contrast
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Contrast"
      value={edits.adjustments.contrast}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={0}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(contrast) => void edits.change({ contrast })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
