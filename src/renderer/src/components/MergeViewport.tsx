import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import type { MergePreview } from '../../../shared/merge'
import {
  constrain,
  INITIAL_VIEW,
  minimumScale,
  replaceDimensions,
  stepScale,
  zoomAt,
  ZOOM_STOPS,
  type Size,
  type View,
} from '../preview/geometry'
import styles from './MergeViewport.module.css'
import { MergePresenter } from '../preview/merge-presenter'
import { usePanDrag } from '../hooks/usePanDrag'
import { usePreviewFrame } from '../hooks/usePreviewFrame'
import { usePreviewWheel } from '../hooks/usePreviewWheel'

interface Model {
  image: Size
  viewport: Size
  view: View
}

export function MergeViewport({
  preview,
  busy,
  comparison,
  overlay,
  onComparison,
  onReady,
  onError,
}: {
  preview: MergePreview | null
  busy: boolean
  comparison: boolean
  overlay: boolean
  onComparison: () => void
  onReady: (preview: MergePreview | null) => void
  onError: (message: string) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const presenter = useRef<MergePresenter | null>(null)
  const [fallback, setFallback] = useState(false)
  const [model, setModel] = useState<Model>({
    image: { width: 0, height: 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model),
    reviewId = useRef('')
  const [decoded, setDecoded] = useState<{ preview: MergePreview; fallback: boolean } | null>(null),
    [failed, setFailed] = useState<MergePreview | null>(null)
  const ready =
    !!preview &&
    decoded?.preview === preview &&
    decoded.fallback === fallback &&
    failed !== preview &&
    !busy
  const { schedule, cancel } = usePreviewFrame(() => {
    const model = current.current
    setModel(model)
    if (ready) presenter.current?.draw(model.image, model.viewport, model.view, comparison, overlay)
  })
  useEffect(() => {
    schedule()
  }, [comparison, overlay, ready, schedule])
  const change = useCallback(
    (action: (model: Model) => Model, immediate = true) => {
      const next = action(current.current)
      if (next === current.current) return
      next.view = constrain(next.view, next.image, next.viewport)
      current.current = next
      if (immediate) setModel(next)
      schedule()
    },
    [schedule],
  )
  const panBy = useCallback(
    (x: number, y: number) => {
      change(
        (model) => ({
          ...model,
          view: { ...model.view, x: model.view.x + x, y: model.view.y + y },
        }),
        false,
      )
    },
    [change],
  )
  const pan = usePanDrag(viewport, panBy)
  const { dragging, dragged, stop: stopDrag } = pan
  usePreviewWheel(viewport, ready, change, stopDrag)

  useEffect(() => {
    stopDrag()
    cancel()
    onReady(null)
    if (!preview || busy) return
    let active = true
    const images = [preview.resultUrl, preview.referenceUrl, preview.overlayUrl].map((url) => {
      const image = new Image()
      image.src = url
      return image
    })
    void Promise.all(images.map((image) => image.decode())).then(
      () => {
        if (!active) return
        if (
          !Number.isSafeInteger(preview.width) ||
          !Number.isSafeInteger(preview.height) ||
          preview.width < 1 ||
          preview.height < 1 ||
          images.some(
            (image) =>
              image.naturalWidth !== preview.width || image.naturalHeight !== preview.height,
          )
        ) {
          setFailed(preview)
          onError('Merge preview dimensions do not match the native image.')
          return
        }
        change((model) => {
          const image = { width: images[0].naturalWidth, height: images[0].naturalHeight }
          const view =
            reviewId.current === preview.reviewId
              ? replaceDimensions(model.view, model.image, image, model.viewport)
              : INITIAL_VIEW
          reviewId.current = preview.reviewId
          return { ...model, image, view }
        })
        try {
          const renderer = new MergePresenter(canvas.current!, images, fallback, () =>
            setFallback(true),
          )
          presenter.current = renderer
        } catch {
          if (!fallback) setFallback(true)
          else {
            setFailed(preview)
            onError('Could not display the native merge preview. Retry to prepare it again.')
          }
          return
        }
        setDecoded({ preview, fallback })
        onReady(preview)
      },
      () => {
        if (active) {
          setFailed(preview)
          onError('Could not load the native merge preview. Retry to prepare it again.')
        }
      },
    )
    return () => {
      active = false
      cancel()
      presenter.current?.dispose()
      presenter.current = null
      for (const image of images) image.src = ''
    }
  }, [preview, busy, change, cancel, stopDrag, onReady, onError, fallback])

  useEffect(() => {
    const element = viewport.current!
    const observer = new ResizeObserver(([entry]) => {
      stopDrag()
      change(
        (model) => ({
          ...model,
          viewport: { width: entry.contentRect.width, height: entry.contentRect.height },
        }),
        false,
      )
    })
    observer.observe(element)
    window.addEventListener('blur', stopDrag)
    return () => {
      stopDrag()
      observer.disconnect()
      window.removeEventListener('blur', stopDrag)
    }
  }, [change, stopDrag])

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
    const model = current.current
    zoom(stepScale(model.view.scale, direction, minimumScale(model.image, model.viewport)))
  }
  function keyDown(event: KeyboardEvent) {
    if (
      !ready ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.target as HTMLElement).closest(
        'select, input, textarea, [contenteditable], [role="menu"]',
      )
    )
      return
    if (event.key === '+' || event.key === '=') step(1)
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
  const { view } = model
  const pannable =
    model.image.width * view.scale > model.viewport.width + 0.5 ||
    model.image.height * view.scale > model.viewport.height + 0.5
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !ready) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    pan.reset()
    if (!pannable) return
    pan.start(event.nativeEvent)
  }
  const preset = ZOOM_STOPS.find((stop) => Math.abs(stop - view.scale) < 0.00001)
  return (
    <section
      className={styles.preview}
      aria-label="Merge preview"
      aria-busy={!ready}
      onKeyDown={keyDown}
    >
      <div className={styles.toolbar}>
        <button aria-pressed={comparison} disabled={!ready} onClick={onComparison}>
          Show {comparison ? 'merged result' : 'prepared reference'}
        </button>
        <div
          className={styles.zoomControls}
          title="100% shows one native image pixel per CSS pixel."
        >
          <button
            aria-label="Zoom out"
            disabled={!ready || view.scale <= minimumScale(model.image, model.viewport) + 0.00001}
            onClick={() => step(-1)}
          >
            <Minus size={13} />
          </button>
          <select
            aria-label="Merge preview zoom"
            disabled={!ready}
            value={view.fit ? 'fit' : preset === undefined ? 'custom' : String(preset)}
            onChange={(event) =>
              event.target.value === 'fit' ? fit() : zoom(Number(event.target.value))
            }
          >
            <option value="fit">Fit</option>
            {!view.fit && preset === undefined && (
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
            aria-label="Fit merge preview"
            aria-pressed={view.fit}
            disabled={!ready}
            onClick={fit}
          >
            <Maximize size={13} />
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className={`${styles.viewport} ${ready && pannable ? styles.pannable : ''} ${dragging && ready ? styles.dragging : ''}`}
        tabIndex={0}
        role="img"
        aria-label="Merge review image"
        data-testid="merge-viewport"
        data-ready={ready}
        data-scale={view.scale}
        data-pan-x={view.x}
        data-pan-y={view.y}
        data-fit={view.fit}
        data-dragging={dragging && ready}
        onPointerDown={pointerDown}
        onPointerMove={(event) => pan.move(event.nativeEvent)}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={pan.lostCapture}
        onDoubleClick={(event) => {
          if (!ready || dragged.current) return
          if (view.fit) {
            const box = event.currentTarget.getBoundingClientRect()
            zoom(1, {
              x: event.clientX - box.left - box.width / 2,
              y: event.clientY - box.top - box.height / 2,
            })
          } else fit()
        }}
      >
        <canvas
          key={String(fallback)}
          ref={canvas}
          className={styles.canvas}
          hidden={!ready}
          role="img"
          aria-label={
            comparison
              ? 'Prepared reference'
              : overlay
                ? 'Merged result with deghost overlay'
                : 'Merged result'
          }
          data-testid="merge-preview"
        />
        {!ready && (
          <p role="status" className={styles.status}>
            {failed === preview && preview
              ? 'Native preview unavailable.'
              : busy
                ? 'Preparing native merge…'
                : preview
                  ? 'Loading native detail…'
                  : 'Waiting for merge preview…'}
          </p>
        )}
      </div>
    </section>
  )
}
