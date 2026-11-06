import { Button } from './ui/Controls'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  defaultEditTransferGroups,
  editTransferGroups,
  type EditClipboard,
  type EditTransferGroup,
} from '../../../shared/edit-transfer'
import styles from './ExportDialog.module.css'
import type { EditingPreset } from '../../../shared/presets'
import type { EditApplicationPreparation } from '../../../shared/edit-transfer'

export function PasteEditsDialog({
  ids,
  onClose,
  onStarted,
  preset,
}: {
  ids: string[]
  onClose: () => void
  onStarted: () => void
  preset?: EditingPreset
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [clipboard, setClipboard] = useState<EditClipboard | null>(null)
  const [groups, setGroups] = useState<EditTransferGroup[]>(
    preset?.definition.groups ?? [...defaultEditTransferGroups],
  )
  const [prepared, setPrepared] = useState<EditApplicationPreparation | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    dialog.current?.showModal()
    if (preset) return
    void window.irodori
      .getEditClipboard()
      .then((value) => {
        if (!current) return
        if (!value) {
          setError('Copy edits from a photo first.')
          setLoading(false)
        }
        setClipboard(value)
      })
      .catch((error) => {
        if (current) {
          setError(String(error))
          setLoading(false)
        }
      })
    return () => {
      current = false
    }
  }, [preset])
  useEffect(() => {
    if (!clipboard && !preset) return
    let current = true
    if (!groups.length) return
    const pending = preset
      ? window.irodori.preparePresetApplication({
          presetId: preset.id,
          expectedPresetRevision: preset.revision,
          photoIds: ids,
        })
      : window.irodori.preparePasteEdits({
          clipboardId: clipboard!.id,
          photoIds: ids,
          groups,
        })
    void pending
      .then((value) => {
        if (current) setPrepared(value)
      })
      .catch((error) => {
        if (current) setError(String(error))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
      void pending
        .then((value) =>
          preset
            ? window.irodori.disposePresetPreparation(value.id)
            : window.irodori.disposePastePreparation(value.id),
        )
        .catch(() => {})
    }
  }, [clipboard, ids, groups, preset])
  const unavailable = prepared?.targets.filter((target) => target.unavailable).length ?? 0
  const eligible = prepared ? prepared.targets.length - unavailable : 0
  const reasons = [
    ...new Set(
      prepared?.targets.flatMap((target) => (target.unavailable ? [target.unavailable] : [])) ?? [],
    ),
  ]
  async function apply() {
    if (!prepared || applying || !eligible) return
    setApplying(true)
    setError('')
    try {
      if (preset) await window.irodori.startPresetApplication(prepared.id)
      else await window.irodori.startPasteEdits(prepared.id)
      onStarted()
      onClose()
    } catch (error) {
      setError(String(error))
      setApplying(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="paste-edits-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!applying) onClose()
      }}
    >
      <header>
        <h2 id="paste-edits-title">{preset ? 'Apply preset' : 'Paste edits'}</h2>
        <Button
          type="button"
          aria-label={preset ? 'Close apply preset' : 'Close paste edits'}
          disabled={applying}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <div className={styles.body} aria-busy={loading || applying}>
        {clipboard && <p className={styles.summary}>From {clipboard.filename}</p>}
        {preset && (
          <p className={styles.summary}>
            {preset.name} · Revision {preset.revision}
          </p>
        )}
        <p>
          {ids.length === 1
            ? 'Apply to this photo.'
            : `Apply to ${ids.length} selected photos, including hidden selections.`}
        </p>
        <p>
          {preset
            ? 'The included groups replace the current values.'
            : 'Choose the settings to replace.'}{' '}
          Each changed photo gets one Undo step. Originals stay unchanged.
        </p>
        <div className={styles.form} role="group" aria-label="Settings to paste">
          {editTransferGroups.map((group) => (
            <label key={group.id} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={groups.includes(group.id)}
                disabled={!!preset || applying || loading || !clipboard?.groups.includes(group.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...groups, group.id]
                    : groups.filter((id) => id !== group.id)
                  setPrepared(null)
                  setError('')
                  setLoading(next.length > 0)
                  setGroups(next)
                }}
              />
              {group.label}
            </label>
          ))}
        </div>
        {!preset && (
          <p>
            Crop, white balance and lens corrections are excluded by default. Camera-dependent
            settings require compatible photos.
          </p>
        )}
        {loading && <p role="status">Checking selected photos…</p>}
        {!groups.length && <p role="status">Choose at least one setting group.</p>}
        {prepared && (
          <p role="status">
            {eligible} ready · {unavailable} unavailable
          </p>
        )}
        {reasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
        {unavailable > 0 && <p>Unavailable photos will be skipped and listed in task details.</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <span />
        <div>
          <Button type="button" disabled={applying} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={!prepared || !eligible || loading || applying}
            onClick={() => void apply()}
          >
            {applying ? 'Starting…' : 'Apply edits'}
          </Button>
        </div>
      </footer>
    </dialog>
  )
}
