import { colorIntensityModule } from '../../../shared/color-intensity'
import type { EditController } from '../hooks/useEdits'
import { AdjustmentInput } from './AdjustmentInput'

export function ColorIntensity({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  return (
    <>
      {(['saturation', 'vibrance'] as const).map((key) => {
        const parameter = colorIntensityModule.parameters[key]
        return (
          <AdjustmentInput
            key={`${edits.state?.photoId ?? 'empty'}-${key}`}
            label={key === 'saturation' ? 'Saturation' : 'Vibrance'}
            value={edits.adjustments[key]}
            min={parameter.min}
            max={parameter.max}
            step={parameter.step}
            precision={0}
            resetKey={edits.state?.revision}
            disabled={!edits.state || !previewReady}
            busy={edits.saving}
            onChange={(value) => void edits.change({ [key]: value })}
            onCommit={() => void edits.flush().catch(() => undefined)}
            onCancel={edits.cancel}
          />
        )
      })}
    </>
  )
}
