import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import {
  maskCapabilities,
  maskHasEdges,
  neutralMaskColor,
  neutralMaskEdge,
  type MaskColor,
  type MaskEdgeSettings,
  type MaskLight,
  type MaskOperation,
  type MaskPoint,
  type MaskStroke,
  type ResolvedMask,
} from '../../../shared/masks'
import type { MaskDetailTab, MaskWorkspace } from '../../../shared/workspace'
import type { EditController } from './useEdits'

type Draft = {
  photoId: string
  revision: number
  maskId: string
  light?: MaskLight
  color?: MaskColor
  edge?: MaskEdgeSettings
  stroke?: MaskStroke
  order?: string[]
}

export function moveMask(ids: readonly string[], id: string, target: number): string[] {
  const next = [...ids],
    from = next.indexOf(id)
  if (from < 0) return next
  next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, target)), 0, id)
  return next
}

/** Local drafts own no durable geometry; every commit goes through the photo edit owner. */
export function useMasks(
  edits: EditController,
  photoId: string | undefined,
  enabled: boolean,
  previewReady: boolean,
  workspace: MaskWorkspace,
  onWorkspace: (workspace: MaskWorkspace) => void,
) {
  const scope = useMemo(() => ({ photoId, enabled }), [photoId, enabled])
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const [pending, setPending] = useState(false)
  const [committingAdjustments, setCommittingAdjustments] = useState<Pick<
    Draft,
    'photoId' | 'revision' | 'maskId' | 'edge' | 'color'
  > | null>(null)
  const pendingCommit = useRef<Promise<void> | null>(null)
  const [brushDraft, setBrushDraft] = useState<{
    scope: object
    selectedId: string | null
    values: Partial<Pick<MaskWorkspace, 'size' | 'feather'>>
  } | null>(null)
  const busy = useRef(false)
  const [failure, setFailure] = useState<{ scope: object; message: string } | null>(null)
  const error = failure?.scope === scope ? failure.message : ''
  const setError = useCallback((message: string) => setFailure({ scope, message }), [scope])
  const [epoch, setEpoch] = useState(0)
  const publish = useCallback((value: Draft | null) => {
    draftRef.current = value
    setDraft(value)
    setEpoch((v) => v + 1)
  }, [])
  const cancel = useCallback(() => {
    publish(null)
  }, [publish])
  const state = edits.state
  const confirmed = useMemo(
    () => edits.adjustments.localMasks ?? [],
    [edits.adjustments.localMasks],
  )
  const selectedId =
    workspace.photoId === photoId && confirmed.some((m) => m.id === workspace.selectedId)
      ? workspace.selectedId
      : (confirmed[0]?.id ?? null)
  const selected = confirmed.find((m) => m.id === selectedId) ?? null
  const current = useRef({ edits, photoId, enabled, workspace, selectedId, onWorkspace })
  useLayoutEffect(() => {
    current.current = { edits, photoId, enabled, workspace, selectedId, onWorkspace }
  })
  const brushValues =
    brushDraft?.scope === scope && brushDraft.selectedId === selectedId ? brushDraft.values : null
  const supported = enabled && previewReady && edits.confirmed && !!state && !!photoId
  const available = supported && !pending && !edits.saving
  const active = supported && workspace.brush && workspace.detailTab === 'coverage' && !!selected
  const changeWorkspace = (patch: Partial<MaskWorkspace>) => {
    const value = current.current
    const next = {
      ...value.workspace,
      photoId: value.photoId ?? null,
      selectedId: value.selectedId,
      ...patch,
    }
    // A tab change may resume before React publishes an accepted create's selection.
    current.current = { ...value, workspace: next, selectedId: next.selectedId }
    value.onWorkspace(next)
  }
  const mutate = async (operations: MaskOperation[], expectedRevision?: number) => {
    if (current.current.photoId !== photoId || !current.current.enabled) return
    if (busy.current) return
    busy.current = true
    setPending(true)
    setError('')
    try {
      await current.current.edits.commitMasks(operations, expectedRevision)
    } catch (error) {
      setError(String(error))
      throw error
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const flush = useCallback(async () => {
    const value = draftRef.current
    if (!value?.light && !value?.edge && !value?.color) return pendingCommit.current ?? undefined
    if (value.edge || value.color)
      setCommittingAdjustments({
        photoId: value.photoId,
        revision: value.revision,
        maskId: value.maskId,
        edge: value.edge,
        color: value.color,
      })
    publish(null)
    if (
      value.photoId !== current.current.photoId ||
      value.revision !== current.current.edits.state?.revision
    ) {
      setCommittingAdjustments(null)
      throw new Error('Edits changed. The local adjustment draft was cancelled.')
    }
    busy.current = true
    setPending(true)
    const work = current.current.edits.commitMasks(
      [
        {
          kind: 'update',
          id: value.maskId,
          ...(value.light ? { light: value.light } : {}),
          ...(value.color ? { color: value.color } : {}),
          ...(value.edge ? { edge: value.edge } : {}),
        },
      ],
      value.revision,
    )
    pendingCommit.current = work
    try {
      await work
      setError('')
    } catch (error) {
      setError(String(error))
      throw error
    } finally {
      busy.current = false
      setPending(false)
      setCommittingAdjustments(null)
      if (pendingCommit.current === work) pendingCommit.current = null
    }
  }, [publish, setError])
  const registerFlush = edits.registerFlush
  useEffect(() => registerFlush(flush), [registerFlush, flush])
  useEffect(() => {
    const value = draftRef.current
    if (value && (!enabled || value.photoId !== photoId || value.revision !== state?.revision))
      publish(null)
  }, [enabled, photoId, state?.revision, publish])
  useEffect(() => {
    if (!active && !draft) return
    const off = window.irodori.onWindowBlur(cancel)
    const focus = (event: FocusEvent) => {
      if (
        draftRef.current?.stroke &&
        !(event.target as HTMLElement).closest('[data-testid="main-preview"]')
      )
        cancel()
    }
    document.addEventListener('focusin', focus)
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).closest(
          'input, textarea, select, dialog, [role="menu"], #agent-console',
        )
      )
        return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        cancel()
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        ['z', 'y'].includes(event.key.toLowerCase()) &&
        draftRef.current?.stroke
      ) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      off()
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('focusin', focus)
    }
  }, [active, draft, cancel])
  const resolved = useMemo<ResolvedMask[]>(() => {
    if (!draft || draft.photoId !== photoId || draft.revision !== state?.revision) return confirmed
    let result = confirmed.map((mask) =>
      mask.id !== draft.maskId
        ? mask
        : {
            ...mask,
            light: draft.light ?? mask.light,
            color: draft.color ?? mask.color,
            strokes:
              draft.stroke && !maskHasEdges(mask) ? [...mask.strokes, draft.stroke] : mask.strokes,
          },
    )
    if (draft.order) result = draft.order.map((id) => result.find((mask) => mask.id === id)!)
    return result
  }, [confirmed, draft, photoId, state?.revision])
  const adjustments: AdjustmentParameters = { ...edits.adjustments, localMasks: resolved }
  const edgeValues =
    draft &&
    draft.photoId === photoId &&
    draft.revision === state?.revision &&
    draft.maskId === selectedId &&
    draft.edge
      ? draft.edge
      : committingAdjustments &&
          committingAdjustments.photoId === photoId &&
          committingAdjustments.revision === state?.revision &&
          committingAdjustments.maskId === selectedId &&
          committingAdjustments.edge
        ? committingAdjustments.edge
        : (selected?.edge ?? neutralMaskEdge)
  const colorValues =
    draft &&
    draft.photoId === photoId &&
    draft.revision === state?.revision &&
    draft.maskId === selectedId &&
    draft.color
      ? draft.color
      : committingAdjustments &&
          committingAdjustments.photoId === photoId &&
          committingAdjustments.revision === state?.revision &&
          committingAdjustments.maskId === selectedId &&
          committingAdjustments.color
        ? committingAdjustments.color
        : (selected?.color ?? neutralMaskColor)
  const safely = (work: Promise<unknown>) => {
    void work.catch(() => undefined)
  }
  const finish = async () => {
    if (busy.current) return
    const value = draftRef.current
    publish(null)
    if (!value || !value.stroke) return
    if (
      value.photoId !== current.current.photoId ||
      !current.current.enabled ||
      value.revision !== current.current.edits.state?.revision
    )
      return
    await mutate([{ kind: 'stroke', id: value.maskId, stroke: value.stroke }], value.revision)
  }
  return {
    photoId,
    scope,
    masks: resolved,
    selectedId,
    selected: resolved.find((m) => m.id === selectedId) ?? null,
    edgeValues,
    colorValues,
    available,
    supported,
    active,
    overlayVisible: enabled && workspace.overlay,
    busy: pending || edits.saving,
    error,
    setError,
    workspace: { ...workspace, ...brushValues },
    adjustments,
    gesturing: !!draft,
    drawing: !!draft?.stroke,
    strokeDraft:
      draft && draft.photoId === photoId && draft.revision === state?.revision
        ? draft.stroke
        : undefined,
    epoch,
    cancel,
    flush,
    resetKey: `${photoId}:${state?.revision}:${selectedId}`,
    select: async (id: string) => {
      await edits.flush()
      if (current.current.photoId !== photoId || !current.current.enabled) return
      if (!current.current.edits.state?.settings.maskStack.some((mask) => mask.id === id)) return
      cancel()
      changeWorkspace({ selectedId: id })
    },
    showDetailTab: async (detailTab: MaskDetailTab) => {
      await edits.flush()
      if (current.current.photoId !== photoId || !current.current.enabled) return
      cancel()
      changeWorkspace({
        ...brushValues,
        detailTab,
        ...(detailTab === 'adjustments' ? { brush: false } : {}),
      })
      setBrushDraft(null)
    },
    create: () =>
      safely(
        (async () => {
          await edits.flush()
          cancel()
          const id = crypto.randomUUID()
          await mutate([{ kind: 'create', id, name: `Mask ${confirmed.length + 1}` }])
          if (current.current.photoId !== photoId || !current.current.enabled) return
          changeWorkspace({
            selectedId: id,
            detailTab: 'coverage',
            brush: true,
            mode: 'add',
            overlay: true,
          })
        })(),
      ),
    update: (operation: MaskOperation) =>
      safely(
        (async () => {
          await edits.flush()
          cancel()
          await mutate([operation])
        })(),
      ),
    duplicate: (maskId = selectedId) =>
      confirmed.some((mask) => mask.id === maskId) &&
      safely(
        (async () => {
          const target = confirmed.find((mask) => mask.id === maskId)!
          await edits.flush()
          cancel()
          const id = crypto.randomUUID()
          await mutate([
            {
              kind: 'duplicate',
              id: target.id,
              newId: id,
              name: `${target.name.slice(0, 94)} copy`,
            },
          ])
          if (current.current.photoId === photoId && current.current.enabled)
            changeWorkspace({ selectedId: id })
        })(),
      ),
    changeLight: (key: keyof MaskLight, value: number) => {
      if (!available || !selected || !state || !photoId) return
      const previous = draftRef.current
      const prior =
        previous?.maskId === selected.id &&
        previous.photoId === photoId &&
        previous.revision === state.revision
          ? previous
          : null
      publish({
        ...(prior?.edge ? { edge: prior.edge } : {}),
        ...(prior?.color ? { color: prior.color } : {}),
        photoId,
        revision: state.revision,
        maskId: selected.id,
        light: {
          ...(prior?.light ?? selected.light),
          [key]: value,
        },
      })
    },
    commitLight: () => safely(flush()),
    changeColor: (key: keyof MaskColor, value: number) => {
      if (!available || !selected || !state || !photoId) return
      const previous = draftRef.current
      const prior =
        previous?.maskId === selected.id &&
        previous.photoId === photoId &&
        previous.revision === state.revision
          ? previous
          : null
      publish({
        ...(prior?.light ? { light: prior.light } : {}),
        ...(prior?.edge ? { edge: prior.edge } : {}),
        photoId,
        revision: state.revision,
        maskId: selected.id,
        color: { ...(prior?.color ?? selected.color), [key]: value },
      })
    },
    commitColor: () => safely(flush()),
    changeEdge: (key: keyof MaskEdgeSettings, value: number) => {
      if (!available || !selected || !state || !photoId) return
      const previous = draftRef.current
      const prior =
        previous?.maskId === selected.id &&
        previous.photoId === photoId &&
        previous.revision === state.revision
          ? previous
          : null
      publish({
        ...(prior?.light ? { light: prior.light } : {}),
        ...(prior?.color ? { color: prior.color } : {}),
        photoId,
        revision: state.revision,
        maskId: selected.id,
        edge: {
          ...(prior?.edge ?? selected.edge),
          [key]: value,
        },
      })
    },
    commitEdge: () => safely(flush()),
    changeBrush: (key: 'size' | 'feather', value: number) => {
      setBrushDraft({ scope, selectedId, values: { ...brushValues, [key]: value } })
    },
    commitBrush: () => {
      if (brushValues) changeWorkspace(brushValues)
      setBrushDraft(null)
    },
    cancelBrush: () => setBrushDraft(null),
    preference: (patch: Partial<MaskWorkspace>) => {
      cancel()
      changeWorkspace(patch)
    },
    move: (id: string, target: number) =>
      safely(
        (async () => {
          await edits.flush()
          cancel()
          const ids = moveMask(
            confirmed.map((m) => m.id),
            id,
            target,
          )
          if (ids.some((id, i) => id !== confirmed[i].id)) await mutate([{ kind: 'reorder', ids }])
        })(),
      ),
    previewOrder: (id: string, target: number) => {
      if (busy.current || !available || !state || !photoId) return
      publish({
        photoId,
        revision: state.revision,
        maskId: id,
        order: moveMask(
          confirmed.map((m) => m.id),
          id,
          target,
        ),
      })
    },
    finishOrder: () => {
      const value = draftRef.current
      publish(null)
      if (value?.order && value.order.some((id, i) => id !== confirmed[i].id))
        safely(mutate([{ kind: 'reorder', ids: value.order }], value.revision))
    },
    beginStroke: (point: MaskPoint) => {
      if (busy.current || !available || !active || !state || !selected || !photoId) return false
      publish({
        photoId,
        revision: state.revision,
        maskId: selected.id,
        stroke: {
          mode: workspace.mode,
          radius: workspace.size / 200,
          feather: workspace.feather / 100,
          points: [point],
        },
      })
      return true
    },
    appendStroke: (point: MaskPoint) => {
      const value = draftRef.current
      if (busy.current || !current.current.enabled || !value?.stroke) return
      const last = value.stroke.points.at(-1)!
      if (Math.hypot(point.x - last.x, point.y - last.y) < 1e-6) return
      if (value.stroke.points.length >= maskCapabilities.maxStrokePoints) {
        cancel()
        setError('The brush stroke is too complex. Paint a shorter stroke.')
        return
      }
      publish({ ...value, stroke: { ...value.stroke, points: [...value.stroke.points, point] } })
    },
    endStroke: () => safely(finish()),
  }
}
export type MasksController = ReturnType<typeof useMasks>
