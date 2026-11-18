import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type {
  EditCheckpoint,
  EditCheckpointPage,
  EditCheckpointSummary,
  EditComparisonSource,
} from '../../../shared/edit-checkpoints'
import { isCollectionChanged } from '../../../shared/collections'
import { CollectionRefresh, currentCollectionPolicy } from '../collections/controller'
import { collectionWindow, gridLayout, revealNearest } from '../collections/layout'
import { useCollection } from '../hooks/useCollection'
import type { EditCheckpointsController } from '../hooks/useEditCheckpoints'
import { Button, IconButton } from './ui/Controls'
import { CommandMenu, type MenuInitialFocus } from './ui/CommandMenu'
import { EditCheckpointDialog, type EditCheckpointDialogAction } from './EditCheckpointDialog'
import styles from './EditCheckpoints.module.css'

const rowHeight = 44
type SourceChoice = EditCheckpointSummary | null
const sourceId = (source: SourceChoice | undefined) => source?.id ?? 'current'

export function EditCheckpoints({
  active,
  photoId,
  blocked,
  checkpoints,
}: {
  active: boolean
  photoId: string | null
  blocked: boolean
  checkpoints: EditCheckpointsController
}) {
  const scope = useMemo(() => ({ photoId }), [photoId])
  const latest = useRef({ photoId, scope, active })
  useLayoutEffect(() => {
    latest.current = { photoId, scope, active }
  })
  const [summary, setSummary] = useState<{ scope: object; page: EditCheckpointPage } | null>(null)
  const [selection, setSelection] = useState<{ scope: object; id: string } | null>(null)
  const selectedId = selection?.scope === scope ? selection.id : null
  const page = summary?.scope === scope ? summary.page : null
  const [details, setDetails] = useState<{ scope: object; checkpoint: EditCheckpoint } | null>(null)
  const selected =
    details?.scope === scope && details.checkpoint.id === selectedId ? details.checkpoint : null
  const [choices, setChoices] = useState<{
    scope: object
    a: SourceChoice | undefined
    b: SourceChoice
  } | null>(null)
  const a = choices?.scope === scope ? choices.a : undefined
  const b = choices?.scope === scope ? choices.b : null
  const baseline = a === undefined ? selected : a
  const selectRow = (row: EditCheckpointSummary) => {
    setSelection({ scope, id: row.id })
    setChoices((previous) =>
      previous?.scope === scope && previous.a !== undefined ? previous : { scope, a: row, b: null },
    )
  }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState<{ scope: object; value: EditCheckpointDialogAction } | null>(
    null,
  )
  const [menu, setMenu] = useState<{
    scope: object
    row: EditCheckpointSummary
    trigger: HTMLButtonElement
    x: number
    y: number
    initialFocus: MenuInitialFocus
  } | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ scope: object; id: string } | null>(null)
  const anchor = useRef<{ scope: object; id: string; index: number; inset: number } | null>(null)
  const restoreAnchor = useRef(true)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(132)
  const [direction, setDirection] = useState<-1 | 1>(1)
  const [refresh] = useState(() => new CollectionRefresh(async () => {}))
  const stale = useCallback(
    (error: unknown) => {
      if (!isCollectionChanged(error)) return false
      void refresh.request().catch(() => {})
      return true
    },
    [refresh],
  )
  const collection = useCollection<EditCheckpointSummary>(stale)
  useEffect(() => {
    let live = true
    refresh.resume()
    refresh.setWork(async () => {
      const captured = latest.current
      if (!captured.photoId) return
      setLoading(true)
      setError('')
      try {
        const page = await window.irodori.listEditCheckpoints(captured.photoId, {
          anchorId: anchor.current?.scope === captured.scope ? anchor.current.id : undefined,
        })
        if (!live || latest.current.scope !== captured.scope) return
        restoreAnchor.current = true
        setSummary({ scope: captured.scope, page })
      } catch (error) {
        if (live && latest.current.scope === captured.scope) setError(String(error))
      } finally {
        if (live && latest.current.scope === captured.scope) setLoading(false)
      }
    })
    const unsubscribe = window.irodori.onLibraryEvent((event) => {
      if (event.editCheckpointsChanged?.photoId === latest.current.photoId) void refresh.request()
    })
    return () => {
      live = false
      refresh.close()
      unsubscribe()
    }
  }, [refresh])
  useEffect(() => {
    collection.controller.configure(`checkpoints:${photoId ?? 'empty'}`, 0, async () => ({
      records: [],
    }))
    restoreAnchor.current = true
    if (photoId) void refresh.request()
  }, [photoId, refresh, collection.controller])
  useEffect(() => {
    let current = true
    if (!selectedId || !photoId || !page) return
    void window.irodori
      .getEditCheckpoint(photoId, selectedId)
      .then((checkpoint) => {
        if (current) setDetails({ scope, checkpoint })
      })
      .catch((error) => {
        if (current) {
          setSelection(null)
          setDetails(null)
          setError(String(error))
        }
      })
    return () => {
      current = false
    }
  }, [photoId, selectedId, page, scope])
  const layout = useMemo(() => gridLayout(page?.total ?? 0, 1, rowHeight), [page?.total])
  const visible = useMemo(
    () =>
      collectionWindow(
        layout,
        top,
        height,
        direction,
        currentCollectionPolicy().lookahead,
        [],
        active && !!photoId,
      ),
    [layout, top, height, direction, active, photoId],
  )
  useEffect(() => {
    if (!page || !photoId) return
    const revision = page.storeRevision
    collection.controller.configure(
      `checkpoints:${photoId}:${revision}`,
      page.total,
      async (offset) => ({
        records:
          offset === 0
            ? page.checkpoints
            : (
                await window.irodori.listEditCheckpoints(photoId, {
                  offset,
                  expectedStoreRevision: revision,
                })
              ).checkpoints,
      }),
    )
  }, [page, photoId, collection.controller])
  useEffect(() => {
    collection.controller.setWindow(visible)
  }, [collection.controller, visible])
  useLayoutEffect(() => {
    if (!active || !viewport.current || !page || !restoreAnchor.current) return
    const saved = anchor.current?.scope === scope ? anchor.current : null
    const index = page.anchorIndex ?? Math.min(saved?.index ?? 0, Math.max(0, page.total - 1))
    viewport.current.scrollTop = layout.top(index) + (saved?.inset ?? 0)
    setTop(viewport.current.scrollTop)
    restoreAnchor.current = false
  }, [active, page, layout, scope])
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || pending.scope !== scope || !active || selectedId !== pending.id) return
    const row = viewport.current?.querySelector<HTMLButtonElement>(
      `[data-checkpoint-id="${pending.id}"]`,
    )
    if (!row) return
    pendingFocus.current = null
    row.focus({ preventScroll: true })
  }, [active, scope, selectedId, visible, collection.records])
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setHeight(entry.contentRect.height)
    })
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  const scroll = (scrollTop: number) => {
    setDirection(scrollTop < top ? -1 : 1)
    setTop(scrollTop)
    const index = layout.first(scrollTop)
    const row = collection.records.get(index)
    if (row) anchor.current = { scope, id: row.id, index, inset: scrollTop - layout.top(index) }
  }
  const navigate = async (index: number) => {
    if (index < 0 || index >= (page?.total ?? 0)) return
    const captured = scope
    try {
      const row = await collection.controller.get(index)
      if (!row || latest.current.scope !== captured || !latest.current.active) return
      pendingFocus.current = { scope, id: row.id }
      selectRow(row)
      if (viewport.current) scroll(revealNearest(viewport.current, layout.top(index), rowHeight))
    } catch (error) {
      setError(String(error))
    }
  }
  const closeMenu = useCallback(
    (restore = false) => {
      setMenu(null)
      if (restore && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true })
    },
    [menu],
  )
  const openMenu = (
    row: EditCheckpointSummary,
    trigger: HTMLButtonElement,
    initialFocus: MenuInitialFocus = 'first',
  ) => {
    if (menu?.trigger === trigger) return closeMenu(true)
    const bounds = trigger.getBoundingClientRect()
    setMenu({ scope, row, trigger, x: bounds.right - 180, y: bounds.bottom + 4, initialFocus })
  }
  const manage = async (mode: 'rename' | 'delete') => {
    if (!menu || !photoId) return
    const captured = menu
    closeMenu(true)
    try {
      const checkpoint = await window.irodori.getEditCheckpoint(photoId, captured.row.id)
      if (latest.current.scope === captured.scope) setAction({ scope, value: { mode, checkpoint } })
    } catch (error) {
      setError(String(error))
    }
  }
  const options = [
    ...new Map(
      [selected, baseline, b].flatMap((row) => (row ? [[row.id, row] as const] : [])),
    ).values(),
  ]
  const choose = (member: 'a' | 'b', id: string) => {
    const choice = options.find((row) => row.id === id) ?? null
    setChoices({ scope, a: baseline, b, [member]: choice })
  }
  const source = (row: SourceChoice): EditComparisonSource =>
    row
      ? { kind: 'checkpoint', checkpointId: row.id, expectedCheckpointRevision: row.revision }
      : { kind: 'current', expectedRevision: 0 }
  const working = checkpoints.busy || loading
  const canCompare = !!photoId && sourceId(baseline) !== sourceId(b)
  return (
    <section className={styles.panel} aria-label="Versions">
      <header>
        <h2>Versions</h2>
        <Button
          disabled={!photoId || blocked || checkpoints.active || working}
          onClick={() => setAction({ scope, value: { mode: 'new' } })}
        >
          Save checkpoint…
        </Button>
      </header>
      <div
        ref={viewport}
        className={styles.list}
        role="list"
        aria-label="Saved checkpoints"
        aria-busy={loading || collection.loading}
        tabIndex={0}
        data-cache-records={collection.records.size}
        onScroll={(event) => {
          closeMenu(false)
          scroll(event.currentTarget.scrollTop)
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = [...collection.records].find(([, row]) => row.id === selectedId)?.[0] ?? -1
          void navigate(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? (page?.total ?? 0) - 1
                : Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
          )
        }}
      >
        {!photoId ? (
          <p>Select a photograph to save or inspect its versions.</p>
        ) : loading && !page ? (
          <p role="status">Loading checkpoints…</p>
        ) : page?.total === 0 ? (
          <p>No checkpoints yet. Save a version before your next editing pass.</p>
        ) : null}
        <div style={{ height: layout.height, position: 'relative' }}>
          {visible.overscan.map((index) => {
            const row = collection.records.get(index)
            return row ? (
              <div
                key={row.id}
                role="listitem"
                className={styles.row}
                data-selected={selectedId === row.id}
                style={{ top: layout.top(index) }}
              >
                <button
                  type="button"
                  className={styles.select}
                  data-checkpoint-id={row.id}
                  aria-label={`${row.name} checkpoint`}
                  aria-pressed={selectedId === row.id}
                  tabIndex={selectedId === row.id ? 0 : -1}
                  onClick={() => selectRow(row)}
                >
                  <strong>{row.name}</strong>
                  <span>
                    Saved edit {row.capturedFromRevision} ·{' '}
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </button>
                <IconButton
                  icon={MoreHorizontal}
                  label={`Actions for ${row.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.scope === scope && menu.row.id === row.id}
                  disabled={working}
                  onClick={(event) => openMenu(row, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      event.stopPropagation()
                      openMenu(row, event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first')
                    }
                  }}
                />
              </div>
            ) : (
              <div
                key={index}
                className={styles.row}
                style={{ top: layout.top(index) }}
                role="status"
              >
                Loading checkpoint…
              </div>
            )
          })}
        </div>
      </div>
      {(error || collection.error || checkpoints.error) && (
        <p className={styles.error} role="alert">
          {error || collection.error || checkpoints.error}{' '}
          {(error || collection.error) && (
            <Button
              onClick={() => {
                collection.controller.retry()
                void refresh.request()
              }}
            >
              Retry checkpoints
            </Button>
          )}
        </p>
      )}
      <div className={styles.comparison}>
        <p className={styles.hint}>
          {checkpoints.active
            ? 'Read-only comparison. End comparison to continue editing.'
            : 'Select a checkpoint, then choose it for A or B. Compare changes no saved edits.'}
        </p>
        {(['a', 'b'] as const).map((member) => (
          <label key={member}>
            <span>{member.toUpperCase()}</span>
            <select
              aria-label={member === 'a' ? 'Comparison A' : 'Comparison B'}
              value={sourceId(member === 'a' ? baseline : b)}
              disabled={!photoId || checkpoints.active || working}
              onChange={(event) => choose(member, event.target.value)}
            >
              <option value="current">Current edits</option>
              {options.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div className={styles.actions}>
          {checkpoints.active ? (
            <Button onClick={checkpoints.close}>End comparison</Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canCompare || blocked || working}
              onClick={() => void checkpoints.compare(source(baseline), source(b))}
            >
              Compare
            </Button>
          )}
          <Button
            disabled={!selected || blocked || working}
            onClick={() => selected && void checkpoints.restore(selected)}
          >
            Restore selected
          </Button>
        </div>
        {checkpoints.preparing && <p role="status">Preparing version comparison…</p>}
      </div>
      {menu?.scope === scope && active && (
        <CommandMenu<'rename' | 'delete'>
          id="checkpoint-actions"
          label={`Actions for ${menu.row.name}`}
          x={menu.x}
          y={menu.y}
          initialFocus={menu.initialFocus}
          sections={[
            {
              id: 'checkpoint',
              actions: [
                { id: 'rename', label: 'Rename…' },
                { id: 'delete', label: 'Delete…', destructive: true },
              ],
            },
          ]}
          onClose={closeMenu}
          onAction={(mode) => void manage(mode)}
        />
      )}
      {action?.scope === scope && (
        <EditCheckpointDialog
          action={action.value}
          checkpoints={checkpoints}
          onClose={() => setAction(null)}
          onSaved={(checkpoint) => {
            setSelection(checkpoint ? { scope, id: checkpoint.id } : null)
            setDetails(checkpoint ? { scope, checkpoint } : null)
            setChoices((previous) => {
              if (!previous || previous.scope !== scope)
                return checkpoint ? { scope, a: checkpoint, b: null } : null
              const replacedId = 'checkpoint' in action.value ? action.value.checkpoint.id : null
              const update = (source: SourceChoice | undefined) =>
                source?.id === replacedId ? checkpoint : source
              return { scope, a: update(previous.a), b: update(previous.b) ?? null }
            })
            void refresh.request()
          }}
        />
      )}
    </section>
  )
}
