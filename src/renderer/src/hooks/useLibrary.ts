import { useCallback, useRef, useState } from 'react'
import type { GalleryEntry } from '../../../shared/stacks'
import type { BrowseQuery } from '../../../shared/browse'
import {
  PAGE_SIZE,
  type LibraryEvent,
  type Photo,
  type PhotoReference,
} from '../../../shared/contracts'

interface LibraryState {
  photos: Photo[]
  entries: GalleryEntry[]
  storedTotal: number
  revision: number
  hiddenSelectedIds: string[]
  hiddenActiveCover: PhotoReference | null
  total: number
  offset: number
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

export function useLibrary(onError: (error: string) => void) {
  const [state, setState] = useState<LibraryState>({
    photos: [],
    entries: [],
    storedTotal: 0,
    revision: 0,
    hiddenSelectedIds: [],
    hiddenActiveCover: null,
    total: 0,
    offset: 0,
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
  const navigating = useRef(false)
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
  const update = useCallback((next: Partial<LibraryState>) => {
    current.current = { ...current.current, ...next }
    setState(current.current)
  }, [])

  const refresh = useCallback(
    async (firstImportedId?: string) => {
      if (navigating.current) return
      const ticket = request.current
      const refreshTicket = ++refreshing.current
      const selectionTicket = selectionRevision.current
      try {
        const previous = current.current
        const id = previous.activeId ?? firstImportedId
        const located = id ? await window.luma.locateGalleryPhoto(id) : null
        let pageOffset = previous.offset
        let page = await window.luma.listGallery(pageOffset, [...previous.selected.keys()])
        if (pageOffset >= page.total && pageOffset > 0) {
          pageOffset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE)
          page = await window.luma.listGallery(pageOffset, [...previous.selected.keys()])
        }
        if (
          ticket !== request.current ||
          refreshTicket !== refreshing.current ||
          selectionTicket !== selectionRevision.current
        )
          return
        const photo = located ? located.photo : (page.entries[0]?.photo ?? null)
        const firstSelection =
          (!initialized.current || previous.total === 0) &&
          photo !== null &&
          pendingCount.current === 0
        if (photo) initialized.current = true
        update({
          photos: page.entries.map((e) => e.photo),
          entries: page.entries,
          storedTotal: page.storedTotal,
          revision: page.revision,
          hiddenSelectedIds: page.hiddenSelectedIds,
          hiddenActiveCover:
            located && located.entries[located.index - located.offset].photo.id !== located.photo.id
              ? (located.entries[located.index - located.offset].cover ?? null)
              : null,
          total: page.total,
          offset: pageOffset,
          photo,
          activeId: photo?.id ?? null,
          position: located?.index ?? pageOffset,
          ...(firstSelection
            ? { selected: new Map([[photo!.id, photo!]]), anchor: photo!.id }
            : {}),
        })
      } catch (error) {
        if (ticket === request.current) onError(String(error))
      }
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
        navigating.current = false
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
          const range = await window.luma.getGalleryRange(anchor, photo.id)
          selected = new Map(modifiers.toggle ? current.current.selected : [])
          for (const item of range) selected.set(item.id, item)
        } else {
          anchor = photo.id
          selected = new Map(modifiers.toggle ? previous.selected : [])
          if (modifiers.toggle && selected.has(photo.id)) selected.delete(photo.id)
          else selected.set(photo.id, { id: photo.id, filename: photo.filename })
        }
        const latest = current.current
        const index = latest.photos.findIndex((item) => item.id === photo.id)
        updateSelection(
          {
            selected,
            anchor,
            photo,
            activeId: photo.id,
            position: index < 0 ? latest.position : latest.offset + index,
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
        const result = await window.luma.locateGalleryPhoto(id, delta)
        if (!result) return
        const photo = result.photo
        updateSelection(
          {
            ...(ticket === request.current
              ? {
                  photos: result.entries.map((e) => e.photo),
                  entries: result.entries,
                  storedTotal: result.storedTotal,
                  revision: result.revision,
                  hiddenSelectedIds: [],
                  hiddenActiveCover: null,
                  total: result.total,
                  offset: result.offset,
                }
              : {}),
            position: result.index,
            photo,
            activeId: photo.id,
            anchor: photo.id,
            selected: new Map([[photo.id, photo]]),
          },
          since,
        )
      }).catch((error) => onError(String(error))),
    [enqueueSelection, onError, updateSelection],
  )

  const changePage = useCallback(
    async (offset: number) => {
      const ticket = ++request.current
      navigating.current = true
      try {
        const result = await window.luma.listGallery(offset, [...current.current.selected.keys()])
        if (ticket === request.current)
          update({
            photos: result.entries.map((e) => e.photo),
            entries: result.entries,
            storedTotal: result.storedTotal,
            revision: result.revision,
            hiddenSelectedIds: result.hiddenSelectedIds,
            total: result.total,
            offset,
          })
      } catch (error) {
        onError(String(error))
      } finally {
        if (ticket === request.current) {
          navigating.current = false
          void refresh()
        }
      }
    },
    [onError, refresh, update],
  )

  const openPhoto = useCallback(
    (id: string, preserveSelection = false) =>
      enqueueSelection(async (since) => {
        const ticket = request.current
        const result = await window.luma.locateGalleryPhoto(id)
        if (!result) return
        const photo = result.photo
        const entry = result.entries[result.index - result.offset]
        const hidden = entry.photo.id !== photo.id
        updateSelection(
          {
            ...(ticket === request.current
              ? {
                  photos: result.entries.map((e) => e.photo),
                  entries: result.entries,
                  storedTotal: result.storedTotal,
                  revision: result.revision,
                  hiddenSelectedIds: hidden ? [photo.id] : [],
                  hiddenActiveCover: hidden ? (entry.cover ?? null) : null,
                  total: result.total,
                  offset: result.offset,
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
      }).catch((error) => onError(String(error))),
    [enqueueSelection, onError, updateSelection],
  )

  const selectStack = useCallback(
    (stackId: string, expectedRevision: number, isCurrent: () => boolean = () => true) =>
      enqueueSelection(async (since) => {
        if (!isCurrent()) return
        try {
          const snapshot = await window.luma.getStackSnapshot(stackId, expectedRevision)
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
          const range = await window.luma.getBrowseRange(acceptedQuery, anchor, photo.id)
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
        const references = await window.luma.getBrowseSection(acceptedQuery, key)
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
    contextSelect,
    navigate,
    changePage,
    openPhoto,
    selectStack,
    browseSelect,
    browseSection,
    clearSelection,
    restoreBrowserClick,
  }
}
