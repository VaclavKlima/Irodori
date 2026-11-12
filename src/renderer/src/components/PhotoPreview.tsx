import { ChevronLeft, ChevronRight, FileImage, Layers, Scan } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { flushSync } from 'react-dom'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import {
  neutralAdjustments,
  sameAdjustments,
  snapshotAdjustments,
} from '../../../shared/adjustments'
import type { Photo } from '../../../shared/contracts'
import { mapCropAffine } from '../../../shared/crop'
import { spatialControlsActive } from '../../../shared/detail-controls'
import type { EditorPreviewPolicy } from '../../../shared/editor-preview-policy'
import type { EditState } from '../../../shared/edits'
import type { DisplayTarget } from '../../../shared/hdr'
import {
  HDR_FIRST_SURFACE_VERSION,
  hdrFirstSurfaceRequestKey,
  type HdrFirstSurfaceOffer,
  type HdrFirstSurfaceRequest,
} from '../../../shared/hdr-first-surface'
import { whiteBalanceSampleArea } from '../../../shared/white-balance-picker'
import type { PreviewViewState } from '../../../shared/workspace'
import layout from '../App.module.css'
import { useComparisonPreview } from '../hooks/useComparisonPreview'
import type { CropController } from '../hooks/useCrop'
import { useForegroundActivity } from '../hooks/useForegroundActivity'
import { useFullPreview } from '../hooks/useFullPreview'
import { useHdrAnalysis } from '../hooks/useHdrAnalysis'
import { usePanDrag } from '../hooks/usePanDrag'
import { usePreviewAnalysis, type ClippingMask } from '../hooks/usePreviewAnalysis'
import { usePreviewFrame } from '../hooks/usePreviewFrame'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { usePreviewWheel } from '../hooks/usePreviewWheel'
import type { WhiteBalancePickerController } from '../hooks/useWhiteBalancePicker'
import type { ToneCurvesController } from '../hooks/useToneCurves'
import type { MasksController } from '../hooks/useMasks'
import { maskCanonicalPoint } from '../../../shared/mask-geometry'
import { MaskOverlayPresenter } from '../preview/mask-overlay'
import { useWorkingPreview } from '../hooks/useWorkingPreview'
import type { EditGestureCommit } from '../preview/edit-gesture'
import {
  constrain,
  INITIAL_VIEW,
  minimumScale,
  normalizedSourcePoint,
  replaceDimensions,
  restoreView,
  savedView,
  stepScale,
  ZOOM_STOPS,
  zoomAt,
  type PresentedPreviewGeometry,
  type Size,
  type View,
} from '../preview/geometry'
import { HdrPresenter } from '../preview/hdr-presenter'
import { clippingOverlayPixels } from '../preview/clipping-overlay'
import { confirmedAdjustments, confirmedGestureCommit } from '../preview/confirmed-adjustments'
import type { ReserveNativeMask } from '../preview/native-mask-relay'
import { maskPixelTarget } from '../preview/native-mask-reservation'
import { PreviewPresenter } from '../preview/presenter'
import { CropOverlay } from './CropOverlay'
import { GradientOverlay } from './GradientOverlay'
import styles from './PhotoPreview.module.css'
import { ProgressSpinner } from './ProgressSpinner'
import { IconButton } from './ui/Controls'
import { InspectionRegion } from './InspectionRegion'
import type { InspectionRegionController } from '../hooks/useInspectionRegion'
import type { ObjectSelectionController } from '../hooks/useObjectSelection'
import { ObjectSelectionOverlay } from './ObjectSelection'
import { inspectionGeometryMatches } from '../preview/inspection-geometry'
import { selectionScreenPoint } from '../preview/object-selection-geometry'
import { neutralMaskColor, neutralMaskLight } from '../../../shared/masks'
import { maskCoverageNodes, maskTreeHasEdges } from '../../../shared/masks-gpu'

interface Model {
  loaded: boolean
  image: Size
  viewport: Size
  view: View
}
interface Props {
  previewPolicy: EditorPreviewPolicy
  hdrJpeg?: boolean
  suspended?: boolean
  initialView?: PreviewViewState | null
  onViewChange?: (view: PreviewViewState) => void
  displayTarget: DisplayTarget
  tools: PreviewTools
  gesturing: boolean
  editingEpoch?: number
  adjustments: AdjustmentParameters
  confirmedEdits?: EditState | null
  gestureCommit?: EditGestureCommit | null
  onEditingReady: (photoId: string | null) => void
  onPresentationFailure: () => void
  photo: Photo | null
  group?: { index: number; count: number }
  total: number
  position: number
  onNavigate: (direction: -1 | 1) => Promise<void>
  onImport: () => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
  whiteBalancePicker?: WhiteBalancePickerController
  toneCurves?: ToneCurvesController
  crop?: CropController
  masks?: MasksController
  inspection?: InspectionRegionController
  objectSelection?: ObjectSelectionController
  maskEdgeCoverage?: { ready: boolean; pending: boolean; error: string; retry: () => void }
}

function maskCursorStyle(
  geometry: PresentedPreviewGeometry,
  viewport: Size,
  point: { x: number; y: number },
  size: number,
) {
  const { image, view } = geometry,
    scaleX = viewport.width / geometry.viewport.width,
    scaleY = viewport.height / geometry.viewport.height,
    diameter =
      (size / 100) *
      Math.min(
        geometry.maskGeometry?.canonicalWidth ?? image.width,
        geometry.maskGeometry?.canonicalHeight ?? image.height,
      ) *
      view.scale
  return {
    left:
      (geometry.viewport.width / 2 + view.x + (point.x - image.width / 2) * view.scale) * scaleX,
    top:
      (geometry.viewport.height / 2 + view.y + (point.y - image.height / 2) * view.scale) * scaleY,
    width: diameter * scaleX,
    height: diameter * scaleY,
  }
}

