import { useState } from 'react'
import { Pipette } from 'lucide-react'
import type { WhiteBalancePickerController } from '../hooks/useWhiteBalancePicker'
import {
  whiteBalanceSampleSizes,
  type WhiteBalanceSampleFailure,
} from '../../../shared/white-balance-picker'
import { AdjustmentInput } from './AdjustmentInput'
import styles from './WhiteBalancePicker.module.css'

const failure: Record<WhiteBalanceSampleFailure, string> = {
  'unsupported-source': 'Choose a supported single RAW capture.',
  'source-limits-unavailable': 'Verified source limits are unavailable for this photo.',
  dark: 'This area is too dark. Choose a brighter neutral midtone.',
  clipped: 'This area is too bright or clipped. Choose a neutral midtone.',
  'insufficient-coverage': 'Too few usable pixels. Choose a larger, opaque neutral area.',
  'uneven-sample': 'This area has uneven color. Choose an evenly lit neutral area.',
  'out-of-model':
    'This sample cannot be neutralized within the supported temperature and tint range.',
}
function SampleCoordinate({
  label,
  value,
  disabled,
  change,
}: {
  label: string
  value: number
  disabled: boolean
  change: (value: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  return (
    <AdjustmentInput
      label={label}
      value={draft ?? value * 100}
      min={0}
      max={100}
      step={0.01}
      precision={2}
      unit="%"
      resetKey={value}
      disabled={disabled}
      onChange={setDraft}
      onCommit={() => {
        if (draft !== null) change(draft / 100)
        setDraft(null)
      }}
      onCancel={() => setDraft(null)}
    />
  )
}
export function WhiteBalancePicker({ picker }: { picker: WhiteBalancePickerController }) {
  const proposal = picker.proposal
  return (
    <div className={styles.picker}>
      <button
        type="button"
        disabled={!picker.supported || picker.pending}
        aria-pressed={picker.active}
        title={
          picker.supported
            ? 'Sample a known neutral area before creative edits'
            : 'Requires a supported single RAW capture'
        }
        onClick={() =>
          picker.active ? picker.cancel() : void picker.start().catch(() => undefined)
        }
      >
        <Pipette size={13} aria-hidden="true" /> Neutral white balance
      </button>
      {picker.active && (
        <div
          className={styles.controls}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              picker.cancel()
            }
          }}
        >
          <p>Choose an evenly lit neutral midtone. Click the photo or set its position below.</p>
          <div className={styles.sizes} role="group" aria-label="White-balance sample area">
            {whiteBalanceSampleSizes.map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={picker.sample.diameter === size}
                disabled={picker.pending}
                onClick={() => picker.updateSample({ diameter: size })}
                aria-label={`Sample size ${size} pixels`}
              >
                {size} × {size}
              </button>
            ))}
          </div>
          <SampleCoordinate
            label="Sample X"
            value={picker.sample.x}
            disabled={picker.pending}
            change={(x) => picker.updateSample({ x })}
          />
          <SampleCoordinate
            label="Sample Y"
            value={picker.sample.y}
            disabled={picker.pending}
            change={(y) => picker.updateSample({ y })}
          />
          <p role="status" aria-live="polite">
            {picker.pending
              ? 'Preparing neutral sample…'
              : picker.error ||
                (proposal?.status === 'invalid'
                  ? failure[proposal.reason]
                  : proposal?.status === 'valid'
                    ? `${proposal.settings.kelvin} K · Tint ${proposal.settings.tint} · ${proposal.accepted}/${proposal.total} pixels`
                    : 'Sample an area to preview a proposal.')}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={picker.pending}
              onClick={() => void picker.requestSample()}
            >
              Sample neutral area
            </button>
            <button
              type="button"
              disabled={picker.pending || proposal?.status !== 'valid'}
              onClick={() => void picker.apply()}
            >
              Apply white balance
            </button>
            <button type="button" onClick={picker.cancel}>
              Cancel picker
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
