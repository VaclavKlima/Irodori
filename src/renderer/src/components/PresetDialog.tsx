import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/Controls'
import {
  defaultEditTransferGroups,
  editTransferGroups,
  type EditTransferGroup,
} from '../../../shared/edit-transfer'
import type { EditingPreset } from '../../../shared/presets'
import styles from './ExportDialog.module.css'
import dialogStyles from './PresetDialog.module.css'
import { DEFAULT_PRESET_APPEARANCE, type PresetAppearance } from '../../../shared/preset-appearance'
import { PresetAppearancePicker } from './PresetAppearancePicker'

export type PresetDialogAction =
  | { mode: 'new'; photoId: string }
  | { mode: 'update'; photoId: string; preset: EditingPreset }
  | { mode: 'details' | 'delete'; preset: EditingPreset }

export function PresetDialog({
  action,
  onClose,
  onSaved,
}: {
  action: PresetDialogAction
  onClose: () => void
  onSaved: (preset: EditingPreset | null) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    nameInput = useRef<HTMLInputElement>(null)
  const preset = 'preset' in action ? action.preset : undefined
  const [name, setName] = useState(preset?.name ?? '')
  const [appearance, setAppearance] = useState<PresetAppearance>(
    preset?.appearance ?? { ...DEFAULT_PRESET_APPEARANCE },
  )
  const [groups, setGroups] = useState<EditTransferGroup[]>(
    preset?.definition.groups ?? [...defaultEditTransferGroups],
  )
  const [available, setAvailable] = useState<EditTransferGroup[]>([])
  const [loading, setLoading] = useState('photoId' in action)
  const [saving, setSaving] = useState(false),
    [error, setError] = useState('')
  const photoId = 'photoId' in action ? action.photoId : null
  useEffect(() => {
    dialog.current?.showModal()
    if (action.mode === 'delete') cancel.current?.focus()
    else {
      nameInput.current?.focus()
      nameInput.current?.select()
    }
  }, [action.mode])
  useEffect(() => {
    if (!photoId) return
    let current = true
    void Promise.all([window.irodori.getEdits(photoId), window.irodori.getLensSettings(photoId)])
      .then(([edits, lens]) => {
        if (!current) return
        const allowed = editTransferGroups
          .filter((g) =>
            g.id === 'white-balance'
              ? !!edits.whiteBalanceProfile && !edits.referenceWhiteBalance && !edits.hdrJpeg
              : g.id === 'lens'
                ? !lens.fixed && Object.values(lens.profile).some(Boolean)
                : true,
          )
          .map((g) => g.id)
        setAvailable(allowed)
        setGroups((groups) => groups.filter((group) => allowed.includes(group)))
      })
      .catch((error) => {
        if (current) setError(String(error))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [photoId])
  async function save() {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      if (action.mode === 'delete') {
        await window.irodori.deletePreset({
          presetId: action.preset.id,
          expectedPresetRevision: action.preset.revision,
        })
        onSaved(null)
      } else if (action.mode === 'details') {
        onSaved(
          await window.irodori.updatePreset({
            presetId: action.preset.id,
            expectedPresetRevision: action.preset.revision,
            name,
            appearance,
          }),
        )
      } else {
        const source = { mode: 'photo' as const, photoId: photoId!, groups }
        onSaved(
          action.mode === 'new'
            ? await window.irodori.createPreset({ name, source, appearance })
            : await window.irodori.updatePreset({
                presetId: action.preset.id,
                expectedPresetRevision: action.preset.revision,
                name,
                source,
                appearance,
              }),
        )
      }
      onClose()
    } catch (error) {
      setError(String(error))
      setSaving(false)
    }
  }
  const title =
    action.mode === 'new'
      ? 'New preset'
      : action.mode === 'update'
        ? 'Update preset'
        : action.mode === 'details'
          ? 'Edit preset details'
          : 'Delete preset'
  return (
    <dialog
      ref={dialog}
      className={`${styles.dialog} ${dialogStyles.dialog}`}
      aria-labelledby="preset-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
    >
      <form
        className={dialogStyles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <header>
          <h2 id="preset-dialog-title">{title}</h2>
        </header>
        <div className={`${styles.body} ${dialogStyles.body}`} aria-busy={loading || saving}>
          {action.mode === 'delete' ? (
            <p>Delete “{preset!.name}”? Applied photo edits and accepted tasks are retained.</p>
          ) : (
            <div className={styles.form}>
              <label>
                Name
                <input
                  ref={nameInput}
                  aria-label="Preset name"
                  value={name}
                  maxLength={100}
                  required
                  disabled={saving}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>
          )}
          {action.mode !== 'delete' && (
            <PresetAppearancePicker
              value={appearance}
              name={name}
              disabled={saving}
              onChange={setAppearance}
            />
          )}
          {photoId && (
            <>
              <p>
                Save confirmed settings from the current photo. Choose the complete groups to
                include.
              </p>
              <div className={styles.form} role="group" aria-label="Included preset settings">
                {editTransferGroups.map((group) => (
                  <label key={group.id} className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={groups.includes(group.id)}
                      disabled={loading || saving || !available.includes(group.id)}
                      onChange={(event) =>
                        setGroups(
                          event.target.checked
                            ? [...groups, group.id]
                            : groups.filter((id) => id !== group.id),
                        )
                      }
                    />
                    {group.label}
                  </label>
                ))}
              </div>
              <p>
                Crop, white balance and lens corrections require an explicit choice.
                Camera-dependent groups need compatible photographs.
              </p>
            </>
          )}
          {loading && <p role="status">Reading available settings…</p>}
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
              disabled={
                saving ||
                loading ||
                (action.mode !== 'delete' && !name.trim()) ||
                (!!photoId && !groups.length)
              }
            >
              {saving ? 'Saving…' : action.mode === 'delete' ? 'Delete preset' : 'Save preset'}
            </Button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}
