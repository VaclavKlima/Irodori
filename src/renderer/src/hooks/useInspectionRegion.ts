import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentInspectionRegion } from '../../../shared/agent'
import type { EditState } from '../../../shared/edits'
import type { PreviewContext } from '../../../shared/inspection'

export type InspectionRectangle = AgentInspectionRegion['region']

/** Region selection is workspace context, never a photograph edit or checkpoint. */
export function useInspectionRegion(
  photoId: string | undefined,
  edits: EditState | null,
  available: boolean,
  flush: () => Promise<void>,
) {
  const geometryKey = JSON.stringify([
    photoId,
    edits?.settings.crop ? { ...edits.settings.crop, aspectRatio: null } : undefined,
    edits?.settings.lens.distortion,
  ])
  const scope = useMemo(() => ({ geometryKey }), [geometryKey])
  const [stored, setStored] = useState<{
    key: typeof scope
    context: PreviewContext
    region?: InspectionRectangle
  }>()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const current = useRef({ photoId, scope, available })
  useLayoutEffect(() => {
    current.current = { photoId, scope, available }
  }, [photoId, scope, available])
  const value = stored?.key === scope ? stored : undefined
  const active = open && available && !!value
  const start = useCallback(async () => {
    if (!photoId || !available) return
    const key = scope
    setLoading(true)
    setError('')
    try {
      await flush()
      const confirmed = await window.irodori.getEdits(photoId)
      const context = await window.irodori.getPreviewContext(photoId, confirmed.revision)
      if (current.current.scope !== key || !current.current.available) return
      setStored((previous) => ({
        key,
        context,
        region:
          previous?.key === key && previous.context.gridIdentity === context.gridIdentity
            ? previous.region
            : undefined,
      }))
      setOpen(true)
    } catch (reason) {
      if (current.current.scope === key) setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [photoId, available, scope, flush])
  // Revalidate after confirmed edits without allowing an old asynchronous lookup to retarget selection.
  useEffect(() => {
    if (!value || !photoId || !edits || (!open && !value.region)) return
    let cancelled = false
    void window.irodori.getPreviewContext(photoId, edits.revision).then(
      (context) => {
        if (cancelled || current.current.scope !== scope) return
        setStored((previous) =>
          previous?.key === scope
            ? {
                ...previous,
                context,
                region:
                  previous.context.gridIdentity === context.gridIdentity
                    ? previous.region
                    : undefined,
              }
            : previous,
        )
      },
      (reason) => {
        if (!cancelled) setError(String(reason))
      },
    )
    return () => {
      cancelled = true
    }
    // Context publication must not trigger another lookup of the same revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId, edits?.revision, scope, open])
  const commit = useCallback(
    (region: InspectionRectangle) => {
      setStored((previous) =>
        previous?.key === scope && region.gridIdentity === previous.context.gridIdentity
          ? { ...previous, region: { ...region } }
          : previous,
      )
    },
    [scope],
  )
  const clear = useCallback(() => {
    setStored((previous) => (previous ? { ...previous, region: undefined } : previous))
  }, [])
  const close = useCallback(() => setOpen(false), [])
  const pending = useMemo<AgentInspectionRegion | undefined>(
    () =>
      value?.region && photoId
        ? { photoId, gridIdentity: value.context.gridIdentity, region: { ...value.region } }
        : undefined,
    [value, photoId],
  )
  return { active, loading, error, context: value?.context, pending, start, close, clear, commit }
}
export type InspectionRegionController = ReturnType<typeof useInspectionRegion>
