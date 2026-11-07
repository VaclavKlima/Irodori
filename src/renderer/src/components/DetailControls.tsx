import { detailCapabilities } from '../../../shared/detail-controls'
import type { EditController } from '../hooks/useEdits'
import { AdjustmentInput } from './AdjustmentInput'
import { InspectorSection } from './InspectorSection'
import inspectorStyles from './Inspector.module.css'

export function DetailControls({
  edits,
  previewReady,
  expanded,
  onToggle,
  sharpeningExpanded,
  onSharpeningToggle,
}: {
  edits: EditController
  previewReady: boolean
  expanded: boolean
  onToggle: () => void
  sharpeningExpanded: boolean
  onSharpeningToggle: () => void
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
      <p className={inspectorStyles.hint}>Preview updates when a change is committed.</p>
      <InspectorSection
        id="detail-controls"
        title="Detail"
        heading="Noise reduction"
        expanded={expanded}
        onToggle={onToggle}
      >
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
      </InspectorSection>
      <InspectorSection
        id="sharpening-controls"
        title="Sharpening"
        expanded={sharpeningExpanded}
        onToggle={onSharpeningToggle}
      >
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
      </InspectorSection>
    </>
  )
}
