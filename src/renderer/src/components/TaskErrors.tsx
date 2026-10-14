import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TaskErrorPage } from '../../../shared/contracts'
import { collectionWindow, measuredLayout } from '../collections/layout'
import { currentCollectionPolicy } from '../collections/controller'
import { useCollection } from '../hooks/useCollection'
import styles from './TaskProgress.module.css'

function ErrorRow({
  entry,
  index,
  top,
  onMeasure,
}: {
  entry: TaskErrorPage['errors'][number]
  index: number
  top: number
  onMeasure: (index: number, height: number) => void
}) {
  const element = useRef<HTMLLIElement>(null)
  useLayoutEffect(() => {
    if (!element.current) return
    const observer = new ResizeObserver(([entry]) =>
      onMeasure(index, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height),
    )
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [index, onMeasure])
  return (
    <li ref={element} style={{ top }}>
      <strong>{entry.filename}</strong>
      <span>{entry.message}</span>
    </li>
  )
}
export function TaskErrors({
  id,
  total,
  active,
  getErrors,
}: {
  id: string
  total: number
  active: boolean
  getErrors: (id: string, offset: number) => Promise<TaskErrorPage>
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0),
    [height, setHeight] = useState(240)
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(new Map())
  const [direction, setDirection] = useState<-1 | 1>(1)
  const layout = useMemo(() => measuredLayout(total, heights), [total, heights])
  const collection = useCollection<TaskErrorPage['errors'][number]>()
  const window = useMemo(
    () =>
      collectionWindow(
        layout,
        scrollTop,
        height,
        direction,
        currentCollectionPolicy().lookahead,
        [],
        active,
      ),
    [layout, scrollTop, height, active, direction],
  )
  const latest = useRef({ layout, scrollTop })
  const restoration = useRef<{ index: number; inset: number } | null>(null)
  useLayoutEffect(() => {
    latest.current = { layout, scrollTop }
  })
  const measure = useCallback((index: number, height: number) => {
    if (height <= 0) return
    const view = latest.current,
      first = view.layout.first(view.scrollTop)
    setHeights((previous) => {
      if (Math.abs((previous.get(index) ?? 0) - height) < 0.5) return previous
      restoration.current = { index: first, inset: view.scrollTop - view.layout.top(first) }
      const next = new Map(previous)
      next.set(index, height)
      return next
    })
  }, [])
  useLayoutEffect(() => {
    if (!active || !viewport.current) return
    const restore = restoration.current
    const top = restore ? layout.top(restore.index) + restore.inset : latest.current.scrollTop
    viewport.current.scrollTop = top
    restoration.current = null
    if (top !== latest.current.scrollTop) {
      latest.current.scrollTop = top
      setScrollTop(top)
    }
  }, [layout, active])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    collection.controller.configure(id, total, async (offset) => ({
      records: (await getErrors(id, offset)).errors,
    }))
  }, [collection.controller, id, total, getErrors])
  useEffect(() => {
    collection.controller.setWindow(window)
  }, [collection.controller, window])
  return (
    <div
      ref={viewport}
      hidden={!active}
      className={styles.errors}
      data-testid={`task-errors-${id}`}
      tabIndex={0}
      aria-label="Task errors"
      aria-busy={collection.loading}
      data-cache-records={collection.records.size}
      onScroll={(event) => {
        if (!active) return
        setDirection(event.currentTarget.scrollTop < latest.current.scrollTop ? -1 : 1)
        latest.current.scrollTop = event.currentTarget.scrollTop
        setScrollTop(event.currentTarget.scrollTop)
      }}
    >
      {collection.error && (
        <p role="alert">
          {collection.error}{' '}
          <button onClick={() => collection.controller.retry()}>Retry errors</button>
        </p>
      )}
      <ul style={{ height: layout.height }}>
        {window.overscan.map((index) => {
          const entry = collection.records.get(index)
          return entry ? (
            <ErrorRow
              key={index}
              entry={entry}
              index={index}
              top={layout.top(index)}
              onMeasure={measure}
            />
          ) : (
            <li
              key={index}
              style={{ top: layout.top(index), height: heights.get(index) ?? 68 }}
              role="status"
            >
              Loading error…
            </li>
          )
        })}
      </ul>
    </div>
  )
}
