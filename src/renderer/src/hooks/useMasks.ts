import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import {
  maskCapabilities,
  findMaskComponent,
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type MaskOperator,
  validateMaskGradient,
  type MaskColor,
  type MaskEdgeSettings,
  type MaskLight,
  type MaskGradient,
  type MaskOperation,
  type MaskPoint,
  type MaskStroke,
  type ResolvedMask,
} from '../../../shared/masks'
import { mapMaskCoverage, maskCoverageNodes } from '../../../shared/masks-gpu'
import {
  defaultColorMaskRange,
  defaultLuminanceMaskRange,
  sampledLuminanceMaskRange,
  validateMaskRange,
  type MaskRange,
} from '../../../shared/mask-ranges'
import type { MaskGeometry } from '../../../shared/mask-geometry'
import type { MaskDetailTab, MaskWorkspace } from '../../../shared/workspace'
import type { EditController } from './useEdits'
import { inspectionGeometryMatches } from '../preview/inspection-geometry'

type Draft = {
  photoId: string
  revision: number
  maskId: string
  componentId?: string
  strokeTarget?: 'primary' | 'result'
  newComponent?: { componentId: string; parentId?: string; name: string; operator: MaskOperator }
  light?: MaskLight
  color?: MaskColor
  edge?: MaskEdgeSettings
  stroke?: MaskStroke
  order?: string[]
  gradient?: MaskGradient
  range?: MaskRange
  /** Numeric fields flush on navigation; unfinished handle gestures cancel. */
  gradientInput?: boolean
}

type RangeTarget =
  | { kind: 'new-mask'; id: string; name: string }
  | {
      kind: 'new-component'
      maskId: string
      componentId: string
      parentId?: string
      name: string
      operator: MaskOperator
    }
  | { kind: 'replace-component'; maskId: string; componentId: string }
type RangeSession = {
  photoId: string
  revision: number
  kind: MaskRange['kind']
  target: RangeTarget
  value: MaskRange | null
}

