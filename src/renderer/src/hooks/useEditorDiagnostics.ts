import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditState } from '../../../shared/edits'
import type { DisplayTarget } from '../../../shared/hdr'
import type {
  DiagnosticImage,
  PhotoDiagnosticsRequest,
  PhotoDiagnosticsResult,
} from '../../../shared/photo-diagnostics'
import type { InspectionRegionController } from './useInspectionRegion'

export type DiagnosticScope = 'whole-photo' | 'region' | `mask:${string}`
type RequestState = { result: PhotoDiagnosticsResult } | { error: string }

export function useEditorDiagnostics({
  photoId,
  edits,
  inspection,
  display,
  enabled,
  unavailableReason,
}: {
  photoId?: string
  edits: EditState | null
  inspection: InspectionRegionController
  display: DisplayTarget
  enabled: boolean
  unavailableReason?: string
}) {
  const [selected, setSelected] = useState<{ photoId: string; scope: DiagnosticScope }>()
  const [overlay, setOverlay] = useState<DiagnosticImage['label']>()
  const [attempt, setAttempt] = useState(0)
  const saved = edits?.photoId === photoId ? edits?.settings.maskStack : undefined
  const chosen = selected?.photoId === photoId ? (selected?.scope ?? 'whole-photo') : 'whole-photo'
  const maskId = chosen.startsWith('mask:') ? chosen.slice(5) : undefined
  const mask = saved?.find((entry) => entry.id === maskId)
  const scope = maskId && !mask ? 'whole-photo' : chosen
  const revision = edits?.photoId === photoId ? edits?.revision : undefined
  const region =
    scope === 'region' &&
    inspection.context?.revision === revision &&
    inspection.pending?.photoId === photoId
      ? inspection.pending?.region
      : undefined
  const knownMaskGrid =
    scope.startsWith('mask:') &&
    inspection.context?.photoId === photoId &&
    inspection.context?.revision === revision
      ? inspection.context?.gridIdentity
      : undefined
  const presented = display.presentation
  const presentedMode = presented?.mode
  const targetGeneration = display.generation
  const ready =
    enabled &&
    presented?.stage === 'presented' &&
    presented.photoId === photoId &&
    presented.revision === revision &&
    presented.targetGeneration === targetGeneration

  const request = useMemo<PhotoDiagnosticsRequest | undefined>(() => {
    if (!ready || !photoId || revision === undefined || (!region && !maskId)) return
    if (scope === 'whole-photo') return
    return {
      photoId,
      expectedRevision: revision,
      target: 'current',
      targetGeneration,
      ...(region
        ? { region }
        : { maskId, ...(knownMaskGrid ? { gridIdentity: knownMaskGrid } : {}) }),
    } satisfies PhotoDiagnosticsRequest
  }, [ready, photoId, revision, region, maskId, knownMaskGrid, scope, targetGeneration])
  const run = useMemo(
    () => ({ request, attempt, presentedMode }),
    [request, attempt, presentedMode],
  )
  const [state, setState] = useState<{ run: typeof run; state: RequestState }>()
  const draining = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    const request = run.request
    if (!request) return
    const id = crypto.randomUUID()
    let active = true
    let started = false
    // Numeric rectangle fields can be committed in quick succession.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await draining.current
          if (!active) return
          const gridIdentity = request.gridIdentity ?? request.region?.gridIdentity
          started = true
          const result = await window.irodori.getPhotoDiagnostics(id, request)
          if (!active) return
          if (
            result.photoId !== request.photoId ||
            result.revision !== request.expectedRevision ||
            (gridIdentity !== undefined && result.gridIdentity !== gridIdentity) ||
            result.target.generation !== request.targetGeneration ||
            result.target.mode !== run.presentedMode ||
            (request.maskId
              ? result.selection.kind !== 'mask' || result.selection.maskId !== request.maskId
              : result.selection.kind !== 'rectangle')
          )
            throw new Error('The diagnostic result no longer matches the selected photograph.')
          setState({ run, state: { result } })
        } catch (reason) {
          if (active)
            setState({
              run,
              state: { error: reason instanceof Error ? reason.message : String(reason) },
            })
        } finally {
          started = false
        }
      })()
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timer)
      if (started) draining.current = window.irodori.cancelPhotoDiagnostics(id).catch(() => {})
    }
  }, [run])

  const value = state?.run === run ? state.state : undefined
  const result = value && 'result' in value ? value.result : undefined
  const error = value && 'error' in value ? value.error : undefined
  const waiting =
    unavailableReason ??
    (scope === 'region' && !inspection.pending?.region
      ? 'Draw or enter an inspection region.'
      : 'Waiting for the committed preview…')
  return {
    scope,
    masks: saved,
    select: (next: DiagnosticScope) => {
      if (photoId) setSelected({ photoId, scope: next })
      setOverlay(undefined)
      setState(undefined)
    },
    overlay,
    toggleOverlay: (next: DiagnosticImage['label']) =>
      setOverlay((previous) => (previous === next ? undefined : next)),
    result,
    error,
    waiting,
    pending: !!request && !value,
    retry: () => setAttempt((previous) => previous + 1),
  }
}

export type EditorDiagnosticsController = ReturnType<typeof useEditorDiagnostics>
