import { useLayoutEffect, useRef } from 'react'
import { Trash2, Layers } from 'lucide-react'
import { groupMergeUnavailable, mergeUnavailable, type MergeMode } from '../../../shared/merge'
import type { StackSnapshot } from '../../../shared/stacks'
import type { PhotoReference } from '../../../shared/contracts'
import styles from './PhotoActions.module.css'

export function PhotoContextMenu({
  x,
  y,
  selection,
  photo,
  snapshot,
  onDelete,
  onDeletePhoto,
  onMerge,
  onGroupAction,
  onClose,
  canGroup,
  busy,
  pending,
  onStackAction,
}: {
  x: number
  y: number
  selection: readonly PhotoReference[]
  photo: PhotoReference | null
  snapshot: StackSnapshot | null
  onDelete: () => void
  onDeletePhoto: () => void
  onMerge: (mode: MergeMode) => void
  onGroupAction: (action: 'delete' | MergeMode) => void
  onClose: (restoreFocus?: boolean) => void
  canGroup: boolean
  busy: boolean
  pending: boolean
  onStackAction: (action: 'group' | 'ungroup' | 'remove' | 'cover' | 'select' | 'scan') => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const count = selection.length
  const stack = snapshot?.stack
  const originals = snapshot?.photos.filter((photo) => photo.assetKind !== 'derived') ?? []
  const selectionMergeReason = mergeUnavailable(count)
  const groupMergeReason = groupMergeUnavailable(originals)
  const organizationReason = busy ? 'Finish the current library task first.' : undefined
  const groupSelectionReason =
    organizationReason ?? (!canGroup ? 'Select at least two ungrouped photos.' : undefined)
  const coverReason =
    organizationReason ??
    (photo?.id === stack?.coverId ? 'This photo is already the group cover.' : undefined)
  const showPhotoDelete = photo && (count !== 1 || selection[0].id !== photo.id)
  useLayoutEffect(() => {
    const element = menu.current!
    const box = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`
    element.querySelector<HTMLButtonElement>('[data-delete-action]')?.focus()
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) onClose(false)
    }
    const resize = () => onClose(true)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
    }
  }, [x, y, onClose])
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Photo actions"
      aria-busy={pending}
      className={styles.menu}
      style={{ left: x, top: y }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLButtonElement)
          event.target.scrollIntoView({ block: 'nearest' })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          onClose(true)
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const buttons = Array.from(menu.current?.querySelectorAll('button') ?? [])
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
          ]?.focus()
        }
      }}
    >
      {photo && (stack || showPhotoDelete) && (
        <div role="group" aria-labelledby="photo-actions-label" className={styles.section}>
          <h2 id="photo-actions-label">Photo</h2>
          {stack && (
            <>
              <button
                role="menuitem"
                aria-disabled={pending || !!coverReason}
                title={coverReason}
                aria-describedby={coverReason ? 'cover-unavailable' : undefined}
                onClick={() => {
                  if (!pending && !coverReason) onStackAction('cover')
                }}
              >
                Set this photo as group cover
              </button>
              {coverReason && <p id="cover-unavailable">{coverReason}</p>}
              <button
                role="menuitem"
                aria-disabled={pending || busy}
                title={organizationReason}
                aria-describedby={busy ? 'organization-unavailable' : undefined}
                onClick={() => {
                  if (!pending && !busy) onStackAction('remove')
                }}
              >
                Remove this photo from group
              </button>
            </>
          )}
          {showPhotoDelete && (
            <button
              role="menuitem"
              aria-disabled={pending}
              onClick={() => {
                if (!pending) onDeletePhoto()
              }}
            >
              <Trash2 size={14} />
              Delete this photo…
            </button>
          )}
        </div>
      )}
      <div role="group" aria-labelledby="selection-actions-label" className={styles.section}>
        <h2 id="selection-actions-label">Selected photos ({count})</h2>
        {(['hdr', 'noise'] as const).map((mode) => (
          <button
            key={mode}
            role="menuitem"
            aria-disabled={pending || !!selectionMergeReason}
            title={selectionMergeReason}
            aria-describedby={selectionMergeReason ? 'selection-merge-unavailable' : undefined}
            onClick={() => {
              if (!pending && !selectionMergeReason) onMerge(mode)
            }}
          >
            <Layers size={14} />
            {mode === 'hdr' ? 'Merge to HDR…' : 'Stack for noise reduction…'}
          </button>
        ))}
        {selectionMergeReason && <p id="selection-merge-unavailable">{selectionMergeReason}</p>}
        <button
          role="menuitem"
          aria-disabled={pending || !!groupSelectionReason}
          title={groupSelectionReason}
          aria-describedby={groupSelectionReason ? 'group-selection-unavailable' : undefined}
          onClick={() => {
            if (!pending && !groupSelectionReason) onStackAction('group')
          }}
        >
          <Layers size={14} />
          Group selected photos
        </button>
        {groupSelectionReason && <p id="group-selection-unavailable">{groupSelectionReason}</p>}
        <button
          data-delete-action
          role="menuitem"
          aria-disabled={pending || count === 0}
          onClick={() => {
            if (!pending && count) onDelete()
          }}
        >
          <Trash2 size={14} />
          {count === 1 ? 'Delete photo…' : `Delete ${count} photos…`}
          <kbd>Del</kbd>
        </button>
      </div>
      {stack && (
        <div role="group" aria-labelledby="group-actions-label" className={styles.section}>
          <h2 id="group-actions-label">Group ({stack.count} photos)</h2>
          <p>
            {originals.length} {originals.length === 1 ? 'original' : 'originals'}
          </p>
          <button
            role="menuitem"
            aria-disabled={pending}
            onClick={() => {
              if (!pending) onStackAction('select')
            }}
          >
            <Layers size={14} />
            Select group ({stack.count} photos)
          </button>
          {(['hdr', 'noise'] as const).map((mode) => (
            <button
              key={mode}
              role="menuitem"
              aria-disabled={pending || !!groupMergeReason}
              title={groupMergeReason}
              aria-describedby={groupMergeReason ? 'group-merge-unavailable' : undefined}
              onClick={() => {
                if (!pending && !groupMergeReason) onGroupAction(mode)
              }}
            >
              <Layers size={14} />
              {mode === 'hdr'
                ? `Merge ${originals.length} group originals to HDR…`
                : `Stack ${originals.length} group originals for noise reduction…`}
            </button>
          ))}
          {groupMergeReason && <p id="group-merge-unavailable">{groupMergeReason}</p>}
          <button
            role="menuitem"
            aria-disabled={pending || busy}
            title={organizationReason}
            aria-describedby={busy ? 'organization-unavailable' : undefined}
            onClick={() => {
              if (!pending && !busy) onStackAction('ungroup')
            }}
          >
            Ungroup ({stack.count} photos)
          </button>
          <button
            role="menuitem"
            aria-disabled={pending}
            onClick={() => {
              if (!pending) onGroupAction('delete')
            }}
          >
            <Trash2 size={14} />
            Delete group ({stack.count} photos)…
          </button>
        </div>
      )}
      <div className={styles.section}>
        <button
          role="menuitem"
          aria-disabled={pending || busy}
          title={organizationReason}
          aria-describedby={busy ? 'organization-unavailable' : undefined}
          onClick={() => {
            if (!pending && !busy) onStackAction('scan')
          }}
        >
          <Layers size={14} />
          Group capture sequences…
        </button>
        {organizationReason && <p id="organization-unavailable">{organizationReason}</p>}
      </div>
    </div>
  )
}
