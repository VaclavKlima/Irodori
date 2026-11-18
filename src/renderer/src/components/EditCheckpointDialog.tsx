import { useEffect, useRef, useState } from 'react'
import type { EditCheckpoint } from '../../../shared/edit-checkpoints'
import type { EditCheckpointsController } from '../hooks/useEditCheckpoints'
import { Button } from './ui/Controls'
import styles from './ExportDialog.module.css'
import dialogStyles from './PresetDialog.module.css'

export type EditCheckpointDialogAction =
  { mode: 'new' } | { mode: 'rename' | 'delete'; checkpoint: EditCheckpoint }

export function EditCheckpointDialog({
  action,
  checkpoints,
  onClose,
  onSaved,
}: {
  action: EditCheckpointDialogAction
  checkpoints: EditCheckpointsController
  onClose: () => void
  onSaved: (checkpoint: EditCheckpoint | null) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selected = 'checkpoint' in action ? action.checkpoint : null
  const [name, setName] = useState(selected?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const origin = document.activeElement
    dialog.current?.showModal()
    if (action.mode === 'delete') cancel.current?.focus()
    else {
      input.current?.focus()
      input.current?.select()
    }
    return () => {
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus()
    }
  }, [action.mode])
  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      if (action.mode === 'new') onSaved(await checkpoints.save(name))
      else {
        const request = {
          photoId: action.checkpoint.photoId,
          checkpointId: action.checkpoint.id,
          expectedCheckpointRevision: action.checkpoint.revision,
        }
        if (action.mode === 'delete') {
          await window.irodori.deleteEditCheckpoint(request)
          onSaved(null)
        } else onSaved(await window.irodori.renameEditCheckpoint({ ...request, name }))
      }
      onClose()
    } catch (error) {
      setError(String(error))
      setSaving(false)
    }
  }
  const title =
    action.mode === 'new'
      ? 'Save checkpoint'
      : action.mode === 'rename'
        ? 'Rename checkpoint'
        : 'Delete checkpoint'
  return (
    <dialog
      ref={dialog}
      className={`${styles.dialog} ${dialogStyles.dialog}`}
      aria-labelledby="checkpoint-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
    >
      <form
        className={dialogStyles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <header>
          <h2 id="checkpoint-dialog-title">{title}</h2>
        </header>
        <div className={`${styles.body} ${dialogStyles.body}`} aria-busy={saving}>
          {action.mode === 'delete' ? (
            <p>Delete “{selected!.name}”? Current edits and Undo/Redo history are retained.</p>
          ) : (
            <>
              <div className={styles.form}>
                <label>
                  Name
                  <input
                    ref={input}
                    aria-label="Checkpoint name"
                    value={name}
                    maxLength={100}
                    required
                    readOnly={saving}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              </div>
              <p>
                {action.mode === 'new'
                  ? 'Save all confirmed edits, including framing and local masks, for this photograph.'
                  : 'Renaming preserves every saved setting.'}
              </p>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer>
          <span />
          <div>
            <Button ref={cancel} disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action.mode === 'delete' ? 'danger' : 'primary'}
              disabled={saving || (action.mode !== 'delete' && !name.trim())}
            >
              {saving ? 'Saving…' : title}
            </Button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
