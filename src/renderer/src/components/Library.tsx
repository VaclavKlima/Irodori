import { Images, Plus, ChevronRight, ChevronDown } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { GalleryEntry, StackSummary } from '../../../shared/stacks'
import { PAGE_SIZE, type Photo, type PhotoReference } from '../../../shared/contracts'
import type { SelectionModifiers } from '../hooks/useLibrary'
import styles from '../App.module.css'

interface LibraryProps {
  entries: GalleryEntry[]
  total: number
  storedTotal: number
  hiddenSelectedIds: string[]
  hiddenActiveCover: PhotoReference | null
  offset: number
  selectedIds: Map<string, PhotoReference>
  activeId: string | null
  reveal: { id: string; request: number } | null
  onSelect: (photo: Photo, modifiers: SelectionModifiers) => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
  onImport: () => void
  onPage: (offset: number) => void
  onExpand: (stack: StackSummary) => void
}

export function Library({
  entries,
  total,
  storedTotal,
  hiddenSelectedIds,
  hiddenActiveCover,
  offset,
  selectedIds,
  activeId,
  reveal,
  onContextMenu,
  onSelect,
  onImport,
  onPage,
  onExpand,
}: LibraryProps) {
  const revealedCard = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    revealedCard.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [reveal])
  return (
    <aside
      className={styles.library}
      aria-label="Photo library"
      data-testid="photo-library"
      tabIndex={-1}
    >
      <div className={styles.panelHeading}>
        <h2>Library</h2>
        <button className={styles.iconButton} aria-label="Add photos" onClick={onImport}>
          <Plus size={15} />
        </button>
      </div>
      <div className={styles.libraryScroll}>
        <div className={styles.galleryHeading}>
          <span>
            <Images size={13} /> All photographs
          </span>
          <span className={styles.count} title={`${total} visible photo rows`}>
            {storedTotal}
          </span>
        </div>
        <p className={styles.selectionCount} role="status" data-testid="selection-count">
          {selectedIds.size} selected
        </p>
        {hiddenSelectedIds.length > 0 && (
          <details className={styles.hiddenSelection}>
            <summary>{hiddenSelectedIds.length} selected in collapsed stacks</summary>
            <ul>
              {hiddenSelectedIds.map((id) => (
                <li key={id}>{selectedIds.get(id)?.filename}</li>
              ))}
            </ul>
          </details>
        )}
        {hiddenActiveCover && (
          <p className={styles.hiddenSelection} role="status">
            Viewing a member of {hiddenActiveCover.filename}
          </p>
        )}
        <div className={styles.photoList}>
          {entries.map(({ photo, stack, cover, memberIndex, mergeSourceCount }, index) => (
            <div
              key={photo.id}
              className={`${styles.photoRow} ${stack ? styles.stackRow : ''} ${memberIndex ? styles.stackMember : ''}`}
              data-stack-id={stack?.id}
            >
              {index === 0 && !!memberIndex && (
                <p className={styles.stackContinuation}>Stack: {cover?.filename} (continued)</p>
              )}
              <button
                ref={photo.id === reveal?.id ? revealedCard : undefined}
                className={`${styles.photoCard} ${selectedIds.has(photo.id) ? styles.selectedPhoto : ''} ${activeId === photo.id ? styles.activePhoto : ''}`}
                aria-label={`Select ${photo.filename}`}
                aria-pressed={selectedIds.has(photo.id)}
                aria-current={activeId === photo.id ? 'true' : undefined}
                data-testid={`photo-card-${photo.id}`}
                onClick={(event) =>
                  onSelect(photo, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })
                }
                onContextMenu={(event) => {
                  event.preventDefault()
                  onContextMenu(photo, event.currentTarget, event.clientX, event.clientY)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    const box = event.currentTarget.getBoundingClientRect()
                    onContextMenu(photo, event.currentTarget, box.left + 15, box.top + 15)
                  }
                }}
              >
                <div className={styles.thumbnailFrame}>
                  <img src={photo.thumbnailUrl} alt="" loading="lazy" draggable={false} />
                  <span className={styles.photoNumber}>{offset + index + 1}</span>
                  <span className={styles.photoFormat}>{photo.format}</span>
                </div>
                <span className={styles.thumbnailCaption}>
                  <span>{photo.filename}</span>
                  <span className={styles.selectionDot} aria-hidden="true" />
                </span>
                {mergeSourceCount !== undefined && (
                  <span className={styles.recipeCount}>{mergeSourceCount} recipe sources</span>
                )}
              </button>
              {stack && memberIndex === 0 && (
                <button
                  className={styles.stackExpand}
                  aria-label={`${stack.expanded ? 'Collapse' : 'Expand'} stack for ${photo.filename}, ${stack.count} photos`}
                  aria-expanded={stack.expanded}
                  title={`${stack.count} stack members${mergeSourceCount === undefined ? '' : `; ${mergeSourceCount} recipe sources`}`}
                  onClick={() => onExpand(stack)}
                >
                  {stack.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{stack.count}</span>
                </button>
              )}
            </div>
          ))}
        </div>
        {total > PAGE_SIZE && (
          <nav className={styles.pageControls} aria-label="Library pages">
            <button disabled={offset === 0} onClick={() => onPage(offset - PAGE_SIZE)}>
              Previous
            </button>
            <span>
              {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(total / PAGE_SIZE)}
            </span>
            <button
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => onPage(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </nav>
        )}
      </div>
      <div className={styles.libraryFooter}>
        <span className={styles.statusDot} /> Stored on this device
      </div>
    </aside>
  )
}
