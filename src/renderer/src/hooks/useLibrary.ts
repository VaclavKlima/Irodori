import { useCallback, useRef, useState } from 'react'
import type { GalleryEntry } from '../../../shared/stacks'
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
  const selectionError = useRef<unknown>(null)
  const update = useCallback((next: Partial<LibraryState>) => {
    current.current = { ...current.current, ...next }
    setState(current.current)
  }, [])

  const refresh = useCallback(
    async (firstImportedId?: string) => {
      if (navigating.current) return
      const ticket = request.current
      const refreshTicket = ++refreshing.current
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
        if (ticket !== request.current || refreshTicket !== refreshing.current) return
        const photo = located ? located.photo : (page.entries[0]?.photo ?? null)
        const firstSelection = (!initialized.current || previous.total === 0) && photo !== null
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

  const onEvent = useCallback(
    (event: LibraryEvent) => {
      if (!event.libraryChanged) return
      const previous = current.current
      if (event.deletedIds?.length) {
        request.current++
        navigating.current = false
        const removed = new Set(event.deletedIds)
        const selected = new Map([...previous.selected].filter(([id]) => !removed.has(id)))
        const activeRemoved = previous.activeId !== null && removed.has(previous.activeId)
        update({
          selected,
          anchor: previous.anchor && removed.has(previous.anchor) ? null : previous.anchor,
          ...(activeRemoved ? { activeId: event.replacementId ?? null } : {}),
        })
      }
      void refresh(event.firstImportedId)
    },
    [refresh, update],
  )

  const select = useCallback(
    (photo: Photo, modifiers: SelectionModifiers = {}) => {
      selectionError.current = null
      const work = (async () => {
        const ticket = ++request.current
        navigating.current = true
        try {
          const previous = current.current
          let selected: Map<string, PhotoReference>
          let anchor = previous.anchor
          if (modifiers.shift && anchor) {
            const range = await window.luma.getGalleryRange(anchor, photo.id)
            if (ticket !== request.current) return
            selected = new Map(modifiers.toggle ? previous.selected : [])
            for (const item of range) selected.set(item.id, item)
          } else {
            anchor = photo.id
            selected = new Map(modifiers.toggle ? previous.selected : [])
            if (modifiers.toggle && selected.has(photo.id)) selected.delete(photo.id)
            else selected.set(photo.id, { id: photo.id, filename: photo.filename })
          }
          const index = previous.photos.findIndex((item) => item.id === photo.id)
          update({ selected, anchor, photo, activeId: photo.id, position: previous.offset + index })
        } catch (error) {
          if (ticket === request.current) {
            selectionError.current = error
            onError(String(error))
          }
        } finally {
          if (ticket === request.current) {
            navigating.current = false
            void refresh()
          }
        }
      })()
      pendingSelection.current = work
      return work
    },
    [onError, refresh, update],
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
    async (photo: Photo) => {
      await getSelection()
      request.current++
      navigating.current = false
      selectionError.current = null
      const previous = current.current
      const selected = previous.selected.has(photo.id)
        ? previous.selected
        : new Map([[photo.id, { id: photo.id, filename: photo.filename }]])
      update({
        selected,
        photo,
        activeId: photo.id,
        anchor: selected === previous.selected ? previous.anchor : photo.id,
      })
      void refresh()
      return [...selected.values()]
    },
    [getSelection, refresh, update],
  )

  const navigate = useCallback(
    async (delta: -1 | 1) => {
      const id = current.current.activeId
      if (!id) return
      const ticket = ++request.current
      navigating.current = true
      try {
        const result = await window.luma.locateGalleryPhoto(id, delta)
        if (!result || ticket !== request.current) return
        const photo = result.photo
        update({
          photos: result.entries.map((e) => e.photo),
          entries: result.entries,
          storedTotal: result.storedTotal,
          revision: result.revision,
          hiddenSelectedIds: [],
          hiddenActiveCover: null,
          total: result.total,
          offset: result.offset,
          position: result.index,
          photo,
          activeId: photo.id,
          anchor: photo.id,
          selected: new Map([[photo.id, photo]]),
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
    async (id: string) => {
      const ticket = ++request.current
      navigating.current = true
      try {
        const result = await window.luma.locateGalleryPhoto(id)
        if (!result || ticket !== request.current) return
        const photo = result.photo
        const entry = result.entries[result.index - result.offset]
        const hidden = entry.photo.id !== photo.id
        update({
          photos: result.entries.map((e) => e.photo),
          entries: result.entries,
          storedTotal: result.storedTotal,
          revision: result.revision,
          hiddenSelectedIds: hidden ? [photo.id] : [],
          hiddenActiveCover: hidden ? (entry.cover ?? null) : null,
          total: result.total,
          offset: result.offset,
          position: result.index,
          photo,
          activeId: photo.id,
          anchor: photo.id,
          selected: new Map([[photo.id, photo]]),
          reveal: { id: entry.photo.id, request: ticket },
        })
      } catch (error) {
        if (ticket === request.current) onError(String(error))
      } finally {
        if (ticket === request.current) {
          navigating.current = false
          void refresh()
        }
      }
    },
    [onError, refresh, update],
  )

  const selectStack = useCallback(
    (stackId: string) => {
      const previousWork = pendingSelection.current
      const work = (async () => {
        await previousWork
        const ticket = ++request.current
        navigating.current = true
        try {
          const selected = new Map<string, PhotoReference>()
          let offset = 0
          let total = 0
          let revision: number | undefined
          do {
            const page = await window.luma.getStackMembers(stackId, offset)
            total = page.total
            if (revision !== undefined && revision !== page.stack.revision)
              throw new Error('The stack changed. Select it again.')
            revision = page.stack.revision
            for (const photo of page.photos)
              selected.set(photo.id, { id: photo.id, filename: photo.filename })
            offset += page.photos.length
            if (offset >= page.total) break
          } while (offset < total)
          if (ticket === request.current) update({ selected })
        } catch (error) {
          selectionError.current = error
          throw error
        } finally {
          if (ticket === request.current) {
            navigating.current = false
            void refresh()
          }
        }
      })()
      selectionError.current = null
      pendingSelection.current = work.catch(() => {})
      return work
    },
    [refresh, update],
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
  }
}
