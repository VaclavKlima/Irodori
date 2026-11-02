import type { CSSProperties } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  colorRangeIds,
  neutralColorMixer,
  type ColorRangeAmounts,
} from '../../../shared/color-mixer'
import {
  gradingToneIds,
  neutralColorGrading,
  type GradingTone,
} from '../../../shared/color-grading'
import { creativeColorCapabilities as capabilities } from '../../../shared/creative-color-controls'
import type { CreativeColorSelection } from '../../../shared/workspace'
import type { EditController } from '../hooks/useEdits'
import { AdjustmentInput } from './AdjustmentInput'
import { GradingWheel } from './GradingWheel'
import { InspectorSection } from './InspectorSection'
import styles from './CreativeColorControls.module.css'

interface Props {
  edits: EditController
  previewReady: boolean
  selection: CreativeColorSelection
  onSelectionChange: (selection: CreativeColorSelection) => void
}
const title = (id: string) => id[0].toUpperCase() + id.slice(1)

export function ColorMixerControls({ edits, previewReady, selection, onSelectionChange }: Props) {
  const mixer = edits.adjustments.colorMixer ?? neutralColorMixer,
    selected = selection.range,
    unavailable = !edits.state || !previewReady,
    disabled = unavailable || edits.saving,
    commit = () => void edits.flush().catch(() => undefined),
    change = (key: keyof ColorRangeAmounts, value: number) =>
      void edits.change({
        colorMixer: {
          ...mixer,
          ranges: { ...mixer.ranges, [selected]: { ...mixer.ranges[selected], [key]: value } },
        },
      })
  return (
    <>
      <div className={styles.ranges} role="group" aria-label="Color mixer range">
        {colorRangeIds.map((id) => (
          <button
            type="button"
            key={id}
            style={
              {
                '--range-color': {
                  red: '#d77b77',
                  orange: '#d7a071',
                  yellow: '#d3c36c',
                  green: '#85b27b',
                  aqua: '#75b9b5',
                  blue: '#849fd3',
                  purple: '#ae8bcb',
                  magenta: '#ca8fb9',
                }[id],
              } as CSSProperties
            }
            aria-pressed={selected === id}
            onClick={() => {
              void edits
                .flush()
                .then(() => onSelectionChange({ ...selection, range: id }))
                .catch(() => undefined)
            }}
          >
            <span className={styles.swatch} aria-hidden="true" />
            {title(id)}
          </button>
        ))}
      </div>
      {(['hue', 'saturation', 'luminance'] as const).map((key) => (
        <AdjustmentInput
          key={`${edits.state?.photoId ?? 'empty'}-${selected}-${key}`}
          label={title(key)}
          value={mixer.ranges[selected][key]}
          {...capabilities.colorMixer.parameters[key]}
          unit={undefined}
          resetKey={edits.state?.revision}
          disabled={unavailable}
          busy={edits.saving}
          onChange={(value) => change(key, value)}
          onCommit={commit}
          onCancel={edits.cancel}
        />
      ))}
      <p className={styles.help}>
        Hue shifts up to 30°. Luminance adjusts up to one stop. Neighboring ranges blend smoothly.
      </p>
      <button
        type="button"
        className={styles.reset}
        disabled={disabled}
        onClick={() => {
          void edits.change({ colorMixer: neutralColorMixer }).then(commit)
        }}
      >
        <RotateCcw size={12} aria-hidden="true" />
        Reset color mixer
      </button>
    </>
  )
}
export function ColorGradingControls({
  edits,
  previewReady,
  selection,
  onSelectionChange,
  expanded,
  onToggle,
  blendingExpanded,
  onBlendingToggle,
}: Props & {
  expanded: boolean
  onToggle: () => void
  blendingExpanded: boolean
  onBlendingToggle: () => void
}) {
  const grade = edits.adjustments.colorGrading ?? neutralColorGrading,
    selected = selection.tone,
    unavailable = !edits.state || !previewReady,
    disabled = unavailable || edits.saving,
    commit = () => void edits.flush().catch(() => undefined),
    changeTone = (value: Partial<GradingTone>) =>
      void edits.change({
        colorGrading: {
          ...grade,
          tones: { ...grade.tones, [selected]: { ...grade.tones[selected], ...value } },
        },
      })
  return (
    <>
      <InspectorSection
        id="color-grading-controls"
        title="Color Grading"
        heading="Color grading"
        expanded={expanded}
        onToggle={onToggle}
      >
        <div className={styles.tones} role="group" aria-label="Color grading tone">
          {gradingToneIds.map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={selected === id}
              onClick={() => {
                void edits
                  .flush()
                  .then(() => onSelectionChange({ ...selection, tone: id }))
                  .catch(() => undefined)
              }}
            >
              {title(id)}
            </button>
          ))}
        </div>
        <GradingWheel
          key={`${edits.state?.photoId ?? 'empty'}-${selected}`}
          label={title(selected)}
          value={grade.tones[selected]}
          disabled={disabled}
          resetKey={edits.state?.revision}
          onChange={changeTone}
          onCommit={commit}
          onCancel={edits.cancel}
        />
        <p className={styles.help}>Set the tint with Hue and Saturation.</p>
        {(['hue', 'saturation', 'luminance'] as const).map((key) => (
          <AdjustmentInput
            key={`${edits.state?.photoId ?? 'empty'}-${selected}-${key}`}
            label={title(key)}
            value={grade.tones[selected][key]}
            {...capabilities.colorGrading.parameters[key]}
            unit={key === 'hue' ? '°' : undefined}
            resetKey={edits.state?.revision}
            disabled={unavailable}
            busy={edits.saving}
            onChange={(value) => changeTone({ [key]: value })}
            onCommit={commit}
            onCancel={edits.cancel}
          />
        ))}
        <button
          type="button"
          className={styles.reset}
          disabled={disabled}
          onClick={() => {
            void edits.change({ colorGrading: neutralColorGrading }).then(commit)
          }}
        >
          <RotateCcw size={12} aria-hidden="true" />
          Reset color grading
        </button>
      </InspectorSection>
      <InspectorSection
        id="tone-blending-controls"
        title="Tone blending"
        expanded={blendingExpanded}
        onToggle={onBlendingToggle}
      >
        {(['blending', 'balance'] as const).map((key) => (
          <AdjustmentInput
            key={`${edits.state?.photoId ?? 'empty'}-${key}`}
            label={title(key)}
            value={grade[key]}
            {...capabilities.colorGrading.parameters[key]}
            unit={undefined}
            resetKey={edits.state?.revision}
            disabled={unavailable}
            busy={edits.saving}
            onChange={(value) => void edits.change({ colorGrading: { ...grade, [key]: value } })}
            onCommit={commit}
            onCancel={edits.cancel}
          />
        ))}
        <p className={styles.help}>
          Blending widens tonal transitions. Balance shifts the grade toward shadows or highlights.
          Zero saturation keeps the chosen hue for later.
        </p>
      </InspectorSection>
    </>
  )
}