function rangeOperation(session: RangeSession): MaskOperation | undefined {
  if (!session.value) return undefined
  const { target, value: range } = session
  if (target.kind === 'new-mask') return { kind: 'create', id: target.id, name: target.name, range }
  if (target.kind === 'new-component') {
    const { maskId: id, kind: _kind, ...part } = target
    void _kind
    return { kind: 'component-add', id, ...part, range }
  }
  return {
    kind: 'component-update',
    id: target.maskId,
    componentId: target.componentId,
    range,
    replacePrimary: true,
  }
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
  const creationEpoch = useRef(0)
  const rangeRestoreFocus = useRef<HTMLElement | null>(null)
  const [rangeSession, setRangeSession] = useState<RangeSession | null>(null)
  const rangeSessionRef = useRef<RangeSession | null>(null)
  const [rangePick, setRangePick] = useState<{
    scope: object
    revision: number
    index: number
  } | null>(null)
  const [rangeSamplePending, setRangeSamplePending] = useState(false)
  const [rangeReady, setRangeReady] = useState<string | null>(null)
  const rangeSampleEpoch = useRef(0)
  const rangeGestureStart = useRef<MaskRange | null | undefined>(undefined)
  const [epoch, setEpoch] = useState(0)
  const publishRange = useCallback((value: RangeSession | null) => {
    if (JSON.stringify(rangeSessionRef.current) !== JSON.stringify(value))
      setEpoch((epoch) => epoch + 1)
    rangeSessionRef.current = value
    setRangeSession(value)
    setRangeReady(null)
  }, [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  const [armedPart, setArmedPart] = useState<{
    scope: object
    revision: number
    maskId: string
    componentId: string
    parentId?: string
    name: string
    operator: MaskOperator
    kind: 'brush' | MaskGradient['kind']
  } | null>(null)
  const [armedGradient, setArmedGradient] = useState<{
    scope: object
    revision: number
    kind: MaskGradient['kind']
  } | null>(null)
  const [gradientGeometry, setGradientGeometry] = useState<{
    photoId: string
    revision: number
    width: number
    height: number
  } | null>(null)
  const [pending, setPending] = useState(false)
  const [committingAdjustments, setCommittingAdjustments] = useState<Pick<
    Draft,
    'photoId' | 'revision' | 'maskId' | 'componentId' | 'edge' | 'color' | 'gradient' | 'range'
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
  const [gradientRejected, setGradientRejected] = useState(0)
  const publish = useCallback((value: Draft | null) => {
    draftRef.current = value
    setDraft(value)
    setEpoch((v) => v + 1)
  }, [])
  const cancel = useCallback(() => {
    const restore = rangeRestoreFocus.current
    rangeRestoreFocus.current = null
    if (
      restore &&
      document.activeElement?.closest(
        '[aria-label$="range controls"], [data-testid="main-preview"]',
      )
    ) {
      setTimeout(() => {
        if (restore.isConnected) restore.focus({ preventScroll: true })
      }, 0)
    }
    creationEpoch.current++
    rangeSampleEpoch.current++
    rangeGestureStart.current = undefined
    setRangeSamplePending(false)
    publishRange(null)
    setRangePick(null)
    publish(null)
    setArmedGradient(null)
    setArmedPart(null)
  }, [publish, publishRange])
  const state = edits.state
  const activeRangePick =
    rangePick?.scope === scope && rangePick.revision === state?.revision ? rangePick : null
  useEffect(
    () => () => {
      rangeSampleEpoch.current++
    },
    [scope],
  )
  const confirmed = useMemo(
    () => edits.adjustments.localMasks ?? [],
    [edits.adjustments.localMasks],
  )
  const activeRangeSession =
    rangeSession && rangeSession.photoId === photoId && rangeSession.revision === state?.revision
      ? rangeSession
      : null
  const selectedId = activeRangeSession
    ? activeRangeSession.target.kind === 'new-mask'
      ? activeRangeSession.target.id
      : activeRangeSession.target.maskId
    : workspace.photoId === photoId && confirmed.some((m) => m.id === workspace.selectedId)
      ? workspace.selectedId
      : (confirmed[0]?.id ?? null)
  const selected = confirmed.find((m) => m.id === selectedId) ?? null
  const selectedComponentId = activeRangeSession
    ? activeRangeSession.target.kind === 'new-mask'
      ? activeRangeSession.target.id
      : activeRangeSession.target.componentId
    : workspace.photoId === photoId &&
        workspace.selectedId === selectedId &&
        selected &&
        maskCoverageNodes(selected, true).some((node) => node.id === workspace.selectedComponentId)
      ? (workspace.selectedComponentId ?? null)
      : null
  const selectedPart =
    selectedComponentId && selected
      ? (maskCoverageNodes(selected, true).find((node) => node.id === selectedComponentId) ?? null)
      : null
  const selectedCoverage = selectedPart ?? selected
  const activePart =
    armedPart?.scope === scope && armedPart.revision === state?.revision ? armedPart : null
  const creatingGradient =
    activePart && activePart.kind !== 'brush'
      ? activePart.kind
      : armedGradient?.scope === scope && armedGradient.revision === state?.revision
        ? armedGradient.kind
        : null
  const gradientDimensions =
    gradientGeometry &&
    gradientGeometry.photoId === photoId &&
    gradientGeometry.revision === state?.revision
      ? { width: gradientGeometry.width, height: gradientGeometry.height }
      : undefined
  const current = useRef({ edits, photoId, enabled, workspace, selectedId, onWorkspace })
  useLayoutEffect(() => {
    current.current = { edits, photoId, enabled, workspace, selectedId, onWorkspace }
  })
  const brushValues =
    brushDraft?.scope === scope && brushDraft.selectedId === selectedId ? brushDraft.values : null
  const supported =
    enabled &&
    (previewReady ||
      !!activePart ||
      !!activeRangeSession ||
      !!(draft && draft.photoId === photoId && draft.revision === state?.revision)) &&
    edits.confirmed &&
    !!state &&
    !!photoId
  const available = supported && !pending && !edits.saving
  const active =
    supported &&
    !creatingGradient &&
    !activeRangeSession &&
    !activeRangePick &&
    workspace.brush &&
    workspace.detailTab === 'coverage' &&
    !!selected
  const editingGradient =
    supported &&
    !creatingGradient &&
    !activeRangeSession &&
    !activeRangePick &&
    !!selectedPart?.gradient &&
    workspace.detailTab === 'coverage' &&
    !workspace.brush
  const registerGradientGeometry = useCallback((geometry?: MaskGeometry) => {
    const value = current.current
    const revision = value.edits.state?.revision
    if (!geometry || !value.photoId || revision === undefined) {
      setGradientGeometry(null)
      return
    }
    const { canonicalWidth: width, canonicalHeight: height } = geometry
    setGradientGeometry((previous) =>
      previous &&
      previous.photoId === value.photoId &&
      previous.revision === revision &&
      previous.width === width &&
      previous.height === height
        ? previous
        : { photoId: value.photoId!, revision, width, height },
    )
  }, [])
  const changeWorkspace = (patch: Partial<MaskWorkspace>) => {
    const value = current.current
    const next = {
      ...value.workspace,
      photoId: value.photoId ?? null,
      selectedId:
        rangeSessionRef.current?.target.kind === 'new-mask' &&
        value.workspace.photoId === value.photoId
          ? value.workspace.selectedId
          : value.selectedId,
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
    if (
      !value?.light &&
      !value?.edge &&
      !value?.color &&
      !value?.range &&
      !(value?.gradient && value.gradientInput)
    ) {
      if (value?.gradient) publish(null)
      return pendingCommit.current ?? undefined
    }
    if (value.edge || value.color || value.gradient || value.range)
      setCommittingAdjustments({
        photoId: value.photoId,
        revision: value.revision,
        maskId: value.maskId,
        componentId: value.componentId,
        edge: value.edge,
        color: value.color,
        gradient: value.gradient,
        range: value.range,
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
          ...(value.componentId ? { componentId: value.componentId } : {}),
          ...(value.light ? { light: value.light } : {}),
          ...(value.color ? { color: value.color } : {}),
          ...(value.edge ? { edge: value.edge } : {}),
          ...(value.gradient ? { gradient: value.gradient } : {}),
          ...(value.range ? { range: value.range } : {}),
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
    const session = rangeSessionRef.current
    if (
      session &&
      (!enabled || session.photoId !== photoId || session.revision !== state?.revision)
    )
      cancel()
  }, [enabled, photoId, state?.revision, cancel])
  useEffect(() => {
    const value = draftRef.current
    if (value && (!enabled || value.photoId !== photoId || value.revision !== state?.revision))
      publish(null)
  }, [enabled, photoId, state?.revision, publish])
  useEffect(() => {
    if (!active && !draft && !creatingGradient && !activeRangeSession && !activeRangePick) return
    const off = window.irodori.onWindowBlur(cancel)
    const focus = (event: FocusEvent) => {
      if (
        (draftRef.current?.stroke ||
          (draftRef.current?.gradient && !draftRef.current.gradientInput)) &&
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
        (draftRef.current?.stroke ||
          draftRef.current?.gradient ||
          activeRangeSession ||
          activeRangePick)
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
  }, [active, draft, cancel, creatingGradient, activeRangeSession, activeRangePick])
  const resolved = useMemo<ResolvedMask[]>(() => {
    const currentDraft =
      draft && draft.photoId === photoId && draft.revision === state?.revision ? draft : null
    let result = !currentDraft
      ? confirmed
      : confirmed.map((root) => {
          if (root.id !== currentDraft.maskId) return root
          const nextRoot = mapMaskCoverage(root, (mask) => {
            const target = currentDraft.componentId ?? root.id
            if (mask.id !== target) return mask
            const next = {
              ...mask,

              ...(mask.id === root.id
                ? {
                    light: currentDraft.light ?? mask.light,
                    color: currentDraft.color ?? mask.color,
                  }
                : {}),
              gradient:
                currentDraft.gradient && !currentDraft.newComponent
                  ? currentDraft.gradient
                  : mask.gradient,
              ...(currentDraft.range
                ? {
                    range: currentDraft.range,
                    base: undefined,
                    gradient: undefined,
                    preparedRangeBase: undefined,
                  }
                : {}),
              ...(currentDraft.stroke && !currentDraft.newComponent
                ? currentDraft.strokeTarget === 'primary'
                  ? { strokes: [...mask.strokes, currentDraft.stroke] }
                  : { resultStrokes: [...(mask.resultStrokes ?? []), currentDraft.stroke] }
                : {}),
            }
            if (currentDraft.newComponent && (currentDraft.stroke || currentDraft.gradient)) {
              const { componentId: id, name, operator } = currentDraft.newComponent
              next.operands = [
                ...(next.operands ?? []),
                {
                  id,
                  name,
                  operator,
                  enabled: true,
                  inverted: false,
                  head: null,
                  resultHead: null,
                  strokes: currentDraft.stroke ? [currentDraft.stroke] : [],
                  resultStrokes: [],
                  operands: [],
                  edge: { ...neutralMaskEdge },
                  ...(currentDraft.gradient ? { gradient: currentDraft.gradient } : {}),
                },
              ]
            }
            return next
          })
          return currentDraft.gradient || currentDraft.stroke || currentDraft.range
            ? mapMaskCoverage(nextRoot, (node) => ({ ...node, preparedCoverage: undefined }))
            : nextRoot
        })
    if (currentDraft?.order)
      result = currentDraft.order.map((id) => result.find((mask) => mask.id === id)!)
    if (activeRangeSession?.value) {
      const session = activeRangeSession,
        range = session.value!,
        target = session.target
      const base = {
        enabled: true,
        inverted: false,
        head: null,
        resultHead: null,
        strokes: [],
        resultStrokes: [],
        operands: [],
        edge: { ...neutralMaskEdge },
        range,
      }
      if (target.kind === 'new-mask') {
        result = [
          {
            ...base,
            id: target.id,
            name: target.name,
            light: { ...neutralMaskLight },
            color: { ...neutralMaskColor },
          },
          ...result,
        ]
      } else {
        result = result.map((root) =>
          root.id !== target.maskId
            ? root
            : mapMaskCoverage(root, (node) => {
                if (target.kind === 'new-component' && node.id === (target.parentId ?? root.id)) {
                  return {
                    ...node,
                    preparedCoverage: undefined,
                    operands: [
                      ...(node.operands ?? []),
                      {
                        ...base,
                        id: target.componentId,
                        name: target.name,
                        operator: target.operator,
                      },
                    ],
                  }
                }
                if (target.kind === 'replace-component' && node.id === target.componentId) {
                  return {
                    ...node,
                    range,
                    base: undefined,
                    gradient: undefined,
                    preparedRangeBase: undefined,
                    preparedCoverage: undefined,
                  }
                }
                return { ...node, preparedCoverage: undefined }
              }),
        )
      }
    }
    return result
  }, [confirmed, draft, photoId, state?.revision, activeRangeSession])
  const rangePreviewOperation = activeRangeSession ? rangeOperation(activeRangeSession) : undefined
  const rangePreviewKey = rangePreviewOperation
    ? JSON.stringify([photoId, state?.revision, rangePreviewOperation])
    : undefined
  const coverageMutation = rangePreviewOperation
    ? { operations: [rangePreviewOperation] }
    : draft && draft.photoId === photoId && draft.revision === state?.revision
      ? draft.newComponent && (draft.stroke || draft.gradient)
        ? {
            operations: [
              {
                kind: 'component-add' as const,
                id: draft.maskId,
                ...draft.newComponent,
                ...(draft.gradient ? { gradient: draft.gradient } : {}),
                ...(draft.stroke ? { stroke: draft.stroke } : {}),
              },
            ],
          }
        : draft.stroke
          ? {
              operations: [
                {
                  kind: 'stroke' as const,
                  id: draft.maskId,
                  componentId: draft.componentId,
                  strokeTarget: draft.strokeTarget,
                  stroke: draft.stroke,
                },
              ],
            }
          : draft.range
            ? {
                operations: [
                  {
                    kind: 'update' as const,
                    id: draft.maskId,
                    componentId: draft.componentId,
                    range: draft.range,
                  },
                ],
              }
            : draft.gradient
              ? {
                  operations: [
                    {
                      kind: 'update' as const,
                      id: draft.maskId,
                      componentId: draft.componentId,
                      ...(draft.gradient ? { gradient: draft.gradient } : {}),
                    },
                  ],
                }
              : undefined
      : undefined
  const adjustments = useMemo<AdjustmentParameters>(
    () => ({ ...edits.adjustments, localMasks: resolved }),
    [edits.adjustments, resolved],
  )
  const resolvedRoot = resolved.find((mask) => mask.id === selectedId)
  const resolvedPart =
    selectedComponentId && resolvedRoot
      ? maskCoverageNodes(resolvedRoot, true).find((node) => node.id === selectedComponentId)
      : undefined
  const overlayMask: ResolvedMask | undefined =
    workspace.overlayScope === 'selected-part' && resolvedPart
      ? {
          ...resolvedPart,
          enabled: true,
          light: { ...neutralMaskLight },
          color: { ...neutralMaskColor },
        }
      : resolvedRoot
  const edgeValues =
    draft &&
    draft.photoId === photoId &&
    draft.revision === state?.revision &&
    draft.maskId === selectedId &&
    (draft.componentId ?? null) === selectedComponentId &&
    draft.edge
      ? draft.edge
      : committingAdjustments &&
          committingAdjustments.photoId === photoId &&
          committingAdjustments.revision === state?.revision &&
          committingAdjustments.maskId === selectedId &&
          (committingAdjustments.componentId ?? null) === selectedComponentId &&
          committingAdjustments.edge
        ? committingAdjustments.edge
        : (selectedCoverage?.edge ?? neutralMaskEdge)
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
    if (value.newComponent) {
      await mutate(
        [{ kind: 'component-add', id: value.maskId, ...value.newComponent, stroke: value.stroke }],
        value.revision,
      )
      setArmedPart(null)
      changeWorkspace({ selectedComponentId: value.newComponent.componentId })
    } else
      await mutate(
        [
          {
            kind: 'stroke',
            id: value.maskId,
            componentId: value.componentId,
            strokeTarget: value.strokeTarget,
            stroke: value.stroke,
          },
        ],
        value.revision,
      )
  }
  const previewGradient = (gradient: MaskGradient, gradientInput = false) => {
    if (busy.current || !available || !state || !selected || !selectedPart?.gradient || !photoId)
      return false
    try {
      validateMaskGradient(gradient, gradientDimensions?.width, gradientDimensions?.height)
    } catch (error) {
      if (gradientInput) {
        publish(null)
        setError(String(error))
        setGradientRejected((value) => value + 1)
      }
      return false
    }
    if (gradientInput) setError('')
    publish({
      photoId,
      revision: state.revision,
      maskId: selected.id,
      componentId: selectedComponentId ?? undefined,
      gradient,
      gradientInput,
    })
    return true
  }
  const finishGradient = async () => {
    const value = draftRef.current
    publish(null)
    if (
      busy.current ||
      !value?.gradient ||
      !current.current.enabled ||
      value.photoId !== current.current.photoId ||
      value.revision !== current.current.edits.state?.revision
    )
      return
    const confirmed = current.current.edits.state.settings.maskStack.find(
      (mask) => mask.id === value.maskId,
    )
    const component = confirmed ? findMaskComponent(confirmed, value.componentId) : undefined
    if (!component || JSON.stringify(component.gradient) === JSON.stringify(value.gradient)) return
    await mutate(
      [
        {
          kind: 'update',
          id: value.maskId,
          componentId: value.componentId,
          gradient: value.gradient,
        },
      ],
      value.revision,
    )
  }
  const gradientValues =
    draft &&
    draft.photoId === photoId &&
    draft.revision === state?.revision &&
    draft.maskId === selectedId &&
    (draft.componentId ?? null) === selectedComponentId &&
    draft.gradient
      ? draft.gradient
      : committingAdjustments &&
          committingAdjustments.photoId === photoId &&
          committingAdjustments.revision === state?.revision &&
          committingAdjustments.maskId === selectedId &&
          (committingAdjustments.componentId ?? null) === selectedComponentId &&
          committingAdjustments.gradient
        ? committingAdjustments.gradient
        : selectedPart?.gradient
  const rangeValues = activeRangeSession
    ? activeRangeSession.value
    : draft?.range && draft.photoId === photoId && draft.revision === state?.revision
      ? draft.range
      : committingAdjustments?.range &&
          committingAdjustments.photoId === photoId &&
          committingAdjustments.revision === state?.revision
        ? committingAdjustments.range
        : (selectedCoverage?.range ?? null)
  const rangeKind = activeRangeSession?.kind ?? rangeValues?.kind
  const changeRange = (value: MaskRange) => {
    if (!available || busy.current || rangeSamplePending || !photoId || !state) return
    try {
      validateMaskRange(value)
    } catch (error) {
      setError(String(error))
      cancelRangeChange()
      return
    }
    setError('')
    if (activeRangeSession) {
      if (rangeGestureStart.current === undefined)
        rangeGestureStart.current = activeRangeSession.value
      publishRange({ ...activeRangeSession, value: structuredClone(value) })
    } else if (selected && selectedCoverage?.range) {
      publish({
        photoId,
        revision: state.revision,
        maskId: selected.id,
        componentId: selectedComponentId ?? undefined,
        range: structuredClone(value),
      })
    }
  }
  const commitRange = () => {
    rangeGestureStart.current = undefined
    if (!rangeSessionRef.current) safely(flush())
  }
  const cancelRangeChange = () => {
    const session = rangeSessionRef.current
    if (session && rangeGestureStart.current !== undefined)
      publishRange({ ...session, value: rangeGestureStart.current })
    else if (!session) publish(null)
    rangeGestureStart.current = undefined
    setGradientRejected((value) => value + 1)
  }
  const startRange = async (
    kind: MaskRange['kind'],
    destination?: Extract<RangeTarget, { kind: 'new-component' | 'replace-component' }>,
  ) => {
    if (!available || busy.current || !photoId || !state) return
    const restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const token = creationEpoch.current
    await edits.flush()
    if (
      current.current.photoId !== photoId ||
      !current.current.enabled ||
      creationEpoch.current !== token ||
      !current.current.edits.state
    )
      return
    cancel()
    rangeRestoreFocus.current = restoreFocus
    const name = `${kind === 'color' ? 'Color' : 'Luminance'} range ${confirmed.length + 1}`
    const target: RangeTarget = destination ?? { kind: 'new-mask', id: crypto.randomUUID(), name }
    publishRange({
      photoId,
      revision: current.current.edits.state.revision,
      kind,
      target,
      value: kind === 'luminance' ? structuredClone(defaultLuminanceMaskRange) : null,
    })
    changeWorkspace({ detailTab: 'coverage', brush: false, overlay: true, overlayScope: 'result' })
    setRangePick(
      kind === 'color' ? { scope, revision: current.current.edits.state.revision, index: 0 } : null,
    )
  }
  const sampleRangeAt = async (
    point: MaskPoint,
    sampleIndex?: number,
    presentedGeometry?: MaskGeometry,
  ) => {
    if (!rangeKind || !photoId || !state || busy.current || rangeSamplePending) return
    const token = ++rangeSampleEpoch.current
    const revision = state.revision
    const selectedIndex = sampleIndex ?? activeRangePick?.index ?? 0
    setRangeSamplePending(true)
    setError('')
    try {
      await edits.flush()
      if (token !== rangeSampleEpoch.current || current.current.photoId !== photoId) return
      const context = await window.irodori.getMaskContext(photoId, revision)
      if (token !== rangeSampleEpoch.current || current.current.photoId !== photoId) return
      if (presentedGeometry && !inspectionGeometryMatches(context.geometry, presentedGeometry))
        throw new Error(
          'Photograph geometry changed. Wait for the current preview before sampling.',
        )
      const result = await window.irodori.sampleMaskRange({
        photoId,
        expectedRevision: revision,
        renderingIdentity: context.renderingIdentity,
        point,
      })
      if (
        token !== rangeSampleEpoch.current ||
        current.current.photoId !== photoId ||
        current.current.edits.state?.revision !== revision
      )
        return
      if (result.photoId !== photoId || result.revision !== revision)
        throw new Error('The range sample belongs to an older photograph or edit revision.')
      let value: MaskRange
      if (rangeKind === 'color') {
        if (!result.color)
          throw new Error(
            result.reason ??
              'The sampled area has no defined color. Use Luminance range for black.',
          )
        const previous =
          rangeValues?.kind === 'color' ? rangeValues : defaultColorMaskRange(result.color)
        const samples = [...previous.samples]
        samples[Math.min(selectedIndex, samples.length)] = result.color
        value = { ...previous, samples }
      } else value = sampledLuminanceMaskRange(result.luminance)
      if (rangeSessionRef.current) publishRange({ ...rangeSessionRef.current, value })
      else if (selected) {
        await mutate(
          [
            {
              kind: 'update',
              id: selected.id,
              componentId: selectedComponentId ?? undefined,
              range: value,
            },
          ],
          revision,
        )
      }
      setRangePick(null)
    } catch (error) {
      if (token === rangeSampleEpoch.current) setError(String(error))
    } finally {
      if (token === rangeSampleEpoch.current) setRangeSamplePending(false)
    }
  }
  const acceptRange = async () => {
    const session = rangeSessionRef.current
    if (
      !session ||
      !rangePreviewKey ||
      rangeReady !== rangePreviewKey ||
      !available ||
      rangeSamplePending
    )
      return
    const operation = rangeOperation(session)
    if (!operation) return
    setRangePick(null)
    await mutate([operation], session.revision)
    if (current.current.photoId !== session.photoId || !current.current.enabled) return
    rangeRestoreFocus.current = null
    publishRange(null)
    const target = session.target
    changeWorkspace({
      selectedId: target.kind === 'new-mask' ? target.id : target.maskId,
      selectedComponentId: target.kind === 'new-mask' ? target.id : target.componentId,
      detailTab: 'coverage',
      brush: false,
      overlay: true,
    })
  }
  return {
    photoId,
    scope,
    masks: resolved,
    selectedId,
    selected: resolved.find((m) => m.id === selectedId) ?? null,
    selectedComponentId,
    selectedPart,
    coverageTarget: selectedCoverage,
    edgeValues,
    colorValues,
    available: available && !activeRangeSession,
    rangeAvailable: available && !rangeSamplePending,
    supported,
    rangeValues,
    rangeKind,
    rangeCreating: !!activeRangeSession,
    rangePicking: !!activeRangePick && enabled,
    rangeSamplePending,
    rangePreviewKey,
    rangePreviewReady: !!rangePreviewKey && rangeReady === rangePreviewKey,
    setRangePreviewReady: setRangeReady,
    rangeAcceptLabel:
      activeRangeSession?.target.kind === 'new-component'
        ? 'Add part'
        : activeRangeSession?.target.kind === 'replace-component'
          ? 'Replace coverage'
          : 'Create mask',
    startRange: (kind: MaskRange['kind']) => safely(startRange(kind)),
    addRangePart: (kind: MaskRange['kind'], operator: MaskOperator, parentId?: string) => {
      if (selected)
        safely(
          startRange(kind, {
            kind: 'new-component',
            maskId: selected.id,
            componentId: crypto.randomUUID(),
            parentId,
            name: `${kind === 'color' ? 'Color' : 'Luminance'} range part`,
            operator,
          }),
        )
    },
    replaceRangePart: (kind: MaskRange['kind'], componentId: string) => {
      if (selected)
        safely(startRange(kind, { kind: 'replace-component', maskId: selected.id, componentId }))
    },
    changeRange,
    commitRange,
    cancelRangeChange,
    pickRangeSample: (index: number) => {
      if (available && !rangeSamplePending) {
        setRangePick({ scope, revision: state!.revision, index })
        changeWorkspace({ brush: false })
      }
    },
    stopRangePicking: () => {
      rangeSampleEpoch.current++
      setRangePick(null)
      setRangeSamplePending(false)
    },
    sampleRangeAt: (point: MaskPoint, sampleIndex?: number, presentedGeometry?: MaskGeometry) =>
      safely(sampleRangeAt(point, sampleIndex, presentedGeometry)),
    acceptRange: () => safely(acceptRange()),
    canNavigate: !activeRangeSession && enabled && edits.confirmed && !!state && !!photoId,
    active,
    creatingGradient,
    editingGradient,
    gradientValues,
    gradientDraft:
      draft && draft.photoId === photoId && draft.revision === state?.revision
        ? draft.gradient
        : undefined,
    gradientDimensions,
    setGradientGeometry: registerGradientGeometry,
    previewGradient: (gradient: MaskGradient) => previewGradient(gradient),
    changeGradient: (gradient: MaskGradient) => {
      previewGradient(gradient, true)
    },
    commitGradient: () => safely(flush()),
    finishGradient: () => safely(finishGradient()),
    armGradient: (kind: MaskGradient['kind']) =>
      safely(
        (async () => {
          if (!available || busy.current || confirmed.length >= maskCapabilities.maxMasks) return
          const token = creationEpoch.current
          await edits.flush()
          if (
            current.current.photoId !== photoId ||
            !current.current.enabled ||
            creationEpoch.current !== token ||
            !current.current.edits.state
          )
            return
          cancel()
          changeWorkspace({ detailTab: 'coverage', brush: false })
          setArmedGradient({ scope, revision: current.current.edits.state.revision, kind })
        })(),
      ),
    previewCreatedGradient: (gradient: MaskGradient) => {
      if (!activePart || !photoId || !state) return
      try {
        validateMaskGradient(gradient, gradientDimensions?.width, gradientDimensions?.height)
      } catch {
        return
      }
      publish({
        photoId,
        revision: state.revision,
        maskId: activePart.maskId,
        componentId: activePart.parentId,
        newComponent: {
          componentId: activePart.componentId,
          parentId: activePart.parentId,
          name: activePart.name,
          operator: activePart.operator,
        },
        gradient,
      })
    },
    createGradient: async (gradient: MaskGradient) => {
      if (!available || busy.current || !photoId || !state) return
      validateMaskGradient(gradient, gradientDimensions?.width, gradientDimensions?.height)
      const revision = state.revision
      const token = creationEpoch.current
      const part = activePart
      await edits.flush()
      if (
        current.current.photoId !== photoId ||
        !current.current.enabled ||
        current.current.edits.state?.revision !== revision ||
        creationEpoch.current !== token
      ) {
        cancel()
        return
      }
      cancel()
      const id = part?.componentId ?? crypto.randomUUID()
      await mutate(
        [
          part
            ? {
                kind: 'component-add',
                id: part.maskId,
                componentId: id,
                parentId: part.parentId,
                name: part.name,
                operator: part.operator,
                gradient,
              }
            : {
                kind: 'create',
                id,
                name: `${gradient.kind === 'linear' ? 'Linear' : 'Radial'} gradient ${confirmed.length + 1}`,
                gradient,
              },
        ],
        revision,
      )
      if (current.current.photoId !== photoId || !current.current.enabled) return
      changeWorkspace({
        selectedId: part?.maskId ?? id,
        selectedComponentId: id,
        detailTab: part ? 'coverage' : 'adjustments',
        brush: false,
        overlay: true,
      })
    },
    overlayVisible: enabled && workspace.overlay,
    overlayMask,
    busy: pending || edits.saving,
    error,
    setError,
    workspace: {
      ...workspace,
      ...brushValues,
      overlayScope:
        selectedComponentId === null
          ? ('result' as const)
          : (workspace.overlayScope ?? ('result' as const)),
    },
    adjustments,
    coverageMutation,
    gesturing: !!draft || !!activeRangeSession,
    drawing: !!draft?.stroke,
    strokeDraft:
      draft && draft.photoId === photoId && draft.revision === state?.revision
        ? draft.stroke
        : undefined,
    epoch,
    cancel,
    flush,
    resetKey: `${photoId}:${state?.revision}:${selectedId}:${selectedComponentId}:${gradientRejected}`,
    selectComponent: async (componentId: string | null) => {
      await edits.flush()
      if (current.current.photoId !== photoId || !current.current.enabled) return
      cancel()
      changeWorkspace({ selectedComponentId: componentId, brush: false })
    },
    armComponent: (
      operator: MaskOperator,
      kind: 'brush' | MaskGradient['kind'],
      parentId?: string,
    ) =>
      safely(
        (async () => {
          if (!available || !selected) return
          const token = creationEpoch.current
          await edits.flush()
          if (
            current.current.photoId !== photoId ||
            !current.current.enabled ||
            creationEpoch.current !== token ||
            current.current.selectedId !== selected.id ||
            !current.current.edits.state
          )
            return
          cancel()
          setArmedPart({
            scope,
            revision: current.current.edits.state.revision,
            maskId: selected.id,
            parentId,
            componentId: crypto.randomUUID(),
            name: `${kind === 'brush' ? 'Brush' : kind === 'linear' ? 'Linear gradient' : 'Radial gradient'} part`,
            operator,
            kind,
          })
          changeWorkspace({
            detailTab: 'coverage',
            brush: kind === 'brush',
            mode: 'add',
            overlay: true,
          })
        })(),
      ),
    addingPart: !!activePart,
    select: async (id: string) => {
      await edits.flush()
      if (current.current.photoId !== photoId || !current.current.enabled) return
      if (!current.current.edits.state?.settings.maskStack.some((mask) => mask.id === id)) return
      cancel()
      changeWorkspace({ selectedId: id, selectedComponentId: null })
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
            selectedComponentId: id,
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
            changeWorkspace({ selectedId: id, selectedComponentId: null })
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
        componentId: selectedComponentId ?? undefined,
        edge: {
          ...(prior?.edge ?? selectedCoverage!.edge),
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
        componentId: activePart ? activePart.parentId : (selectedComponentId ?? undefined),
        strokeTarget: selectedComponentId ? 'primary' : 'result',
        ...(activePart
          ? {
              newComponent: {
                componentId: activePart.componentId,
                parentId: activePart.parentId,
                name: activePart.name,
                operator: activePart.operator,
              },
            }
          : {}),
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
