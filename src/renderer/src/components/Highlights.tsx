import { highlightsModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Highlights({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  const parameter = highlightsModule.parameters.highlights
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Highlights"
      value={edits.adjustments.highlights}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={0}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(highlights) => void edits.change({ highlights })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
