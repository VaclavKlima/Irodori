import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { validatePatch, type EditState } from '../../../shared/edits'
import { useForegroundActivity } from './useForegroundActivity'
import {
  EditGestureCommits,
  type EditGestureCommitSnapshot,
  type EditGestureScope,
} from './edit-gesture-commit'
import { EditFlushes } from './edit-flush'

import {
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
type AdjustmentPatch = Partial<AdjustmentParameters>

export function useEdits(photoId: string | undefined, enabled = true) {
  const { begin, pulse } = useForegroundActivity(photoId, undefined, enabled)
  const [state, setState] = useState<EditState | null>(null)
  const [draft, setDraft] = useState<AdjustmentPatch | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const epochRef = useRef(0)
  // Returning to the same photo requires a fresh authoritative read for this enabled cycle.
  const confirmationScope = useMemo(() => ({ photoId, enabled }), [photoId, enabled])
  const [confirmedScope, setConfirmedScope] = useState<typeof confirmationScope | null>(null)
  const commits = useRef(new EditGestureCommits())
  const [gestureCommit, setGestureCommit] = useState<EditGestureCommitSnapshot | null>(null)
  const current = useRef<EditState | null>(null)
  const gesture = useRef<{
    state: EditState
    patch: AdjustmentPatch
    fromEpoch: number
    scope: EditGestureScope
  } | null>(null)
  const busy = useRef(false)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const flushes = useRef(new EditFlushes())
  useEffect(() => {
    if (draft || saving) return begin()
  }, [draft, saving, begin])
  const syncGestureCommit = useCallback(() => {
    setGestureCommit(commits.current.snapshot)
  }, [])
  const advanceEpoch = useCallback(() => {
    epochRef.current++
    setEpoch(epochRef.current)
  }, [])
  const accept = useCallback(
    (next: EditState) => {
      if (current.current?.photoId === next.photoId && current.current.revision > next.revision)
        return
      commits.current.observe(next)
      syncGestureCommit()
      if (current.current?.photoId === next.photoId && current.current.revision === next.revision)
        return
      current.current = next
      gesture.current = null
      setState(next)
      setDraft(null)
      advanceEpoch()
    },
    [advanceEpoch, syncGestureCommit],
  )
  const flushGesture = useCallback(
    async (trackCommit: boolean) => {
      const edit = gesture.current
      gesture.current = null
      if (!edit) {
        // Pointer release, capture loss and blur may flush the same pending write.
        // Keep its final draft until acceptance instead of briefly showing the base edit.
        if (!busy.current) setDraft(null)
        return pending.current
      }
      if (sameAdjustments(edit.state.settings, { ...edit.state.settings, ...edit.patch })) {
        setDraft(null)
        return pending.current
      }
      const commit = trackCommit
        ? commits.current.begin(edit.scope, edit.state, edit.fromEpoch, {
            ...edit.state.settings,
            ...edit.patch,
          })
        : null
      syncGestureCommit()
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
          if (commit) {
            commits.current.succeeded(edit.scope, commit.id, next)
            syncGestureCommit()
          }
          if (
            commits.current.isActive(edit.scope) &&
            current.current?.photoId === edit.state.photoId
          )
            setError('')
        } catch (error) {
          if (commit) {
            commits.current.failed(edit.scope, commit.id)
            syncGestureCommit()
          }
          if (
            commits.current.isActive(edit.scope) &&
            current.current?.photoId === edit.state.photoId
          ) {
            setError(String(error))
            setDraft(null)
            const recovered = await window.luma.getEdits(edit.state.photoId)
            if (
              current.current?.photoId === edit.state.photoId &&
              commits.current.isActive(edit.scope) &&
              recovered.photoId === edit.state.photoId
            )
              accept(recovered)
          }
          throw error
        } finally {
          busy.current = false
          setSaving(false)
        }
      })()
      pending.current = work.catch(() => undefined)
      flushes.current.track(edit.state.photoId, work)
      return work
    },
    [accept, syncGestureCommit],
  )
  const flush = useCallback(() => flushGesture(true), [flushGesture])
  useEffect(() => {
    const tracker = commits.current
    let active = true,
      requested = 0
    tracker.enter(confirmationScope)
    if (current.current?.photoId !== photoId) current.current = null
    const refresh = () => {
      if (!photoId || !enabled) return
      const request = ++requested
      void window.luma
        .getEdits(photoId)
        .then((next) => {
          if (!active || request !== requested) return
          if (next.photoId !== photoId)
            throw new Error('The edit response does not match this photo.')
          if (current.current?.photoId === photoId && current.current.revision > next.revision)
            return
          accept(next)
          setConfirmedScope(confirmationScope)
          setError('')
        })
        .catch((error) => {
          if (active && request === requested) {
            tracker.invalidate()
            syncGestureCommit()
            setConfirmedScope(null)
            setError(String(error))
          }
        })
    }
    refresh()
    const unsubscribe = window.luma.onLibraryEvent((event) => {
      const changed = event.editsChanged
      if (enabled && changed && changed.photoId === photoId) {
        tracker.observeRevision(changed.photoId, changed.revision)
        syncGestureCommit()
        setConfirmedScope(null)
        refresh()
      }
    })
    return () => {
      active = false
      unsubscribe()
      tracker.leave(confirmationScope)
      void flushGesture(false).catch(() => undefined)
    }
  }, [photoId, enabled, accept, flushGesture, confirmationScope, syncGestureCommit])
  useEffect(
    () =>
      window.luma.onFlushEdits((scope) =>
        flushes.current.flush(
          scope,
          gesture.current?.state.photoId ?? current.current?.photoId,
          flush,
        ),
      ),
    [flush],
  )
  const cancel = () => {
    commits.current.invalidate()
    syncGestureCommit()
    gesture.current = null
    setDraft(null)
    advanceEpoch()
  }
  const change = async (patch: AdjustmentPatch) => {
    pulse()
    const photo = current.current?.photoId
    if (!photo) return
    try {
      validatePatch(patch)
      const active = gesture.current
      const changingControl = active && Object.keys(patch).some((key) => !(key in active.patch))
      if (!active || changingControl) {
        commits.current.invalidate()
        syncGestureCommit()
      }
      const intent = commits.current.intentGeneration
      if (changingControl) await flushGesture(false)
      if (busy.current) await pending.current
      if (
        current.current?.photoId !== photo ||
        !commits.current.isActive(confirmationScope, intent)
      )
        return
      gesture.current ??= {
        state: current.current,
        patch,
        fromEpoch: epochRef.current,
        scope: confirmationScope,
      }
      gesture.current.patch = { ...gesture.current.patch, ...patch }
      setDraft(gesture.current.patch)
    } catch (error) {
      if (commits.current.isActive(confirmationScope) && current.current?.photoId === photo)
        setError(String(error))
    }
  }
  const history = useCallback(
    async (direction: 'undo' | 'redo') => {
      commits.current.invalidate()
      syncGestureCommit()
      const photoId = current.current?.photoId
      if (!photoId) return
      try {
        await flushGesture(false)
        const confirmed = current.current
        if (
          confirmed?.photoId !== photoId ||
          !(direction === 'undo' ? confirmed.canUndo : confirmed.canRedo)
        )
          return
        const next = await window.luma[direction === 'undo' ? 'undoEdit' : 'redoEdit'](
          confirmed.photoId,
          confirmed.revision,
        )
        if (current.current?.photoId !== photoId || next.photoId !== photoId) return
        accept(next)
        setError('')
      } catch (error) {
        if (current.current?.photoId === photoId) setError(String(error))
      }
    },
    [flushGesture, accept, syncGestureCommit],
  )
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !enabled ||
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
  }, [history, enabled])
  const visible = state?.photoId === photoId ? state : null
  return {
    state: visible,
    confirmed: enabled && !!visible && confirmedScope === confirmationScope,
    gestureCommit:
      enabled &&
      gestureCommit?.scope === confirmationScope &&
      gestureCommit.commit.photoId === photoId
        ? gestureCommit.commit
        : null,
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
