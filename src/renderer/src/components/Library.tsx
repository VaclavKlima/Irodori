import { Images, Plus, ChevronRight, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GalleryEntry, GallerySummary, StackSummary } from '../../../shared/stacks'
import type { Photo, PhotoReference } from '../../../shared/contracts'
import type { CollectionAnchor } from '../../../shared/collections'
import { isCollectionChanged } from '../../../shared/collections'
import type { SelectionModifiers } from '../hooks/useLibrary'
import { useCollection } from '../hooks/useCollection'
import { useCollectionThumbnails } from '../hooks/useCollectionThumbnails'
import { currentCollectionPolicy } from '../collections/controller'
import {
  captureAnchor,
  collectionWindow,
  gridLayout,
  locateAnchor,
  revealNearest,
} from '../collections/layout'
import { CollectionThumbnail } from './CollectionThumbnail'
import styles from '../App.module.css'

interface LibraryProps {
  active: boolean
  summary: GallerySummary | null
  hiddenActiveCover: PhotoReference | null
  selectedIds: Map<string, PhotoReference>
  activeId: string | null
  focusId: string | null
  onFocus: (id: string | null) => void
  initialAnchor: CollectionAnchor | null
  onAnchor: (anchor: CollectionAnchor | null) => void
  reveal: { id: string; request: number } | null
  onSelect: (photo: Photo, modifiers: SelectionModifiers) => void
  onToggle: (photo: Photo) => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
  onImport: () => void
  onRefresh: () => Promise<void>
  onExpand: (stack: StackSummary) => void
}

