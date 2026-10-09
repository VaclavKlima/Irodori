import { useCallback, useEffect, useRef, useState } from 'react'
import { validatePatch, type EditState } from '../../../shared/edits'

import {
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
type AdjustmentPatch = Partial<AdjustmentParameters>

export function useEdits(photoId: string | undefined) {
  const [state, setState] = useState<EditState | null>(null)
  const [draft, setDraft] = useState<AdjustmentPatch | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const current = useRef<EditState | null>(null)
  const gesture = useRef<{ state: EditState; patch: AdjustmentPatch } | null>(null)
  const busy = useRef(false)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const accept = useCallback((next: EditState) => {
    if (current.current?.photoId === next.photoId && current.current.revision >= next.revision)
      return
    current.current = next
    gesture.current = null
    setState(next)
    setDraft(null)
    setEpoch((value) => value + 1)
  }, [])
  const flush = useCallback(async () => {
    const edit = gesture.current
    gesture.current = null
    if (!edit || sameAdjustments(edit.state.settings, { ...edit.state.settings, ...edit.patch })) {
      setDraft(null)
      return pending.current
    }
    busy.current = true
    setSaving(true)
    const work = (async () => {
      try {
        const next = await window.luma.updateEdits(
          edit.state.photoId,
          edit.patch,
          edit.state.revision,
        )
        if (current.current?.photoId === next.photoId) accept(next)
        setError('')
      } catch (error) {
        if (current.current?.photoId === edit.state.photoId) {
          setError(String(error))
          setDraft(null)
          accept(await window.luma.getEdits(edit.state.photoId))
        }
        throw error
      } finally {
        busy.current = false
        setSaving(false)
      }
    })()
    pending.current = work.catch(() => undefined)
    return work
  }, [accept])
  useEffect(() => {
    let active = true
    current.current = null
    const refresh = () => {
      if (!photoId) return
      void window.luma
        .getEdits(photoId)
        .then((next) => {
          if (active) accept(next)
        })
        .catch((error) => {
          if (active) setError(String(error))
        })
    }
    refresh()
    const unsubscribe = window.luma.onLibraryEvent((event) => {
      if (event.editsChanged?.photoId === photoId) refresh()
    })
    return () => {
      active = false
      unsubscribe()
      void flush().catch(() => undefined)
    }
  }, [photoId, accept, flush])
  useEffect(() => window.luma.onFlushEdits(flush), [flush])
  const cancel = () => {
    gesture.current = null
    setDraft(null)
    setEpoch((value) => value + 1)
  }
  const change = async (patch: AdjustmentPatch) => {
    const photo = current.current?.photoId
    if (!photo) return
    try {
      validatePatch(patch)
      const active = gesture.current
      if (active && Object.keys(patch).some((key) => !(key in active.patch))) await flush()
      if (busy.current) await pending.current
      if (current.current?.photoId !== photo) return
      gesture.current ??= { state: current.current, patch }
      gesture.current.patch = { ...gesture.current.patch, ...patch }
      setDraft(gesture.current.patch)
    } catch (error) {
      setError(String(error))
    }
  }
  const history = useCallback(
    async (direction: 'undo' | 'redo') => {
      try {
        await flush()
        const confirmed = current.current
        if (!confirmed || !(direction === 'undo' ? confirmed.canUndo : confirmed.canRedo)) return
        accept(
          await window.luma[direction === 'undo' ? 'undoEdit' : 'redoEdit'](
            confirmed.photoId,
            confirmed.revision,
          ),
        )
        setError('')
      } catch (error) {
        setError(String(error))
      }
    },
    [flush, accept],
  )
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        (event.target as HTMLElement).closest(
          'input, textarea, select, [contenteditable], #agent-console',
        )
      )
        return
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void history(event.shiftKey ? 'redo' : 'undo')
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault()
        void history('redo')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [history])
  const visible = state?.photoId === photoId ? state : null
  return {
    state: visible,
    adjustments: {
      whiteBalance:
        draft?.whiteBalance ?? visible?.settings.whiteBalance ?? neutralAdjustments.whiteBalance,
      exposureEv:
        draft?.exposureEv ?? visible?.settings.exposureEv ?? neutralAdjustments.exposureEv,
      highlights:
        draft?.highlights ?? visible?.settings.highlights ?? neutralAdjustments.highlights,
      shadows: draft?.shadows ?? visible?.settings.shadows ?? neutralAdjustments.shadows,
      whites: draft?.whites ?? visible?.settings.whites ?? neutralAdjustments.whites,
      blacks: draft?.blacks ?? visible?.settings.blacks ?? neutralAdjustments.blacks,
      contrast: draft?.contrast ?? visible?.settings.contrast ?? neutralAdjustments.contrast,
    },
    error,
    saving,
    gesturing: !!draft,
    epoch,
    change,
    cancel,
    flush,
    history,
  }
}
export type EditController = ReturnType<typeof useEdits>
