import type { PreviewViewState } from '../../../shared/workspace'
import { useHdrAnalysis } from '../hooks/useHdrAnalysis'
import { SDR_TARGET } from '../../../shared/hdr'
import type { DisplayTarget } from '../../../shared/hdr'
import { HdrPresenter, type HdrPresentationState } from '../preview/hdr-presenter'
import { useForegroundActivity } from '../hooks/useForegroundActivity'
import { HdrCpuPresenter } from '../preview/hdr-cpu-presenter'
import { hdrPresentationMemory, HDR_PRESENTATION_BUDGET } from '../preview/hdr-memory'
import { neutralAdjustments } from '../../../shared/adjustments'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { usePreviewAnalysis, type ClippingMask } from '../hooks/usePreviewAnalysis'
import type { AdjustmentParameters } from '../../../shared/adjustments'
import { PreviewPresenter } from '../preview/presenter'
import { useWorkingPreview } from '../hooks/useWorkingPreview'
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { ChevronLeft, ChevronRight, FileImage, Maximize, Minus, Plus } from 'lucide-react'
import type { Photo } from '../../../shared/contracts'
import {
  constrain,
  savedView,
  restoreView,
  INITIAL_VIEW,
  minimumScale,
  replaceDimensions,
  stepScale,
  zoomAt,
  ZOOM_STOPS,
  type Size,
  type View,
} from '../preview/geometry'
import layout from '../App.module.css'
import styles from './PhotoPreview.module.css'
import { useFullPreview } from '../hooks/useFullPreview'
import { usePanDrag } from '../hooks/usePanDrag'
import { usePreviewFrame } from '../hooks/usePreviewFrame'
import { usePreviewWheel } from '../hooks/usePreviewWheel'
import { ProgressSpinner } from './ProgressSpinner'
import { PreviewMetadata } from './PreviewMetadata'

const PRESENTATION_CACHE = import.meta.env.VITE_LUMA_HDR_PRESENTATION_CACHE === '1'

interface Model {
  loaded: boolean
  image: Size
  viewport: Size
  view: View
}
interface Props {
  hdrJpeg?: boolean
  suspended?: boolean
  initialView?: PreviewViewState | null
  onViewChange?: (view: PreviewViewState) => void
  displayTarget: DisplayTarget
  tools: PreviewTools
  gesturing: boolean
  editingEpoch?: number
  adjustments: AdjustmentParameters
  confirmedEdits?: HdrPresentationState | null
  onEditingReady: (photoId: string | null) => void
  photo: Photo | null
  total: number
  position: number
  onNavigate: (direction: -1 | 1) => Promise<void>
  onImport: () => void
  onContextMenu: (photo: Photo, element: HTMLElement, x: number, y: number) => void
}

