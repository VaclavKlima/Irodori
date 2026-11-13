import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import { maskEdgePixelIdentity } from '../../../shared/mask-edges'
import { maskCoverageNodes, mapMaskCoverage } from '../../../shared/masks-gpu'
import {
  hasMaskAdjustments,
  maskHasEdges,
  validatePreparedMaskCoverage,
  type PreparedMaskCoverage,
  type MaskMutation,
} from '../../../shared/masks'

interface Options {
  photoId: string | undefined
  revision: number | undefined
  /** An authoritative refresh must revalidate even if a source changed at the same revision. */
  confirmation: object | undefined
  enabled: boolean
  parameters: AdjustmentParameters
  selectedId: string | null
  overlayVisible: boolean
  mutation?: MaskMutation
}
interface Completed {
  identity: string
  confirmation: object | undefined
  coverages: Record<string, PreparedMaskCoverage>
  rangeBases: Record<string, PreparedMaskCoverage>
}

/** Main prepares committed coverage and validated geometry drafts without publishing draft history. */
export function useMaskEdgeCoverage({
  photoId,
  revision,
  confirmation,
  enabled,
  parameters,
  selectedId,
  overlayVisible,
  mutation,
}: Options) {
  const requiredById = new Map<string, import('../../../shared/masks').ResolvedMask>()
  for (const root of parameters.localMasks ?? []) {
    if (root.enabled && hasMaskAdjustments(root))
      for (const node of maskCoverageNodes(root))
        if (maskHasEdges(node) || node.range) requiredById.set(node.id, node)
    if (overlayVisible && selectedId) {
      const selected = maskCoverageNodes(root, true).find((node) => node.id === selectedId)
      if (selected)
        for (const node of maskCoverageNodes(selected))
          if (maskHasEdges(node) || node.range) requiredById.set(node.id, node)
    }
  }
  const required = [...requiredById.values()]
  const identity = JSON.stringify([
    photoId,
    revision,
    mutation,
    required.map((mask) => [mask.id, maskEdgePixelIdentity(mask)]).sort(),
  ])
  const requiredIds = required.map((mask) => mask.id)
  const request = useRef({ identity, requiredIds, photoId, revision, confirmation, mutation })
  useLayoutEffect(() => {
    request.current = { identity, requiredIds, photoId, revision, confirmation, mutation }
  })
  const [completed, setCompleted] = useState<Completed | null>(null)
  const [failure, setFailure] = useState<{
    identity: string
    confirmation: object | undefined
    message: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retirement = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    if (!enabled || !photoId || revision === undefined || !request.current.requiredIds.length)
      return
    const current = request.current
    const requestId = crypto.randomUUID()
    let active = true
    const work = async () => {
      // Electron invokes can otherwise let an old cancellation overtake a new request.
      await retirement.current
      if (!active) return
      const response = await window.irodori.prepareMaskCoverage({
        photoId,
        revision,
        maskIds: current.requiredIds,
        requestId,
        ...(current.mutation ? { mutation: current.mutation } : {}),
      })
      if (!active) return
      if (response.photoId !== photoId || response.revision !== revision)
        throw new Error('Prepared mask edges belong to an older photograph or revision.')
      if (
        current.requiredIds.some(
          (id) =>
            !Object.hasOwn(response.coverages, id) && !Object.hasOwn(response.rangeBases ?? {}, id),
        )
      )
        throw new Error('Prepared mask edges are incomplete. Retry GPU.')
      for (const coverage of Object.values(response.coverages))
        validatePreparedMaskCoverage(coverage)
      for (const coverage of Object.values(response.rangeBases ?? {}))
        validatePreparedMaskCoverage(coverage)
      setCompleted({
        identity,
        confirmation,
        coverages: response.coverages,
        rangeBases: response.rangeBases ?? {},
      })
    }
    void work().catch((error) => {
      if (active) setFailure({ identity, confirmation, message: String(error) })
    })
    return () => {
      active = false
      retirement.current = window.irodori
        .cancelMaskCoverage(photoId, requestId)
        .catch(() => undefined)
    }
  }, [enabled, photoId, revision, identity, confirmation, attempt])
  const ready =
    !requiredIds.length ||
    (enabled && completed?.identity === identity && completed.confirmation === confirmation)
  const error =
    !ready && failure?.identity === identity && failure.confirmation === confirmation
      ? failure.message
      : ''
  const localMasks = useMemo(() => {
    const masks = parameters.localMasks
    if (!masks?.length) return masks
    if (
      (!ready || !completed || completed.identity !== identity) &&
      !masks.some((mask) =>
        maskCoverageNodes(mask, true).some(
          (node) => node.preparedCoverage || node.preparedRangeBase,
        ),
      )
    )
      return masks
    if (
      !requiredIds.length &&
      !masks.some((mask) =>
        maskCoverageNodes(mask, true).some(
          (node) => node.preparedCoverage || node.preparedRangeBase,
        ),
      )
    )
      return masks
    return masks.map((root) =>
      mapMaskCoverage(root, (mask) => {
        const current = { ...mask }
        delete current.preparedCoverage
        delete current.preparedRangeBase
        const coverage =
          ready && completed?.identity === identity ? completed.coverages[mask.id] : undefined
        const rangeBase =
          ready && completed?.identity === identity ? completed.rangeBases[mask.id] : undefined
        if (rangeBase && mask.range) current.preparedRangeBase = rangeBase
        return coverage && maskHasEdges(mask) ? { ...current, preparedCoverage: coverage } : current
      }),
    )
  }, [parameters.localMasks, completed, identity, ready, requiredIds.length])
  const prepared = useMemo<AdjustmentParameters>(
    () => ({ ...parameters, localMasks }),
    [parameters, localMasks],
  )
  const retry = useCallback(() => {
    setFailure(null)
    setAttempt((value) => value + 1)
  }, [])
  return {
    parameters: prepared,
    ready,
    pending: !!requiredIds.length && enabled && !ready && !error,
    error,
    retry,
  }
}
