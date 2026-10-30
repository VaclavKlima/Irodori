import { useEffect, useMemo, useRef, useState } from 'react'
import type { DisplayPreview } from '../../../shared/contracts'
import {
  PREPARED_COMPARISON_VERSION,
  validatePreparedPreviewSourceRef,
} from '../../../shared/prepared-comparison'

/** Own the one main comparison lease and drain it before admitting its replacement. */
export function useComparisonPreview(after: DisplayPreview | null, enabled: boolean) {
  const source = after?.workingSource,
    photoId = source?.photoId,
    cacheId = source?.cacheId,
    workingSha256 = source?.workingSha256,
    revision = after?.settingsRevision,
    width = after?.width,
    height = after?.height,
    hdr = after?.format === 'hdr-working' || Boolean(after?.linear?.hdr),
    geometry = JSON.stringify(after?.crop ?? null),
    alreadyBefore = Boolean(after?.comparisonOf),
    [attempt, setAttempt] = useState(0),
    cycle = useMemo(() => {
      if (
        !enabled ||
        alreadyBefore ||
        !photoId ||
        !cacheId ||
        !workingSha256 ||
        revision === undefined ||
        !width ||
        !height
      )
        return null
      return {
        source: { photoId, cacheId, workingSha256 },
        revision,
        width,
        height,
        hdr,
        geometry,
        attempt,
      }
    }, [
      enabled,
      alreadyBefore,
      photoId,
      cacheId,
      workingSha256,
      revision,
      width,
      height,
      hdr,
      geometry,
      attempt,
    ]),
    [state, setState] = useState<{
      cycle: NonNullable<typeof cycle>
      preview?: DisplayPreview
      error?: string
    } | null>(null),
    retirement = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    if (!cycle) return
    const prior = retirement.current,
      token = crypto.randomUUID()
    let cancelled = false,
      issued = false
    const work = (async () => {
      await prior.catch(() => undefined)
      if (cancelled) return
      try {
        issued = true
        const preview = await window.irodori.requestComparisonPreview(
            cycle.source,
            token,
            cycle.revision,
          ),
          identity = preview.comparisonOf
        if (cancelled) return
        validatePreparedPreviewSourceRef(preview.workingSource)
        if (
          preview.photoId !== cycle.source.photoId ||
          preview.requestId !== token ||
          preview.settingsRevision !== cycle.revision ||
          preview.width !== cycle.width ||
          preview.height !== cycle.height ||
          preview.format !== (cycle.hdr ? 'hdr-working' : 'rgba8-srgb') ||
          JSON.stringify(preview.crop ?? null) !== cycle.geometry ||
          !preview.linear?.url ||
          Boolean(preview.linear.hdr) !== cycle.hdr ||
          identity?.version !== PREPARED_COMPARISON_VERSION ||
          identity.settingsRevision !== cycle.revision ||
          identity.after.photoId !== cycle.source.photoId ||
          identity.after.cacheId !== cycle.source.cacheId ||
          identity.after.workingSha256 !== cycle.source.workingSha256
        )
          throw new Error('The comparison does not match the current photograph and edits.')
        setState({ cycle, preview })
      } catch (error) {
        if (issued) await window.irodori.releaseFullPreview(token).catch(() => undefined)
        issued = false
        if (!cancelled)
          setState({ cycle, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      cancelled = true
      const release = issued ? window.irodori.releaseFullPreview(token) : Promise.resolve()
      retirement.current = Promise.allSettled([prior, work, release])
    }
  }, [cycle])

  const current = cycle && state?.cycle === cycle ? state : null
  return {
    preview: current?.preview ?? null,
    error: current?.error ?? '',
    loading: Boolean(cycle && !current?.preview && !current?.error),
    retry: () => setAttempt((value) => value + 1),
  }
}
