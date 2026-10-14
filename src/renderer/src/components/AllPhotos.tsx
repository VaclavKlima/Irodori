import { useCollection } from '../hooks/useCollection'
import { useCollectionThumbnails } from '../hooks/useCollectionThumbnails'
import { CollectionThumbnail } from './CollectionThumbnail'
import { currentCollectionPolicy, CollectionRefresh } from '../collections/controller'
import { captureAnchor, collectionWindow, locateAnchor } from '../collections/layout'
import type { WorkspaceState } from '../../../shared/workspace'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Layers, Search } from 'lucide-react'
import type { Photo, PhotoReference } from '../../../shared/contracts'
import {
  BROWSE_CHUNK_SIZE,
  browseSectionKey,
  isBrowseCatalogChanged,
  DEFAULT_BROWSE_QUERY,
  type BrowseQuery,
  type BrowseGrouping,
  type BrowsePhoto,
  type BrowseSummary,
  type BrowseSelectionOperations,
} from '../../../shared/browse'
import {
  BROWSE_HEADER_HEIGHT,
  browseCollectionLayout,
  browseIndexTop,
  browseNavigableIndex,
  createBrowseLayout,
  firstVisibleBrowseIndex,
  visibleBrowseRows,
} from '../browse/layout'
import styles from './AllPhotos.module.css'

