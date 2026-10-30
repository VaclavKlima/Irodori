import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  defaultEditTransferGroups,
  editTransferGroups,
  type EditClipboard,
  type EditPastePreparation,
  type EditTransferGroup,
} from '../../../shared/edit-transfer'
import styles from './ExportDialog.module.css'

export function PasteEditsDialog({
  ids,
  onClose,
  onStarted,
}: {
  ids: string[]
  onClose: () => void
  onStarted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [clipboard, setClipboard] = useState<EditClipboard | null>(null)
  const [groups, setGroups] = useState<EditTransferGroup[]>([...defaultEditTransferGroups])
  const [prepared, setPrepared] = useState<EditPastePreparation | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    dialog.current?.showModal()
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
  }, [])
  useEffect(() => {
    if (!clipboard) return
    let current = true
    if (!groups.length) return
    const pending = window.irodori.preparePasteEdits({
      clipboardId: clipboard.id,
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
      void pending.then((value) => window.irodori.disposePastePreparation(value.id)).catch(() => {})
    }
  }, [clipboard, ids, groups])
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
      await window.irodori.startPasteEdits(prepared.id)
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
        <h2 id="paste-edits-title">Paste edits</h2>
        <button type="button" aria-label="Close paste edits" disabled={applying} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className={styles.body} aria-busy={loading || applying}>
        {clipboard && <p className={styles.summary}>From {clipboard.filename}</p>}
        <p>
          {ids.length === 1
            ? 'Apply to this photo.'
            : `Apply to ${ids.length} selected photos, including hidden selections.`}
        </p>
        <p>
          Choose the settings to replace. Each changed photo gets one Undo step. Originals stay
          unchanged.
        </p>
        <div className={styles.form} role="group" aria-label="Settings to paste">
          {editTransferGroups.map((group) => (
            <label key={group.id} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={groups.includes(group.id)}
                disabled={applying || loading || !clipboard?.groups.includes(group.id)}
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
        <p>
          Crop, white balance and lens corrections are excluded by default. Camera-dependent
          settings require compatible photos.
        </p>
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
          <button type="button" disabled={applying} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!prepared || !eligible || loading || applying}
            onClick={() => void apply()}
          >
            {applying ? 'Starting…' : 'Apply edits'}
          </button>
        </div>
      </footer>
    </dialog>
  )
}
