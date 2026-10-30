import { AdjustmentInput } from './AdjustmentInput'
import type { EditController } from '../hooks/useEdits'
import styles from '../App.module.css'
export function WhiteBalance({
  edits,
  previewReady,
}: {
  edits: EditController
  previewReady: boolean
}) {
  const profile = edits.state?.whiteBalanceProfile
  const wb = edits.adjustments.whiteBalance
  const value = wb?.mode === 'custom' ? wb : (profile?.estimate ?? { kelvin: 6500, tint: 0 })
  const unavailable = !profile || !previewReady
  return (
    <>
      <button
        disabled={unavailable || edits.saving || wb?.mode !== 'custom'}
        onClick={() =>
          void edits
            .change({ whiteBalance: { mode: 'as-shot' } })
            .then(() => edits.flush())
            .catch(() => undefined)
        }
      >
        {edits.state?.referenceWhiteBalance ? 'Reference white balance' : 'As Shot'}
      </button>
      <p className={styles.demoNote}>
        {!profile
          ? 'White balance is unavailable for this photo. Verified Sony ZV-1/ZV-1A RAW required.'
          : wb?.mode === 'custom'
            ? 'Custom · Irodori temperature model'
            : edits.state?.referenceWhiteBalance
              ? 'Reference-based reset · estimated Kelvin and Tint'
              : 'As Shot · estimated Kelvin and Tint'}
      </p>
      <AdjustmentInput
        key={`${edits.state?.photoId}-temperature`}
        label="Temperature"
        unit="K"
        value={value.kelvin}
        min={2000}
        max={25000}
        step={50}
        precision={0}
        resetKey={edits.state?.revision}
        disabled={unavailable}
        busy={edits.saving}
        onChange={(kelvin) =>
          void edits.change({ whiteBalance: { mode: 'custom', kelvin, tint: value.tint } })
        }
        onCommit={() => void edits.flush().catch(() => undefined)}
        onCancel={edits.cancel}
      />
      <AdjustmentInput
        key={`${edits.state?.photoId}-tint`}
        label="Tint"
        value={value.tint}
        min={-100}
        max={100}
        step={1}
        precision={0}
        resetKey={edits.state?.revision}
        disabled={unavailable}
        busy={edits.saving}
        onChange={(tint) =>
          void edits.change({ whiteBalance: { mode: 'custom', kelvin: value.kelvin, tint } })
        }
        onCommit={() => void edits.flush().catch(() => undefined)}
        onCancel={edits.cancel}
      />
    </>
  )
}