interface Presentation {
  query: BrowseQuery
  summary: BrowseSummary | null
  photos: ReadonlyMap<number, BrowsePhoto>
  generation: number
}
type CollapsedGroups = Record<BrowseGrouping, ReadonlySet<string>>
function SectionCheckbox({
  count,
  selected,
  label,
  onChange,
  focusKey,
}: {
  count: number
  selected: number
  label: string
  onChange: (checked: boolean) => void
  focusKey: string
}) {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = selected > 0 && selected < count
  }, [count, selected])
  return (
    <input
      ref={input}
      type="checkbox"
      checked={selected === count}
      aria-label={`Select ${label}`}
      data-focus-key={focusKey}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

export function AllPhotos({
  active,
  selected,
  selection,
  focusedPhoto,
  onFocusPhoto,
  onOpen,
  onContextMenu,
  onImport,
  onError,
  initialState,
  onState,
  covered,
}: {
  active: boolean
  covered: boolean
  initialState: WorkspaceState | null
  onState: (change: Partial<WorkspaceState>) => void
  selected: Map<string, PhotoReference>
  selection: BrowseSelectionOperations
  focusedPhoto: BrowsePhoto | null
  onFocusPhoto: (photo: BrowsePhoto | null) => void
  onOpen: (id: string, doubleClick?: boolean) => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
  onImport: () => void
  onError: (message: string) => void
}) {
  const [search, setSearch] = useState(initialState?.query.search ?? '')
  const [query, setQuery] = useState<BrowseQuery>(initialState?.query ?? DEFAULT_BROWSE_QUERY)
  const [storedPresentation, setPresentation] = useState<Presentation>({
    query: initialState?.query ?? DEFAULT_BROWSE_QUERY,
    summary: null,
    photos: new Map(),
    generation: 0,
  })
  const [size, setSize] = useState({ width: 1100, height: 500 })
  const [scrollTop, setScrollTop] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<CollapsedGroups>(() => ({
    date: new Set(initialState?.folds.date),
    month: new Set(initialState?.folds.month),
    year: new Set(initialState?.folds.year),
  }))
  const staleRefresh = useRef<() => void>(() => {})
  const collection = useCollection<BrowsePhoto>((error) => {
    if (!isBrowseCatalogChanged(error)) return false
    staleRefresh.current()
    return true
  })
  const presentation = useMemo(
    () => ({ ...storedPresentation, photos: collection.records }),
    [storedPresentation, collection.records],
  )
  const [direction, setDirection] = useState<-1 | 1>(1)
  const initialAnchor = useRef(initialState?.libraryAnchor ?? null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState('')
  const root = useRef<HTMLElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const latest = useRef({
    presentation,
    selected,
    size,
    scrollTop,
    focusedPhoto,
    focusedIndex,
    collapsedGroups,
    active,
  })
  useLayoutEffect(() => {
    latest.current = {
      presentation,
      selected,
      size,
      scrollTop,
      focusedPhoto,
      focusedIndex,
      collapsedGroups,
      active,
    }
  })
  const summaryTicket = useRef(0)
  const navigationTicket = useRef(0)
  const scrollRevision = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedFocus = useRef<string | null>(null)
  const restoreScroll = useRef<{ top: number; revision: number } | null>(null)
  const queryRef = useRef(query)
  const collapsed = collapsedGroups[presentation.query.grouping]
  const layout = useMemo(
    () =>
      createBrowseLayout(presentation.summary?.sections ?? [], size.width, size.height, collapsed),
    [presentation.summary, size.width, size.height, collapsed],
  )
  const rows = useMemo(
    () => visibleBrowseRows(layout, scrollTop, size.height),
    [layout, scrollTop, size.height],
  )

  const refreshCatalog = useCallback(async function refreshCatalog(
    nextQuery: BrowseQuery = queryRef.current,
    reset = false,
  ) {
    const ticket = ++summaryTicket.current
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = null
    const previous = latest.current
    setLoading(true)
    setFailure('')
    try {
      const summary = await globalThis.window.luma.getBrowseSummary(nextQuery, [
        ...previous.selected.keys(),
      ])
      if (ticket !== summaryTicket.current) return
      const currentView = latest.current
      const currentScroll = currentView.active
        ? (viewport.current?.scrollTop ?? currentView.scrollTop)
        : currentView.scrollTop
      reset = reset || currentView.presentation.query.search !== nextQuery.search
      const scrollTicket = scrollRevision.current
      const oldLayout = createBrowseLayout(
        currentView.presentation.summary?.sections ?? [],
        currentView.size.width,
        currentView.size.height,
        currentView.collapsedGroups[currentView.presentation.query.grouping],
      )
      const first = firstVisibleBrowseIndex(oldLayout, currentScroll)
      const firstSection = oldLayout.sections.find((section) => section.bottom > currentScroll)
      const anchor = captureAnchor(
        browseCollectionLayout(oldLayout),
        currentScroll,
        currentView.presentation.photos,
        (photo) => photo.id,
      )
      const inset = currentScroll - browseIndexTop(oldLayout, first)
      const changed =
        currentView.presentation.summary?.revision !== summary.revision ||
        currentView.presentation.query.search !== nextQuery.search ||
        currentView.presentation.query.grouping !== nextQuery.grouping
      let nextScroll = reset ? 0 : currentScroll
      if (anchor && !reset && changed) {
        const index = await locateAnchor(
          anchor,
          async (id) =>
            (await globalThis.window.luma.locateBrowsePhoto(nextQuery, id, summary.revision))
              ?.index ?? null,
          summary.total,
        )
        const newLayout = createBrowseLayout(
          summary.sections,
          currentView.size.width,
          currentView.size.height,
          currentView.collapsedGroups[nextQuery.grouping],
        )
        nextScroll = Math.max(
          0,
          Math.min(
            browseIndexTop(newLayout, index) + inset,
            newLayout.height - currentView.size.height,
          ),
        )
      } else if (
        !reset &&
        changed &&
        currentView.presentation.summary?.revision === summary.revision
      ) {
        const newLayout = createBrowseLayout(
          summary.sections,
          currentView.size.width,
          currentView.size.height,
          currentView.collapsedGroups[nextQuery.grouping],
        )
        nextScroll = Math.max(0, browseIndexTop(newLayout, first) + inset)
      } else if (!reset && changed && firstSection) {
        const newLayout = createBrowseLayout(
          summary.sections,
          currentView.size.width,
          currentView.size.height,
          currentView.collapsedGroups[nextQuery.grouping],
        )
        const heading = newLayout.sections.find(
          (section) => section.section.key === firstSection.section.key,
        )
        nextScroll = Math.min(
          heading ? heading.top + currentScroll - firstSection.top : nextScroll,
          Math.max(0, newLayout.height - currentView.size.height),
        )
      }
      const initialRestoration = initialAnchor.current !== null
      if (initialAnchor.current && !reset) {
        const anchor = initialAnchor.current
        const index = await locateAnchor(
          anchor,
          async (id) =>
            (await globalThis.window.luma.locateBrowsePhoto(nextQuery, id, summary.revision))
              ?.index ?? null,
          summary.total,
        )
        const newLayout = createBrowseLayout(
          summary.sections,
          currentView.size.width,
          currentView.size.height,
          currentView.collapsedGroups[nextQuery.grouping],
        )
        nextScroll = Math.max(
          0,
          Math.min(
            browseIndexTop(newLayout, index) + anchor.inset,
            newLayout.height - currentView.size.height,
          ),
        )
        initialAnchor.current = null
      }
      if (currentScroll <= 1 && !currentView.focusedPhoto && !reset && !initialRestoration)
        nextScroll = 0
      if (ticket !== summaryTicket.current) return
      if (reset || scrollTicket === scrollRevision.current) {
        restoreScroll.current = { top: nextScroll, revision: scrollRevision.current }
        setScrollTop(nextScroll)
      }
      if (changed) setFocusedIndex(null)
      setPresentation((current) => ({
        query: nextQuery,
        summary,
        photos: changed ? new Map() : current.photos,
        generation: changed ? current.generation + 1 : current.generation,
      }))
    } catch (error) {
      if (ticket === summaryTicket.current) {
        if (isBrowseCatalogChanged(error))
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null
            void refreshCatalog()
          }, 30)
        else setFailure(String(error))
      }
    } finally {
      if (ticket === summaryTicket.current) setLoading(false)
    }
  }, [])
  const refreshRequest = useRef({ query, reset: false })
  const refreshReader = useRef(refreshCatalog)
  useLayoutEffect(() => {
    refreshReader.current = refreshCatalog
  }, [refreshCatalog])
  const [refreshRunner] = useState(
    () =>
      new CollectionRefresh(async () => {
        const request = refreshRequest.current
        refreshRequest.current = { ...request, reset: false }
        await refreshReader.current(request.query, request.reset)
      }),
  )
  useLayoutEffect(() => {
    refreshRunner.resume()
  }, [refreshRunner])
  const refresh = useCallback(
    (nextQuery: BrowseQuery = queryRef.current, reset = false) => {
      refreshRequest.current = { query: nextQuery, reset: reset || refreshRequest.current.reset }
      return refreshRunner.request()
    },
    [refreshRunner],
  )
  const retryRefresh = useCallback(() => {
    if (retryTimer.current) return
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null
      void refresh()
    }, 30)
  }, [refresh])
  useLayoutEffect(() => {
    staleRefresh.current = retryRefresh
  }, [retryRefresh])

  useEffect(() => {
    const current = latest.current
    if (!current.focusedPhoto || !current.presentation.summary) return
    const ticket = navigationTicket.current
    const generation = current.presentation.generation
    const requestedPhotoId = current.focusedPhoto.id
    let cancelled = false
    void globalThis.window.luma
      .locateBrowsePhoto(
        current.presentation.query,
        requestedPhotoId,
        current.presentation.summary.revision,
      )
      .then(
        (location) => {
          if (
            cancelled ||
            ticket !== navigationTicket.current ||
            generation !== latest.current.presentation.generation ||
            requestedPhotoId !== latest.current.focusedPhoto?.id
          )
            return
          const view = latest.current
          const section = view.presentation.summary?.sections.find(
            (section) =>
              location &&
              location.index >= section.offset &&
              location.index < section.offset + section.count,
          )
          const hidden =
            section && view.collapsedGroups[view.presentation.query.grouping].has(section.key)
          view.focusedIndex = hidden ? null : (location?.index ?? null)
          view.focusedPhoto = hidden ? null : (location?.photo ?? null)
          setFocusedIndex(view.focusedIndex)
          onFocusPhoto(view.focusedPhoto)
        },
        (error) => {
          if (cancelled) return
          if (isBrowseCatalogChanged(error)) retryRefresh()
          else onError(String(error))
        },
      )
    return () => {
      cancelled = true
    }
  }, [presentation.generation, collapsed, onFocusPhoto, onError, retryRefresh])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryRef.current.search === search) return
      const next = { ...queryRef.current, search }
      queryRef.current = next
      setQuery(next)
      onState({ query: next })
      void refresh(next, true)
    }, 200)
    return () => clearTimeout(timer)
  }, [search, refresh, onState])
  useEffect(() => {
    // Start an external catalog request when the workspace or shared selection changes.
    if (active) void refresh()
  }, [active, selected, refresh])
  useEffect(
    () =>
      globalThis.window.luma.onLibraryEvent((event) => {
        if (event.libraryChanged) void refresh()
      }),
    [refresh],
  )
  useLayoutEffect(
    () => () => {
      summaryTicket.current++
      navigationTicket.current++
      if (retryTimer.current) clearTimeout(retryTimer.current)
      refreshRunner.close()
    },
    [refreshRunner],
  )

  useLayoutEffect(() => {
    if (restoreScroll.current !== null && viewport.current && active) {
      if (restoreScroll.current.revision === scrollRevision.current)
        viewport.current.scrollTop = restoreScroll.current.top
      restoreScroll.current = null
    }
  }, [presentation, active, layout])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    if (viewport.current) viewport.current.scrollTop = latest.current.scrollTop
    if (savedFocus.current)
      root.current
        ?.querySelector<HTMLElement>(`[data-focus-key="${savedFocus.current}"]`)
        ?.focus({ preventScroll: true })
  }, [active])

  const sharedLayout = useMemo(() => browseCollectionLayout(layout), [layout])
  const window = useMemo(
    () =>
      collectionWindow(
        sharedLayout,
        scrollTop,
        size.height,
        direction,
        currentCollectionPolicy().lookahead,
        focusedIndex === null ? [] : [focusedIndex],
        active && !covered,
      ),
    [sharedLayout, scrollTop, size.height, focusedIndex, active, covered, direction],
  )
  useEffect(() => {
    if (!storedPresentation.summary) return
    const { query, summary } = storedPresentation
    collection.controller.configure(
      `${query.search}:${query.grouping}:${summary.revision}`,
      summary.total,
      async (offset) => ({
        records: (await globalThis.window.luma.getBrowseChunk(query, offset, summary.revision))
          .photos,
      }),
    )
  }, [collection.controller, storedPresentation])
  useEffect(() => {
    collection.controller.setWindow(window)
  }, [collection.controller, window])
  useCollectionThumbnails(collection.records, window, (photo) => photo.thumbnailUrl)
  useLayoutEffect(() => {
    if (!active || !presentation.summary || restoreScroll.current || initialAnchor.current) return
    const anchor = captureAnchor(
      sharedLayout,
      viewport.current?.scrollTop ?? scrollTop,
      collection.records,
      (photo) => photo.id,
    )
    if (anchor) onState({ libraryAnchor: anchor })
  }, [active, presentation.summary, sharedLayout, scrollTop, collection.records, onState])

  async function focusIndex(index: number) {
    const current = latest.current.presentation
    if (!current.summary?.total) return
    const ticket = ++navigationTicket.current
    index = Math.max(0, Math.min(current.summary.total - 1, index))
    try {
      const photo = await collection.controller.get(index)
      if (
        ticket !== navigationTicket.current ||
        current.generation !== latest.current.presentation.generation ||
        !latest.current.active
      )
        return
      if (!photo) return
      const view = latest.current
      const currentLayout = createBrowseLayout(
        view.presentation.summary?.sections ?? [],
        view.size.width,
        view.size.height,
        view.collapsedGroups[view.presentation.query.grouping],
      )
      if (browseNavigableIndex(currentLayout, index, 1) !== index) return
      view.focusedPhoto = photo
      view.focusedIndex = index
      setFocusedIndex(index)
      onFocusPhoto(photo)
      const top = browseIndexTop(currentLayout, index)
      const element = viewport.current!
      const before = element.scrollTop
      if (top < element.scrollTop) element.scrollTop = top
      else if (top + currentLayout.rowHeight > element.scrollTop + element.clientHeight)
        element.scrollTop = top + currentLayout.rowHeight - element.clientHeight
      if (element.scrollTop !== before) scrollRevision.current++
      latest.current.scrollTop = element.scrollTop
      setScrollTop(element.scrollTop)
      element.focus({ preventScroll: true })
    } catch (error) {
      if (isBrowseCatalogChanged(error)) retryRefresh()
      else onError(String(error))
    }
  }
  function focusPhoto(photo: BrowsePhoto, index: number) {
    navigationTicket.current++
    latest.current.focusedPhoto = photo
    latest.current.focusedIndex = index
    setFocusedIndex(index)
    onFocusPhoto(photo)
    viewport.current?.focus({ preventScroll: true })
  }
  function updateCollapsed(next: ReadonlySet<string>) {
    const view = latest.current
    const { summary, query } = view.presentation
    if (!summary) return
    const currentScroll = viewport.current?.scrollTop ?? view.scrollTop
    const previousLayout = createBrowseLayout(
      summary.sections,
      view.size.width,
      view.size.height,
      view.collapsedGroups[query.grouping],
    )
    const nextLayout = createBrowseLayout(summary.sections, view.size.width, view.size.height, next)
    const anchor = previousLayout.sections.find((section) => section.bottom > currentScroll)
    const nextAnchor = nextLayout.sections.find(
      (section) => section.section.key === anchor?.section.key,
    )
    let nextScroll = currentScroll
    if (anchor && nextAnchor) {
      if (!anchor.rows || !nextAnchor.rows)
        nextScroll = nextAnchor.top + Math.min(currentScroll - anchor.top, BROWSE_HEADER_HEIGHT - 1)
      else {
        const index = firstVisibleBrowseIndex(previousLayout, currentScroll)
        nextScroll =
          browseIndexTop(nextLayout, index) + currentScroll - browseIndexTop(previousLayout, index)
      }
    }
    nextScroll = Math.max(0, Math.min(nextScroll, nextLayout.height - view.size.height))
    navigationTicket.current++
    scrollRevision.current++
    if (
      view.focusedPhoto &&
      next.has(browseSectionKey(view.focusedPhoto.captureDate, query.grouping))
    ) {
      view.focusedPhoto = null
      view.focusedIndex = null
      setFocusedIndex(null)
      onFocusPhoto(null)
    }
    view.collapsedGroups = { ...view.collapsedGroups, [query.grouping]: next }
    view.scrollTop = nextScroll
    restoreScroll.current = { top: nextScroll, revision: scrollRevision.current }
    setCollapsedGroups(view.collapsedGroups)
    onState({
      folds: {
        date: [...view.collapsedGroups.date],
        month: [...view.collapsedGroups.month],
        year: [...view.collapsedGroups.year],
      },
    })
    setScrollTop(nextScroll)
  }
  const allCollapsed =
    !!presentation.summary?.sections.length &&
    presentation.summary.sections.every((section) => collapsed.has(section.key))
  const focusedVisible =
    focusedIndex !== null &&
    rows.some(
      (row) =>
        row.kind === 'photos' && focusedIndex >= row.start && focusedIndex < row.start + row.count,
    ) &&
    presentation.photos.has(focusedIndex)

  return (
    <section
      ref={root}
      className={styles.browser}
      hidden={!active}
      aria-label="Library"
      data-testid="all-photos"
      onFocusCapture={(event) => {
        const key = (event.target as HTMLElement).dataset.focusKey
        if (key) savedFocus.current = key
      }}
    >
      <div className={styles.toolbar}>
        <h1>Library</h1>
        <label className={styles.search}>
          <Search size={15} />
          <input
            type="search"
            maxLength={500}
            aria-label="Search photos"
            data-focus-key="search"
            placeholder="Search filenames, cameras, lenses, dates…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className={styles.grouping}>
          Group by{' '}
          <select
            aria-label="Group photos by"
            data-focus-key="grouping"
            value={query.grouping}
            onChange={(event) => {
              const next = { ...queryRef.current, grouping: event.target.value as BrowseGrouping }
              queryRef.current = next
              setQuery(next)
              onState({ query: next })
              void refresh(next)
            }}
          >
            <option value="date">Date</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </label>
        <button
          className={styles.foldAll}
          data-focus-key="fold-all"
          disabled={!presentation.summary?.sections.length}
          onClick={() => {
            const next = new Set(collapsed)
            for (const section of presentation.summary?.sections ?? []) {
              if (allCollapsed) next.delete(section.key)
              else next.add(section.key)
            }
            updateCollapsed(next)
          }}
        >
          {allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
        </button>
      </div>
      <div className={styles.selection}>
        <span role="status" data-testid="browse-selection-count">
          {presentation.summary?.total ?? 0} matching · {selected.size} selected
          {presentation.summary?.outsideSelected
            ? ` · ${presentation.summary.outsideSelected} outside current results`
            : ''}
        </span>
        <button
          data-focus-key="clear-selection"
          disabled={!selected.size}
          onClick={() => void selection.clear()}
        >
          Clear selection
        </button>
        <span className={styles.help}>Double-click or Enter to edit · Space to select</span>
      </div>
      <div
        ref={viewport}
        role="grid"
        aria-label="Library grid"
        aria-multiselectable="true"
        aria-busy={loading || collection.loading}
        aria-activedescendant={focusedVisible ? `browse-photo-${focusedPhoto?.id}` : undefined}
        tabIndex={0}
        data-focus-key="grid"
        data-testid="browse-grid"
        data-cache-chunks={Math.ceil(presentation.photos.size / BROWSE_CHUNK_SIZE)}
        data-cache-photos={presentation.photos.size}
        data-search={presentation.query.search}
        data-grouping={presentation.query.grouping}
        className={styles.viewport}
        onScroll={(event) => {
          if (active) {
            scrollRevision.current++
            setDirection(event.currentTarget.scrollTop < latest.current.scrollTop ? -1 : 1)
            latest.current.scrollTop = event.currentTarget.scrollTop
            setScrollTop(event.currentTarget.scrollTop)
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.altKey) return
          if (event.key === 'Enter' && focusedPhoto && focusedIndex !== null) {
            event.preventDefault()
            onOpen(focusedPhoto.id)
          } else if (event.key === ' ' && focusedPhoto && focusedIndex !== null) {
            event.preventDefault()
            void selection.select(focusedPhoto, presentation.query, { toggle: true })
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            if (!focusedPhoto) return
            event.preventDefault()
            const box =
              document.getElementById(`browse-photo-${focusedPhoto.id}`)?.getBoundingClientRect() ??
              event.currentTarget.getBoundingClientRect()
            onContextMenu(focusedPhoto, event.currentTarget, box.left + 15, box.top + 15)
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
            const index = focusedIndex ?? firstVisibleBrowseIndex(layout, scrollTop)
            const page = Math.max(1, Math.floor(size.height / layout.rowHeight)) * layout.columns
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? (presentation.summary?.total ?? 1) - 1
                  : index +
                    ({
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -layout.columns,
                      ArrowDown: layout.columns,
                      PageUp: -page,
                      PageDown: page,
                    }[event.key] ?? 0)
            const direction = ['ArrowLeft', 'ArrowUp', 'PageUp', 'End'].includes(event.key) ? -1 : 1
            const navigable = browseNavigableIndex(layout, next, direction)
            if (navigable !== null) void focusIndex(navigable)
          }
        }}
      >
        {failure || collection.error ? (
          <div className={styles.empty} role="alert">
            {failure || collection.error}
            <button
              data-focus-key="retry"
              onClick={() => {
                collection.controller.retry()
                void refresh()
              }}
            >
              Retry browsing
            </button>
          </div>
        ) : presentation.summary?.total === 0 ? (
          <div className={styles.empty}>
            {query.search ? 'No photos match your search.' : 'Your library is empty.'}
            {!query.search && (
              <button data-focus-key="import" onClick={onImport}>
                Import photos
              </button>
            )}
          </div>
        ) : !presentation.summary ? (
          <div className={styles.empty} role="status">
            Loading photographs…
          </div>
        ) : (
          <div className={styles.content} style={{ height: layout.height }}>
            {rows.map((row) =>
              row.kind === 'header' ? (
                <div
                  role="row"
                  key={`section-${row.section.key}`}
                  className={styles.section}
                  style={{ top: row.top }}
                  data-testid={`browse-section-${row.section.key}`}
                >
                  <div role="gridcell" className={styles.sectionControls}>
                    <SectionCheckbox
                      count={row.section.count}
                      selected={row.section.selected}
                      label={row.section.label}
                      focusKey={`section-${row.section.key}`}
                      onChange={(checked) =>
                        void selection.section(row.section.key, presentation.query, checked)
                      }
                    />
                    <button
                      className={styles.foldGroup}
                      aria-label={`${collapsed.has(row.section.key) ? 'Expand' : 'Collapse'} ${row.section.label}`}
                      aria-expanded={!collapsed.has(row.section.key)}
                      data-focus-key={`fold-${row.section.key}`}
                      onClick={() => {
                        const next = new Set(collapsed)
                        if (next.has(row.section.key)) next.delete(row.section.key)
                        else next.add(row.section.key)
                        updateCollapsed(next)
                      }}
                    >
                      <ChevronRight size={14} aria-hidden="true" />
                      {row.section.label}
                      <span>
                        {row.section.count} {row.section.count === 1 ? 'photo' : 'photos'}
                      </span>
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  role="row"
                  className={styles.row}
                  key={`${row.section.key}-${row.start}`}
                  style={{
                    top: row.top,
                    height: layout.rowHeight,
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: row.count }, (_, i) => {
                    const index = row.start + i,
                      photo = presentation.photos.get(index)
                    if (!photo)
                      return (
                        <div
                          role="gridcell"
                          key={index}
                          className={styles.placeholder}
                          aria-label="Loading photo"
                        />
                      )
                    const origin =
                      photo.dateOrigin.kind === 'merge-reference'
                        ? `Capture date from merge reference: ${photo.dateOrigin.filename}${photo.captureDate ? ` (${photo.captureDate.slice(0, 10)})` : ' (unknown date)'}`
                        : (photo.captureDate?.slice(0, 10) ?? 'Unknown date')
                    return (
                      <div
                        role="gridcell"
                        aria-selected={selected.has(photo.id)}
                        className={styles.cell}
                        key={photo.id}
                      >
                        <button
                          id={`browse-photo-${photo.id}`}
                          data-testid={`browse-photo-${photo.id}`}
                          tabIndex={-1}
                          className={styles.card}
                          aria-label={`${photo.filename}, ${origin}`}
                          aria-pressed={selected.has(photo.id)}
                          data-focused={focusedPhoto?.id === photo.id}
                          title={origin}
                          onClick={(event) => {
                            focusPhoto(photo, index)
                            if (event.detail < 2)
                              void selection.select(photo, presentation.query, {
                                shift: event.shiftKey,
                                toggle: event.metaKey || event.ctrlKey,
                                click: true,
                              })
                          }}
                          onDoubleClick={() => onOpen(photo.id, true)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            focusPhoto(photo, index)
                            onContextMenu(photo, viewport.current!, event.clientX, event.clientY)
                          }}
                        >
                          <span className={styles.thumbnail}>
                            <CollectionThumbnail url={photo.thumbnailUrl} />
                            <span className={styles.format}>{photo.format}</span>
                          </span>
                          <span className={styles.caption}>
                            <span>{photo.filename}</span>
                            {photo.dateOrigin.kind === 'merge-reference' && (
                              <Layers size={12} className={styles.origin} aria-label={origin} />
                            )}
                          </span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </section>
  )
}
