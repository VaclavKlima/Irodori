import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type MouseEvent } from 'react'
import type { CropController } from '../hooks/useCrop'
import { moveCrop, resizeCrop, type CropCorner } from '../../../shared/crop-authoring'
import type { CropPoint, CropSettings, CropSize } from '../../../shared/crop'
import type { View, Size } from '../preview/geometry'
import styles from './CropOverlay.module.css'

type CaptureElement = HTMLElement | SVGPolygonElement
interface Drag {
  element: CaptureElement
  pointerId: number
  corner: CropCorner | null
  draft: CropSettings
  source: CropSize
  start: CropPoint
  handle: CropPoint
}
const labels = ['Top left', 'Top right', 'Bottom right', 'Bottom left']
const interpolate = (a: CropPoint, b: CropPoint, amount: number): CropPoint => ({
  x: a.x + (b.x - a.x) * amount,
  y: a.y + (b.y - a.y) * amount,
})

/** Only a matching uncropped native frame may host this transient overlay. */
export function CropOverlay({
  crop,
  viewport,
  view,
}: {
  crop: CropController
  viewport: Size
  view: View
}) {
  const element = useRef<HTMLDivElement>(null),
    drag = useRef<Drag | null>(null)
  const context = crop.context
  useEffect(
    () => () => {
      const value = drag.current
      drag.current = null
      if (value?.element.hasPointerCapture(value.pointerId))
        value.element.releasePointerCapture(value.pointerId)
    },
    [context],
  )
  const geometry = crop.geometry,
    draft = crop.draft
  if (!crop.active || !context || !geometry || !draft || view.scale <= 0) return null
  const project = (point: CropPoint) => ({
      x: viewport.width / 2 + view.x + (point.x - context.source.width / 2) * view.scale,
      y: viewport.height / 2 + view.y + (point.y - context.source.height / 2) * view.scale,
    }),
    corners = geometry.corners.map(project),
    disabled = crop.pending || crop.stale
  const sourcePoint = (x: number, y: number): CropPoint => {
    const box = element.current!.getBoundingClientRect()
    return {
      x: (x - box.left - viewport.width / 2 - view.x) / view.scale + context.source.width / 2,
      y: (y - box.top - viewport.height / 2 - view.y) / view.scale + context.source.height / 2,
    }
  }
  const start = (event: PointerEvent<CaptureElement>, corner: CropCorner | null) => {
    event.stopPropagation()
    if (disabled || event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const point = sourcePoint(event.clientX, event.clientY)
    event.currentTarget.setPointerCapture(event.pointerId)
    crop.beginGesture()
    drag.current = {
      element: event.currentTarget,
      pointerId: event.pointerId,
      corner,
      draft,
      source: context.source,
      start: point,
      handle: corner === null ? point : geometry.corners[corner],
    }
  }
  const finish = (cancelled: boolean) => {
    const value = drag.current
    if (!value) return
    drag.current = null
    if (cancelled) crop.cancelGesture()
    else crop.commitGesture()
    if (value.element.hasPointerCapture(value.pointerId))
      value.element.releasePointerCapture(value.pointerId)
  }
  const move = (event: PointerEvent<CaptureElement>) => {
    event.stopPropagation()
    const value = drag.current
    if (!value || value.pointerId !== event.pointerId) return
    if (disabled) {
      finish(true)
      return
    }
    const point = sourcePoint(event.clientX, event.clientY),
      delta = { x: point.x - value.start.x, y: point.y - value.start.y }
    crop.editDraft(() =>
      value.corner === null
        ? moveCrop(value.source, value.draft, delta)
        : resizeCrop(value.source, value.draft, value.corner, {
            x: value.handle.x + delta.x,
            y: value.handle.y + delta.y,
          }),
    )
  }
  const key = (event: KeyboardEvent<CaptureElement>, corner: CropCorner | null) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (drag.current) finish(true)
      else crop.cancel()
      return
    }
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const amount = event.shiftKey ? 10 : 1,
      delta = {
        x: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
        y: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0,
      }
    crop.beginGesture()
    crop.editDraft(() =>
      corner === null
        ? moveCrop(context.source, draft, delta)
        : resizeCrop(context.source, draft, corner, {
            x: geometry.corners[corner].x + delta.x,
            y: geometry.corners[corner].y + delta.y,
          }),
    )
    crop.commitGesture()
  }
  const events = {
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<CaptureElement>) => {
      event.stopPropagation()
      finish(false)
    },
    onPointerCancel: (event: PointerEvent<CaptureElement>) => {
      event.stopPropagation()
      finish(true)
    },
    onLostPointerCapture: () => finish(true),
    onBlur: () => finish(true),
    onDoubleClick: (event: MouseEvent<CaptureElement>) => event.stopPropagation(),
  }
  const polygon = corners.map(({ x, y }) => `${x},${y}`).join(' ')
  return (
    <div ref={element} className={styles.overlay} data-testid="crop-overlay">
      <svg width={viewport.width} height={viewport.height} aria-label="Crop framing">
        <path
          d={`M0,0 H${viewport.width} V${viewport.height} H0 Z M${corners.map(({ x, y }) => `${x},${y}`).join(' L')} Z`}
          fillRule="evenodd"
          className={styles.shade}
        />
        <polygon
          points={polygon}
          className={styles.frame}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label="Move crop frame"
          aria-disabled={disabled}
          aria-describedby="crop-instructions"
          onPointerDown={(event) => start(event, null)}
          onKeyDown={(event) => key(event, null)}
          {...events}
        />
        {[1 / 3, 2 / 3].map((amount) =>
          [
            [
              interpolate(corners[0], corners[1], amount),
              interpolate(corners[3], corners[2], amount),
            ],
            [
              interpolate(corners[0], corners[3], amount),
              interpolate(corners[1], corners[2], amount),
            ],
          ].map(([a, b], index) => (
            <line
              key={`${amount}-${index}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={styles.grid}
            />
          )),
        )}
      </svg>
      {corners.map((point, index) => (
        <button
          key={index}
          type="button"
          className={styles.handle}
          style={{
            left: Math.max(8, Math.min(viewport.width - 8, point.x)),
            top: Math.max(8, Math.min(viewport.height - 8, point.y)),
          }}
          aria-label={`${labels[index]} crop corner`}
          aria-describedby="crop-instructions"
          disabled={disabled}
          onPointerDown={(event) => start(event, index as CropCorner)}
          onKeyDown={(event) => key(event, index as CropCorner)}
          {...events}
        />
      ))}
    </div>
  )
}