// The parent keys this component by photo ID so every new photograph starts in Fit.
export function PhotoPreview({
  hdrJpeg = false,
  suspended = false,
  initialView = null,
  onViewChange,
  displayTarget,
  photo,
  adjustments,
  confirmedEdits = null,
  tools,
  gesturing,
  editingEpoch = 0,
  onEditingReady,
  total,
  position,
  onNavigate,
  onImport,
  onContextMenu,
}: Props) {
  const presentationState = PRESENTATION_CACHE ? confirmedEdits : null
  const recoveryView = useRef(initialView)
  const initialTarget = useRef(displayTarget)
  const overlay = useRef<HTMLCanvasElement>(null)
  const divider = useRef<HTMLDivElement>(null)
  const dividerPointer = useRef<number | null>(null)
  const [mask, setMask] = useState<ClippingMask>()
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLCanvasElement>(null)
  const retainedSurface = useRef<HTMLCanvasElement>(null)
  const [retained, setRetained] = useState(false)
  const restoreCanvasFocus = useRef(false)
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) {
      restoreCanvasFocus.current = document.activeElement === image.current
      const previous = image.current,
        surface = retainedSurface.current
      if (surface && previous?.dataset.editing === 'ready') {
        try {
          if (previous.dataset.backend === 'webgpu-hdr') {
            // A lost device's drawing buffer is unavailable. The presenter saved
            // this bounded copy while the completed frame was still readable.
            if (surface.dataset.presentationSerial === previous.dataset.presentationSerial)
              setRetained(true)
          } else {
            const scale = Math.min(1, 1024 / Math.max(previous.width, previous.height))
            surface.width = Math.max(1, Math.round(previous.width * scale))
            surface.height = Math.max(1, Math.round(previous.height * scale))
            surface.getContext('2d')!.drawImage(previous, 0, 0, surface.width, surface.height)
            setRetained(true)
          }
        } catch {
          /* Keep first-render loading explicit if a lost device cannot be copied. */
        }
      }
    }
    image.current = canvas
    if (canvas && restoreCanvasFocus.current) {
      canvas.focus({ preventScroll: true })
      restoreCanvasFocus.current = false
    }
  }, [])
  const [model, setModel] = useState<Model>({
    loaded: false,
    image: { width: photo?.width ?? 0, height: photo?.height ?? 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model)
  const [fallback, setFallback] = useState(false)
  const full = useFullPreview(photo?.id, !suspended, fallback ? 'sdr' : displayTarget.mode)
  const { begin: beginActivity, pulse: pulseActivity } = useForegroundActivity(
    photo?.id,
    undefined,
    !suspended,
  )
  const [displayedUrl, setDisplayedUrl] = useState('')
  const presenter = useRef<PreviewPresenter | HdrPresenter | HdrCpuPresenter | null>(null)
  const [hdrReady, setHdrReady] = useState(false)
  const [cachedDisplayReady, setCachedDisplayReady] = useState(false)
  useEffect(() => {
    if (!hdrReady) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRetained(false)
  }, [hdrReady])
  const selectedAt = useRef(0)
  const firstPresentedMs = useRef<number | undefined>(undefined)
  const firstUsefulMs = useRef<number | undefined>(undefined)
  useEffect(() => {
    selectedAt.current = performance.now()
    firstPresentedMs.current = undefined
    firstUsefulMs.current = undefined
  }, [photo?.id, suspended])
  const cachedPresented = useCallback((presented: boolean) => {
    if (presented) firstUsefulMs.current ??= performance.now() - selectedAt.current
    setCachedDisplayReady(presented)
  }, [])
  const fallbackReason = useRef('')
  const fullVisible = Boolean(full.preview && (displayedUrl || full.preview.linear?.hdr))
  const live = useWorkingPreview(full.preview, fullVisible && !suspended)
  const { generation } = live
  const working = fallback && hdrJpeg ? null : live.working
  const hdrCapable = hdrJpeg || !!working?.hdr
  const { mode, split, hdrRanges, analyze, update } = tools
  const analysisPending = useCallback(
    (pending: boolean) => update({ analysisPending: pending }),
    [update],
  )
  const actualTarget = useMemo(
    () =>
      fallback
        ? {
            ...SDR_TARGET,
            generation: displayTarget.generation,
            requested: displayTarget.requested,
            headroom: displayTarget.headroom,
          }
        : displayTarget,
    [fallback, displayTarget],
  )
  const hdrOverlay = hdrRanges
    ? 0
    : tools.domain === 'working-hdr'
      ? tools.hdrOverlay & 4
      : tools.hdrOverlay
  const shadows = tools.shadows || tools.hover === 'shadows'
  const highlights = tools.highlights || tools.hover === 'highlights'
  const sdrAnalysisError = usePreviewAnalysis(
    working?.hdr || suspended ? null : working,
    `${photo?.id}-${working?.identity ?? 'pending'}-${generation}`,
    mode === 'before' ? neutralAdjustments : adjustments,
    shadows || highlights,
    gesturing,
    analyze,
    setMask,
    beginActivity,
  )
  const analysisError = useHdrAnalysis(
    hdrReady && !suspended ? working : null,
    mode === 'before' ? neutralAdjustments : adjustments,
    actualTarget,
    'content-hdr',
    !!hdrOverlay,
    analyze,
    setMask,
    gesturing,
    fallback,
    beginActivity,
  )
  useEffect(() => {
    if (gesturing && mode === 'before') update({ mode: 'after' })
  }, [gesturing, mode, update])
  const histogramError =
    full.error || live.error || (working?.hdr ? analysisError : sdrAnalysisError)
  useEffect(() => update({ analysisError: histogramError }), [histogramError, update])
  useEffect(() => update({ hdr: !!working?.hdr }), [working?.hdr, update])
  useEffect(() => {
    const preview = full.preview
    if (!preview || suspended) return
    const ready = working?.hdr ? hdrReady : !!displayedUrl
    let cancelled = false
    const report = () => {
      if (cancelled) return
      if (ready) firstPresentedMs.current ??= performance.now() - selectedAt.current
      if (ready) firstUsefulMs.current ??= firstPresentedMs.current
      void window.luma.reportPreviewPresentation({
        photoId: preview.photoId,
        revision: preview.settingsRevision ?? 0,
        targetGeneration: displayTarget.generation,
        backend:
          fallback && hdrJpeg
            ? 'canvas2d-hdr-sdr'
            : working?.hdr
              ? fallback
                ? 'canvas2d-hdr-sdr'
                : 'webgpu-hdr'
              : 'legacy',
        mode: working?.hdr && !fallback ? displayTarget.mode : 'sdr',
        stage: ready ? 'presented' : 'loading',
        reason:
          fallback && hdrJpeg
            ? 'HDR renderer unavailable; showing the JPEG SDR primary.'
            : working?.hdr
              ? fallback
                ? fallbackReason.current
                : displayTarget.reason
              : 'Legacy SDR processing.',
        timings:
          ready || cachedDisplayReady
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
    working?.hdr,
    hdrReady,
    cachedDisplayReady,
    displayedUrl,
    fallback,
    hdrJpeg,
    displayTarget.generation,
    displayTarget.mode,
    displayTarget.reason,
  ])
  const editingSurface = !!working
  const placeholderView = constrain(model.view, full.placeholder ?? model.image, model.viewport)
  function draw(model: Model) {
    pulseActivity()
    const started = performance.now()
    presenter.current?.setComparison(mode, split)
    if (presenter.current instanceof HdrPresenter || presenter.current instanceof HdrCpuPresenter)
      presenter.current.setHdrRanges(hdrRanges)
    if (
      PRESENTATION_CACHE &&
      (presenter.current instanceof HdrPresenter || presenter.current instanceof HdrCpuPresenter)
    )
      presenter.current.setPresentationState(presentationState)
    if (presenter.current instanceof HdrPresenter)
      presenter.current.setEditing(gesturing, editingEpoch)
    if (PRESENTATION_CACHE && working?.hdr && !presentationState) return
    presenter.current?.draw(model.image, model.viewport, model.view, {
      whiteBalance: adjustments.whiteBalance,
      exposureEv: adjustments.exposureEv,
      contrast: adjustments.contrast,
      highlights: adjustments.highlights,
      shadows: adjustments.shadows,
      whites: adjustments.whites,
      blacks: adjustments.blacks,
    })
    performance.measure('luma.preview.presentation', {
      start: started,
      detail: {
        exposureEv: adjustments.exposureEv,
        contrast: adjustments.contrast,
        highlights: adjustments.highlights,
        shadows: adjustments.shadows,
        whites: adjustments.whites,
        blacks: adjustments.blacks,
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
    if (!mask || !working) return
    const { image, viewport, view } = model
    let levelIndex = 0
    while (levelIndex + 1 < mask.levels.length && view.scale * 2 ** levelIndex < 1) levelIndex++
    const level = mask.levels[levelIndex]
    const left = (viewport.width - image.width * view.scale) / 2 + view.x,
      top = (viewport.height - image.height * view.scale) / 2 + view.y
    const pixelWidth = (image.width * view.scale) / level.width,
      pixelHeight = (image.height * view.scale) / level.height
    const sx = Math.max(0, Math.floor(-left / pixelWidth)),
      sy = Math.max(0, Math.floor(-top / pixelHeight))
    const width = Math.max(
      0,
      Math.min(level.width, Math.ceil((viewport.width - left) / pixelWidth)) - sx,
    )
    const height = Math.max(
      0,
      Math.min(level.height, Math.ceil((viewport.height - top) / pixelHeight)) - sy,
    )
    if (!width || !height) return
    const compact = document.createElement('canvas')
    compact.width = width
    compact.height = height
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bits = level.data[(sy + y) * level.width + sx + x],
          i = (y * width + x) * 4
        if (working.hdr && bits & hdrOverlay) {
          pixels[i] = 255
          pixels[i + 1] = 160
          pixels[i + 3] = (x + y) % 4 < 2 ? 220 : 140
        } else if (!working.hdr && highlights && bits & 2) {
          pixels[i] = 255
          pixels[i + 3] = 180
        } else if (!working.hdr && shadows && bits & 1) {
          pixels[i + 2] = 255
          pixels[i + 3] = 180
        }
      }
    compact.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0)
    context.save()
    if (mode === 'split') {
      context.beginPath()
      context.rect(canvas.width * split, 0, canvas.width, canvas.height)
      context.clip()
    }
    context.imageSmoothingEnabled = false
    context.drawImage(
      compact,
      left + sx * pixelWidth,
      top + sy * pixelHeight,
      width * pixelWidth,
      height * pixelHeight,
    )
    context.restore()
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
      if (next.loaded && next.viewport.width > 0 && !recoveryView.current && photo?.id)
        onViewChange?.(savedView(photo.id, next.view, next.image))
      if (immediate) setModel(next)
      schedule()
    },
    [schedule, photo, onViewChange],
  )
  const ready = Boolean(
    !suspended &&
    photo &&
    model.loaded &&
    model.image.width &&
    model.viewport.width &&
    model.viewport.height &&
    (!full.preview?.linear?.hdr || hdrReady) &&
    !full.error,
  )
  const { view } = model
  const panX = model.image.width * view.scale > model.viewport.width + 0.5
  const panY = model.image.height * view.scale > model.viewport.height + 0.5
  const minimum = minimumScale(model.image, model.viewport)

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
  usePreviewWheel(viewport, ready, change, stopDrag)
  const adjustmentKey = JSON.stringify(adjustments)
  useEffect(() => {
    stopDrag()
  }, [
    stopDrag,
    adjustmentKey,
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
      window.luma.onLibraryEvent((event) => {
        if (event.lensChanged && event.lensChanged.photoId === photo?.id) stopDrag()
      }),
    [photo?.id, stopDrag],
  )

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (suspended || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return
      stopDrag()
      change((model) => ({
        ...model,
        viewport: { width: entry.contentRect.width, height: entry.contentRect.height },
        ...(model.loaded && recoveryView.current
          ? {
              view: restoreView(recoveryView.current, model.image, {
                width: entry.contentRect.width,
                height: entry.contentRect.height,
              }),
            }
          : {}),
      }))
      if (current.current.loaded && recoveryView.current) {
        recoveryView.current = null
        if (photo?.id)
          onViewChange?.(savedView(photo.id, current.current.view, current.current.image))
      }
    })
    observer.observe(element)
    window.addEventListener('blur', stopDrag)
    return () => {
      observer.disconnect()
      window.removeEventListener('blur', stopDrag)
    }
  }, [change, stopDrag, suspended, photo, onViewChange])

  const { preview: renderedFrame, pixels, displayFailed } = full
  useEffect(() => {
    const canvas = image.current
    if (!canvas || suspended) {
      if (PRESENTATION_CACHE && suspended) {
        // Suspension ends this presentation cycle before a later fresh edit confirmation.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setHdrReady(false)
        setCachedDisplayReady(false)
        setRetained(false)
      }
      return
    }
    try {
      if (working?.hdr) {
        // A replacement surface has no validated pixels yet.
        setHdrReady(false)
        presenter.current = fallback
          ? new HdrCpuPresenter(canvas, () => setHdrReady(true), displayFailed, beginActivity)
          : new HdrPresenter(
              canvas,
              initialTarget.current,
              (reason) => {
                fallbackReason.current = reason.slice(0, 512)
                setFallback(true)
              },
              () => setHdrReady(true),
              analyze,
              retainedSurface.current ?? undefined,
              beginActivity,
              analysisPending,
              cachedPresented,
            )
      } else
        presenter.current = new PreviewPresenter(canvas, fallback || !editingSurface, () =>
          setFallback(true),
        )
    } catch {
      // Canvas capability checks can require replacing the DOM canvas with a 2D surface.
      setFallback(true)
    }
    return () => {
      presenter.current?.dispose()
      presenter.current = null
    }
  }, [
    fallback,
    generation,
    editingSurface,
    working?.hdr,
    displayFailed,
    suspended,
    analyze,
    beginActivity,
    analysisPending,
    cachedPresented,
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
      if (pixels && (!editingSurface || fallback)) presenter.current.setBitmap(pixels)
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
        if (photo?.id) onViewChange?.(savedView(photo.id, current.current.view, dimensions))
      }
    } catch {
      if (!fallback) setFallback(true)
      else displayFailed()
    }
  }, [
    renderedFrame,
    pixels,
    change,
    displayFailed,
    fallback,
    generation,
    editingSurface,
    suspended,
    photo,
    onViewChange,
  ])

  useEffect(() => {
    if (suspended) {
      onEditingReady(null)
      return
    }
    try {
      if (
        PRESENTATION_CACHE &&
        (presenter.current instanceof HdrPresenter || presenter.current instanceof HdrCpuPresenter)
      )
        presenter.current.setPresentationState(presentationState)
      if (working) presenter.current?.setWorking(working)
      onEditingReady(
        working && (!PRESENTATION_CACHE || !working.hdr || hdrReady) ? (photo?.id ?? null) : null,
      )
    } catch {
      // Canvas capability checks can require replacing the DOM canvas with a 2D surface.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(true)
    }
    return () => onEditingReady(null)
  }, [
    working,
    fallback,
    generation,
    photo?.id,
    onEditingReady,
    suspended,
    presentationState,
    hdrReady,
  ])

  useEffect(() => {
    if (
      hdrCapable &&
      displayTarget.capabilities?.hardware &&
      displayTarget.capabilities.extended &&
      fallback
    ) {
      // A new capability probe allows recovery after device loss.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- A failed presenter waits for a fresh capability generation.
  }, [
    displayTarget.generation,
    displayTarget.capabilities?.hardware,
    displayTarget.capabilities?.extended,
    hdrCapable,
  ])
  useEffect(() => {
    if (presenter.current instanceof HdrPresenter || presenter.current instanceof HdrCpuPresenter)
      presenter.current.setTarget(displayTarget)
  }, [displayTarget, working, fallback])

  useEffect(() => {
    if (!fallback || !working?.hdr || !fallbackReason.current.includes('memory limit')) return
    const dpr = window.devicePixelRatio || 1
    if (
      hdrPresentationMemory(
        working.width,
        working.height,
        Math.round(model.viewport.width * dpr),
        Math.round(model.viewport.height * dpr),
      ).total <= HDR_PRESENTATION_BUDGET
    ) {
      // A smaller viewport can recover without changing the photograph or display target.
      // The GPU presenter drains retained surfaces if ordinary planning needs their headroom.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFallback(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Retry only when allocation dimensions change.
  }, [model.viewport.width, model.viewport.height, working?.width, working?.height])

  useEffect(() => {
    if (suspended) cancel()
    // Edit submission remains immediate; gestures use the shared animation-frame callback.
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
    adjustments.whiteBalance,
    mode,
    split,
    hdrRanges,
    working,
    fallback,
    generation,
    gesturing,
    editingEpoch,
    presentationState,
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
  function keyDown(event: KeyboardEvent) {
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
    if (working && event.key === '\\') update({ mode: mode === 'before' ? 'after' : 'before' })
    else if (working && event.key.toLowerCase() === 'y')
      update({ mode: mode === 'split' ? 'after' : 'split' })
    else if (working && event.key.toLowerCase() === 'j')
      update({
        shadows: !(tools.shadows && tools.highlights),
        highlights: !(tools.shadows && tools.highlights),
      })
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
    if (event.button !== 0 || !event.isPrimary || !ready) return
    event.preventDefault()
    image.current?.focus({ preventScroll: true })
    pan.reset()
    if (!panX && !panY) return
    pan.start(event.nativeEvent)
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    pan.move(event.nativeEvent)
  }
  const exactPreset = ZOOM_STOPS.some((stop) => Math.abs(stop - view.scale) < 0.00001)
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
          className={`${styles.viewport} ${ready && (panX || panY) ? styles.pannable : ''} ${dragging ? styles.dragging : ''}`}
          data-testid="preview-viewport"
          data-mode={view.fit ? 'fit' : 'manual'}
          data-scale={view.scale}
          data-pan-x={view.x}
          data-pan-y={view.y}
          data-loading={Boolean(photo && !fullVisible && !full.error)}
          data-resolution={
            cachedDisplayReady && !hdrReady
              ? 'cached-exact'
              : fullVisible
                ? 'full'
                : full.placeholder
                  ? 'placeholder'
                  : 'loading'
          }
          data-image-width={model.image.width}
          data-image-height={model.image.height}
          data-dragging={dragging}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={(event) => pan.release(event.nativeEvent)}
          onPointerCancel={(event) => pan.cancel(event.nativeEvent)}
          onLostPointerCapture={(event) => {
            if (event.target === divider.current) stopDrag()
            else pan.lostCapture()
          }}
          onDoubleClick={(event) => {
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
              <canvas
                key={`${fallback}-${generation}-${editingSurface}`}
                ref={attachCanvas}
                className={styles.canvas}
                role="img"
                aria-label={photo.filename}
                data-testid="main-preview"
                data-suspended={suspended}
                data-gesturing={gesturing}
                data-editing-epoch={editingEpoch}
                data-cached-display-ready={cachedDisplayReady}
                data-src={full.preview?.url}
                tabIndex={0}
                aria-keyshortcuts="+ - 0 1 ArrowLeft ArrowRight ArrowUp ArrowDown"
                style={{
                  width: model.viewport.width || undefined,
                  height: model.viewport.height || undefined,
                  visibility:
                    (!suspended && !full.error && cachedDisplayReady) ||
                    (fullVisible && ready && (!full.preview?.linear?.hdr || hdrReady))
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
                  visibility: retained && !hdrReady && !cachedDisplayReady ? 'visible' : 'hidden',
                  pointerEvents: 'none',
                }}
              />
              <canvas
                ref={overlay}
                className={styles.overlay}
                aria-hidden="true"
                data-testid="clipping-overlay"
              />
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
              {(!fullVisible ||
                (!!full.preview?.linear?.hdr && !hdrReady && !retained && !cachedDisplayReady)) && (
                <div className={styles.message} role={full.error ? 'alert' : 'status'}>
                  {full.error ? (
                    <span>Could not load this preview.</span>
                  ) : (
                    <>
                      <ProgressSpinner />
                      <span>Loading preview…</span>
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
        {photo ? <PreviewMetadata photo={photo} /> : <div />}
        <div className={styles.viewControls} data-testid="preview-view-controls">
          <div className={layout.photoPagination}>
            <button
              className={layout.iconButton}
              aria-label="Previous photo"
              disabled={!photo || position <= 0}
              onClick={() => void onNavigate(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              <strong>{String(photo ? position + 1 : 0).padStart(2, '0')}</strong>
              <span> / {String(total).padStart(2, '0')}</span>
            </span>
            <button
              className={layout.iconButton}
              aria-label="Next photo"
              disabled={!photo || position + 1 >= total}
              onClick={() => void onNavigate(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div
            className={styles.zoomControls}
            data-testid="zoom-controls"
            title="100% shows one full-resolution image pixel per CSS pixel. Higher zoom enlarges it."
          >
            <button
              aria-label="Zoom out"
              disabled={!ready || view.scale <= minimum + 0.00001}
              onClick={() => step(-1)}
            >
              <Minus size={13} />
            </button>
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
            <button
              aria-label="Zoom in"
              disabled={!ready || view.scale >= 32}
              onClick={() => step(1)}
            >
              <Plus size={13} />
            </button>
            <button
              aria-label="Fit preview"
              title="Fit preview (0)"
              disabled={!ready}
              onClick={fit}
            >
              <Maximize size={13} />
            </button>
          </div>
        </div>
        {photo && (
          <span
            className={styles.resolution}
            data-testid="preview-resolution"
            role="status"
            aria-description={full.error || live.error || undefined}
            title={
              full.error ||
              live.error ||
              (fullVisible
                ? `${model.image.width} × ${model.image.height} · ${working?.hdr ? 'Rec.2020 linear working data' : 'sRGB'} · Original preserved`
                : 'Loading the full-resolution image.')
            }
          >
            {full.error ? (
              <>
                <span>Full resolution unavailable</span>
                <button onClick={full.retry} aria-description={full.error}>
                  Retry
                </button>
              </>
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
    </section>
  )
}
