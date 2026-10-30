import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  validatePatch,
  mergeEditPatch,
  type EditState,
  type EditPatch,
} from '../../../shared/edits'
import { spatialControlsKey } from '../../../shared/detail-controls'
import { neutralNoiseReduction, neutralDetailSharpening } from '../../../shared/spatial-detail'
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
  snapshotAdjustments,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
type AdjustmentPatch = Partial<AdjustmentParameters> &
  Pick<EditPatch, 'noiseReduction' | 'detailSharpening'>

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
  const historyGuards = useRef(new Set<symbol>())
  const suspendHistory = useCallback(() => {
    const owner = Symbol('transient editing tool')
    historyGuards.current.add(owner)
    return () => {
      historyGuards.current.delete(owner)
    }
  }, [])
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
      const settings = mergeEditPatch(edit.state.settings, edit.patch),
        sourceChanged = spatialControlsKey(settings) !== spatialControlsKey(edit.state.settings)
      if (sameAdjustments(edit.state.settings, settings) && !sourceChanged) {
        setDraft(null)
        return pending.current
      }
      const commit =
        trackCommit && !sourceChanged
          ? commits.current.begin(edit.scope, edit.state, edit.fromEpoch, settings)
          : null
      syncGestureCommit()
      busy.current = true
      setSaving(true)
      const work = (async () => {
        try {
          const next = await window.irodori.updateEdits(
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
            const recovered = await window.irodori.getEdits(edit.state.photoId)
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
      void window.irodori
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
    const unsubscribe = window.irodori.onLibraryEvent((event) => {
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
      window.irodori.onFlushEdits((scope) =>
        flushes.current.flush(
          scope,
          gesture.current?.state.photoId ?? current.current?.photoId,
          async () => {
            if (historyGuards.current.size)
              throw new Error('Finish or cancel the crop before continuing.')
            await flush()
          },
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
      const priorPatch = gesture.current.patch
      gesture.current.patch = { ...priorPatch, ...patch }
      if (patch.noiseReduction)
        gesture.current.patch.noiseReduction = {
          ...priorPatch.noiseReduction,
          ...patch.noiseReduction,
        }
      if (patch.detailSharpening)
        gesture.current.patch.detailSharpening = {
          ...priorPatch.detailSharpening,
          ...patch.detailSharpening,
        }
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
        const next = await window.irodori[direction === 'undo' ? 'undoEdit' : 'redoEdit'](
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
        event.defaultPrevented ||
        historyGuards.current.size > 0 ||
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
  const authored = useMemo(
    () => (visible && draft ? mergeEditPatch(visible.settings, draft) : visible?.settings),
    [visible, draft],
  )
  const adjustments = useMemo(() => snapshotAdjustments(authored ?? neutralAdjustments), [authored])
  return {
    state: visible,
    confirmed: enabled && !!visible && confirmedScope === confirmationScope,
    gestureCommit:
      enabled &&
      gestureCommit?.scope === confirmationScope &&
      gestureCommit.commit.photoId === photoId
        ? gestureCommit.commit
        : null,
    adjustments,
    spatial: {
      noiseReduction: authored?.noiseReduction ?? neutralNoiseReduction,
      detailSharpening: authored?.detailSharpening ?? neutralDetailSharpening,
    },
    error,
    saving,
    gesturing: !!draft,
    epoch,
    change,
    cancel,
    flush,
    history,
    suspendHistory,
  }
}
export type EditController = ReturnType<typeof useEdits>
