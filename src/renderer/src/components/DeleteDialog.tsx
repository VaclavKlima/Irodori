import { useEffect, useRef, useState } from 'react'
import type { PhotoReference } from '../../../shared/contracts'
import styles from './PhotoActions.module.css'

export function DeleteDialog({
  photos,
  onClose,
  onStarted,
}: {
  photos: readonly PhotoReference[]
  onClose: () => void
  onStarted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
    cancel.current?.focus()
  }, [])
  function close() {
    if (!pending) {
      dialog.current?.close()
      onClose()
    }
  }
  async function confirm() {
    if (pending) return
    setPending(true)
    try {
      await window.luma.deletePhotos(photos.map((photo) => photo.id))
      dialog.current?.close()
      onStarted()
    } catch (error) {
      setError(String(error))
      setPending(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="delete-title"
      aria-describedby="delete-description"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <h2 id="delete-title">
        {photos.length === 1 ? 'Move photo to Trash?' : `Move ${photos.length} photos to Trash?`}
      </h2>
      <p id="delete-description">
        Luma’s internal copies will move to system Trash. Your source files and SD card will stay
        untouched.
      </p>
      <p>
        Merged results remain usable after source deletion, but reproducing their merge requires the
        original source bytes.
      </p>
      <ul className={styles.targets} tabIndex={0} aria-label="Photos to move to Trash">
        {photos.map((photo) => (
          <li key={photo.id}>{photo.filename}</li>
        ))}
      </ul>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <footer>
        <button ref={cancel} disabled={pending} onClick={close}>
          Cancel
        </button>
        <button className={styles.destructive} disabled={pending} onClick={() => void confirm()}>
          {pending ? 'Starting…' : 'Move to Trash'}
        </button>
      </footer>
    </dialog>
  )
}