export function Library({
  active,
  summary,
  hiddenActiveCover,
  selectedIds,
  activeId,
  focusId,
  onFocus,
  initialAnchor,
  onAnchor,
  reveal,
  onContextMenu,
  onSelect,
  onToggle,
  onImport,
  onRefresh,
  onExpand,
}: LibraryProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 216, height: 500 })
  const [scrollTop, setScrollTop] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [direction, setDirection] = useState<-1 | 1>(1)
  const scrollRevision = useRef(0)
  const navigation = useRef(0)
  const revealedRequest = useRef<number | null>(null)
  const controlFocus = useRef<{ photoId: string; stack: boolean; element: HTMLElement } | null>(
    null,
  )
  const savedAnchor = useRef(initialAnchor)
  const restored = useRef(false)
  const restoredLayout = useRef<string | null>(null)
  const restoring = useRef(false)
  const collection = useCollection<GalleryEntry>((error) => {
    if (!isCollectionChanged(error)) return false
    void onRefresh()
    return true
  })
  const { controller, records, error, loading } = collection
  const rowHeight = Math.ceil(Math.max(100, size.width - 34) / 1.75) + 58
  const layout = useMemo(
    () => gridLayout(summary?.total ?? 0, 1, rowHeight),
    [summary?.total, rowHeight],
  )
  const window = useMemo(
    () =>
      collectionWindow(
        layout,
        scrollTop,
        size.height,
        direction,
        currentCollectionPolicy().lookahead,
        focusedIndex === null ? [] : [focusedIndex],
        active,
      ),
    [layout, scrollTop, size.height, focusedIndex, active, direction],
  )
  const latest = useRef({ layout, records, scrollTop, summary, active, focusId })
  useLayoutEffect(() => {
    latest.current = { layout, records, scrollTop, summary, active, focusId }
  })
  const capture = useCallback(() => {
    const view = latest.current
    if (restoring.current) return
    const anchor = captureAnchor(
      view.layout,
      viewport.current?.scrollTop ?? view.scrollTop,
      view.records,
      (entry) => entry.photo.id,
      (entry) => entry.cover?.id,
    )
    if (anchor) {
      savedAnchor.current = anchor
      onAnchor(anchor)
    }
  }, [onAnchor])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0)
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!summary) return
    let live = true
    const ticket = scrollRevision.current
    const anchor = savedAnchor.current
    restoring.current = true
    const focused = document.activeElement
    if (
      focused instanceof HTMLElement &&
      viewport.current?.contains(focused) &&
      focused !== viewport.current
    ) {
      const photoId = focused.closest<HTMLElement>('[data-photo-id]')?.dataset.photoId
      if (photoId)
        controlFocus.current = {
          photoId,
          stack: focused.hasAttribute('data-stack-toggle'),
          element: focused,
        }
    }
    const followTop = restored.current && latest.current.scrollTop <= 1 && !latest.current.focusId
    const read = async (offset: number) => ({
      records: (await globalThis.window.luma.getGalleryChunk(offset, summary)).entries,
    })
    controller.configure(`${summary.catalogRevision}:${summary.revision}`, summary.total, read)
    const layoutKey = `${summary.catalogRevision}:${summary.revision}:${rowHeight}:${size.height}`
    const unchanged = restoredLayout.current === layoutKey
    restoredLayout.current = layoutKey
    if (unchanged || (reveal && revealedRequest.current !== reveal.request)) {
      restoring.current = false
      restored.current = true
      return
    }
    const restore = async () => {
      if (!anchor || followTop) return
      const index = await locateAnchor(
        anchor,
        async (id) =>
          (await globalThis.window.luma.locateGalleryPhoto(id, 0, summary))?.index ?? null,
        summary.total,
      )
      if (!live || ticket !== scrollRevision.current || !viewport.current) return
      const top = Math.max(
        0,
        Math.min(layout.top(index) + anchor.inset, layout.height - size.height),
      )
      restoring.current = true
      viewport.current.scrollTop = top
      latest.current.scrollTop = top
      setScrollTop(top)
      restoring.current = false
    }
    void restore()
      .catch((failure) => {
        if (isCollectionChanged(failure)) void onRefresh()
      })
      .finally(() => {
        if (live) restoring.current = false
      })
    restored.current = true
    return () => {
      live = false
    }
  }, [controller, summary, layout, size.height, rowHeight, onRefresh, reveal])
  useEffect(() => {
    controller.setWindow(window)
  }, [controller, window])
  useCollectionThumbnails(records, window, (entry) => entry.photo.thumbnailUrl)
  useLayoutEffect(() => {
    if (active && records.size) capture()
  }, [active, records, capture])
  useLayoutEffect(() => {
    if (active && viewport.current) viewport.current.scrollTop = latest.current.scrollTop
  }, [active])
  useLayoutEffect(() => {
    const recovery = controlFocus.current
    if (!recovery || recovery.element.isConnected || !viewport.current || !active) return
    if (document.activeElement !== document.body && document.activeElement !== viewport.current) {
      controlFocus.current = null
      return
    }
    const row = viewport.current.querySelector<HTMLElement>(`[data-photo-id="${recovery.photoId}"]`)
    const target = row?.querySelector<HTMLElement>(
      recovery.stack ? '[data-stack-toggle]' : '[data-testid^="photo-card-"]',
    )
    if (target) {
      target.focus({ preventScroll: true })
      controlFocus.current = null
    }
  }, [records, active])

  useEffect(() => {
    if (!active || !summary || !focusId) return
    let live = true
    void globalThis.window.luma.locateGalleryPhoto(focusId, 0, summary).then(
      (location) => {
        if (live) setFocusedIndex(location?.index ?? null)
      },
      (failure) => {
        if (isCollectionChanged(failure)) void onRefresh()
      },
    )
    return () => {
      live = false
    }
  }, [active, focusId, summary, onRefresh])
  useEffect(() => {
    if (!active || !reveal || !summary || revealedRequest.current === reveal.request) return
    const ticket = ++navigation.current
    void globalThis.window.luma.locateGalleryPhoto(reveal.id, 0, summary).then(
      async (location) => {
        if (!location || ticket !== navigation.current || !viewport.current) return
        await controller.get(location.index)
        if (ticket !== navigation.current) return
        revealedRequest.current = reveal.request
        const top = revealNearest(viewport.current, layout.top(location.index), rowHeight)
        latest.current.scrollTop = top
        scrollRevision.current++
        setScrollTop(top)
      },
      (failure) => {
        if (isCollectionChanged(failure)) void onRefresh()
      },
    )
  }, [active, reveal, summary, controller, layout, rowHeight, onRefresh])
  async function navigateIndex(index: number, modifiers: SelectionModifiers) {
    if (!summary?.total || !viewport.current) return
    const ticket = ++navigation.current
    index = Math.max(0, Math.min(summary.total - 1, index))
    try {
      const entry = await controller.get(index)
      if (!entry || ticket !== navigation.current || !latest.current.active) return
      setFocusedIndex(index)
      onFocus(entry.photo.id)
      if (!modifiers.toggle || modifiers.shift) onSelect(entry.photo, modifiers)
      const top = revealNearest(viewport.current, layout.top(index), rowHeight)
      scrollRevision.current++
      latest.current.scrollTop = top
      setScrollTop(top)
      viewport.current.focus({ preventScroll: true })
    } catch (failure) {
      if (isCollectionChanged(failure)) void onRefresh()
    }
  }
  return (
    <aside
      className={styles.library}
      aria-label="Photo library"
      data-testid="photo-library"
      tabIndex={-1}
    >
      <div className={styles.panelHeading}>
        <h2>Photos</h2>
        <button className={styles.iconButton} aria-label="Add photos" onClick={onImport}>
          <Plus size={15} />
        </button>
      </div>
      <div className={styles.galleryHeading}>
        <span>
          <Images size={13} /> All photographs
        </span>
        <span className={styles.count} title={`${summary?.total ?? 0} visible photo rows`}>
          {summary?.storedTotal ?? 0}
        </span>
      </div>
      <p className={styles.selectionCount} role="status" data-testid="selection-count">
        {selectedIds.size} selected
      </p>
      {!!summary?.hiddenSelectedIds.length && (
        <details className={styles.hiddenSelection}>
          <summary>{summary.hiddenSelectedIds.length} selected in collapsed stacks</summary>
          <ul>
            {summary.hiddenSelectedIds.map((id) => (
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
      <div
        ref={viewport}
        className={styles.libraryScroll}
        data-testid="editor-photo-scroll"
        tabIndex={0}
        role="listbox"
        aria-label="Editor photographs"
        aria-multiselectable="true"
        aria-busy={loading}
        aria-activedescendant={
          focusedIndex !== null &&
          window.overscan.includes(focusedIndex) &&
          records.get(focusedIndex)
            ? `editor-photo-${records.get(focusedIndex)!.photo.id}`
            : undefined
        }
        data-row-height={rowHeight}
        data-columns={1}
        data-cache-photos={records.size}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          if (!active) return
          if (top !== latest.current.scrollTop) {
            setDirection(top < latest.current.scrollTop ? -1 : 1)
            if (!restoring.current) scrollRevision.current++
          }
          latest.current.scrollTop = top
          setScrollTop(top)
          capture()
        }}
        onKeyDown={(event) => {
          if (event.altKey || (event.target as HTMLElement).closest('[data-stack-toggle]')) return
          const index = focusedIndex ?? layout.first(scrollTop)
          if (event.key === ' ') {
            event.preventDefault()
            void controller.get(index).then((entry) => {
              if (entry) onToggle(entry.photo)
            })
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            const entry = records.get(index)
            if (!entry) return
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            onContextMenu(entry.photo, event.currentTarget, box.left + 15, box.top + 15)
          } else if (
            [
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
              'Home',
              'End',
              'PageUp',
              'PageDown',
            ].includes(event.key)
          ) {
            event.preventDefault()
            const amount = Math.max(1, Math.floor(size.height / rowHeight))
            const target =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? (summary?.total ?? 1) - 1
                  : index +
                    ({
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -1,
                      ArrowDown: 1,
                      PageUp: -amount,
                      PageDown: amount,
                    }[event.key] ?? 0)
            void navigateIndex(target, {
              shift: event.shiftKey,
              toggle: event.ctrlKey || event.metaKey,
            })
          }
        }}
      >
        {error && (
          <p role="alert" className={styles.collectionError}>
            {error} <button onClick={() => controller.retry()}>Retry photographs</button>
          </p>
        )}
        {!summary ? (
          <p role="status">Loading photographs…</p>
        ) : (
          <div className={styles.photoList} style={{ height: layout.height }}>
            {window.overscan.map((index) => {
              const entry = records.get(index)
              if (!entry)
                return (
                  <div
                    key={`loading-${index}`}
                    className={styles.photoPlaceholder}
                    style={{ top: layout.top(index), height: rowHeight - 12 }}
                    role="status"
                    aria-label="Loading photo"
                  />
                )
              const { photo, stack, memberIndex, mergeSourceCount } = entry
              return (
                <div
                  key={photo.id}
                  className={`${styles.photoRow} ${stack ? styles.stackRow : ''} ${memberIndex ? styles.stackMember : ''}`}
                  style={{ top: layout.top(index) }}
                  data-stack-id={stack?.id}
                  data-photo-id={photo.id}
                >
                  <button
                    id={`editor-photo-${photo.id}`}
                    tabIndex={-1}
                    className={`${styles.photoCard} ${selectedIds.has(photo.id) ? styles.selectedPhoto : ''} ${activeId === photo.id ? styles.activePhoto : ''}`}
                    aria-label={`Select ${photo.filename}`}
                    aria-selected={selectedIds.has(photo.id)}
                    aria-pressed={selectedIds.has(photo.id)}
                    aria-current={activeId === photo.id ? 'true' : undefined}
                    data-testid={`photo-card-${photo.id}`}
                    data-focused={focusId === photo.id}
                    onClick={(event) => {
                      navigation.current++
                      setFocusedIndex(index)
                      onFocus(photo.id)
                      event.currentTarget.focus({ preventScroll: true })
                      onSelect(photo, {
                        shift: event.shiftKey,
                        toggle: event.ctrlKey || event.metaKey,
                      })
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setFocusedIndex(index)
                      onFocus(photo.id)
                      onContextMenu(photo, event.currentTarget, event.clientX, event.clientY)
                    }}
                  >
                    <div className={styles.thumbnailFrame}>
                      <CollectionThumbnail url={photo.thumbnailUrl} />
                      <span className={styles.photoNumber}>{index + 1}</span>
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
                      data-stack-toggle
                      className={styles.stackExpand}
                      aria-label={`${stack.expanded ? 'Collapse' : 'Expand'} stack for ${photo.filename}, ${stack.count} photos`}
                      aria-expanded={stack.expanded}
                      title={`${stack.count} stack members`}
                      onClick={() => onExpand(stack)}
                    >
                      {stack.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <span>{stack.count}</span>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className={styles.libraryFooter}>
        <span className={styles.statusDot} /> Stored on this device
      </div>
    </aside>
  )
}
