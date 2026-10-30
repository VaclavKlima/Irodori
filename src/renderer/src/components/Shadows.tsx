import { shadowsModule } from '../../../shared/adjustments'
import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'

export function Shadows({ edits, previewReady }: { edits: EditController; previewReady: boolean }) {
  const parameter = shadowsModule.parameters.shadows
  return (
    <AdjustmentInput
      key={edits.state?.photoId ?? 'empty'}
      label="Shadows"
      value={edits.adjustments.shadows}
      min={parameter.min}
      max={parameter.max}
      step={parameter.step}
      precision={0}
      resetKey={edits.state?.revision}
      disabled={!edits.state || !previewReady}
      busy={edits.saving}
      onChange={(shadows) => void edits.change({ shadows })}
      onCommit={() => void edits.flush().catch(() => undefined)}
      onCancel={edits.cancel}
    />
  )
}
