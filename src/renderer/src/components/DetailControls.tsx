import { detailCapabilities } from '../../../shared/detail-controls'
import type { EditController } from '../hooks/useEdits'
import { AdjustmentInput } from './AdjustmentInput'
import styles from './DetailControls.module.css'

export function DetailControls({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  const disabled = !edits.state || !previewReady
  const shared = {
    disabled,
    busy: edits.saving,
    resetKey: edits.state?.revision,
    onCommit: () => void edits.flush().catch(() => undefined),
    onCancel: edits.cancel,
  }
  return (
    <>
      <p className={styles.hint}>Preview updates when a change is committed.</p>
      {(['luminance', 'chroma'] as const).map((key) => {
        const { min, max, step, precision } = detailCapabilities.noiseReduction.parameters[key]
        return (
          <AdjustmentInput
            key={`${edits.state?.photoId ?? 'empty'}-noise-${key}`}
            label={key === 'luminance' ? 'Luminance noise' : 'Color noise'}
            value={edits.spatial.noiseReduction[key]}
            min={min}
            max={max}
            step={step}
            precision={precision}
            {...shared}
            onChange={(value) => void edits.change({ noiseReduction: { [key]: value } })}
          />
        )
      })}
      {(['amount', 'radius', 'threshold'] as const).map((key) => {
        const { min, max, step, precision } = detailCapabilities.detailSharpening.parameters[key]
        return (
          <AdjustmentInput
            key={`${edits.state?.photoId ?? 'empty'}-detail-${key}`}
            label={key === 'amount' ? 'Sharpening' : key === 'radius' ? 'Radius' : 'Threshold'}
            value={edits.spatial.detailSharpening[key]}
            min={min}
            max={max}
            step={step}
            precision={precision}
            unit={key === 'radius' ? 'px' : undefined}
            {...shared}
            onChange={(value) => void edits.change({ detailSharpening: { [key]: value } })}
          />
        )
      })}
    </>
  )
}
