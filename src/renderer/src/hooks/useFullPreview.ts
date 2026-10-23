import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FullPreview, DisplayPreview } from '../../../shared/contracts'
import type { DisplayTarget } from '../../../shared/hdr'
import { cachedFrame, loadFrame, type FrameLease } from '../preview/frame-cache'
import { useForegroundActivity } from './useForegroundActivity'
import {
  hdrFirstSurfaceOfferMatches,
  type HdrFirstSurfaceOffer,
  type HdrFirstSurfaceRequest,
} from '../../../shared/hdr-first-surface'
import {
  captureHdrPreviewRetirement,
  hdrFirstSurfaceExistingOwners,
  hdrHasCompletedPhoto,
  hdrForgetCompletedPhoto,
} from '../preview/hdr-preview-resources'

interface State {
  preview: DisplayPreview | null
  pixels: ImageBitmap | null
  placeholder: FullPreview | null
  error: string | null
  firstSurface: HdrFirstSurfaceOffer | null
}
const empty: State = {
  preview: null,
  pixels: null,
  placeholder: null,
  error: null,
  firstSurface: null,
}

export function useFullPreview(
  photoId: string | undefined,
  enabled = true,
  mode: 'sdr' | 'hdr' = 'hdr',
  firstSurface?: HdrFirstSurfaceRequest,
  ordinaryRaster = false,
) {
  const { begin } = useForegroundActivity(photoId, undefined, enabled)
  const latestRevision = useRef(0)
  const displayedLease = useRef<FrameLease | null>(null)
  const latestFirstSurface = useRef(firstSurface)
  latestFirstSurface.current = firstSurface
  const activeRequest = useRef<{
    photoId: string
    requestId: string
    firstSurface?: HdrFirstSurfaceRequest
  } | null>(null)
  const isFirstSurfaceCurrent = useCallback((offer: HdrFirstSurfaceOffer) => {
    const current = activeRequest.current,
      snapshot = latestFirstSurface.current
    if (!current?.firstSurface || !snapshot) return false
    try {
      return (
        hdrFirstSurfaceOfferMatches(
          offer,
          current.firstSurface,
          current.photoId,
          current.requestId,
        ) && hdrFirstSurfaceOfferMatches(offer, snapshot, current.photoId, current.requestId)
      )
    } catch {
      return false
    }
  }, [])
  useEffect(
    () => () => {
      displayedLease.current?.release()
    },
    [],
  )
  const regenerateRevision = useRef(0)
  const [revision, setRevision] = useState(0)
  useEffect(
    () =>
      window.luma.onLibraryEvent((event) => {
        if (event.editsChanged && event.lensChanged)
          hdrForgetCompletedPhoto(event.editsChanged.photoId)
        if (event.editsChanged && event.editsChanged.photoId === photoId) {
          latestRevision.current = event.editsChanged.revision
          setRevision(event.editsChanged.revision)
          if (event.lensChanged) setState(empty)
        }
      }),
    [photoId],
  )
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State>(empty)
  const [activeRequestIdentity, setActiveRequestIdentity] = useState<{
    id: string
    startedAt?: number
  }>({ id: '' })
  // Optional display authorization can change without restarting an admitted source job.
  const sourceCycle = useMemo(
    () => ({ photoId, enabled, attempt, revision, mode }),
    [photoId, enabled, attempt, revision, mode],
  )
  const [admission, setAdmission] = useState<{
    cycle: typeof sourceCycle
    ordinaryRaster: boolean
    timings?: {
      ownerWaitStartedAt?: number
      ownerWaitFinishedAt?: number
      admissionFinishedAt: number
    }
    target?: DisplayTarget
    error?: unknown
  } | null>(null)
  useEffect(() => {
    if (!sourceCycle.photoId || !sourceCycle.enabled || admission?.cycle === sourceCycle) return
    let cancelled = false
    void (async () => {
      try {
        // Unknown/HDR sources retain the real earlier-owner barrier even without
        // an optional descriptor. Confirmed display-referred sources can prepare
        // ordinary raster pixels while an unrelated GPU owner drains.
        const ownerWaitStartedAt = ordinaryRaster ? undefined : performance.now()
        if (!ordinaryRaster) await captureHdrPreviewRetirement()
        // Renderer performance.now(): this continuation observes real earlier-owner
        // drain; its scheduling delay is included, rather than claiming GPU elapsed time.
        const ownerWaitFinishedAt = ordinaryRaster ? undefined : performance.now()
        if (cancelled) return
        const target = await window.luma.getDisplayState()
        if (!cancelled)
          setAdmission({
            cycle: sourceCycle,
            target,
            ordinaryRaster,
            timings: {
              ownerWaitStartedAt,
              ownerWaitFinishedAt,
              admissionFinishedAt: performance.now(),
            },
          })
      } catch (error) {
        if (!cancelled) setAdmission({ cycle: sourceCycle, error, ordinaryRaster })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sourceCycle, ordinaryRaster, admission])
  useEffect(() => {
    if (!photoId || !enabled || admission?.cycle !== sourceCycle) return
    const regenerate = attempt > 0 && revision === regenerateRevision.current
    const requestId = crypto.randomUUID()
    const abort = new AbortController()
    let cancelled = false
    let frame: FrameLease | undefined
    let offered: HdrFirstSurfaceOffer | undefined
    activeRequest.current = { photoId, requestId }
    const unsubscribe = window.luma.onHdrFirstSurface((offer) => {
      if (offer.photoId !== photoId || offer.requestId !== requestId) return
      if (cancelled || !isFirstSurfaceCurrent(offer)) {
        void window.luma.releaseHdrFirstSurface(requestId, offer.surfaceId).catch(() => undefined)
        return
      }
      offered = offer
      setState((previous) => ({ ...previous, firstSurface: offer }))
    })
    const releaseActivity = begin()
    void (async () => {
      const started = performance.now()
      try {
        if (admission.error) throw admission.error
        // This effect runs after the admission render, so earlier confirmed edit
        // replies can commit. A held edit reply never blocks ordinary source work.
        // Freeze once: a later confirmation cannot upgrade or restart this job.
        const snapshot = latestFirstSurface.current,
          completedSource = hdrHasCompletedPhoto(photoId),
          rendererReservation = hdrFirstSurfaceExistingOwners()
        let surfaceRequest: HdrFirstSurfaceRequest | undefined
        if (
          !admission.ordinaryRaster &&
          !completedSource &&
          snapshot &&
          admission.target &&
          snapshot.target.generation === admission.target.generation &&
          snapshot.target.outputVersion === admission.target.outputVersion &&
          snapshot.target.mode === admission.target.mode &&
          snapshot.target.colorSpace === admission.target.colorSpace &&
          snapshot.target.peak === admission.target.peak &&
          snapshot.target.headroom === admission.target.headroom &&
          snapshot.target.mode === mode
        )
          surfaceRequest = {
            ...structuredClone(snapshot),
            rendererReservation,
          }
        activeRequest.current = { photoId, requestId, firstSurface: surfaceRequest }
        // The existing state publication and bridge invocation follow in this same turn.
        setActiveRequestIdentity({ id: requestId, startedAt: performance.now() })
        let preview: DisplayPreview | null = await window.luma.requestHdrPreview(
          photoId,
          requestId,
          regenerate,
          mode,
          surfaceRequest,
          rendererReservation,
        )
        if (cancelled) return
        if (!preview && !regenerate)
          preview = await window.luma.requestCachedFullPreview(photoId, requestId)
        if (cancelled) return
        if (!preview) preview = await window.luma.requestFullPreview(photoId, requestId, regenerate)
        if (cancelled) return
        if ((preview.settingsRevision ?? 0) < latestRevision.current) return
        if (preview.photoId !== photoId || preview.requestId !== requestId)
          throw new Error('The preview response does not match this photo.')
        if (preview.format === 'hdr-working') {
          displayedLease.current?.release()
          displayedLease.current = null
          setState((previous) => ({
            preview,
            pixels: null,
            placeholder: null,
            error: null,
            firstSurface:
              !preview.firstSurfaceDecline && previous.firstSurface?.requestId === requestId
                ? previous.firstSurface
                : null,
          }))
          return
        }
        frame = cachedFrame(preview) ?? undefined
        if (!frame) {
          // The placeholder and frame share the exact rendering revision.
          setState((previous) => (previous.pixels ? previous : { ...empty, placeholder: preview }))
          frame = await loadFrame(preview, abort.signal)
        }
        if (cancelled || (preview.settingsRevision ?? 0) < latestRevision.current) {
          frame.release()
          return
        }
        displayedLease.current?.release()
        displayedLease.current = frame
        setState({
          preview,
          pixels: frame.bitmap,
          placeholder: null,
          error: null,
          firstSurface: null,
        })
        performance.measure('luma.full-preview.load', {
          start: started,
          detail: { photoId, renderId: preview.renderId },
        })
      } catch (error) {
        // An edit can cancel main-process work before React cleans up this effect.
        // A superseded request must not replace the working preview with an error.
        if (!cancelled && revision >= latestRevision.current) {
          setState((state) => ({
            ...state,
            preview: null,
            pixels: null,
            firstSurface: null,
            error: error instanceof Error ? error.message : String(error),
          }))
          void window.luma.releaseFullPreview(requestId).catch(() => undefined)
        }
      } finally {
        releaseActivity()
      }
    })()
    return () => {
      cancelled = true
      unsubscribe()
      if (activeRequest.current?.requestId === requestId) activeRequest.current = null
      releaseActivity()
      abort.abort()
      if (frame && frame !== displayedLease.current) frame.release()
      void window.luma.releaseFullPreview(requestId).catch(() => undefined)
      if (offered)
        void window.luma.releaseHdrFirstSurface(requestId, offered.surfaceId).catch(() => undefined)
    }
  }, [
    photoId,
    attempt,
    revision,
    enabled,
    begin,
    mode,
    admission,
    sourceCycle,
    isFirstSurfaceCurrent,
  ])

  const retry = useCallback(() => {
    regenerateRevision.current = latestRevision.current
    setState(empty)
    setAttempt((value) => value + 1)
  }, [])
  const displayFailed = useCallback(
    () =>
      setState((state) => ({
        ...state,
        preview: null,
        pixels: null,
        firstSurface: null,
        error: 'The full-resolution image could not be displayed.',
      })),
    [],
  )
  return {
    ...state,
    requestId: activeRequestIdentity.id,
    requestStartedAt: activeRequestIdentity.startedAt,
    admissionTimings: admission?.cycle === sourceCycle ? admission.timings : undefined,
    retry,
    displayFailed,
    isFirstSurfaceCurrent,
  }
}
