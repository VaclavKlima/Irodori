import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from './ui/Controls'
import { editTransferGroups, type EditTransferGroup } from '../../../shared/edit-transfer'
import {
  presetGroupKeys,
  type EditingPreset,
  type PresetPage,
  type PresetSummary,
  type PresetWorkspace,
} from '../../../shared/presets'
import { isCollectionChanged } from '../../../shared/collections'
import { CollectionRefresh, currentCollectionPolicy } from '../collections/controller'
import { collectionWindow, gridLayout, revealNearest } from '../collections/layout'
import { useCollection } from '../hooks/useCollection'
import { PresetDialog, type PresetDialogAction } from './PresetDialog'
import styles from './Presets.module.css'
import { PresetIcon } from './PresetIcon'
import { presetAppearanceLabel } from '../../../shared/preset-appearance'

const rowHeight = 44
const groupLabel = (id: EditTransferGroup) =>
  id === 'color'
    ? 'Color'
    : id === 'sharpening'
      ? 'Sharpening'
      : editTransferGroups.find((g) => g.id === id)!.label
const labels: Record<string, string> = {
  exposureEv: 'Exposure (EV)',
  kelvin: 'Temperature (K)',
  mode: 'Mode',
  chromaticAberration: 'Chromatic aberration',
}
const label = (key: string) =>
  labels[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
function describe(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (value === null) return 'Unconstrained'
  if (Array.isArray(value))
    return value.map((point) => `(${point.input}, ${point.output})`).join(' → ')
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(([key]) => key !== 'version')
      .map(([key, v]) => `${label(key)}: ${describe(v)}`)
      .join(' · ')
  return String(value)
}

export function Presets({
  active,
  photoId,
  selectionCount,
  blocked,
  state,
  onState,
  onApply,
}: {
  active: boolean
  photoId: string | null
  selectionCount: number
  blocked: boolean
  state: PresetWorkspace
  onState: (state: PresetWorkspace) => void
  onApply: (preset: EditingPreset, selection: boolean) => Promise<void>
}) {
  const latest = useRef(state),
    activeRef = useRef(active)
  useLayoutEffect(() => {
    latest.current = state
    activeRef.current = active
  })
  const change = useCallback(
    (patch: Partial<PresetWorkspace>) => {
      const next = { ...latest.current, ...patch }
      latest.current = next
      onState(next)
    },
    [onState],
  )
  const [summary, setSummary] = useState<{ page: PresetPage; search: string } | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const page = summary?.search === state.search ? summary.page : null
  const [details, setDetails] = useState<{ preset: EditingPreset; storeRevision: number } | null>(
    null,
  )
  const selected =
    details?.preset.id === state.selectedId && details.storeRevision === page?.storeRevision
      ? details.preset
      : null
  const reading = !!state.selectedId && !selected
  const [action, setAction] = useState<PresetDialogAction | null>(null),
    [applying, setApplying] = useState(false)
  const viewport = useRef<HTMLDivElement>(null),
    restore = useRef(true)
  const [top, setTop] = useState(0),
    [height, setHeight] = useState(160),
    [direction, setDirection] = useState<-1 | 1>(1)
  const [refresh] = useState(() => new CollectionRefresh(async () => {}))
  const stale = useCallback(
    (error: unknown) => {
      if (!isCollectionChanged(error)) return false
      void refresh.request().catch(() => {})
      return true
    },
    [refresh],
  )
  const collection = useCollection<PresetSummary>(stale)
  useEffect(() => {
    let current = true
    refresh.resume()
    refresh.setWork(async () => {
      const search = latest.current.search
      setLoading(true)
      setError('')
      try {
        const page = await window.irodori.listPresets({
          search,
          anchorId: latest.current.anchor?.id,
        })
        if (!current || search !== latest.current.search) return
        restore.current = true
        setSummary({ page, search })
      } catch (error) {
        if (current) setError(String(error))
      } finally {
        if (current) setLoading(false)
      }
    })
    const unsubscribe = window.irodori.onLibraryEvent((event) => {
      if (event.presetsChanged) void refresh.request()
    })
    return () => {
      current = false
      refresh.close()
      unsubscribe()
    }
  }, [refresh])
  useEffect(() => {
    void refresh.request()
  }, [state.search, refresh])
  useEffect(() => {
    let current = true
    if (!state.selectedId || !page) return
    const storeRevision = page.storeRevision
    void window.irodori
      .getPreset(state.selectedId)
      .then((preset) => {
        if (current) setDetails({ preset, storeRevision })
      })
      .catch((error) => {
        if (current) {
          if (String(error).includes('preset is unavailable')) change({ selectedId: null })
          else setError(String(error))
        }
      })
    return () => {
      current = false
    }
  }, [state.selectedId, page, change])
  const layout = useMemo(() => gridLayout(page?.total ?? 0, 1, rowHeight), [page?.total])
  const visibleWindow = useMemo(
    () =>
      collectionWindow(
        layout,
        top,
        height,
        direction,
        currentCollectionPolicy().lookahead,
        [],
        active,
      ),
    [layout, top, height, direction, active],
  )
  useEffect(() => {
    if (!page) return
    const search = state.search,
      revision = page.storeRevision
    collection.controller.configure(`${search}:${revision}`, page.total, async (offset) => ({
      records:
        offset === 0
          ? page.presets
          : (
              await globalThis.window.irodori.listPresets({
                search,
                offset,
                expectedStoreRevision: revision,
              })
            ).presets,
    }))
  }, [collection.controller, page, state.search])
  useEffect(() => {
    collection.controller.setWindow(visibleWindow)
  }, [collection.controller, visibleWindow])
  useLayoutEffect(() => {
    if (!active || !viewport.current || !page) return
    if (restore.current) {
      const anchor = latest.current.anchor
      const index = page.anchorIndex ?? Math.min(anchor?.index ?? 0, Math.max(0, page.total - 1))
      viewport.current.scrollTop = layout.top(index) + (anchor?.inset ?? 0)
      setTop(viewport.current.scrollTop)
      restore.current = false
    }
  }, [active, page, layout])
  useEffect(() => {
    if (!viewport.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setHeight(entry.contentRect.height)
    })
    observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [])
  function scroll(scrollTop: number) {
    setDirection(scrollTop < top ? -1 : 1)
    setTop(scrollTop)
    const index = layout.first(scrollTop),
      row = collection.records.get(index)
    if (row)
      change({
        anchor: { id: row.id, index, inset: scrollTop - layout.top(index) },
      })
  }
  async function navigate(index: number) {
    if (index < 0 || index >= (page?.total ?? 0)) return
    try {
      const row = await collection.controller.get(index)
      if (!row || !activeRef.current) return
      change({ selectedId: row.id })
      if (viewport.current) scroll(revealNearest(viewport.current, layout.top(index), rowHeight))
      requestAnimationFrame(() =>
        viewport.current?.querySelector<HTMLButtonElement>(`[data-preset-id="${row.id}"]`)?.focus(),
      )
    } catch (error) {
      setError(String(error))
    }
  }
  async function apply(selection: boolean) {
    if (!selected || applying) return
    setApplying(true)
    setError('')
    try {
      await onApply(selected, selection)
    } catch (error) {
      setError(String(error))
    } finally {
      setApplying(false)
    }
  }
  return (
    <section className={styles.panel} aria-label="Presets">
      <header>
        <h2>Presets</h2>
        <Button
          disabled={!photoId || blocked}
          onClick={() => photoId && setAction({ mode: 'new', photoId })}
        >
          + New…
        </Button>
      </header>
      <input
        className={styles.search}
        type="search"
        aria-label="Search presets"
        placeholder="Search presets"
        value={state.search}
        maxLength={500}
        onChange={(event) => {
          restore.current = true
          change({ search: event.target.value, anchor: null })
        }}
      />
      <div
        className={styles.list}
        ref={viewport}
        role="listbox"
        aria-label="Saved presets"
        aria-busy={loading || collection.loading}
        tabIndex={0}
        data-cache-records={collection.records.size}
        onScroll={(event) => scroll(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index =
            [...collection.records].find(([, p]) => p.id === latest.current.selectedId)?.[0] ?? -1
          void navigate(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? (page?.total ?? 0) - 1
                : Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
          )
        }}
      >
        {loading && !page && <p role="status">Loading presets…</p>}
        {page?.total === 0 && !loading && (
          <p>
            {state.search
              ? 'No matching presets.'
              : 'No presets yet. Save edits from a photo with New…'}
          </p>
        )}
        <div style={{ height: layout.height, position: 'relative' }}>
          {visibleWindow.overscan.map((index) => {
            const row = collection.records.get(index)
            return row ? (
              <button
                type="button"
                role="option"
                aria-selected={state.selectedId === row.id}
                aria-description={presetAppearanceLabel(row.appearance)}
                title={`${row.name} · ${presetAppearanceLabel(row.appearance)}`}
                data-preset-id={row.id}
                className={styles.row}
                key={row.id}
                tabIndex={state.selectedId === row.id ? 0 : -1}
                style={{ top: layout.top(index) }}
                onClick={() => change({ selectedId: row.id })}
              >
                <PresetIcon appearance={row.appearance} />
                <div className={styles.rowText}>
                  <strong>{row.name}</strong>
                  <span>{row.groups.map(groupLabel).join(' · ')}</span>
                </div>
              </button>
            ) : (
              <div
                className={styles.row}
                key={index}
                style={{ top: layout.top(index) }}
                role="status"
              >
                Loading preset…
              </div>
            )
          })}
        </div>
      </div>
      <details className={styles.included}>
        <summary>
          Included settings{' '}
          <span>{selected ? `${selected.definition.groups.length} groups` : ''}</span>
        </summary>
        {reading ? (
          <p role="status">Reading preset…</p>
        ) : selected ? (
          <>
            <p>
              {selected.name} · Revision {selected.revision}
            </p>
            {selected.definition.groups.map((group) => (
              <div key={group}>
                <h3>{groupLabel(group)}</h3>
                <p>
                  {describe(
                    Object.fromEntries(
                      Object.entries(selected.definition.values).filter(([key]) =>
                        (presetGroupKeys[group] as readonly string[]).includes(key),
                      ),
                    ),
                  )}
                </p>
              </div>
            ))}
          </>
        ) : (
          <p>Select a preset to inspect its saved settings. Selecting changes no photo.</p>
        )}
      </details>
      {(error || collection.error) && (
        <p className={styles.error} role="alert">
          {error || collection.error}{' '}
          <Button
            onClick={() => {
              collection.controller.retry()
              void refresh.request()
            }}
          >
            Retry presets
          </Button>
        </p>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={!selected || !photoId || blocked || reading || applying}
          onClick={() => void apply(false)}
        >
          Apply to current photo
        </Button>
        <Button
          disabled={!selected || !selectionCount || blocked || reading || applying}
          onClick={() => void apply(true)}
        >
          Apply to selection · {selectionCount} {selectionCount === 1 ? 'photo' : 'photos'}
        </Button>
        <div>
          <Button
            disabled={!selected || reading || applying}
            onClick={() => selected && setAction({ mode: 'details', preset: selected })}
          >
            Edit details…
          </Button>
          <Button
            disabled={!selected || !photoId || blocked || reading || applying}
            onClick={() =>
              selected && photoId && setAction({ mode: 'update', preset: selected, photoId })
            }
          >
            Update…
          </Button>
          <Button
            variant="danger"
            disabled={!selected || reading || applying}
            onClick={() => selected && setAction({ mode: 'delete', preset: selected })}
          >
            Delete…
          </Button>
        </div>
      </div>
      {action && (
        <PresetDialog
          action={action}
          onClose={() => setAction(null)}
          onSaved={(preset) => {
            change({ selectedId: preset?.id ?? null })
            void refresh.request()
          }}
        />
      )}
    </section>
  )
}
