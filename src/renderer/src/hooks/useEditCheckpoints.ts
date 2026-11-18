import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditCheckpoint, EditComparisonSource } from '../../../shared/edit-checkpoints'
import type { EditComparisonSession } from '../../../shared/edit-comparisons'
import type { EditController } from './useEdits'

/** Checkpoint commands capture confirmed edits; the preview owns only the frozen presentation. */
export function useEditCheckpoints(
  photoId: string | undefined,
  edits: EditController,
  enabled: boolean,
) {
  const [comparison, setComparison] = useState<EditComparisonSession | null>(null)
  const [preparingPhoto, setPreparingPhoto] = useState<string | null>(null)
  const preparing = enabled && !!photoId && preparingPhoto === photoId
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef({ photoId, enabled, edits })
  useLayoutEffect(() => {
    latest.current = { photoId, enabled, edits }
  })
  const generation = useRef(0)
  const command = useRef(false)
  const owner = useRef<{ photoId: string; id: string; revision: number } | null>(null)
  const end = useCallback(async (reason = '') => {
    generation.current++
    const previous = owner.current
    owner.current = null
    setComparison(null)
    setPreparingPhoto(null)
    setError(reason)
    if (previous)
      await window.irodori.disposeEditComparison(previous.photoId, previous.id).catch(() => {})
  }, [])
  const close = useCallback(() => {
    void end()
  }, [end])
  const suspendHistory = edits.suspendHistory
  useEffect(() => {
    if (!comparison && !preparing) return
    return suspendHistory({ blockFlush: false })
  }, [comparison, preparing, suspendHistory])
  useEffect(() => {
    return () => {
      void end()
    }
  }, [photoId, enabled, end])
  useEffect(
    () =>
      window.irodori.onLibraryEvent((event) => {
        const active = owner.current
        if (!active) return
        if (
          event.deletedIds?.includes(active.photoId) ||
          (event.editsChanged?.photoId === active.photoId &&
            event.editsChanged.revision !== active.revision) ||
          event.sourceChanged?.photoId === active.photoId ||
          event.editCheckpointsChanged?.photoId === active.photoId
        )
          void end('The photograph or its checkpoints changed. Start comparison again.')
      }),
    [end],
  )
  const confirmed = useCallback(async () => {
    const captured = latest.current.photoId
    if (!captured || !latest.current.enabled) throw new Error('Select a photograph first.')
    await latest.current.edits.flush()
    const state = await window.irodori.getEdits(captured)
    if (latest.current.photoId !== captured || !latest.current.enabled)
      throw new Error('The active photograph changed. Try again.')
    return state
  }, [])
  const save = useCallback(
    async (name: string) => {
      const state = await confirmed()
      return window.irodori.createEditCheckpoint({
        photoId: state.photoId,
        expectedRevision: state.revision,
        name,
      })
    },
    [confirmed],
  )
  const restore = useCallback(
    async (checkpoint: EditCheckpoint) => {
      if (command.current) return
      command.current = true
      setBusy(true)
      setError('')
      try {
        await end()
        const state = await confirmed()
        if (state.photoId !== checkpoint.photoId)
          throw new Error('This checkpoint belongs to another photograph.')
        await window.irodori.restoreEditCheckpoint({
          photoId: checkpoint.photoId,
          checkpointId: checkpoint.id,
          expectedCheckpointRevision: checkpoint.revision,
          expectedRevision: state.revision,
        })
      } catch (error) {
        if (latest.current.photoId === checkpoint.photoId && latest.current.enabled)
          setError(String(error))
      } finally {
        command.current = false
        setBusy(false)
      }
    },
    [confirmed, end],
  )
  const compare = useCallback(
    async (baseline: EditComparisonSource, target: EditComparisonSource) => {
      if (command.current) return
      command.current = true
      setBusy(true)
      setError('')
      const capturedPhoto = latest.current.photoId
      let requestGeneration: number | undefined
      try {
        await end()
        const state = await confirmed()
        const freezeCurrent = (source: EditComparisonSource): EditComparisonSource =>
          source.kind === 'current' ? { kind: 'current', expectedRevision: state.revision } : source
        const requestId = crypto.randomUUID()
        requestGeneration = ++generation.current
        owner.current = { photoId: state.photoId, id: requestId, revision: state.revision }
        setPreparingPhoto(state.photoId)
        const next = await window.irodori.prepareEditComparison({
          photoId: state.photoId,
          baseline: freezeCurrent(baseline),
          target: freezeCurrent(target),
          requestId,
        })
        if (generation.current !== requestGeneration || latest.current.photoId !== state.photoId) {
          await window.irodori.disposeEditComparison(state.photoId, next.id)
          return
        }
        owner.current = { photoId: state.photoId, id: next.id, revision: state.revision }
        setComparison(next)
      } catch (error) {
        const active = owner.current
        owner.current = null
        if (active)
          await window.irodori.disposeEditComparison(active.photoId, active.id).catch(() => {})
        if (
          latest.current.photoId === capturedPhoto &&
          latest.current.enabled &&
          (requestGeneration === undefined || requestGeneration === generation.current)
        )
          setError(String(error))
      } finally {
        command.current = false
        setPreparingPhoto(null)
        setBusy(false)
      }
    },
    [confirmed, end],
  )
  const visible = enabled && comparison?.photoId === photoId ? comparison : null
  return {
    comparison: visible,
    active: preparing || !!visible,
    preparing,
    busy,
    error,
    save,
    restore,
    compare,
    close,
  }
}

export type EditCheckpointsController = ReturnType<typeof useEditCheckpoints>
