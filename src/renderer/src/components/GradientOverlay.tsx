import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from 'react'
import { maskCanonicalPoint, maskOutputPoint } from '../../../shared/mask-geometry'
import { validateMaskGradient, type MaskGradient, type MaskPoint } from '../../../shared/masks'
import type { PresentedPreviewGeometry, Size } from '../preview/geometry'
import { selectionScreenPoint } from '../preview/object-selection-geometry'
import {
  centeredGradient,
  gradientFromDrag,
  gradientGuide,
  gradientHandlePoint,
  moveGradientHandle,
  type GradientHandle,
} from '../preview/gradient-geometry'
import type { MasksController } from '../hooks/useMasks'
import { Button } from './ui/Controls'
import styles from './GradientOverlay.module.css'

type Gesture = {
  pointer?: number
  handle?: GradientHandle
  origin: MaskPoint
  gradient?: MaskGradient
  key: string
  target?: HTMLElement
  moved?: boolean
}
export function GradientOverlay({
  masks,
  geometry,
  viewport,
  readGeometry,
}: {
  masks: MasksController
  geometry: PresentedPreviewGeometry
  viewport: Size
  readGeometry: () => PresentedPreviewGeometry | undefined
}) {
  const [creation, setCreation] = useState<MaskGradient>()
  const gesture = useRef<Gesture | null>(null)
  const current = useRef(masks)
  useLayoutEffect(() => {
    current.current = masks
  })
  const mapping = JSON.stringify([
    geometry.maskGeometry,
    geometry.view,
    geometry.viewport,
    geometry.image,
  ])
  const key = `${masks.resetKey}:${mapping}`
  const geo = geometry.maskGeometry!,
    w = geo.canonicalWidth,
    h = geo.canonicalHeight
  const g = (masks.creatingGradient ? creation : undefined) ?? masks.gradientValues
  const active = !!masks.creatingGradient || masks.editingGradient
  const cancel = () => {
    const value = gesture.current
    gesture.current = null
    setCreation(undefined)
    current.current.cancel()
    if (value?.pointer !== undefined && value.target?.hasPointerCapture(value.pointer))
      value.target.releasePointerCapture(value.pointer)
  }
  useEffect(() => {
    if (gesture.current && (!active || gesture.current.key !== key)) cancel()
  }, [key, active]) // Geometry or mode changes cancel before stale coordinates can be published.
  useEffect(() => {
    const off = window.irodori.onWindowBlur(cancel)
    const escape = (e: globalThis.KeyboardEvent) => {
      if (
        (e.key === 'Escape' && active) ||
        (gesture.current && (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase()))
      ) {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      off()
      window.removeEventListener('keydown', escape, true)
    }
  }, [active])
  useEffect(
    () => () => {
      const value = gesture.current
      gesture.current = null
      if (value) current.current.cancel()
      if (value?.pointer !== undefined && value.target?.hasPointerCapture(value.pointer))
        value.target.releasePointerCapture(value.pointer)
    },
    [],
  )
  if (!active) return null
  const point = (event: PointerEvent<HTMLElement>, inside = false): MaskPoint | null => {
    const submitted = readGeometry()
    if (
      !submitted?.maskGeometry ||
      JSON.stringify([
        submitted.maskGeometry,
        submitted.view,
        submitted.viewport,
        submitted.image,
      ]) !== mapping
    )
      return null
    const box = event.currentTarget
        .closest('[data-testid="preview-viewport"]')!
        .getBoundingClientRect(),
      v = geometry.view
    const x =
      (((event.clientX - box.left) * geometry.viewport.width) / box.width -
        geometry.viewport.width / 2 -
        v.x) /
        v.scale +
      geometry.image.width / 2
    const y =
      (((event.clientY - box.top) * geometry.viewport.height) / box.height -
        geometry.viewport.height / 2 -
        v.y) /
        v.scale +
      geometry.image.height / 2
    if (inside && (x < 0 || y < 0 || x > geometry.image.width || y > geometry.image.height))
      return null
    const p = maskCanonicalPoint({ x, y }, geo)
    return [p.x, p.y].every((n) => Number.isFinite(n) && n >= -1 && n <= 2) ? p : null
  }
  const preview = (next: MaskGradient) => {
    try {
      validateMaskGradient(next, w, h)
      return masks.previewGradient(next)
    } catch {
      return false
    }
  }
  const down = (event: PointerEvent<HTMLElement>, handle?: GradientHandle) => {
    if (event.button !== 0 || !event.isPrimary || !masks.available) return
    const origin = point(event, !handle)
    if (!origin) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    gesture.current = {
      pointer: event.pointerId,
      origin,
      gradient: g,
      handle,
      key,
      target: event.currentTarget,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const v = gesture.current
    if (!v || v.pointer !== event.pointerId) return
    event.stopPropagation()
    const p = point(event)
    if (!p) {
      cancel()
      return
    }
    if (Math.hypot(p.x - v.origin.x, p.y - v.origin.y) > 1e-12) v.moved = true
    if (v.handle && v.gradient) preview(moveGradientHandle(v.gradient, v.handle, v.origin, p, w, h))
    else if (masks.creatingGradient) {
      const next = gradientFromDrag(masks.creatingGradient, v.origin, p)
      setCreation(next)
      masks.previewCreatedGradient(next)
    }
  }
  const finish = (event: PointerEvent<HTMLElement>) => {
    const v = gesture.current
    if (!v || v.pointer !== event.pointerId) return
    const p = point(event)
    event.stopPropagation()
    if (v.key !== key || !p) {
      cancel()
      return
    }
    if (v.handle && v.gradient) {
      const moved = Math.hypot(p.x - v.origin.x, p.y - v.origin.y) > 1e-12
      if (
        (v.moved || moved) &&
        !preview(moved ? moveGradientHandle(v.gradient, v.handle, v.origin, p, w, h) : v.gradient)
      ) {
        cancel()
        return
      }
      gesture.current = null
      masks.finishGradient()
    } else if (masks.creatingGradient) {
      gesture.current = null
      const next = gradientFromDrag(masks.creatingGradient, v.origin, p)
      setCreation(undefined)
      try {
        validateMaskGradient(next, w, h)
        void masks.createGradient(next).catch(() => undefined)
      } catch {
        setCreation(undefined)
      }
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const screen = (p: MaskPoint) => selectionScreenPoint(p, geometry, viewport)
  const lines = g ? gradientGuide(g, geo) : []
  const handles: GradientHandle[] =
    g?.kind === 'linear' ? ['start', 'move', 'end'] : ['move', 'radiusX', 'radiusY', 'rotate']
  const projected = g
    ? handles.map((handle) => {
        const p = maskOutputPoint(gradientHandlePoint(g, handle, w, h), geo)
        return p ? { handle, p: screen(p) } : null
      })
    : []
  const reliable = lines !== null && projected.every(Boolean)
  const handleDown = (event: PointerEvent<HTMLButtonElement>) =>
    down(event, event.currentTarget.dataset.handle as GradientHandle)
  const handleBlur = () => {
    if (gesture.current) cancel()
  }
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const handle = e.currentTarget.dataset.handle as GradientHandle
    if (!g || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    const v = gesture.current
    // A cancelled or blurred key gesture stays cancelled until the held arrow is released.
    if (e.repeat && !v) return
    const before = v?.gradient ?? g,
      origin = gradientHandlePoint(before, handle, w, h),
      step = e.shiftKey ? 10 : 1
    if (!v) gesture.current = { origin, gradient: before, handle: handle, key }
    const next = {
      x: origin.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) / w,
      y: origin.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) / h,
    }
    const updated = moveGradientHandle(before, handle, origin, next, w, h)
    if (preview(updated)) gesture.current = { ...gesture.current!, gradient: updated }
  }
  const handleKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key.startsWith('Arrow') && gesture.current && gesture.current.pointer === undefined) {
      e.preventDefault()
      e.stopPropagation()
      gesture.current = null
      masks.finishGradient()
    }
  }
  return (
    <div
      className={`${styles.layer} ${masks.creatingGradient ? styles.drawing : ''}`}
      data-testid="gradient-overlay"
      tabIndex={masks.creatingGradient ? 0 : undefined}
      aria-label="Draw gradient"
      onPointerDown={(e) => {
        if (masks.creatingGradient) down(e)
      }}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onBlur={() => {
        if (gesture.current) cancel()
      }}
      onLostPointerCapture={() => {
        if (gesture.current?.pointer !== undefined) cancel()
      }}
    >
      {reliable && g && (
        <svg
          className={styles.guides}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          aria-hidden="true"
        >
          {lines?.map((line, i) => (
            <polyline
              key={i}
              className={styles.guide}
              points={line
                .map((p) => {
                  const s = screen(p)
                  return `${s.x},${s.y}`
                })
                .join(' ')}
            />
          ))}
        </svg>
      )}
      {reliable &&
        !masks.creatingGradient &&
        projected.map(
          (item) =>
            item && (
              <button
                key={item.handle}
                className={styles.handle}
                aria-label={`Gradient ${item.handle} handle`}
                style={{ left: item.p.x, top: item.p.y }}
                disabled={!masks.available}
                data-handle={item.handle}
                onPointerDown={handleDown}
                onPointerMove={move}
                onPointerUp={finish}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
              />
            ),
        )}
      {masks.creatingGradient && (
        <div className={styles.toolbar} onPointerDown={(e) => e.stopPropagation()}>
          <span>Drag to draw {masks.creatingGradient} gradient</span>
          <Button
            disabled={!masks.available}
            onClick={() =>
              void masks
                .createGradient(centeredGradient(masks.creatingGradient!, geo))
                .catch(() => undefined)
            }
          >
            Place centered
          </Button>
          <Button onClick={cancel}>Cancel</Button>
        </div>
      )}
      {!reliable && (
        <div className={styles.toolbar} role="status">
          Gradient handles cannot be projected reliably for this geometry. Use numeric Geometry
          controls.
        </div>
      )}
    </div>
  )
}
