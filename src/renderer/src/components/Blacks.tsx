import { blacksModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Blacks({ edits, previewReady }: { edits: EditController; previewReady: boolean }) {
  const parameter = blacksModule.parameters.blacks
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Blacks"
      value={edits.adjustments.blacks}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={0}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(blacks) => void edits.change({ blacks })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
