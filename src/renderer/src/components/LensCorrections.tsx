import { useEffect, useRef, useState } from 'react'
import { Aperture } from 'lucide-react'
import { InspectorSection } from './InspectorSection'
import { correctionKinds, type CorrectionKind, type LensState } from '../../../shared/lens'
import styles from '../App.module.css'

const labels: Record<CorrectionKind, string> = {
  distortion: 'Distortion',
  vignetting: 'Vignetting',
  chromaticAberration: 'Lateral chromatic aberration',
}

export function LensCorrections({
  photoId,
  flushEdits,
  expanded,
  onToggle,
  suspended = false,
}: {
  photoId: string
  flushEdits: () => Promise<void>
  expanded: boolean
  onToggle: () => void
  suspended?: boolean
}) {
  const [state, setState] = useState<LensState | null>(null)
  const [error, setError] = useState('')
  const pending = useRef(0)
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (suspended) return
      void window.irodori
        .getLensSettings(photoId)
        .then((next) => {
          if (active && pending.current === 0)
            setState((previous) =>
              !previous || next.revision >= previous.revision ? next : previous,
            )
        })
        .catch((error: unknown) => {
          if (active) setError(String(error))
        })
    }
    refresh()
    const unsubscribe = window.irodori.onLibraryEvent((event) => {
      if (event.lensChanged?.photoId === photoId) refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [photoId, suspended])
  const update = async (kind: CorrectionKind, enabled: boolean) => {
    setError('')
    pending.current++
    setState((previous) =>
      previous ? { ...previous, settings: { ...previous.settings, [kind]: enabled } } : previous,
    )
    try {
      await flushEdits()
      await window.irodori.updateLensSettings(photoId, kind, enabled)
    } catch (error) {
      setError(String(error))
    } finally {
      pending.current--
      if (pending.current === 0) {
        try {
          const next = await window.irodori.getLensSettings(photoId)
          if (pending.current === 0)
            setState((previous) =>
              !previous || next.revision >= previous.revision ? next : previous,
            )
        } catch (error) {
          setError(String(error))
        }
      }
    }
  }

  return (
    <InspectorSection
      id="lens-controls"
      title="Lens corrections"
      icon={Aperture}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div data-testid="lens-corrections" data-revision={state?.revision}>
        <p className={styles.lensProfile}>{state?.profile.label ?? 'Reading lens metadata…'}</p>
        {state?.fixed && (
          <p>Lens corrections were applied during merge preparation and are fixed.</p>
        )}
        {correctionKinds.map((kind) => (
          <div key={kind} className={styles.lensCorrection}>
            <label>
              <input
                type="checkbox"
                checked={!!state?.profile[kind] && (state.fixed || !!state.settings[kind])}
                disabled={suspended || state?.fixed || !state?.profile[kind]}
                aria-describedby={!state?.profile[kind] ? `lens-${kind}-reason` : undefined}
                onChange={(event) => void update(kind, event.target.checked)}
              />
              {labels[kind]}
            </label>
            {state?.profile.unavailable[kind] && (
              <p id={`lens-${kind}-reason`}>{state.profile.unavailable[kind]}</p>
            )}
          </div>
        ))}
        {error && <p role="alert">{error}</p>}
      </div>
    </InspectorSection>
  )
}
