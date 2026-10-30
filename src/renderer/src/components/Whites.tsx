import { whitesModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Whites({ edits, previewReady }: { edits: EditController; previewReady: boolean }) {
  const parameter = whitesModule.parameters.whites
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Whites"
      value={edits.adjustments.whites}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={0}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(whites) => void edits.change({ whites })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
