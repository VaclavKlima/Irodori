import { useCallback, useRef, useState } from 'react'
import type { GallerySummary } from '../../../shared/stacks'
import type { WorkspaceSnapshot } from '../../../shared/workspace'
import { isCollectionChanged } from '../../../shared/collections'
import type { BrowseQuery } from '../../../shared/browse'
import type { LibraryEvent, Photo, PhotoReference } from '../../../shared/contracts'

interface LibraryState {
  summary: GallerySummary | null
  storedTotal: number
  hiddenActiveCover: PhotoReference | null
  total: number
  position: number
  photo: Photo | null
  selected: Map<string, PhotoReference>
  anchor: string | null
  activeId: string | null
  reveal: { id: string; request: number } | null
}
export interface SelectionModifiers {
  shift?: boolean
  toggle?: boolean
  click?: boolean
}

export function useLibrary(onError: (error: string) => void, onActivePhotoChange?: () => void) {
  const [state, setState] = useState<LibraryState>({
    summary: null,
    storedTotal: 0,
    hiddenActiveCover: null,
    total: 0,
    position: 0,
    photo: null,
    selected: new Map(),
    anchor: null,
    activeId: null,
    reveal: null,
  })
  const current = useRef(state)
  const request = useRef(0)
  const refreshing = useRef(0)
  const refreshWork = useRef<Promise<void> | null>(null)
  const refreshDirty = useRef(false)
  const importedDuringRefresh = useRef<string | undefined>(undefined)
  const initialized = useRef(false)
  const pendingSelection = useRef(Promise.resolve())
  const pendingCount = useRef(0)
  const selectionRevision = useRef(0)
  const selectionError = useRef<unknown>(null)
  const deletionRevision = useRef(0)
  const deletedAt = useRef(new Map<string, number>())
  const browserClick = useRef<{
    id: string
    revision: number
    since: number
    selected: Map<string, PhotoReference>
    anchor: string | null
  } | null>(null)
  const update = useCallback(
    (next: Partial<LibraryState>) => {
      if (next.activeId !== undefined && next.activeId !== current.current.activeId)
        onActivePhotoChange?.()
      current.current = { ...current.current, ...next }
      setState(current.current)
    },
    [onActivePhotoChange],
  )

  const hydrate = useCallback(
    (snapshot: WorkspaceSnapshot) => {
      initialized.current = snapshot.state !== null
      update({
        selected: new Map(snapshot.selected.map((p) => [p.id, p])),
        anchor: snapshot.state?.rangeAnchorId ?? null,
        activeId: snapshot.activePhoto?.id ?? null,
        photo: snapshot.activePhoto,
      })
    },
    [update],
  )
  const refresh = useCallback(
    (firstImportedId?: string): Promise<void> => {
      refreshDirty.current = true
      importedDuringRefresh.current ??= firstImportedId
      if (refreshWork.current) return refreshWork.current
      refreshWork.current = (async () => {
        while (refreshDirty.current) {
          refreshDirty.current = false
          const ticket = request.current,
            selectionTicket = selectionRevision.current
          try {
            const previous = current.current
            const summary = await window.irodori.getGallerySummary([...previous.selected.keys()])
            const id = previous.activeId ?? importedDuringRefresh.current
            const located = id ? await window.irodori.locateGalleryPhoto(id, 0, summary) : null
            const first =
              !located && !initialized.current && summary.total
                ? await window.irodori.getGalleryChunk(0, summary)
                : null
            if (ticket !== request.current || selectionTicket !== selectionRevision.current) {
              refreshDirty.current = true
              continue
            }
            const photo = located?.photo ?? first?.entries[0]?.photo ?? null
            const firstSelection =
              !initialized.current && photo !== null && pendingCount.current === 0
            if (photo) initialized.current = true
            const entry = located?.entries[located.index - located.offset]
            update({
              summary,
              total: summary.total,
              storedTotal: summary.storedTotal,
              hiddenActiveCover:
                entry && entry.photo.id !== photo?.id ? (entry.cover ?? null) : null,
              photo,
              activeId: photo?.id ?? null,
              position: located?.index ?? 0,
              ...(firstSelection
                ? { selected: new Map([[photo!.id, photo!]]), anchor: photo!.id }
                : {}),
            })
            importedDuringRefresh.current = undefined
          } catch (error) {
            if (isCollectionChanged(error)) refreshDirty.current = true
            else if (ticket === request.current) onError(String(error))
          }
        }
      })().finally(() => {
        refreshWork.current = null
      })
      return refreshWork.current
    },
    [onError, update],
  )

  const updateSelection = useCallback(
    (next: Partial<LibraryState>, since: number) => {
      const removed = (id: string) => (deletedAt.current.get(id) ?? 0) > since
      const activeRemoved = next.activeId != null && removed(next.activeId)
      selectionRevision.current++
      selectionError.current = null
      update({
        ...next,
        ...(next.selected
          ? { selected: new Map([...next.selected].filter(([id]) => !removed(id))) }
          : {}),
        ...(next.anchor && removed(next.anchor) ? { anchor: null } : {}),
        ...(activeRemoved
          ? {
              photo: current.current.photo,
              activeId: current.current.activeId,
              position: current.current.position,
            }
          : {}),
      })
    },
    [update],
  )

  const enqueueSelection = useCallback(
    <T>(action: (since: number) => T | Promise<T>): Promise<T> => {
      const since = deletionRevision.current
      pendingCount.current++
      const work = pendingSelection.current.then(async () => {
        try {
          const result = await action(since)
          return result
        } catch (error) {
          selectionError.current = error
          throw error
        } finally {
          pendingCount.current--
          if (pendingCount.current === 0) void refresh()
        }
      })
      pendingSelection.current = work.then(
        () => {},
        () => {},
      )
      return work
    },
    [refresh],
  )

  const onEvent = useCallback(
    (event: LibraryEvent) => {
      if (!event.libraryChanged) return
      const previous = current.current
      if (event.deletedIds?.length) {
        request.current++
        selectionRevision.current++
        const revision = ++deletionRevision.current
        for (const id of event.deletedIds) deletedAt.current.set(id, revision)
        const removed = new Set(event.deletedIds)
        const selected = new Map([...previous.selected].filter(([id]) => !removed.has(id)))
        const activeRemoved = previous.activeId !== null && removed.has(previous.activeId)
        update({
          selected,
          anchor: previous.anchor && removed.has(previous.anchor) ? null : previous.anchor,
          ...(activeRemoved ? { activeId: event.replacementId ?? null, photo: null } : {}),
        })
      }
      void refresh(event.firstImportedId)
    },
    [refresh, update],
  )

  const select = useCallback(
    (photo: Photo, modifiers: SelectionModifiers = {}) => {
      return enqueueSelection(async (since) => {
        const previous = current.current
        let selected: Map<string, PhotoReference>
        let anchor = previous.anchor
        if (modifiers.shift && anchor) {
          const range = await window.irodori.getGalleryRange(anchor, photo.id)
          selected = new Map(modifiers.toggle ? current.current.selected : [])
          for (const item of range) selected.set(item.id, item)
        } else {
          anchor = photo.id
          selected = new Map(modifiers.toggle ? previous.selected : [])
          if (modifiers.toggle && selected.has(photo.id)) selected.delete(photo.id)
          else selected.set(photo.id, { id: photo.id, filename: photo.filename })
        }
        updateSelection(
          {
            selected,
            anchor,
            photo,
            activeId: photo.id,
          },
          since,
        )
      }).catch((error) => onError(String(error)))
    },
    [enqueueSelection, onError, updateSelection],
  )

  const getSelection = useCallback(async () => {
    let pending: Promise<void>
    do {
      pending = pendingSelection.current
      await pending
    } while (pending !== pendingSelection.current)
    if (selectionError.current) throw selectionError.current
    return [...current.current.selected.values()]
  }, [])

  const contextSelect = useCallback(
    (photo: Photo, preserveActive = false) =>
      enqueueSelection((since) => {
        const previous = current.current
        const selected = previous.selected.has(photo.id)
          ? previous.selected
          : new Map([[photo.id, { id: photo.id, filename: photo.filename }]])
        updateSelection(
          {
            selected,
            ...(!preserveActive ? { photo, activeId: photo.id } : {}),
            anchor: selected === previous.selected ? previous.anchor : photo.id,
          },
          since,
        )
        return [...current.current.selected.values()]
      }),
    [enqueueSelection, updateSelection],
  )

  const navigate = useCallback(
    (delta: -1 | 1) =>
      enqueueSelection(async (since) => {
        const id = current.current.activeId
        if (!id) return
        const ticket = request.current
        const result = await window.irodori.locateGalleryPhoto(id, delta)
        if (!result) return
        const photo = result.photo
        updateSelection(
          {
            position: result.index,
            photo,
            activeId: photo.id,
            anchor: photo.id,
            hiddenActiveCover: null,
            selected: new Map([[photo.id, photo]]),
            ...(ticket === request.current
              ? { reveal: { id: photo.id, request: ++refreshing.current } }
              : {}),
          },
          since,
        )
      }).catch((error) => onError(String(error))),
    [enqueueSelection, onError, updateSelection],
  )

  const openPhoto = useCallback(
    (id: string, preserveSelection = false, isCurrent: () => boolean = () => true) =>
      enqueueSelection(async (since) => {
        if (!isCurrent()) return
        const ticket = request.current
        const result = await window.irodori.locateGalleryPhoto(id).catch((error) => {
          if (isCurrent()) throw error
          return null
        })
        if (!result || !isCurrent()) return
        const photo = result.photo
        const entry = result.entries[result.index - result.offset]
        const hidden = entry.photo.id !== photo.id
        updateSelection(
          {
            ...(ticket === request.current
              ? {
                  hiddenActiveCover: hidden ? (entry.cover ?? null) : null,
                  reveal: { id: entry.photo.id, request: ++refreshing.current },
                }
              : {}),
            position: result.index,
            photo,
            activeId: photo.id,
            ...(!preserveSelection
              ? { anchor: photo.id, selected: new Map([[photo.id, photo]]) }
              : {}),
          },
          since,
        )
      }).catch((error) => {
        if (isCurrent()) onError(String(error))
      }),
    [enqueueSelection, onError, updateSelection],
  )

  const selectStack = useCallback(
    (stackId: string, expectedRevision: number, isCurrent: () => boolean = () => true) =>
      enqueueSelection(async (since) => {
        if (!isCurrent()) return
        try {
          const snapshot = await window.irodori.getStackSnapshot(stackId, expectedRevision)
          if (!isCurrent()) return
          const selected = new Map(
            snapshot.photos.map(({ id, filename }) => [id, { id, filename }]),
          )
          updateSelection({ selected }, since)
        } catch (error) {
          if (isCurrent()) throw error
        }
      }),
    [enqueueSelection, updateSelection],
  )

  const browseSelect = useCallback(
    (photo: PhotoReference, query: BrowseQuery, modifiers: SelectionModifiers = {}) => {
      const acceptedQuery = { ...query }
      return enqueueSelection(async (since) => {
        const previous = current.current
        let anchor = previous.anchor
        let selected: Map<string, PhotoReference>
        if (modifiers.shift && anchor) {
          const range = await window.irodori.getBrowseRange(acceptedQuery, anchor, photo.id)
          selected = new Map(modifiers.toggle ? current.current.selected : [])
          for (const item of range) selected.set(item.id, item)
        } else {
          anchor = photo.id
          selected = new Map(modifiers.toggle ? previous.selected : [])
          if (modifiers.toggle && selected.has(photo.id)) selected.delete(photo.id)
          else selected.set(photo.id, { id: photo.id, filename: photo.filename })
        }
        updateSelection({ selected, anchor }, since)
        if (modifiers.click)
          browserClick.current = {
            id: photo.id,
            revision: selectionRevision.current,
            since,
            selected: previous.selected,
            anchor: previous.anchor,
          }
      }).catch((error) => onError(String(error)))
    },
    [enqueueSelection, onError, updateSelection],
  )
  const browseSection = useCallback(
    (key: string, query: BrowseQuery, checked: boolean) => {
      const acceptedQuery = { ...query }
      return enqueueSelection(async (since) => {
        const references = await window.irodori.getBrowseSection(acceptedQuery, key)
        const selected = new Map(current.current.selected)
        for (const photo of references) {
          if (checked) selected.set(photo.id, photo)
          else selected.delete(photo.id)
        }
        updateSelection({ selected }, since)
      }).catch((error) => onError(String(error)))
    },
    [enqueueSelection, onError, updateSelection],
  )
  const clearSelection = useCallback(
    () =>
      enqueueSelection((since) => updateSelection({ selected: new Map(), anchor: null }, since)),
    [enqueueSelection, updateSelection],
  )
  const restoreBrowserClick = useCallback(
    (id: string) =>
      enqueueSelection((since) => {
        const click = browserClick.current
        browserClick.current = null
        if (click?.id === id && click.revision === selectionRevision.current)
          updateSelection(
            { selected: click.selected, anchor: click.anchor },
            Math.min(since, click.since),
          )
      }),
    [enqueueSelection, updateSelection],
  )

  return {
    ...state,
    refresh,
    onEvent,
    select,
    getSelection,
    getActivePhoto: () => current.current.photo,
    getSelectedIds: () => [...current.current.selected.keys()],
    contextSelect,
    navigate,
    hydrate,
    openPhoto,
    selectStack,
    browseSelect,
    browseSection,
    clearSelection,
    restoreBrowserClick,
  }
}