// The parent keys this component by photo ID so every new photograph starts in Fit.
export function PhotoPreview({
  previewPolicy,
  hdrJpeg = false,
  suspended = false,
  initialView = null,
  onViewChange,
  displayTarget,
  photo,
  adjustments: providedAdjustments,
  confirmedEdits = null,
  gestureCommit: localGestureCommit = null,
  tools,
  gesturing,
  editingEpoch = 0,
  onEditingReady,
  onPresentationFailure,
  group,
  total,
  position,
  onNavigate,
  onImport,
  onContextMenu,
  whiteBalancePicker,
  toneCurves,
  crop,
  masks,
  inspection,
  objectSelection,
  maskEdgeCoverage,
}: Props) {
  const cropping = !!crop?.active
  const recoveryView = useRef(initialView)
  const currentTarget = useRef(displayTarget)
  useLayoutEffect(() => {
    currentTarget.current = displayTarget
  }, [displayTarget])
  const overlay = useRef<HTMLCanvasElement>(null)
  const maskOverlay = useRef<HTMLCanvasElement>(null)
  const maskOverlayOwner = useRef<MaskOverlayPresenter | null>(null)
  const maskOverlayFailure = useRef<(message: string) => void>(() => {})
  const maskOverlayReady = useRef<() => void>(() => {})
  const maskPresentationRef = useRef<PresentedPreviewGeometry | undefined>(undefined)
  const redrawMaskCoverage = useRef<() => void>(() => {})
  const [maskPresentation, setMaskPresentation] = useState<PresentedPreviewGeometry>()
  const brushPointer = useRef<number | null>(null)
  const keyboardStroke = useRef(false)
  const brushCursorElement = useRef<HTMLDivElement>(null)
  const [brushCursor, setBrushCursor] = useState<{ x: number; y: number } | null>(null)
  const brushOutput = useRef({ x: 0, y: 0 })
  const [brushPath, setBrushPath] = useState<{ x: number; y: number }[]>([])
  const divider = useRef<HTMLDivElement>(null)
  const dividerPointer = useRef<number | null>(null)
  const [maskState, setMaskState] = useState<{ key: string; value: ClippingMask }>()
  const viewport = useRef<HTMLDivElement>(null)
  const curvePointer = useRef<number | null>(null)
  useEffect(() => {
    const element = viewport.current
    return () => {
      const id = curvePointer.current
      curvePointer.current = null
      if (id !== null && element?.hasPointerCapture(id)) element.releasePointerCapture(id)
    }
  }, [toneCurves?.active, toneCurves?.resetKey])
  const image = useRef<HTMLCanvasElement>(null)
  const retainedSurface = useRef<HTMLCanvasElement>(null)
  const presenter = useRef<PreviewPresenter | HdrPresenter | null>(null)
  const publishMaskPresentation = useCallback((owner: PreviewPresenter | HdrPresenter) => {
    if (presenter.current !== owner) return
    const geometry = owner.presentedGeometry
    if (!geometry) return
    maskPresentationRef.current = geometry
    redrawMaskCoverage.current()
    setMaskPresentation(geometry)
  }, [])
  const readMaskPresentation = useCallback(() => {
    const geometry = maskPresentationRef.current
    return geometry && presenter.current?.presentedGeometry === geometry ? geometry : undefined
  }, [])
  const registerGradientGeometry = masks?.setGradientGeometry
  useEffect(() => {
    registerGradientGeometry?.(maskPresentation?.maskGeometry)
  }, [registerGradientGeometry, maskPresentation?.maskGeometry, masks?.resetKey])
  const hdrRetirement = useRef<Promise<void>>(Promise.resolve())
  const failPresentation = useRef<((reason: string) => void) | undefined>(undefined)
  const firstSurfacePolicyOwner = useRef<HdrPresenter | null>(null)
  const [retainedFrame, setRetained] = useState<{
    sourceSpace: string
    revision: number
    comparison: string
    binding: string
    hdrOwner?: string
    targetGeneration?: string
  } | null>(null)
  const [geometryRevision, setGeometryRevision] = useState(0)
  const restoreCanvasFocus = useRef(false)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      // The photo-keyed owner and its recovery canvas are both being discarded.
      // Same-photo canvas replacements leave this owner mounted.
      mounted.current = false
    }
  }, [])
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) {
      maskPresentationRef.current = undefined
      maskOverlayOwner.current?.clear()
      setMaskPresentation(undefined)
      setBrushCursor(null)
      restoreCanvasFocus.current ||= document.activeElement === image.current
      const previous = image.current,
        surface = retainedSurface.current
      if (mounted.current && surface && previous?.dataset.editing === 'ready') {
        const identity = {
          sourceSpace: previous.dataset.frameSourceSpace ?? 'confirmed',
          revision: Number(previous.dataset.frameGeometryRevision ?? -1),
          comparison: previous.dataset.comparison ?? 'after',
          binding: previous.dataset.spatialComparisonBinding ?? 'single',
          hdrOwner: previous.dataset.hdrPresentationOwner,
          targetGeneration: previous.dataset.targetGeneration,
        }
        try {
          if (previous.dataset.backend === 'webgpu-hdr') {
            // Materialize owned completed CPU half pixels before clearing the old ref.
            // Device loss may already have done this before React replaces the canvas.
            const activePresenter = presenter.current
            const recovered =
              activePresenter instanceof HdrPresenter
                ? activePresenter.recoverCompletedFrame(surface)
                : surface.dataset.presentationSerial === previous.dataset.presentationSerial
            if (recovered) setRetained(identity)
          } else {
            const scale = Math.min(1, 1024 / Math.max(previous.width, previous.height))
            surface.width = Math.max(1, Math.round(previous.width * scale))
            surface.height = Math.max(1, Math.round(previous.height * scale))
            surface.getContext('2d')!.drawImage(previous, 0, 0, surface.width, surface.height)
            setRetained(identity)
          }
        } catch {
          /* Keep first-render loading explicit if a lost device cannot be copied. */
        }
      }
      // A queued frame can run before passive effect cleanup. Retire the detached
      // canvas's owner before a new working source can reach its old presenter.
      const detachedPresenter = presenter.current
      if (detachedPresenter) {
        if (presenter.current === detachedPresenter) presenter.current = null
        detachedPresenter.dispose()
        hdrRetirement.current = detachedPresenter.whenDisposed
        void hdrRetirement.current.catch(() => undefined)
      }
    }
    image.current = canvas
    if (canvas && restoreCanvasFocus.current) {
      canvas.focus({ preventScroll: true })
      restoreCanvasFocus.current = document.activeElement !== canvas
    }
  }, [])
  const [model, setModel] = useState<Model>({
    loaded: false,
    image: { width: photo?.width ?? 0, height: photo?.height ?? 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model)
  useEffect(() => {
    const element = viewport.current
    return () => {
      const id = brushPointer.current
      brushPointer.current = null
      keyboardStroke.current = false
      if (id !== null && element?.hasPointerCapture(id)) element.releasePointerCapture(id)
    }
  }, [masks?.active, masks?.resetKey])

  useEffect(() => {
    if (masks?.drawing) return
    const id = brushPointer.current
    brushPointer.current = null
    keyboardStroke.current = false
    if (id !== null && viewport.current?.hasPointerCapture(id))
      viewport.current.releasePointerCapture(id)
  }, [masks?.drawing])
  const framingView = useRef<{ image: Size; view: View } | null>(null)
  const [hdrAttempt, setHdrAttempt] = useState(0)
  const [presenterGeneration, setPresenterGeneration] = useState(0)
  const [hdrFailure, setHdrFailure] = useState<{
    owner: string
    capabilityGeneration: number
    reason: string
  } | null>(null)
  const [authoredHdrDemand, setAuthoredHdrDemand] = useState<{
    monitor: string
    headroomStops: number
  } | null>(null)
  const monitorIdentity = displayTarget.capabilities?.monitor
    ? JSON.stringify(displayTarget.capabilities.monitor)
    : null
  const headroomStops = displayTarget.capabilities?.headroomStops
  const gpuCapabilityFailure = [
    'device-lost',
    'adapter-unavailable',
    'canvas-unsupported',
  ].includes(displayTarget.capabilities?.failure ?? '')
  const holdAuthoredHdrSource = Boolean(
    hdrJpeg &&
    authoredHdrDemand &&
    authoredHdrDemand.monitor === monitorIdentity &&
    authoredHdrDemand.headroomStops > 0 &&
    typeof headroomStops === 'number' &&
    headroomStops > 0 &&
    displayTarget.requested !== 'sdr' &&
    gpuCapabilityFailure,
  )
  useEffect(() => {
    if (
      !authoredHdrDemand ||
      (hdrJpeg &&
        displayTarget.requested !== 'sdr' &&
        monitorIdentity === authoredHdrDemand.monitor &&
        !(
          displayTarget.capabilities?.hardware &&
          displayTarget.capabilities.extended &&
          !(typeof headroomStops === 'number' && headroomStops > 0)
        ))
    )
      return
    // A real display/source choice releases the interrupted HDR demand.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAuthoredHdrDemand(null)
  }, [authoredHdrDemand, hdrJpeg, displayTarget, monitorIdentity, headroomStops])
  const firstSurfaceRequest = useMemo<HdrFirstSurfaceRequest | undefined>(() => {
    if (
      !photo ||
      (hdrFailure && hdrFailure.capabilityGeneration === displayTarget.generation) ||
      suspended ||
      gesturing ||
      cropping ||
      (confirmedEdits && spatialControlsActive(confirmedEdits.settings))
    )
      return undefined
    // An optional display surface requires confirmed edits; original-source preparation does not.
    if (
      !confirmedEdits ||
      confirmedEdits.photoId !== photo.id ||
      confirmedEdits.settings.processing !== 'hdr-v1' ||
      model.viewport.width <= 0 ||
      model.viewport.height <= 0
    )
      return undefined
    if (!sameAdjustments(providedAdjustments, confirmedEdits.settings)) return undefined
    return {
      version: HDR_FIRST_SURFACE_VERSION,
      generation: editingEpoch + 1,
      settingsRevision: confirmedEdits.revision,
      parameters: snapshotAdjustments(confirmedEdits.settings),
      target: displayTarget,
      viewport: model.viewport,
      dpr: window.devicePixelRatio || 1,
      view: model.view,
      comparison: tools.mode,
      split: tools.split,
      hdrRanges: tools.hdrRanges,
      kernel: 'linear64',
      // The hook captures live existing owners after earlier presenters drain.
      rendererReservation: { ramBytes: 0, vramBytes: 0 },
    }
  }, [
    photo,
    hdrFailure,
    suspended,
    gesturing,
    confirmedEdits,
    providedAdjustments,
    editingEpoch,
    displayTarget,
    model.viewport,
    model.view,
    tools.mode,
    tools.split,
    tools.hdrRanges,
    cropping,
  ])
  const firstSurfaceKey = firstSurfaceRequest ? hdrFirstSurfaceRequestKey(firstSurfaceRequest) : ''
  const full = useFullPreview(
    photo?.id,
    !suspended,
    holdAuthoredHdrSource ? 'hdr' : displayTarget.mode,
    firstSurfaceRequest,
    !!photo &&
      confirmedEdits?.photoId === photo.id &&
      confirmedEdits.settings.processing === 'display-referred-v1',
    cropping ? crop?.context?.revision : undefined,
  )
  const adjustments = useMemo(
    () => ({
      ...providedAdjustments,
      maskGeometry: full.preview?.maskGeometry,
    }),
    [providedAdjustments, full.preview?.maskGeometry],
  )
  const confirmedParameters = useMemo(
    () => confirmedAdjustments(confirmedEdits, photo?.id, full.preview ?? undefined),
    [confirmedEdits, photo?.id, full.preview],
  )
  const gestureConfirmation = useMemo(
    () =>
      confirmedEdits && confirmedParameters
        ? { revision: confirmedEdits.revision, settings: confirmedParameters }
        : null,
    [confirmedEdits, confirmedParameters],
  )
  const presentationState = previewPolicy.presentationCache ? gestureConfirmation : null
  const gestureCommit = useMemo(
    () =>
      previewPolicy.interactivePrecision === 'f32'
        ? confirmedGestureCommit(localGestureCommit, photo?.id, full.preview ?? undefined)
        : null,
    [previewPolicy.interactivePrecision, localGestureCommit, photo?.id, full.preview],
  )
  const { isFirstSurfaceCurrent } = full
  const { begin: beginActivity, pulse: pulseActivity } = useForegroundActivity(
    photo?.id,
    undefined,
    !suspended,
  )
  const [displayedUrl, setDisplayedUrl] = useState('')
  const [rasterReady, setRasterReady] = useState(false)
  const [hdrReady, setHdrReady] = useState(false)
  const [analysisPresentationSerial, setAnalysisPresentationSerial] = useState(0)
  const [rasterHistogramError, setRasterHistogramError] = useState<string | undefined>()
  const [rasterClippingFailure, setRasterClippingFailure] = useState<{
    key: string
    message: string
  }>()
  const maskPublication = useRef<string | undefined>(undefined)
  const hdrLoaded = useCallback(() => {
    const presentedOwner = presenter.current
    if (presentedOwner) publishMaskPresentation(presentedOwner)
    setHdrReady(true)
    const target = currentTarget.current,
      caps = target.capabilities
    if (
      hdrJpeg &&
      target.mode === 'hdr' &&
      target.requested !== 'sdr' &&
      caps?.monitor &&
      typeof caps.headroomStops === 'number' &&
      caps.headroomStops > 0
    ) {
      const monitor = JSON.stringify(caps.monitor),
        headroomStops = caps.headroomStops
      setAuthoredHdrDemand((previous) =>
        previous?.monitor === monitor && previous.headroomStops === headroomStops
          ? previous
          : { monitor, headroomStops },
      )
    }
    const owner = presenter.current
    const key = owner instanceof HdrPresenter ? owner.maskPublicationKey : undefined
    // Overlay state also causes same-pixel redraws. Only a different actual
    // normal publication retries analysis after presentation preemption.
    if (key !== undefined && key !== maskPublication.current) {
      maskPublication.current = key
      setAnalysisPresentationSerial((value) => value + 1)
    }
  }, [hdrJpeg, publishMaskPresentation])
  const [cachedDisplayReady, setCachedDisplayReady] = useState(false)
  const [firstSurfaceReady, setFirstSurfaceReady] = useState(false)
  const [firstSurfacePainted, setFirstSurfacePainted] = useState(false)
  const firstSurfaceId = useRef('')
  useEffect(() => {
    if (!hdrReady) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRetained(null)
  }, [hdrReady])
  const selectedAt = useRef(0)
  const firstPresentedMs = useRef<number | undefined>(undefined)
  const firstUsefulMs = useRef<number | undefined>(undefined)
  const firstSurfacePresented = useCallback(
    (offer: HdrFirstSurfaceOffer, phase: 'fenced' | 'painted' | 'invalidated') => {
      if (phase === 'invalidated') {
        if (firstSurfaceId.current === offer.surfaceId) {
          firstSurfaceId.current = ''
          setFirstSurfaceReady(false)
          setFirstSurfacePainted(false)
        }
        return
      }
      if (!isFirstSurfaceCurrent(offer)) return
      if (phase === 'fenced') {
        const activePresenter = presenter.current,
          canvas = image.current,
          previous = current.current
        if (
          !(activePresenter instanceof HdrPresenter) ||
          !canvas ||
          canvas.dataset.firstSurfaceId !== offer.surfaceId
        )
          return
        if (
          canvas.dataset.previewRequestId !== offer.requestId ||
          previous.viewport.width !== offer.identity.viewport.width ||
          previous.viewport.height !== offer.identity.viewport.height ||
          (window.devicePixelRatio || 1) !== offer.identity.dpr
        ) {
          activePresenter.invalidateFirstSurface()
          return
        }
        // This callback runs after the real asynchronous GPU fence, outside React
        // lifecycle work. Commit authoritative geometry before any visible paint;
        // the presenter starts its two real paint observations only after return.
        canvas.style.visibility = 'hidden'
        canvas.dataset.frameSourceSpace = 'confirmed'
        canvas.dataset.frameGeometryRevision = String(offer.identity.settingsRevision)
        flushSync(() => {
          const next = {
            ...previous,
            image: { ...offer.identity.image },
            view: { ...offer.identity.view },
          }
          current.current = next
          setModel(next)
          firstSurfaceId.current = offer.surfaceId
          setFirstSurfaceReady(true)
        })
        // A synchronous commit may also flush a pending selection or target update.
        if (
          presenter.current === activePresenter &&
          image.current === canvas &&
          !isFirstSurfaceCurrent(offer)
        )
          activePresenter.invalidateFirstSurface()
      } else if (firstSurfaceId.current === offer.surfaceId) {
        firstUsefulMs.current ??= performance.now() - selectedAt.current
        setFirstSurfacePainted(true)
      }
    },
    [isFirstSurfaceCurrent],
  )
  useEffect(() => {
    selectedAt.current = performance.now()
    firstPresentedMs.current = undefined
    firstUsefulMs.current = undefined
  }, [photo?.id, suspended])
  const cachedPresented = useCallback(
    (presented: boolean) => {
      if (presented) {
        firstUsefulMs.current ??= performance.now() - selectedAt.current
        const owner = presenter.current
        if (owner) publishMaskPresentation(owner)
      }
      setCachedDisplayReady(presented)
    },
    [publishMaskPresentation],
  )
  const fullVisible = Boolean(full.preview && (displayedUrl || full.preview.linear?.hdr))
  const live = useWorkingPreview(full.preview, fullVisible && !suspended)
  const { generation } = live
  const working = live.working
  const { mode, split, hdrRanges, analyze, update } = tools
  const cancelRangeMask = masks?.cancel
  const rangeTransient = masks?.rangePicking || masks?.rangeCreating
  const rangeAfterSeen = useRef(false)
  useEffect(() => {
    if (!rangeTransient) rangeAfterSeen.current = false
    else if (mode === 'after') rangeAfterSeen.current = true
    else if (rangeAfterSeen.current) cancelRangeMask?.()
  }, [mode, rangeTransient, cancelRangeMask])
  const comparisonRequired =
    !!full.preview?.requiresUnfilteredComparison && mode !== 'after' && !cropping
  const comparison = useComparisonPreview(
    full.preview,
    comparisonRequired && !suspended && fullVisible,
  )
  const comparisonAlias =
    !!comparison.preview?.linear &&
    comparison.preview.linear.sha256 === full.preview?.workingSource?.workingSha256 &&
    JSON.stringify(comparison.preview.linear.transform) ===
      JSON.stringify(full.preview?.linear?.transform)
  const comparisonLive = useWorkingPreview(
    comparison.preview,
    comparisonRequired && !suspended && !comparisonAlias,
  )
  const verifiedBefore =
    comparison.preview?.linear &&
    comparisonLive.working?.identity ===
      `${comparison.preview.linear.url}:${comparison.preview.linear.sha256}`
      ? comparisonLive.working
      : null
  const beforeWorking = comparisonAlias ? working : verifiedBefore
  const comparisonReady = !comparisonRequired || (!!working && !!beforeWorking)
  const comparisonError = comparisonRequired
    ? comparison.error || (!comparisonAlias && comparisonLive.error) || ''
    : ''
  const comparisonBinding = comparisonRequired
    ? JSON.stringify([
        full.preview?.workingSource?.workingSha256,
        comparison.preview?.linear?.sha256 ?? 'pending',
      ])
    : 'single'
  const analysisWorking = mode === 'before' && comparisonRequired ? beforeWorking : working
  const editingSurface = !!working
  const firstSurface =
    full.firstSurface && full.isFirstSurfaceCurrent(full.firstSurface) ? full.firstSurface : null
  const hdrSurface = !!(firstSurface || full.preview?.linear?.hdr || working?.hdr)
  // Rendered raster revisions do not replace the already uploaded working source.
  const hdrOwnerKey = !(hdrSurface || working?.hdr)
    ? 'raster'
    : full.preview?.requiresUnfilteredComparison
      ? JSON.stringify([full.preview.workingSource, full.preview.linear?.sha256])
      : (firstSurface?.identity.parentWorkingKey ??
        (full.preview?.format === 'hdr-working'
          ? full.preview.firstSurfaceLineage?.parentWorkingKey
          : undefined) ??
        full.preview?.linear?.sha256 ??
        working?.hdr?.sha256 ??
        'pending')
  const presenterRoute = hdrSurface ? 'hdr' : editingSurface ? 'raster-edit' : 'raster-preview'
  const hdrPresentationOwner = JSON.stringify([hdrOwnerKey, generation, hdrAttempt])
  const retryOwner = useRef(hdrPresentationOwner)
  useLayoutEffect(() => {
    retryOwner.current = hdrPresentationOwner
  }, [hdrPresentationOwner])
  const gpuError = hdrFailure?.owner === hdrPresentationOwner ? hdrFailure.reason : ''
  const retained =
    !!retainedFrame &&
    retainedFrame.hdrOwner === (hdrSurface ? hdrPresentationOwner : undefined) &&
    (!hdrSurface || retainedFrame.targetGeneration === String(displayTarget.generation)) &&
    retainedFrame.sourceSpace === (cropping ? 'framing' : 'confirmed') &&
    retainedFrame.revision >= geometryRevision &&
    retainedFrame.comparison === mode &&
    retainedFrame.binding === comparisonBinding
  const retryGpu = useCallback(() => {
    restoreCanvasFocus.current = true
    onEditingReady(null)
    // Reuse the existing display probe; keep the user's current preference and actual target.
    void window.irodori.setPreviewPreference(currentTarget.current.requested).then(
      () => {
        if (!mounted.current || retryOwner.current !== hdrPresentationOwner) return
        setHdrFailure(null)
        setHdrAttempt((value) => value + 1)
      },
      (error) => {
        if (!mounted.current || retryOwner.current !== hdrPresentationOwner) return
        setHdrFailure((previous) =>
          previous?.owner === hdrPresentationOwner
            ? {
                ...previous,
                reason: `GPU capability refresh failed: ${String(error)}`.slice(0, 512),
              }
            : previous,
        )
      },
    )
  }, [onEditingReady, hdrPresentationOwner])
  useEffect(() => {
    if (
      hdrFailure?.owner !== hdrPresentationOwner ||
      hdrFailure.capabilityGeneration === displayTarget.generation ||
      !displayTarget.capabilities?.hardware ||
      !displayTarget.capabilities.extended
    )
      return
    // Only a failed owner restarts after a fresh capability probe; healthy owners use setTarget.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHdrFailure(null)
    setHdrAttempt((value) => value + 1)
  }, [
    hdrFailure,
    hdrPresentationOwner,
    displayTarget.generation,
    displayTarget.capabilities?.hardware,
    displayTarget.capabilities?.extended,
  ])
  const analysisPending = useCallback(
    (pending: boolean) => update({ analysisPending: pending }),
    [update],
  )
  const actualTarget = displayTarget
  const hdrOverlay = hdrRanges
    ? 0
    : tools.domain === 'working-hdr'
      ? tools.hdrOverlay & 4
      : tools.hdrOverlay
  const shadows = tools.shadows || tools.hover === 'shadows'
  const maskSourceKey = JSON.stringify([
    analysisWorking?.identity,
    mode === 'before',
    mode === 'before' ? neutralAdjustments : adjustments,
    maskPixelTarget(actualTarget),
    tools.domain,
  ])
  const setMask = useCallback(
    (value?: ClippingMask) => {
      setMaskState(value ? { key: maskSourceKey, value } : undefined)
    },
    [maskSourceKey],
  )
  const rasterMaskKey = useRef(maskSourceKey)
  useEffect(() => {
    rasterMaskKey.current = maskSourceKey
  }, [maskSourceKey])
  const rasterClippingError =
    rasterClippingFailure?.key === maskSourceKey ? rasterClippingFailure.message : undefined
  const mask = maskState?.key === maskSourceKey ? maskState.value : undefined
  const highlights = tools.highlights || tools.hover === 'highlights'
  const sdrAnalysisError = usePreviewAnalysis(
    analysisWorking?.hdr ||
      suspended ||
      cropping ||
      (mode !== 'before' && maskEdgeCoverage?.ready === false)
      ? null
      : analysisWorking,
    `${photo?.id}-${analysisWorking?.identity ?? 'pending'}-${generation}`,
    mode === 'before' ? neutralAdjustments : adjustments,
    shadows || highlights,
    gesturing,
    analyze,
    setMask,
    beginActivity,
  )
  const reserveNativeMask = useCallback<ReserveNativeMask>((frame, cancel, drained, parameters) => {
    const owner = presenter.current
    return owner instanceof HdrPresenter
      ? owner.reserveMask(frame, cancel, drained, parameters)
      : undefined
  }, [])
  const nativeMaskContext = useMemo(
    () => ({
      confirmed: confirmedEdits,
      comparison: mode === 'before' ? ('before' as const) : ('after' as const),
      comparisonOf:
        mode === 'before' && comparisonRequired && !comparisonAlias
          ? working?.sourceRef
          : undefined,
      reserve: reserveNativeMask,
      presentationSerial: analysisPresentationSerial,
    }),
    [
      confirmedEdits,
      mode,
      reserveNativeMask,
      analysisPresentationSerial,
      comparisonRequired,
      comparisonAlias,
      working?.sourceRef,
    ],
  )
  const { statisticsError: analysisError, maskError } = useHdrAnalysis(
    hdrReady && !suspended && !cropping && (mode === 'before' || maskEdgeCoverage?.ready !== false)
      ? analysisWorking
      : null,
    mode === 'before' ? neutralAdjustments : adjustments,
    actualTarget,
    'content-hdr',
    !!hdrOverlay,
    analyze,
    setMask,
    gesturing,
    false,
    beginActivity,
    nativeMaskContext,
  )
  useEffect(() => {
    if (gesturing && mode === 'before') update({ mode: 'after' })
  }, [gesturing, mode, update])
  const histogramError =
    gpuError ||
    full.error ||
    live.error ||
    comparisonError ||
    (working?.hdr ? analysisError : rasterHistogramError || sdrAnalysisError)
  useEffect(
    () =>
      update({
        analysisError: histogramError,
        clippingError: working?.hdr ? maskError : rasterClippingError,
      }),
    [histogramError, maskError, rasterClippingError, working?.hdr, update],
  )
  useEffect(() => update({ hdr: !!working?.hdr }), [working?.hdr, update])
  useEffect(() => {
    const preview = full.preview
    if ((!preview && !firstSurface) || suspended) return
    const ready = !gpuError && (working?.hdr ? hdrReady : rasterReady && !!displayedUrl)
    let cancelled = false
    const report = () => {
      if (cancelled) return
      if (ready) firstPresentedMs.current ??= performance.now() - selectedAt.current
      if (ready) firstUsefulMs.current ??= firstPresentedMs.current
      void window.irodori.reportPreviewPresentation({
        photoId: preview?.photoId ?? firstSurface!.photoId,
        revision: preview
          ? (preview.settingsRevision ?? 0)
          : firstSurface!.identity.settingsRevision,
        targetGeneration: displayTarget.generation,
        backend: hdrSurface ? 'webgpu-hdr' : 'legacy',
        mode: hdrSurface ? displayTarget.mode : 'sdr',
        stage: gpuError ? 'failed' : ready ? 'presented' : 'loading',
        reason: gpuError || (hdrSurface ? displayTarget.reason : 'Legacy SDR processing.'),
        timings:
          ready || cachedDisplayReady || firstSurfacePainted
            ? {
                ...JSON.parse(image.current?.dataset.loadTimings ?? '{}'),
                firstUsefulMs: firstUsefulMs.current!,
                ...(ready
                  ? {
                      selectionToPresentedMs: firstPresentedMs.current!,
                      nativeEditingReadyMs: firstPresentedMs.current!,
                    }
                  : {}),
                cachedPresentation: Number(cachedDisplayReady),
                firstSurfacePresentation: Number(firstSurfacePainted),
                uploadMs: Number(image.current?.dataset.uploadMs ?? 0),
              }
            : {},
      })
    }
    if (ready) requestAnimationFrame(() => requestAnimationFrame(report))
    else report()
    return () => {
      cancelled = true
    }
  }, [
    suspended,
    full.preview,
    firstSurface,
    firstSurfacePainted,
    hdrSurface,
    working?.hdr,
    rasterReady,
    hdrReady,
    cachedDisplayReady,
    displayedUrl,
    gpuError,
    displayTarget.generation,
    displayTarget.mode,
    displayTarget.reason,
  ])
  const placeholderView = constrain(model.view, full.placeholder ?? model.image, model.viewport)
  const bindWorkingSource = useCallback(
    (owner: PreviewPresenter | HdrPresenter) => {
      if (working) {
        if (owner instanceof HdrPresenter) {
          if (
            full.preview?.format === 'hdr-working' &&
            full.preview.firstSurfacePolicy &&
            firstSurfacePolicyOwner.current !== owner
          ) {
            owner.setFirstSurfacePolicy(full.preview.firstSurfacePolicy)
            firstSurfacePolicyOwner.current = owner
          }
          owner.setWorking(
            working,
            full.preview?.format === 'hdr-working' ? full.preview.firstSurfaceLineage : undefined,
          )
        } else owner.setWorking(working)
      }
      owner.setComparisonSource(
        comparisonRequired && !comparisonAlias && working ? beforeWorking : null,
        comparisonRequired && !comparisonAlias,
      )
    },
    [working, full.preview, beforeWorking, comparisonRequired, comparisonAlias],
  )
  function draw(model: Model) {
    if (mode !== 'before' && maskEdgeCoverage?.ready === false) return
    pulseActivity()
    const started = performance.now()
    presenter.current?.setComparison(mode, split)
    if (presenter.current) {
      try {
        bindWorkingSource(presenter.current)
        if (!presenter.current.presentedGeometry && maskPresentationRef.current) {
          maskPresentationRef.current = undefined
          maskOverlayOwner.current?.clear()
          setMaskPresentation(undefined)
          setBrushCursor(null)
          if (brushPointer.current !== null || keyboardStroke.current) {
            const pointer = brushPointer.current
            brushPointer.current = null
            keyboardStroke.current = false
            masks?.cancel()
            if (pointer !== null && viewport.current?.hasPointerCapture(pointer))
              viewport.current.releasePointerCapture(pointer)
          }
        }
      } catch (error) {
        failPresentation.current?.(String(error))
        return
      }
    }
    if (image.current) image.current.dataset.spatialComparisonBinding = comparisonBinding
    if (presenter.current instanceof HdrPresenter) {
      presenter.current.setHdrRanges(hdrRanges)
      if (previewPolicy.presentationCache) presenter.current.setPresentationState(presentationState)
      presenter.current.setEditing(gesturing, editingEpoch, gestureCommit, gestureConfirmation)
    }
    if (previewPolicy.presentationCache && working?.hdr && !presentationState) return
    if (presenter.current instanceof PreviewPresenter)
      presenter.current.setClippingEnabled(shadows || highlights, maskSourceKey)
    presenter.current?.draw(
      model.image,
      model.viewport,
      model.view,
      snapshotAdjustments(adjustments),
    )
    performance.measure('irodori.preview.presentation', {
      start: started,
      detail: {
        ...snapshotAdjustments(adjustments),
        scale: model.view.scale,
      },
    })
  }

  function drawOverlay(model: Model) {
    const canvas = overlay.current,
      context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const canvasWidth = Math.max(1, Math.round(model.viewport.width)),
      canvasHeight = Math.max(1, Math.round(model.viewport.height))
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (gpuError) return
    if (!comparisonReady || !analysisWorking || !mask || !working) return
    const pixels = clippingOverlayPixels({
      levels: mask.levels,
      image: model.image,
      viewport: model.viewport,
      view: model.view,
      hdr: !!working.hdr,
      hdrOverlay,
      highlights,
      shadows,
      split: mode === 'split' ? split : undefined,
    })
    if (pixels)
      context.putImageData(
        new ImageData(pixels.data, pixels.width, pixels.height),
        pixels.left,
        pixels.top,
      )
  }

  const { schedule, cancel, flush } = usePreviewFrame(() => {
    if (suspended) return
    const model = current.current
    setModel(model)
    draw(model)
    drawOverlay(model)
  })
  const change = useCallback(
    (action: (model: Model) => Model, immediate = true) => {
      const next = action(current.current)
      if (next === current.current) return
      next.view = constrain(next.view, next.image, next.viewport)
      current.current = next
      if (!cropping && next.loaded && next.viewport.width > 0 && !recoveryView.current && photo?.id)
        onViewChange?.(savedView(photo.id, next.view, next.image))
      if (immediate) setModel(next)
      schedule()
    },
    [schedule, photo, onViewChange, cropping],
  )
  const ready = Boolean(
    !suspended &&
    photo &&
    model.loaded &&
    model.image.width &&
    model.viewport.width &&
    model.viewport.height &&
    (full.preview?.linear?.hdr ? hdrReady : rasterReady) &&
    comparisonReady &&
    !gpuError &&
    !full.error,
  )
  useLayoutEffect(() => {
    // A replacement canvas can still be hidden when its ref attaches.
    const canvas = image.current
    if (ready && canvas && restoreCanvasFocus.current) {
      canvas.focus({ preventScroll: true })
      restoreCanvasFocus.current = document.activeElement !== canvas
    }
  }, [ready])
  const { view } = model
  const panX = model.image.width * view.scale > model.viewport.width + 0.5
  const panY = model.image.height * view.scale > model.viewport.height + 0.5

  const panBy = useCallback(
    (x: number, y: number) => {
      const before = current.current.view
      change(
        (model) => ({
          ...model,
          view: { ...model.view, x: model.view.x + x, y: model.view.y + y },
        }),
        false,
      )
      return { x: current.current.view.x - before.x, y: current.current.view.y - before.y }
    },
    [change],
  )
  const pan = usePanDrag(viewport, panBy)
  const { dragging, dragged, stop: stopPan } = pan
  const activityPhotoId = photo?.id
  useEffect(() => {
    if (!suspended && activityPhotoId && !histogramError && (!ready || dragging || gesturing))
      return beginActivity()
  }, [activityPhotoId, suspended, histogramError, ready, dragging, gesturing, beginActivity])
  const stopDrag = useCallback(() => {
    if (
      dividerPointer.current !== null &&
      divider.current?.hasPointerCapture(dividerPointer.current)
    )
      divider.current.releasePointerCapture(dividerPointer.current)
    dividerPointer.current = null
    stopPan()
  }, [stopPan])
  useLayoutEffect(() => {
    stopDrag()
    if (cropping && !framingView.current) {
      framingView.current = {
        image: { ...current.current.image },
        view: { ...current.current.view },
      }
      change((value) => ({ ...value, view: INITIAL_VIEW }))
    } else if (!cropping && framingView.current) {
      const saved = framingView.current
      framingView.current = null
      change((value) => ({
        ...value,
        view: replaceDimensions(saved.view, saved.image, value.image, value.viewport),
      }))
    }
  }, [cropping, change, stopDrag])
  usePreviewWheel(viewport, ready, change, stopDrag)
  const adjustmentKey = JSON.stringify(adjustments)
  useEffect(() => {
    stopDrag()
  }, [
    stopDrag,
    adjustmentKey,
    whiteBalancePicker?.active,
    toneCurves?.active,
    cropping,
    editingEpoch,
    generation,
    displayTarget.generation,
    suspended,
    mode,
    split,
    hdrRanges,
  ])
  useEffect(() => {
    if (!ready) stopDrag()
  }, [ready, stopDrag])
  useEffect(
    () =>
      window.irodori.onLibraryEvent((event) => {
        const changed = event.lensChanged ?? event.geometryChanged ?? event.sourceChanged
        if (changed && changed.photoId === photo?.id) {
          stopDrag()
          setGeometryRevision(changed.revision)
        }
      }),
    [photo?.id, stopDrag],
  )

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = (width: number, height: number) => {
      if (suspended || width <= 0 || height <= 0) return
      if (
        current.current.viewport.width === width &&
        current.current.viewport.height === height &&
        !recoveryView.current
      )
        return
      stopDrag()
      change((model) => ({
        ...model,
        viewport: { width, height },
        ...(model.loaded && recoveryView.current
          ? {
              view: restoreView(recoveryView.current, model.image, {
                width,
                height,
              }),
            }
          : {}),
      }))
      if (current.current.loaded && recoveryView.current) {
        recoveryView.current = null
        if (!cropping && photo?.id)
          onViewChange?.(savedView(photo.id, current.current.view, current.current.image))
      }
    }
    // Establish actual layout before waiting for the observer's first rendering opportunity.
    const initial = element.getBoundingClientRect()
    resize(initial.width, initial.height)
    const observer = new ResizeObserver(([entry]) =>
      resize(entry.contentRect.width, entry.contentRect.height),
    )
    observer.observe(element)
    window.addEventListener('blur', stopDrag)
    return () => {
      observer.disconnect()
      window.removeEventListener('blur', stopDrag)
    }
  }, [change, stopDrag, suspended, photo, onViewChange, cropping])

  const { preview: renderedFrame, pixels, displayFailed } = full
  useEffect(() => {
    const canvas = image.current
    if (!canvas || suspended) {
      if (previewPolicy.presentationCache && suspended) {
        // Suspension ends this presentation cycle before a later fresh edit confirmation.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setHdrReady(false)
        setCachedDisplayReady(false)
        setRetained(null)
      }
      return
    }
    const recoverySurface = retainedSurface.current ?? undefined
    let active = true,
      failed = false,
      activePresenter: PreviewPresenter | HdrPresenter | null = null
    const fail = (reason: string) => {
      if (
        !active ||
        failed ||
        image.current !== canvas ||
        (activePresenter && presenter.current !== activePresenter)
      )
        return
      failed = true
      // Finalize the owner's pending gesture before disabling controls suppresses pointer release.
      onPresentationFailure()
      canvas.style.visibility = 'hidden'
      canvas.dataset.editing = 'unavailable'
      canvas.dataset.presentationError = reason.slice(0, 512)
      setRasterReady(false)
      setHdrFailure({
        owner: hdrPresentationOwner,
        capabilityGeneration: currentTarget.current.generation,
        reason: reason.slice(0, 512) || 'The GPU preview is unavailable.',
      })
      setHdrReady(false)
      setCachedDisplayReady(false)
      setFirstSurfaceReady(false)
      setFirstSurfacePainted(false)
      firstSurfaceId.current = ''
      setRetained(null)
      onEditingReady(null)
      if (activePresenter) {
        activePresenter.dispose()
        hdrRetirement.current = activePresenter.whenDisposed
        void hdrRetirement.current.catch(() => undefined)
      }
      if (presenter.current === activePresenter) presenter.current = null
    }
    failPresentation.current = fail
    if (presenterRoute === 'hdr') {
      // A failed owner waits for an explicit retry, a new source or a fresh capability generation.
      if (!gpuError) {
        setHdrReady(false)
        setCachedDisplayReady(false)
        setFirstSurfaceReady(false)
        setFirstSurfacePainted(false)
        void hdrRetirement.current
          .then(() => {
            if (!active || image.current !== canvas) return
            activePresenter = new HdrPresenter(
              canvas,
              currentTarget.current,
              previewPolicy,
              fail,
              () => {
                if (active && !failed && presenter.current === activePresenter) hdrLoaded()
              },
              analyze,
              recoverySurface,
              beginActivity,
              analysisPending,
              (presented) => {
                if (active && !failed) cachedPresented(presented)
              },
              (offer, phase) => {
                if (active && !failed) firstSurfacePresented(offer, phase)
              },
            )
            presenter.current = activePresenter
            setPresenterGeneration((value) => value + 1)
          })
          .catch((error) => fail(String(error)))
      }
    } else if (!gpuError) {
      setRasterReady(false)
      void hdrRetirement.current
        .then(() => {
          if (!active || image.current !== canvas) return
          activePresenter = new PreviewPresenter(
            canvas,
            presenterRoute === 'raster-preview',
            fail,
            () => {
              if (active && !failed && presenter.current === activePresenter) {
                publishMaskPresentation(activePresenter!)
                setRasterReady(true)
              }
            },
            analyze,
            analysisPending,
            setRasterHistogramError,
            beginActivity,
            (value, key) => {
              if (!active || failed || !key || (value && key !== rasterMaskKey.current)) return
              setMaskState((previous) =>
                value ? { key, value } : previous?.key === key ? undefined : previous,
              )
            },
            (message, key) => {
              if (!active || failed || !key || (message && key !== rasterMaskKey.current)) return
              setRasterClippingFailure((previous) =>
                message ? { key, message } : previous?.key === key ? undefined : previous,
              )
            },
          )
          presenter.current = activePresenter
          setPresenterGeneration((value) => value + 1)
        })
        .catch((error) => fail(String(error)))
    }
    return () => {
      active = false
      if (failPresentation.current === fail) failPresentation.current = undefined
      // Effect cleanup can precede ref detachment during a canvas replacement.
      // Keep the completed snapshot accessible to attachCanvas in either order.
      if (!failed && mounted.current && activePresenter instanceof HdrPresenter)
        activePresenter.recoverCompletedFrame(recoverySurface)
      activePresenter?.dispose()
      if (activePresenter) {
        hdrRetirement.current = activePresenter.whenDisposed
        void hdrRetirement.current.catch(() => undefined)
      }
      if (presenter.current === activePresenter) presenter.current = null
    }
  }, [
    generation,
    presenterRoute,
    hdrOwnerKey,
    hdrPresentationOwner,
    gpuError,
    displayFailed,
    suspended,
    analyze,
    beginActivity,
    analysisPending,
    cachedPresented,
    firstSurfacePresented,
    previewPolicy,
    hdrLoaded,
    publishMaskPresentation,
    onEditingReady,
    onPresentationFailure,
  ])

  useEffect(() => {
    const activePresenter = presenter.current
    if (!(activePresenter instanceof HdrPresenter)) return
    // Establish the current view before either an early surface or the full source arrives.
    draw(current.current)
    if (suspended || !firstSurface || !full.isFirstSurfaceCurrent(firstSurface)) {
      activePresenter.invalidateFirstSurface()
      return
    }
    if (firstSurfacePolicyOwner.current !== activePresenter) {
      activePresenter.setFirstSurfacePolicy(firstSurface.policy)
      firstSurfacePolicyOwner.current = activePresenter
    }
    const currentOffer = () =>
      presenter.current === activePresenter &&
      full.isFirstSurfaceCurrent(firstSurface) &&
      !suspended
    void activePresenter.setFirstSurface(firstSurface, currentOffer).catch(() => {
      // An optional first surface never replaces a valid full-source result or retry.
      if (currentOffer()) activePresenter.invalidateFirstSurface()
    })
    // The current request key invalidates a received surface on every display change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    firstSurface,
    firstSurfaceKey,
    hdrOwnerKey,
    presenterRoute,
    generation,
    presenterGeneration,
    gpuError,
    suspended,
    full.isFirstSurfaceCurrent,
    change,
  ])

  useEffect(() => {
    if (
      suspended ||
      !renderedFrame ||
      (!pixels && !renderedFrame.linear?.hdr) ||
      !presenter.current
    )
      return
    try {
      if (pixels && !editingSurface) presenter.current.setBitmap(pixels)
      if (image.current) {
        image.current.dataset.frameSourceSpace =
          renderedFrame.sourceSpace === 'uncropped' ? 'framing' : 'confirmed'
        image.current.dataset.frameGeometryRevision = String(renderedFrame.settingsRevision ?? 0)
      }
      const dimensions = { width: renderedFrame.width, height: renderedFrame.height }
      // The decoded frame establishes authoritative dimensions after presentation upload.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayedUrl(renderedFrame.url)
      change((model) => ({
        ...model,
        loaded: true,
        image: dimensions,
        view: recoveryView.current
          ? restoreView(recoveryView.current, dimensions, model.viewport)
          : replaceDimensions(model.view, model.image, dimensions, model.viewport),
      }))
      if (current.current.viewport.width > 0) {
        recoveryView.current = null
        if (!cropping && photo?.id)
          onViewChange?.(savedView(photo.id, current.current.view, dimensions))
      }
    } catch (error) {
      failPresentation.current?.(String(error))
    }
  }, [
    renderedFrame,
    pixels,
    change,
    displayFailed,
    generation,
    presenterGeneration,
    editingSurface,
    suspended,
    photo,
    onViewChange,
    cropping,
  ])

  useEffect(() => {
    if (suspended || gpuError) {
      onEditingReady(null)
      return
    }
    try {
      if (previewPolicy.presentationCache && presenter.current instanceof HdrPresenter)
        presenter.current.setPresentationState(presentationState)
      if (presenter.current) bindWorkingSource(presenter.current)
      onEditingReady(
        presenter.current &&
          working &&
          (working.hdr ? !previewPolicy.presentationCache || hdrReady : rasterReady)
          ? (photo?.id ?? null)
          : null,
      )
    } catch (error) {
      failPresentation.current?.(String(error))
    }
    return () => onEditingReady(null)
  }, [
    working,
    beforeWorking,
    comparisonRequired,
    comparisonAlias,
    comparisonReady,
    generation,
    presenterGeneration,
    gpuError,
    photo?.id,
    onEditingReady,
    suspended,
    presentationState,
    confirmedEdits,
    hdrReady,
    rasterReady,
    full.preview,
    hdrOwnerKey,
    previewPolicy,
    hdrLoaded,
    bindWorkingSource,
  ])

  useEffect(() => {
    // Publish newly uploaded raster pixels when their layout and working source are ready.
    // Owner creation resumes after the previous GPU owner drains.
    // Gesture views remain coalesced through the shared animation-frame callback.
    if (
      !suspended &&
      renderedFrame &&
      pixels &&
      model.loaded &&
      model.viewport.width > 0 &&
      model.viewport.height > 0 &&
      presenter.current instanceof PreviewPresenter
    )
      flush()
  }, [
    suspended,
    renderedFrame,
    pixels,
    working,
    beforeWorking,
    comparisonReady,
    generation,
    presenterGeneration,
    model.loaded,
    model.viewport.width,
    model.viewport.height,
    flush,
  ])

  useEffect(() => {
    if (presenter.current instanceof HdrPresenter) presenter.current.setTarget(displayTarget)
  }, [displayTarget, working, presenterRoute, hdrOwnerKey, generation, presenterGeneration])

  useEffect(() => {
    if (suspended) cancel()
    // Submit HDR edits without waiting for a paint callback; viewport motion uses the shared frame callback.
    else if (presenter.current instanceof HdrPresenter) flush()
    else schedule()
  }, [
    suspended,
    cancel,
    flush,
    schedule,
    adjustments.exposureEv,
    adjustments.contrast,
    adjustments.highlights,
    adjustments.shadows,
    adjustments.whites,
    adjustments.blacks,
    adjustments.saturation,
    adjustments.vibrance,
    adjustments.colorMixer,
    adjustments.colorGrading,
    adjustments.whiteBalance,
    adjustments.localMasks,
    adjustments.maskGeometry,
    mode,
    split,
    hdrRanges,
    working,
    generation,
    presenterGeneration,
    gesturing,
    gpuError,
    editingEpoch,
    presentationState,
    gestureCommit,
    gestureConfirmation,
    mask,
    shadows,
    highlights,
    hdrOverlay,
  ])

  function fit() {
    stopDrag()
    change((model) => ({ ...model, view: INITIAL_VIEW }))
  }
  function zoom(scale: number, point = { x: 0, y: 0 }) {
    stopDrag()
    change((model) => ({
      ...model,
      view: zoomAt(model.view, scale, point, model.image, model.viewport),
    }))
  }
  function step(direction: -1 | 1) {
    zoom(
      stepScale(
        current.current.view.scale,
        direction,
        minimumScale(current.current.image, current.current.viewport),
      ),
    )
  }
  useLayoutEffect(() => {
    const render = () => {
      if (
        maskEdgeCoverage?.ready === false &&
        maskPresentationRef.current === presenter.current?.presentedGeometry
      )
        return
      const canvas = maskOverlay.current,
        geometry = readMaskPresentation(),
        context = objectSelection?.context,
        proposal =
          objectSelection?.active &&
          context &&
          geometry &&
          context.width === geometry.image.width &&
          context.height === geometry.image.height &&
          inspectionGeometryMatches(context.geometry, geometry.maskGeometry)
            ? objectSelection.proposal
            : undefined
      if (!canvas) return
      maskOverlayFailure.current = (message) =>
        objectSelection?.active
          ? objectSelection.setError(message)
          : (() => {
              masks?.setRangePreviewReady(null)
              masks?.setError(message)
            })()
      maskOverlayReady.current = () => {
        if (proposal) objectSelection?.setProposalReady(proposal.id)
        if (masks?.rangePreviewKey) masks.setRangePreviewReady(masks.rangePreviewKey)
      }
      const cursor = brushCursorElement.current
      if (cursor && geometry && brushCursor && masks) {
        const style = maskCursorStyle(
          geometry,
          current.current.viewport,
          brushCursor,
          masks.workspace.size,
        )
        cursor.style.left = `${style.left}px`
        cursor.style.top = `${style.top}px`
        cursor.style.width = `${style.width}px`
        cursor.style.height = `${style.height}px`
      }
      if (
        (!proposal && (!masks?.overlayVisible || !masks.selectedId || objectSelection?.active)) ||
        !ready ||
        maskEdgeCoverage?.ready === false ||
        suspended ||
        !geometry?.maskGeometry
      ) {
        maskOverlayOwner.current?.clear()
        return
      }
      try {
        maskOverlayOwner.current ??= new MaskOverlayPresenter(
          canvas,
          (message) => maskOverlayFailure.current(message),
          () => maskOverlayReady.current(),
        )
        maskOverlayOwner.current.draw(
          geometry.image,
          geometry.viewport,
          geometry.view,
          {
            ...adjustments,
            ...(proposal
              ? { localMasks: [{ ...proposal.mask, enabled: true }] }
              : masks?.overlayMask
                ? {
                    localMasks: [
                      (() => {
                        const root = adjustments.localMasks?.find(
                          (mask) => mask.id === masks.selectedId,
                        )
                        if (!root) return masks.overlayMask!
                        if (
                          masks.workspace.overlayScope !== 'selected-part' ||
                          masks.selectedComponentId === null
                        )
                          return root
                        if (masks.selectedComponentId === root.id)
                          return {
                            ...root,
                            operands: [],
                            resultStrokes: [],
                            inverted: false,
                            edge: { featherPx: 0, shiftPx: 0 },
                            preparedCoverage: undefined,
                          }
                        const node = maskCoverageNodes(root, true).find(
                          (node) => node.id === masks.selectedComponentId,
                        )
                        return node
                          ? {
                              ...node,
                              enabled: true,
                              light: { ...neutralMaskLight },
                              color: { ...neutralMaskColor },
                            }
                          : root
                      })(),
                    ],
                  }
                : {}),
            maskGeometry: geometry.maskGeometry,
          },
          proposal?.mask.id ?? masks!.overlayMask?.id ?? masks!.selectedId!,
          proposal?.id,
        )
      } catch (error) {
        maskOverlayFailure.current(String(error))
      }
    }
    // Presentation callbacks redraw before the browser can paint the newly
    // completed photograph; mask drafts reuse that same committed geometry.
    redrawMaskCoverage.current = render
    render()
  }, [
    masks,
    objectSelection,
    ready,
    suspended,
    adjustments,
    readMaskPresentation,
    brushCursor,
    maskEdgeCoverage?.ready,
  ])
  useEffect(
    () => () => {
      maskOverlayOwner.current?.dispose()
      maskOverlayOwner.current = null
    },
    [],
  )
  function brushPoint(output: { x: number; y: number }) {
    brushOutput.current = output
    if (brushPointer.current !== null || keyboardStroke.current)
      setBrushPath((points) => (points.length < 4096 ? [...points, output] : points))
    const geometry = readMaskPresentation()?.maskGeometry
    if (!geometry) {
      masks?.setError(
        'Mask geometry is unavailable. Wait for the full photograph to finish preparing.',
      )
      return null
    }
    return maskCanonicalPoint(output, geometry)
  }
  function pointerBrushPoint(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect(),
      geometry = readMaskPresentation()
    if (!geometry || !box.width || !box.height) return null
    const point = normalizedSourcePoint(
      {
        x: ((event.clientX - box.left) * geometry.viewport.width) / box.width,
        y: ((event.clientY - box.top) * geometry.viewport.height) / box.height,
      },
      geometry.image,
      geometry.viewport,
      geometry.view,
    )
    if (!point) return null
    const output = {
      x: point.x * geometry.image.width,
      y: point.y * geometry.image.height,
    }
    setBrushCursor(output)
    return brushPoint(output)
  }
  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return
    if (
      (event.target as HTMLElement).closest(
        'select, input, textarea, [contenteditable], [role="menu"]',
      )
    )
      return
    if (photo && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault()
      stopDrag()
      const box = viewport.current!.getBoundingClientRect()
      onContextMenu(
        photo,
        image.current ?? (event.currentTarget as HTMLElement),
        box.left + 20,
        box.top + 20,
      )
      return
    }
    if (!ready || event.ctrlKey || event.metaKey || event.altKey) return
    if (
      masks?.active &&
      [' ', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        masks.cancel()
        keyboardStroke.current = false
        return
      }
      const geometry = readMaskPresentation()
      if (!geometry) return
      const position = brushCursor ?? {
        x: geometry.image.width / 2,
        y: geometry.image.height / 2,
      }
      if (event.key === ' ') {
        if (event.repeat) return
        if (keyboardStroke.current) {
          keyboardStroke.current = false
          masks.endStroke()
        } else {
          const point = brushPoint(position)
          if (point) {
            keyboardStroke.current = masks.beginStroke(point)
            setBrushPath([position])
          }
          setBrushCursor(position)
        }
      } else {
        const amount = event.shiftKey ? 10 : 1
        const next = {
          x: Math.max(
            0.5,
            Math.min(
              geometry.image.width - 0.5,
              position.x +
                (event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0),
            ),
          ),
          y: Math.max(
            0.5,
            Math.min(
              geometry.image.height - 0.5,
              position.y +
                (event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0),
            ),
          ),
        }
        setBrushCursor(next)
        const point = brushPoint(next)
        if (point && keyboardStroke.current) masks.appendStroke(point)
      }
      return
    }

    if (cropping && ['\\', 'y', 'j'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      return
    }
    if (working && event.key === '\\') update({ mode: mode === 'before' ? 'after' : 'before' })
    else if (working && event.key.toLowerCase() === 'y')
      update({ mode: mode === 'split' ? 'after' : 'split' })
    else if (working && event.key.toLowerCase() === 'j')
      update(
        working.hdr
          ? { hdrOverlay: tools.hdrOverlay & 1 ? tools.hdrOverlay & ~1 : tools.hdrOverlay | 1 }
          : {
              shadows: !(tools.shadows && tools.highlights),
              highlights: !(tools.shadows && tools.highlights),
            },
      )
    else if (event.key === '+' || event.key === '=') step(1)
    else if (event.key === '-') step(-1)
    else if (event.key === '0') fit()
    else if (event.key === '1') zoom(1)
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      stopDrag()
      const amount = event.shiftKey ? 120 : 40
      change((model) => ({
        ...model,
        view: {
          ...model.view,
          x:
            model.view.x +
            (event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0),
          y:
            model.view.y +
            (event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0),
        },
      }))
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    const middle = event.button === 1 && event.pointerType === 'mouse'
    if ((!middle && (cropping || event.button !== 0)) || !event.isPrimary || !ready) return
    event.preventDefault()
    image.current?.focus({ preventScroll: true })
    if (middle) {
      pan.reset()
      if (panX || panY) pan.start(event.nativeEvent)
      return
    }
    if (masks?.rangePicking) {
      stopDrag()
      const box = event.currentTarget.getBoundingClientRect()
      const geometry = readMaskPresentation()
      const point =
        geometry &&
        normalizedSourcePoint(
          {
            x: ((event.clientX - box.left) * geometry.viewport.width) / box.width,
            y: ((event.clientY - box.top) * geometry.viewport.height) / box.height,
          },
          geometry.image,
          geometry.viewport,
          geometry.view,
        )
      if (point && geometry?.maskGeometry)
        masks.sampleRangeAt(point, undefined, geometry.maskGeometry)
      else masks.setError('Choose a visible point inside the photograph.')
      return
    }
    if (masks?.active) {
      stopDrag()
      keyboardStroke.current = false
      const point = pointerBrushPoint(event)
      if (point && masks.beginStroke(point)) {
        setBrushPath([brushOutput.current])
        brushPointer.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    if (toneCurves?.active) {
      stopDrag()
      const box = event.currentTarget.getBoundingClientRect()
      const point = normalizedSourcePoint(
        { x: event.clientX - box.left, y: event.clientY - box.top },
        current.current.image,
        current.current.viewport,
        current.current.view,
        full.preview?.crop,
      )
      if (!point) {
        toneCurves.setError('Choose a visible tone inside the photograph.')
        return
      }
      if (toneCurves.beginTarget(point, event.clientY)) {
        curvePointer.current = event.pointerId
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    if (whiteBalancePicker?.active) {
      stopDrag()
      const box = event.currentTarget.getBoundingClientRect()
      const point = normalizedSourcePoint(
        { x: event.clientX - box.left, y: event.clientY - box.top },
        current.current.image,
        current.current.viewport,
        current.current.view,
        full.preview?.crop,
      )
      if (point) whiteBalancePicker.sampleAt(point)
      return
    }
    pan.reset()
    if (!panX && !panY) return
    pan.start(event.nativeEvent)
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (masks?.active) {
      const point = pointerBrushPoint(event)
      if (point && brushPointer.current === event.pointerId) masks.appendStroke(point)
      if (brushPointer.current === event.pointerId) return
    }
    if (curvePointer.current === event.pointerId) {
      toneCurves?.moveTarget(event.clientY)
      return
    }
    pan.move(event.nativeEvent)
  }
  const exactPreset = ZOOM_STOPS.some((stop) => Math.abs(stop - view.scale) < 0.00001)
  const pickerArea =
    whiteBalancePicker?.active && ready
      ? whiteBalanceSampleArea(
          whiteBalancePicker.sample,
          full.preview?.crop?.source.width ?? model.image.width,
          full.preview?.crop?.source.height ?? model.image.height,
        )
      : null
  const pickerMatrix = full.preview?.crop?.sourceToOutput,
    pickerOrigin = pickerArea && pickerMatrix ? mapCropAffine(pickerMatrix, pickerArea) : pickerArea
  const zoomValue = view.fit
    ? 'fit'
    : exactPreset
      ? String(ZOOM_STOPS.find((stop) => Math.abs(stop - view.scale) < 0.00001))
      : 'custom'

  return (
    <section className={styles.preview} aria-label="Image preview" onKeyDown={keyDown}>
      <div className={layout.previewArea}>
        <div
          ref={viewport}
          className={`${styles.viewport} ${ready && (panX || panY) ? styles.pannable : ''} ${dragging ? styles.dragging : ''} ${whiteBalancePicker?.active || toneCurves?.active || masks?.active || masks?.editingGradient || masks?.creatingGradient || masks?.rangePicking || objectSelection?.active ? styles.picking : ''}`}
          data-testid="preview-viewport"
          data-mode={view.fit ? 'fit' : 'manual'}
          data-scale={view.scale}
          data-pan-x={view.x}
          data-pan-y={view.y}
          data-loading={Boolean(
            photo && !fullVisible && !firstSurfaceReady && !full.error && !gpuError,
          )}
          data-resolution={
            cachedDisplayReady && !hdrReady
              ? 'cached-exact'
              : firstSurfaceReady && !hdrReady
                ? 'first-surface'
                : fullVisible
                  ? 'full'
                  : full.placeholder
                    ? 'placeholder'
                    : 'loading'
          }
          data-image-width={model.image.width}
          data-image-height={model.image.height}
          data-dragging={dragging}
          data-mask-brush={masks?.active || undefined}
          data-range-picking={masks?.rangePicking || undefined}
          data-object-selection={objectSelection?.active || undefined}
          onPointerDownCapture={(event) => {
            if (event.button === 1) {
              pointerDown(event)
              event.stopPropagation()
            }
          }}
          onPointerDown={pointerDown}
          onAuxClick={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onPointerMove={pointerMove}
          onPointerLeave={() => {
            if (brushPointer.current === null) setBrushCursor(null)
          }}
          onPointerUp={(event) => {
            if (brushPointer.current === event.pointerId) {
              brushPointer.current = null
              masks?.endStroke()
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
              return
            }
            if (curvePointer.current === event.pointerId) {
              curvePointer.current = null
              toneCurves?.endTarget(event.clientY)
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            } else pan.release(event.nativeEvent)
          }}
          onPointerCancel={(event) => {
            if (brushPointer.current === event.pointerId) {
              brushPointer.current = null
              masks?.cancel()
              return
            }
            if (curvePointer.current === event.pointerId) {
              curvePointer.current = null
              toneCurves?.cancelTarget(false)
            } else pan.cancel(event.nativeEvent)
          }}
          onLostPointerCapture={(event) => {
            if (brushPointer.current === event.pointerId) {
              brushPointer.current = null
              masks?.cancel()
              return
            }
            if (curvePointer.current === event.pointerId) {
              curvePointer.current = null
              toneCurves?.cancelTarget(false)
              return
            }
            if (event.target === divider.current) stopDrag()
            else pan.lostCapture()
          }}
          onDoubleClick={(event) => {
            if (
              whiteBalancePicker?.active ||
              toneCurves?.active ||
              masks?.active ||
              masks?.rangePicking ||
              masks?.rangeCreating ||
              objectSelection?.active ||
              masks?.editingGradient ||
              masks?.creatingGradient ||
              cropping
            )
              return
            if (!ready || dragged.current) return
            const box = event.currentTarget.getBoundingClientRect()
            if (current.current.view.fit)
              zoom(1, {
                x: event.clientX - box.left - box.width / 2,
                y: event.clientY - box.top - box.height / 2,
              })
            else fit()
          }}
          onContextMenu={(event) => {
            if (cropping) {
              event.preventDefault()
              return
            }
            if (photo) {
              event.preventDefault()
              stopDrag()
              onContextMenu(
                photo,
                image.current ?? event.currentTarget,
                event.clientX,
                event.clientY,
              )
            }
          }}
        >
          {photo ? (
            <>
              {pickerArea && pickerOrigin && (
                <div
                  className={styles.whiteBalanceSample}
                  aria-hidden="true"
                  data-testid="white-balance-sample"
                  style={{
                    left:
                      model.viewport.width / 2 +
                      view.x +
                      (pickerOrigin.x - model.image.width / 2) * view.scale,
                    top:
                      model.viewport.height / 2 +
                      view.y +
                      (pickerOrigin.y - model.image.height / 2) * view.scale,
                    width: pickerArea.width * view.scale,
                    height: pickerArea.height * view.scale,
                    transformOrigin: '0 0',
                    transform: pickerMatrix
                      ? `matrix(${pickerMatrix[0]},${pickerMatrix[2]},${pickerMatrix[1]},${pickerMatrix[3]},0,0)`
                      : undefined,
                  }}
                />
              )}
              <canvas
                key={`${generation}-${presenterRoute}-${hdrPresentationOwner}-${hdrSurface ? 'hdr' : editingSurface}`}
                ref={attachCanvas}
                className={styles.canvas}
                role="img"
                aria-label={photo.filename}
                data-testid="main-preview"
                data-suspended={suspended}
                data-gesturing={gesturing}
                data-editing-epoch={editingEpoch}
                data-cached-display-ready={cachedDisplayReady}
                data-first-surface-ready={firstSurfaceReady}
                data-preview-request-id={full.requestId}
                data-source-owner-wait-started-at={full.admissionTimings?.ownerWaitStartedAt}
                data-source-owner-wait-finished-at={full.admissionTimings?.ownerWaitFinishedAt}
                data-source-admission-finished-at={full.admissionTimings?.admissionFinishedAt}
                data-source-request-started-at={full.requestStartedAt}
                data-first-surface-painted={firstSurfacePainted}
                data-presentation-error={gpuError || undefined}
                data-hdr-presentation-owner={hdrSurface ? hdrPresentationOwner : undefined}
                data-src={full.preview?.url}
                tabIndex={0}
                aria-keyshortcuts="+ - 0 1 ArrowLeft ArrowRight ArrowUp ArrowDown"
                style={{
                  width: model.viewport.width || undefined,
                  height: model.viewport.height || undefined,
                  visibility:
                    !gpuError &&
                    comparisonReady &&
                    ((!suspended && !full.error && (cachedDisplayReady || firstSurfaceReady)) ||
                      (fullVisible && ready && (!full.preview?.linear?.hdr || hdrReady)))
                      ? 'visible'
                      : 'hidden',
                }}
              />
              <canvas
                ref={retainedSurface}
                className={styles.canvas}
                aria-hidden="true"
                data-testid="retained-preview"
                style={{
                  width: model.viewport.width || undefined,
                  height: model.viewport.height || undefined,
                  visibility:
                    !gpuError && retained && !hdrReady && !cachedDisplayReady && !firstSurfaceReady
                      ? 'visible'
                      : 'hidden',
                  pointerEvents: 'none',
                }}
              />
              <canvas
                ref={maskOverlay}
                className={styles.overlay}
                aria-hidden="true"
                data-testid="mask-coverage-overlay"
                style={{
                  visibility:
                    !gpuError &&
                    (masks?.overlayVisible || objectSelection?.proposal) &&
                    ready &&
                    maskPresentation?.maskGeometry
                      ? 'visible'
                      : 'hidden',
                }}
              />
              {masks &&
                ready &&
                maskPresentation?.maskGeometry &&
                !cropping &&
                !objectSelection?.active &&
                !inspection?.active &&
                !suspended &&
                mode !== 'before' && (
                  <GradientOverlay
                    masks={masks}
                    geometry={maskPresentation}
                    viewport={model.viewport}
                    readGeometry={readMaskPresentation}
                  />
                )}
              {masks?.strokeDraft &&
                masks.selected &&
                maskTreeHasEdges(masks.selected) &&
                maskPresentation && (
                  <svg
                    className={styles.overlay}
                    aria-hidden="true"
                    data-testid="mask-stroke-feedback"
                    viewBox={`0 0 ${model.viewport.width} ${model.viewport.height}`}
                  >
                    <polyline
                      points={brushPath
                        .map((point) => {
                          const p = selectionScreenPoint(point, maskPresentation, model.viewport)
                          return `${p.x},${p.y}`
                        })
                        .join(' ')}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="2"
                      strokeDasharray="3 3"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              {masks?.active && brushCursor && ready && maskPresentation?.maskGeometry && (
                <div
                  ref={brushCursorElement}
                  className={styles.brushCursor}
                  aria-hidden="true"
                  style={maskCursorStyle(
                    maskPresentation,
                    model.viewport,
                    brushCursor,
                    masks.workspace.size,
                  )}
                />
              )}
              <canvas
                ref={overlay}
                className={styles.overlay}
                aria-hidden="true"
                data-testid="clipping-overlay"
                style={{ visibility: gpuError ? 'hidden' : undefined }}
              />
              {crop &&
                cropping &&
                ready &&
                full.preview?.sourceSpace === 'uncropped' &&
                crop.context &&
                full.preview.settingsRevision === crop.context.revision &&
                model.image.width === crop.context.source.width &&
                model.image.height === crop.context.source.height && (
                  <CropOverlay crop={crop} viewport={model.viewport} view={model.view} />
                )}
              {inspection?.active &&
                ready &&
                !cropping &&
                !masks?.active &&
                !masks?.rangePicking &&
                !masks?.rangeCreating &&
                !objectSelection?.active &&
                !whiteBalancePicker?.active &&
                !toneCurves?.active && (
                  <InspectionRegion
                    inspection={inspection}
                    geometry={maskPresentation}
                    viewport={model.viewport}
                    onLocate={(region) => {
                      stopDrag()
                      change((value) => ({
                        ...value,
                        view: {
                          fit: false,
                          scale: 1,
                          x: value.image.width / 2 - region.x - region.width / 2,
                          y: value.image.height / 2 - region.y - region.height / 2,
                        },
                      }))
                    }}
                  />
                )}
              {objectSelection?.active &&
                ready &&
                !cropping &&
                !masks?.active &&
                !masks?.rangePicking &&
                !masks?.rangeCreating &&
                !whiteBalancePicker?.active &&
                !toneCurves?.active &&
                !inspection?.active && (
                  <ObjectSelectionOverlay
                    selection={objectSelection}
                    geometry={maskPresentation}
                    viewport={model.viewport}
                    readGeometry={readMaskPresentation}
                  />
                )}
              {working && mode !== 'after' && <span className={styles.beforeLabel}>Before</span>}
              {working && mode === 'split' && (
                <>
                  <span className={styles.afterLabel}>After</span>
                  <div
                    ref={divider}
                    className={styles.divider}
                    style={{ left: `${split * 100}%` }}
                    role="slider"
                    tabIndex={0}
                    aria-label="Before and After divider"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(split * 100)}
                    aria-orientation="horizontal"
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      event.currentTarget.focus()
                      dividerPointer.current = event.pointerId
                      event.currentTarget.setPointerCapture(event.pointerId)
                    }}
                    onPointerMove={(event) => {
                      event.stopPropagation()
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                      const box = viewport.current!.getBoundingClientRect()
                      update({
                        split: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)),
                      })
                    }}
                    onPointerUp={(event) => {
                      event.stopPropagation()
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }}
                    onPointerCancel={(event) => {
                      event.stopPropagation()
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId)
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                        event.preventDefault()
                        update({
                          split:
                            event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? 1
                                : Math.max(
                                    0,
                                    Math.min(1, split + (event.key === 'ArrowLeft' ? -0.01 : 0.01)),
                                  ),
                        })
                      }
                    }}
                  />
                </>
              )}
              {!fullVisible && full.placeholder?.placeholderUrl && (
                <img
                  className={`${styles.image} ${styles.placeholder}`}
                  src={full.placeholder.placeholderUrl}
                  alt=""
                  aria-hidden="true"
                  data-testid="preview-placeholder"
                  style={{
                    width: full.placeholder.width,
                    height: full.placeholder.height,
                    transform: `translate(-50%, -50%) translate(${placeholderView.x}px, ${placeholderView.y}px) scale(${placeholderView.scale})`,
                  }}
                />
              )}
              {(!!gpuError ||
                !!maskEdgeCoverage?.error ||
                (comparisonRequired && !comparisonReady) ||
                (!fullVisible && !firstSurfaceReady) ||
                (!!full.preview?.linear?.hdr &&
                  !hdrReady &&
                  !retained &&
                  !cachedDisplayReady &&
                  !firstSurfaceReady)) && (
                <div
                  className={styles.message}
                  role={
                    gpuError || maskEdgeCoverage?.error || full.error || comparisonError
                      ? 'alert'
                      : 'status'
                  }
                  data-testid={gpuError ? 'preview-gpu-error' : undefined}
                >
                  {maskEdgeCoverage?.error ? (
                    <>
                      <span>Mask edge processing unavailable</span>
                      <span>{maskEdgeCoverage.error}</span>
                      <button onClick={maskEdgeCoverage.retry}>Retry GPU</button>
                    </>
                  ) : gpuError ? (
                    <>
                      <span>GPU preview unavailable</span>
                      <span style={{ maxWidth: 480, overflowWrap: 'anywhere' }}>{gpuError}</span>
                      <button onClick={retryGpu}>Retry GPU</button>
                    </>
                  ) : full.error || comparisonError ? (
                    <span>
                      {comparisonError
                        ? 'Could not load this comparison.'
                        : 'Could not load this preview.'}
                    </span>
                  ) : (
                    <>
                      <ProgressSpinner />
                      <span>
                        {comparisonRequired && !comparisonReady
                          ? 'Preparing comparison…'
                          : 'Loading preview…'}
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className={layout.emptyLibrary} data-testid="empty-library">
              <FileImage size={38} strokeWidth={1} />
              <h1>Your photographs, at home.</h1>
              <p>Choose photos or a folder to start your library.</p>
              <button className={layout.primaryButton} onClick={onImport}>
                Import your first photos
              </button>
              <span>JPEG · PNG · TIFF · Sony ARW</span>
            </div>
          )}
        </div>
      </div>
      <div className={layout.canvasToolbar} data-testid="preview-footer">
        <div className={layout.photoPagination} data-testid="group-navigation">
          <Layers size={13} aria-hidden="true" />
          <span
            className={styles.navigationLabel}
            title={
              group
                ? `Photo group / ${group.index + 1} of ${group.count}`
                : `All photographs / ${photo ? position + 1 : 0} of ${total}`
            }
          >
            {group
              ? `Photo group / ${group.index + 1} of ${group.count}`
              : `All photographs / ${photo ? position + 1 : 0} of ${total}`}
          </span>
          <button
            className={layout.iconButton}
            aria-label="Previous photo"
            disabled={!photo || position <= 0}
            onClick={() => void onNavigate(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className={layout.iconButton}
            aria-label="Next photo"
            disabled={!photo || position + 1 >= total}
            onClick={() => void onNavigate(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className={styles.viewControls} data-testid="preview-view-controls">
          {photo && (
            <span className={styles.dimensions}>
              {model.image.width} × {model.image.height}
            </span>
          )}
          <div
            className={styles.zoomControls}
            data-testid="zoom-controls"
            title="100% shows one full-resolution image pixel per CSS pixel. Higher zoom enlarges it."
          >
            <select
              aria-label="Preview zoom"
              disabled={!ready}
              value={zoomValue}
              onChange={(event) => {
                if (event.target.value === 'fit') fit()
                else zoom(Number(event.target.value))
              }}
            >
              <option value="fit">Fit</option>
              {!exactPreset && !view.fit && (
                <option value="custom">{Math.round(view.scale * 100)}%</option>
              )}
              {ZOOM_STOPS.map((scale) => (
                <option key={scale} value={scale}>
                  {scale * 100}%
                </option>
              ))}
            </select>
            {inspection && (
              <IconButton
                icon={Scan}
                label="Inspect region"
                className={styles.inspectButton}
                aria-pressed={inspection.active}
                disabled={!ready || cropping || inspection.loading}
                onClick={() => (inspection.active ? inspection.close() : void inspection.start())}
              />
            )}
          </div>
          {photo && (
            <span
              className={styles.resolution}
              data-testid="preview-resolution"
              role="status"
              aria-description={
                gpuError || full.error || live.error || comparisonError || undefined
              }
              title={
                gpuError ||
                full.error ||
                live.error ||
                comparisonError ||
                (fullVisible
                  ? `${model.image.width} × ${model.image.height} · ${working?.hdr ? 'Rec.2020 linear working data' : 'sRGB'} · Original preserved`
                  : 'Loading the full-resolution image.')
              }
            >
              {maskEdgeCoverage?.pending ? (
                <span role="status" data-testid="mask-edge-pending">
                  Updating mask…
                </span>
              ) : maskEdgeCoverage?.error ? (
                <span>Mask edges unavailable</span>
              ) : gpuError ? (
                <span>Preview unavailable</span>
              ) : full.error ? (
                <>
                  <span>Full resolution unavailable</span>
                  <button onClick={full.retry} aria-description={full.error}>
                    Retry
                  </button>
                </>
              ) : comparisonError ? (
                <>
                  <span>Comparison unavailable</span>
                  <button
                    onClick={() => {
                      comparison.retry()
                      comparisonLive.retry()
                    }}
                    aria-description={comparisonError}
                  >
                    Retry comparison
                  </button>
                  <button onClick={() => update({ mode: 'after' })}>Show After</button>
                </>
              ) : comparisonRequired && !comparisonReady ? (
                <>
                  <span>Preparing comparison…</span>
                  <button onClick={() => update({ mode: 'after' })}>Show After</button>
                </>
              ) : firstSurfaceReady && !hdrReady ? (
                <span>Loading full detail…</span>
              ) : fullVisible ? (
                live.error ? (
                  <>
                    <span>Live preview unavailable</span>
                    <button onClick={live.retry} aria-description={live.error}>
                      Retry live preview
                    </button>
                  </>
                ) : working ? (
                  'Full resolution'
                ) : (
                  'Preparing live preview…'
                )
              ) : (
                <>
                  <ProgressSpinner />
                  <span>Loading full resolution…</span>
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
