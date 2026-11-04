import { galleryLayout } from '../collections/gallery-layout'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GalleryEntry, GallerySummary, StackSummary } from '../../../shared/stacks'
import type { Photo, PhotoReference } from '../../../shared/contracts'
import type { CollectionAnchor } from '../../../shared/collections'
import { isCollectionChanged } from '../../../shared/collections'
import type { SelectionModifiers } from '../hooks/useLibrary'
import { useCollection } from '../hooks/useCollection'
import { useCollectionThumbnails } from '../hooks/useCollectionThumbnails'
import { currentCollectionPolicy } from '../collections/controller'
import { captureAnchor, collectionWindow, locateAnchor, revealNearest } from '../collections/layout'
import { CollectionThumbnail } from './CollectionThumbnail'
import styles from './Photos.module.css'

// Match the vertical .scroll padding in Photos.module.css when revealing a row.
const PHOTOS_SCROLL_INSET = 4

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
  onShowCurrent: () => void
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
  onShowCurrent,
  onImport,
  onRefresh,
  onExpand,
}: LibraryProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 216, height: 500 })
  const [scrollTop, setScrollTop] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [direction, setDirection] = useState<-1 | 1>(1)
  const [revealError, setRevealError] = useState('')
  const [revealRetry, setRevealRetry] = useState(0)
  const scrollRevision = useRef(0)
  const navigation = useRef(0)
  const revealedRequest = useRef<number | null>(null)
  const controlFocus = useRef<{
    photoId: string | undefined
    groupId: string | undefined
    control: 'photo' | 'toggle'
    element: HTMLElement
  } | null>(null)
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
  const rowHeight = 56
  const layout = useMemo(
    () => galleryLayout(summary?.total ?? 0, summary?.groups ?? [], Math.max(0, size.width - 14)),
    [summary?.total, summary?.groups, size.width],
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
      const groupId = focused.closest<HTMLElement>('[data-group-id]')?.dataset.groupId
      if (photoId || groupId)
        controlFocus.current = {
          photoId,
          groupId,
          control: focused.dataset.groupControl === 'toggle' ? 'toggle' : 'photo',
          element: focused,
        }
    }
    const followTop = restored.current && latest.current.scrollTop <= 1 && !latest.current.focusId
    const read = async (offset: number) => ({
      records: (await globalThis.window.irodori.getGalleryChunk(offset, summary)).entries,
    })
    controller.configure(`${summary.catalogRevision}:${summary.revision}`, summary.total, read)
    const layoutKey = `${summary.catalogRevision}:${summary.revision}:${rowHeight}:${size.width}:${size.height}`
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
          (await globalThis.window.irodori.locateGalleryPhoto(id, 0, summary))?.index ?? null,
        summary.total,
      )
      if (!live || ticket !== scrollRevision.current || !viewport.current) return
      // Older checkpoints may have an inset from the taller grouped tiles.
      const inset = Math.max(0, Math.min(rowHeight - 1, anchor.inset))
      const top = Math.max(0, Math.min(layout.top(index) + inset, layout.height - size.height))
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
  }, [controller, summary, layout, size.width, size.height, rowHeight, onRefresh, reveal])
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
    if (!recovery || !viewport.current || !active || !records.size) return
    if (document.activeElement === recovery.element) {
      controlFocus.current = null
      return
    }
    if (document.activeElement !== document.body && document.activeElement !== viewport.current) {
      controlFocus.current = null
      return
    }
    const target =
      recovery.control === 'photo'
        ? viewport.current.querySelector<HTMLElement>(
            `[data-testid="photo-card-${recovery.photoId}"]`,
          )
        : viewport.current.querySelector<HTMLElement>(
            `[data-group-id="${recovery.groupId}"] [data-group-control="${recovery.control}"]`,
          )
    if (target) {
      target.focus({ preventScroll: true })
      controlFocus.current = null
    }
  }, [records, active])

  useEffect(() => {
    if (!active || !summary || !focusId) return
    let live = true
    void globalThis.window.irodori.locateGalleryPhoto(focusId, 0, summary).then(
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
    let live = true
    const isCurrent = () => {
      const current = latest.current
      return (
        live &&
        ticket === navigation.current &&
        current.active &&
        current.summary?.catalogRevision === summary.catalogRevision &&
        current.summary.revision === summary.revision
      )
    }
    setRevealError('')
    void globalThis.window.irodori
      .locateGalleryPhoto(reveal.id, 0, summary)
      .then(async (location) => {
        if (!location || !isCurrent() || !viewport.current) return
        const entry = await controller.get(location.index)
        if (!isCurrent() || !viewport.current) return
        if (!entry) throw new Error('This photograph is no longer available in the collection.')
        revealedRequest.current = reveal.request
        const top = revealNearest(
          viewport.current,
          layout.top(location.index) + PHOTOS_SCROLL_INSET,
          layout.box(location.index).height,
        )
        latest.current.scrollTop = top
        scrollRevision.current++
        setScrollTop(top)
      })
      .catch((failure: unknown) => {
        if (!isCurrent() || (failure instanceof Error && failure.name === 'AbortError')) return
        if (isCollectionChanged(failure)) void onRefresh()
        else setRevealError(String(failure))
      })
    return () => {
      live = false
    }
  }, [active, reveal, summary, controller, layout, rowHeight, onRefresh, revealRetry])
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
      const top = revealNearest(
        viewport.current,
        layout.top(index) + PHOTOS_SCROLL_INSET,
        layout.box(index).height,
      )
      scrollRevision.current++
      latest.current.scrollTop = top
      setScrollTop(top)
      viewport.current.focus({ preventScroll: true })
    } catch (failure) {
      if (isCollectionChanged(failure)) void onRefresh()
    }
  }
  const renderedGroups = new Map<
    string,
    { geometry: NonNullable<ReturnType<typeof layout.group>>; indices: number[] }
  >()
  for (const index of window.overscan) {
    const geometry = layout.group(index)
    if (!geometry) continue
    const entry = renderedGroups.get(geometry.stackId) ?? { geometry, indices: [] }
    entry.indices.push(index)
    renderedGroups.set(geometry.stackId, entry)
  }
  const groupMetadata = new Map<string, GalleryEntry>()
  for (const entry of records.values()) {
    if (entry.stack) groupMetadata.set(entry.stack.id, entry)
  }
  function renderPhoto(index: number, groupTop?: number) {
    const geometry = layout.box(index)
    const entry = records.get(index)
    const placement = {
      top: geometry.top - (groupTop ?? 0),
      left: geometry.left,
      width: geometry.width,
      height: geometry.height,
    }
    if (!entry)
      return (
        <div
          key={`loading-${index}`}
          className={styles.placeholder}
          style={placement}
          role="status"
          aria-label="Loading photo"
        />
      )
    const { photo, stack, memberIndex, mergeSourceCount } = entry
    const isCurrent = activeId === photo.id
    const isCover = !!stack && memberIndex === 0
    const status = isCurrent
      ? 'Current'
      : stack
        ? isCover
          ? 'Group cover'
          : 'Group member'
        : photo.width && photo.height
          ? photo.width + ' × ' + photo.height
          : ''
    return (
      <div
        key={photo.id}
        className={`${styles.row} ${isCover ? styles.cover : ''}`}
        style={placement}
        data-stack-id={stack?.id}
        data-photo-id={photo.id}
      >
        <button
          id={`editor-photo-${photo.id}`}
          tabIndex={-1}
          className={styles.card}
          aria-label={`Select ${photo.filename}`}
          aria-selected={selectedIds.has(photo.id)}
          aria-pressed={selectedIds.has(photo.id)}
          aria-current={isCurrent ? 'true' : undefined}
          data-testid={`photo-card-${photo.id}`}
          data-focused={focusId === photo.id}
          title={
            mergeSourceCount === undefined
              ? photo.filename
              : `${photo.filename} · ${mergeSourceCount} recipe sources`
          }
          onClick={(event) => {
            navigation.current++
            setFocusedIndex(index)
            onFocus(photo.id)
            event.currentTarget.focus({ preventScroll: true })
            onSelect(photo, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            setFocusedIndex(index)
            onFocus(photo.id)
            onContextMenu(photo, event.currentTarget, event.clientX, event.clientY)
          }}
        >
          <span className={styles.thumbnail}>
            <CollectionThumbnail url={photo.thumbnailUrl} />
            <span
              className={styles.selection}
              aria-hidden="true"
              hidden={!selectedIds.has(photo.id)}
            >
              ✓
            </span>
          </span>
          <span className={styles.caption}>{photo.filename}</span>
          <span className={styles.status} aria-hidden="true">
            {status}
          </span>
        </button>
        {isCover && (
          <button
            data-stack-toggle
            data-group-control="toggle"
            className={styles.groupToggle}
            aria-label={`${stack.expanded ? 'Collapse' : 'Expand'} stack for ${photo.filename}, ${stack.count} photos`}
            title={`${stack.expanded ? 'Collapse' : 'Expand'} group / ${stack.count} photos`}
            aria-expanded={stack.expanded}
            aria-controls={`group-members-${stack.id}`}
            onClick={() => onExpand(stack)}
          >
            <span>{stack.count}</span>
            {stack.expanded ? (
              <ChevronDown size={11} aria-hidden="true" />
            ) : (
              <ChevronRight size={11} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    )
  }
  return (
    <aside
      className={styles.library}
      aria-label="Photo library"
      data-testid="photo-library"
      tabIndex={-1}
    >
      <div className={styles.heading}>
        <h2>Photos</h2>
        <span className={styles.badge} aria-label={`${summary?.storedTotal ?? 0} photographs`}>
          {summary?.storedTotal ?? 0}
        </span>
      </div>
      <div className={styles.summary}>
        {summary?.storedTotal ?? 0} photos / {summary?.groups.length ?? 0}{' '}
        {summary?.groups.length === 1 ? 'group' : 'groups'}
      </div>
      <div
        ref={viewport}
        className={styles.scroll}
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
        data-gallery-revision={
          summary ? `${summary.catalogRevision}:${summary.revision}` : undefined
        }
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
          if (event.altKey || (event.target as HTMLElement).closest('[data-group-control]')) return
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
            void navigateIndex(layout.move(index, event.key, size.height), {
              shift: event.shiftKey,
              toggle: event.ctrlKey || event.metaKey,
            })
          }
        }}
      >
        {(error || revealError) && (
          <p role="alert" className={styles.error}>
            {error || revealError}{' '}
            <button
              onClick={() => {
                controller.retry()
                setRevealError('')
                setRevealRetry((retry) => retry + 1)
              }}
            >
              Retry photographs
            </button>
          </p>
        )}
        {!summary ? (
          <p role="status" className={styles.empty}>
            Loading photographs…
          </p>
        ) : !summary.total ? (
          <div className={styles.empty}>
            <button onClick={onImport}>Import photographs</button>
          </div>
        ) : (
          <div className={styles.list} style={{ height: layout.height }}>
            {window.overscan.map((index) => {
              const group = layout.group(index)
              if (!group) return renderPhoto(index)
              const { geometry, indices } = renderedGroups.get(group.stackId)!
              if (indices[0] !== index) return null
              const metadata = groupMetadata.get(geometry.stackId)
              const stack = metadata?.stack
              const cover =
                metadata?.cover ?? (metadata?.memberIndex === 0 ? metadata.photo : undefined)
              const expanded = geometry.count > 1
              const origin =
                stack?.origin === 'merge'
                  ? 'Merged group'
                  : stack?.origin === 'capture'
                    ? 'Capture sequence'
                    : stack
                      ? 'Manual group'
                      : 'Reading group…'
              return (
                <section
                  key={geometry.stackId}
                  className={styles.group}
                  style={{ top: geometry.top, width: geometry.width, height: geometry.height }}
                  data-group-id={geometry.stackId}
                  data-expanded={expanded}
                  aria-label={
                    cover ? `${cover.filename}, ${origin.toLowerCase()}` : 'Loading photo group'
                  }
                >
                  <div id={`group-members-${geometry.stackId}`} className={styles.groupMembers}>
                    {indices.map((index) => renderPhoto(index, geometry.top))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span role="status" data-testid="selection-count">
          {selectedIds.size} selected
        </span>
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
        <button className={styles.showCurrent} disabled={!activeId} onClick={onShowCurrent}>
          Show current
        </button>
      </div>
    </aside>
  )
}
