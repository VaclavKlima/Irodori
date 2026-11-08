import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import type { InspectionRegionController, InspectionRectangle } from '../hooks/useInspectionRegion'
import {
  inspectionDrag,
  inspectionGeometryMatches,
  inspectionPoint,
  validInspectionRectangle,
  type RegionHandle,
  type RegionPoint,
} from '../preview/inspection-geometry'
import type { PresentedPreviewGeometry, Size } from '../preview/geometry'
import { Button } from './ui/Controls'
import styles from './InspectionRegion.module.css'

/** All drawing and hit testing share committed presentation geometry. */
export function InspectionRegion({
  inspection,
  geometry,
  viewport,
  onLocate,
}: {
  inspection: InspectionRegionController
  geometry?: PresentedPreviewGeometry
  viewport: Size
  onLocate: (region: InspectionRectangle) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    pointerId: number
    start: RegionPoint
    rectangle: InspectionRectangle
    handle: RegionHandle
    geometry: PresentedPreviewGeometry
  } | null>(null)
  const [draft, setDraft] = useState<InspectionRectangle>()
  const [cancellation, setCancellation] = useState(0)
  const close = inspection.close
  const cancel = useCallback(() => {
    const gesture = drag.current
    drag.current = null
    setDraft(undefined)
    setCancellation((value) => value + 1)
    if (gesture && root.current?.hasPointerCapture(gesture.pointerId))
      root.current.releasePointerCapture(gesture.pointerId)
  }, [])
  useEffect(() => {
    const element = root.current
    const remove = window.irodori.onWindowBlur(cancel)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (drag.current) cancel()
      else close()
    }
    window.addEventListener('keydown', escape)
    return () => {
      remove()
      window.removeEventListener('keydown', escape)
      const gesture = drag.current
      drag.current = null
      if (gesture && element?.hasPointerCapture(gesture.pointerId))
        element.releasePointerCapture(gesture.pointerId)
    }
  }, [cancel, close])
  const context = inspection.context
  if (!context) return null
  const matching =
    geometry &&
    geometry.image.width === context.width &&
    geometry.image.height === context.height &&
    (!context.geometry || inspectionGeometryMatches(geometry.maskGeometry, context.geometry))
  const selected = inspection.pending?.region
  const rectangle = draft ?? selected
  const initial: InspectionRectangle = selected ?? {
    units: 'pixels',
    gridIdentity: context.gridIdentity,
    x: 0,
    y: 0,
    width: Math.min(256, context.width),
    height: Math.min(256, context.height),
  }
  const point = (event: PointerEvent, committed: PresentedPreviewGeometry) => {
    const box = root.current!.getBoundingClientRect()
    return inspectionPoint(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      committed,
      viewport,
    )
  }
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || !matching || !geometry) return
    event.preventDefault()
    event.stopPropagation()
    root.current?.focus({ preventScroll: true })
    const start = point(event, geometry)
    const handle = (event.target as HTMLElement).dataset.regionHandle as RegionHandle | undefined
    drag.current = {
      pointerId: event.pointerId,
      start,
      rectangle: initial,
      handle: handle ?? 'create',
      geometry,
    }
    setDraft(handle ? initial : inspectionDrag(start, start, initial, 'create', context))
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.stopPropagation()
    // A new source grid invalidates the gesture; view updates still use the visible committed grid.
    if (!matching || geometry?.sourceIdentity !== gesture.geometry.sourceIdentity) {
      cancel()
      return
    }
    const next = inspectionDrag(
      gesture.start,
      point(event, geometry!),
      gesture.rectangle,
      gesture.handle,
      context,
    )
    setDraft(next)
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    const gesture = drag.current
    const next = inspectionDrag(
      gesture.start,
      point(event, geometry ?? gesture.geometry),
      gesture.rectangle,
      gesture.handle,
      context,
    )
    if (matching && validInspectionRectangle(next, context)) inspection.commit(next)
    cancel()
  }
  const project = (x: number, y: number) =>
    geometry
      ? {
          x:
            ((geometry.viewport.width / 2 +
              geometry.view.x +
              (x - geometry.image.width / 2) * geometry.view.scale) *
              viewport.width) /
            geometry.viewport.width,
          y:
            ((geometry.viewport.height / 2 +
              geometry.view.y +
              (y - geometry.image.height / 2) * geometry.view.scale) *
              viewport.height) /
            geometry.viewport.height,
        }
      : { x: 0, y: 0 }
  const topLeft = rectangle && project(rectangle.x, rectangle.y)
  const bottomRight =
    rectangle && project(rectangle.x + rectangle.width, rectangle.y + rectangle.height)
  return (
    <>
      <div
        ref={root}
        tabIndex={0}
        className={styles.overlay}
        data-testid="inspection-region-overlay"
        aria-label="Select inspection region"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onBlur={cancel}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {rectangle && matching && topLeft && bottomRight && (
          <>
            <div
              className={styles.rectangle}
              data-testid="inspection-region-frame"
              data-region-handle="move"
              style={{
                left: topLeft.x,
                top: topLeft.y,
                width: bottomRight.x - topLeft.x,
                height: bottomRight.y - topLeft.y,
              }}
            />
            {(['nw', 'ne', 'se', 'sw'] as const).map((handle) => (
              <div
                key={handle}
                aria-hidden="true"
                data-region-handle={handle}
                className={styles.handle}
                style={{
                  left: handle.includes('w') ? topLeft.x : bottomRight.x,
                  top: handle.includes('n') ? topLeft.y : bottomRight.y,
                }}
              />
            ))}
          </>
        )}
      </div>
      <section
        className={styles.controls}
        aria-label="Inspection region"
        data-testid="inspection-region-controls"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className={styles.title}>
          <span>Inspect region</span>
          <Button variant="quiet" onClick={inspection.close}>
            Done
          </Button>
        </div>
        <div className={styles.fields}>
          {(['x', 'y', 'width', 'height'] as const).map((field) => (
            <RegionField
              key={field}
              field={field}
              value={initial[field]}
              cancellation={cancellation}
              disabled={!matching}
              onCommit={(value) => {
                const next = { ...initial, [field]: value }
                if (validInspectionRectangle(next, context)) inspection.commit(next)
              }}
            />
          ))}
        </div>
        <div className={styles.actions}>
          <Button disabled={!selected || !matching} onClick={() => selected && onLocate(selected)}>
            Locate at 100%
          </Button>
          <Button disabled={!selected} onClick={inspection.clear}>
            Clear
          </Button>
          <span>
            {matching
              ? 'Drag an area; next Console prompt uses it.'
              : 'Waiting for matching photograph…'}
          </span>
        </div>
      </section>
    </>
  )
}

function RegionField({
  field,
  value,
  disabled,
  onCommit,
  cancellation,
}: {
  field: 'x' | 'y' | 'width' | 'height'
  value: number
  disabled: boolean
  onCommit: (value: number) => void
  cancellation: number
}) {
  const [draft, setDraft] = useState<{ text: string; cancellation: number } | null>(null)
  const editing = draft?.cancellation === cancellation ? draft.text : null
  const label =
    field === 'x' || field === 'y' ? field.toUpperCase() : field[0].toUpperCase() + field.slice(1)
  const commit = () => {
    if (editing !== null && editing.trim() && Number.isSafeInteger(Number(editing)))
      onCommit(Number(editing))
    setDraft(null)
  }
  return (
    <label>
      {label}
      <input
        type="text"
        inputMode="numeric"
        aria-label={`Inspection ${label}`}
        value={editing ?? String(value)}
        disabled={disabled}
        onFocus={() => setDraft({ text: String(value), cancellation })}
        onChange={(event) => setDraft({ text: event.target.value, cancellation })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(null)
          }
        }}
      />
    </label>
  )
}
