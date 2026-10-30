import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileImage } from 'lucide-react'
import type { ImportCandidate, ImportReviewSummary } from '../../../shared/contracts'
import { isCollectionChanged, type CollectionAnchor } from '../../../shared/collections'
import { applyCandidateSelection, type SelectionChange } from '../collections/import-selection'
import {
  collectionWindow,
  captureAnchor,
  gridLayout,
  locateAnchor,
  revealNearest,
} from '../collections/layout'
import { currentCollectionPolicy, CollectionRefresh } from '../collections/controller'
import { useCollection } from '../hooks/useCollection'
import { useCollectionThumbnails } from '../hooks/useCollectionThumbnails'
import { CollectionThumbnail } from './CollectionThumbnail'
import styles from '../App.module.css'

interface Record {
  candidate: ImportCandidate
  selectionRevision: number
}
export function ImportCandidates({
  review,
  changes,
  disabled,
  active,
  onSelect,
  onRefresh,
  emptyHint,
}: {
  review: ImportReviewSummary
  changes: SelectionChange[]
  disabled: boolean
  active: boolean
  onSelect: (ids: string[], selected: boolean, candidate: ImportCandidate) => void
  onRefresh: () => void
  emptyHint: string
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 320 })
  const [scrollTop, setScrollTop] = useState(0)
  const [focus, setFocus] = useState<{ id: string; index: number } | null>(null)
  const scrollRevision = useRef(0),
    navigation = useRef(0)
  const [direction, setDirection] = useState<-1 | 1>(1)
  const anchor = useRef<CollectionAnchor | null>(null)
  const restoring = useRef(false)
  const focusRecovery = useRef<{ id: string; element: HTMLInputElement | null } | null>(null)
  const collection = useCollection<Record>((error) => {
    if (!isCollectionChanged(error)) return false
    onRefresh()
    return true
  })
  const columns = Math.max(1, Math.floor((size.width - 48 + 15) / (170 + 15)))
  const cardWidth = (size.width - 48 - (columns - 1) * 15) / columns
  const rowHeight = Math.ceil(Math.max(120, cardWidth - 12) / 1.5) + 70
  const layout = useMemo(
    () => gridLayout(review.total, columns, rowHeight),
    [review.total, columns, rowHeight],
  )
  const window = useMemo(
    () =>
      collectionWindow(
        layout,
        scrollTop,
        size.height,
        direction,
        currentCollectionPolicy().lookahead,
        focus ? [focus.index] : [],
        active,
      ),
    [layout, scrollTop, size.height, focus, active, direction],
  )
  const latest = useRef({ layout, scrollTop, records: collection.records, focus, review })
  useLayoutEffect(() => {
    latest.current = { layout, scrollTop, records: collection.records, focus, review }
  })
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
    const previous = anchor.current,
      ticket = scrollRevision.current
    let live = true
    restoring.current = true
    const focused = document.activeElement
    if (
      focused instanceof HTMLInputElement &&
      viewport.current?.contains(focused) &&
      latest.current.focus
    )
      focusRecovery.current = { id: latest.current.focus.id, element: focused }
    collection.controller.configure(
      `${review.sessionId}:${review.orderingRevision}`,
      review.total,
      async (offset) => {
        const chunk = await globalThis.window.irodori.getReviewChunk(
          review.sessionId,
          offset,
          review.orderingRevision,
        )
        return {
          records: chunk.candidates.map((candidate) => ({
            candidate,
            selectionRevision: chunk.selectionRevision,
          })),
          contentRevision: chunk.contentRevision,
        }
      },
    )
    void (async () => {
      if (previous && !(latest.current.scrollTop <= 1 && !latest.current.focus)) {
        const index = await locateAnchor(
          previous,
          async (id) =>
            (
              await globalThis.window.irodori.locateReviewCandidate(
                review.sessionId,
                id,
                review.orderingRevision,
              )
            )?.index ?? null,
          review.total,
        )
        if (live && ticket === scrollRevision.current && viewport.current) {
          const top = Math.max(
            0,
            Math.min(layout.top(index) + previous.inset, layout.height - size.height),
          )
          viewport.current.scrollTop = top
          latest.current.scrollTop = top
          setScrollTop(top)
        }
      }
      if (latest.current.focus) {
        const location = await globalThis.window.irodori.locateReviewCandidate(
          review.sessionId,
          latest.current.focus.id,
          review.orderingRevision,
        )
        if (live) setFocus(location ? { id: location.candidate.id, index: location.index } : null)
      }
    })()
      .catch((error) => {
        if (live && isCollectionChanged(error)) onRefresh()
      })
      .finally(() => {
        if (live) restoring.current = false
      })
    return () => {
      live = false
    }
  }, [
    collection.controller,
    review.sessionId,
    review.orderingRevision,
    review.total,
    layout,
    size.height,
    onRefresh,
  ])
  useEffect(() => {
    collection.controller.setWindow(window)
  }, [collection.controller, window])
  const [refresh] = useState(() => new CollectionRefresh(async () => {}))
  useLayoutEffect(() => {
    refresh.resume()
    refresh.setWork(async () => {
      await collection.controller.refreshWindow(latest.current.review.contentRevision)
    })
  }, [refresh, collection.controller])
  useEffect(() => {
    void refresh.request().catch((error) => {
      if (isCollectionChanged(error)) onRefresh()
    })
  }, [review.contentRevision, review.selectionRevision, active, onRefresh, refresh])
  useLayoutEffect(() => () => refresh.close(), [refresh])
  useLayoutEffect(() => {
    if (!restoring.current)
      anchor.current =
        captureAnchor(layout, scrollTop, collection.records, (record) => record.candidate.id) ??
        anchor.current
  }, [layout, scrollTop, collection.records])
  useLayoutEffect(() => {
    const recovery = focusRecovery.current
    if (!recovery || recovery.element?.isConnected || !viewport.current) return
    const activeElement = document.activeElement
    if (
      activeElement !== document.body &&
      activeElement !== viewport.current &&
      activeElement !== viewport.current.closest('dialog') &&
      !(recovery.element === null && activeElement && viewport.current.contains(activeElement))
    ) {
      focusRecovery.current = null
      return
    }
    const checkbox = viewport.current.querySelector<HTMLInputElement>(
      `[data-candidate-id="${recovery.id}"] input`,
    )
    if (checkbox && !checkbox.disabled) {
      checkbox.focus({ preventScroll: true })
      focusRecovery.current = null
    }
  }, [collection.records, focus, window])
  useCollectionThumbnails(collection.records, window, (record) => record.candidate.thumbnailUrl)
  const generation = useRef(0)
  useEffect(() => {
    const ids = (indices: number[]) =>
      indices.flatMap((i) => {
        const c = collection.records.get(i)?.candidate
        return c ? [c.id] : []
      })
    const request = {
      generation: ++generation.current,
      visible: active
        ? [...new Set(ids([...window.visible, ...window.overscan, ...(window.pinned ?? [])]))]
        : [],
      lookahead: active ? ids(window.lookahead).slice(0, currentCollectionPolicy().records) : [],
    }
    void globalThis.window.irodori
      .requestReviewThumbnails(review.sessionId, request)
      .catch(() => {})
  }, [collection.records, window, active, review.sessionId])
  useEffect(
    () => () => {
      void globalThis.window.irodori
        .requestReviewThumbnails(review.sessionId, {
          generation: ++generation.current,
          visible: [],
          lookahead: [],
        })
        .catch(() => {})
    },
    [review.sessionId],
  )
  async function focusIndex(index: number) {
    const ticket = ++navigation.current
    index = Math.max(0, Math.min(review.total - 1, index))
    try {
      const record = await collection.controller.get(index)
      if (!record || ticket !== navigation.current || !viewport.current) return
      focusRecovery.current = { id: record.candidate.id, element: null }
      setFocus({ id: record.candidate.id, index })
      const top = revealNearest(viewport.current, layout.top(index), rowHeight)
      scrollRevision.current++
      setScrollTop(top)
      requestAnimationFrame(() =>
        viewport.current
          ?.querySelector<HTMLInputElement>(`[data-candidate-id="${record.candidate.id}"] input`)
          ?.focus({ preventScroll: true }),
      )
    } catch (error) {
      if (isCollectionChanged(error)) onRefresh()
    }
  }
  return (
    <div
      ref={viewport}
      className={styles.importGrid}
      aria-label="Import candidates"
      data-testid="import-scroll"
      data-row-height={rowHeight}
      data-columns={columns}
      data-cache-photos={collection.records.size}
      tabIndex={0}
      aria-busy={collection.loading}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop
        setDirection(top < latest.current.scrollTop ? -1 : 1)
        if (top !== latest.current.scrollTop) scrollRevision.current++
        latest.current.scrollTop = top
        setScrollTop(top)
      }}
      onKeyDown={(event) => {
        if (
          event.altKey ||
          ![
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key)
        )
          return
        event.preventDefault()
        const index = focus?.index ?? layout.first(scrollTop),
          amount = Math.max(1, Math.floor(size.height / rowHeight)) * columns
        void focusIndex(
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? review.total - 1
              : index +
                ({
                  ArrowLeft: -1,
                  ArrowRight: 1,
                  ArrowUp: -columns,
                  ArrowDown: columns,
                  PageUp: -amount,
                  PageDown: amount,
                }[event.key] ?? 0),
        )
      }}
    >
      {collection.error && (
        <p role="alert" className={styles.collectionError}>
          {collection.error}{' '}
          <button
            onClick={() => {
              collection.controller.retry()
              onRefresh()
            }}
          >
            Retry photographs
          </button>
        </p>
      )}
      <div className={styles.importContent} style={{ height: layout.height }}>
        {window.overscan.map((index) => {
          const record = collection.records.get(index)
          const style = {
            top: layout.top(index),
            left: 24 + (index % columns) * (cardWidth + 15),
            width: cardWidth,
          }
          if (!record)
            return (
              <div
                key={index}
                className={styles.importPlaceholder}
                style={{ ...style, height: rowHeight - 15 }}
                role="status"
                aria-label="Loading photo"
              />
            )
          const candidate = applyCandidateSelection(
            record.candidate,
            record.selectionRevision,
            changes,
            review.onlyMissing,
          )
          return (
            <label
              key={candidate.id}
              data-candidate-id={candidate.id}
              className={`${styles.importCard} ${candidate.selected ? styles.importSelected : ''}`}
              title={candidate.relativePath}
              style={style}
            >
              <div className={styles.importThumbnail}>
                {candidate.thumbnailUrl ? (
                  <CollectionThumbnail url={candidate.thumbnailUrl} />
                ) : (
                  <FileImage size={30} strokeWidth={1} />
                )}
                <input
                  type="checkbox"
                  aria-label={`Import ${candidate.filename}`}
                  aria-describedby={
                    candidate.alreadyImported ? `import-candidate-${candidate.id}` : undefined
                  }
                  checked={candidate.selected}
                  disabled={
                    disabled ||
                    (review.onlyMissing && candidate.alreadyImported) ||
                    !['unchecked', 'ready'].includes(candidate.status)
                  }
                  onFocus={() => setFocus({ id: candidate.id, index })}
                  onChange={(event) => onSelect([candidate.id], event.target.checked, candidate)}
                />
              </div>
              <strong>{candidate.filename}</strong>
              <span id={`import-candidate-${candidate.id}`}>
                {candidate.alreadyImported
                  ? 'Already in library'
                  : (candidate.message ??
                    (candidate.status === 'imported'
                      ? 'Imported'
                      : candidate.thumbnailState === 'loading'
                        ? 'Loading thumbnail…'
                        : candidate.thumbnailState === 'error'
                          ? 'Thumbnail unavailable'
                          : `${Math.ceil(candidate.bytes / 1024)} KB`))}
              </span>
            </label>
          )
        })}
      </div>
      {!review.total && review.phase !== 'scanning' && (
        <p className={styles.importEmpty}>No supported photographs found. {emptyHint}</p>
      )}
    </div>
  )
}
