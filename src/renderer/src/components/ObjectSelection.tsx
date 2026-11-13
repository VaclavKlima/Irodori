import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { ObjectSelectionController } from '../hooks/useObjectSelection'
import type { PresentedPreviewGeometry, Size } from '../preview/geometry'
import { inspectionGeometryMatches } from '../preview/inspection-geometry'
import {
  selectionCanonicalBox,
  selectionCanonicalPoint,
  selectionDisplayPoint,
  selectionScreenPoint,
  type SelectionPoint,
  type SelectionRectangle,
} from '../preview/object-selection-geometry'
import { Button } from './ui/Controls'
import styles from './ObjectSelection.module.css'

export function ObjectSelectionControls({ selection }: { selection: ObjectSelectionController }) {
  const acceptance = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (selection.selection && selection.previewReady)
      acceptance.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selection.selection, selection.proposal?.id, selection.previewReady])
  if (!selection.active) return null
  const retry = () =>
    void (selection.context
      ? selection.generate()
      : selection.start(selection.target, selection.selection))
  return (
    <section
      className={styles.controls}
      aria-label={
        selection.selection === 'sky'
          ? 'Sky selection'
          : selection.selection === 'background'
            ? 'Background selection'
            : 'Object selection'
      }
      data-testid="object-selection-controls"
    >
      {!selection.selection && (
        <div className={styles.modes} role="group" aria-label="Selection guides">
          {(['box', 'add', 'subtract'] as const).map((mode) => (
            <Button
              key={mode}
              aria-pressed={selection.mode === mode}
              disabled={selection.busy || !selection.context}
              onClick={() => selection.pointMode(mode)}
            >
              {mode === 'box' ? 'Box' : mode === 'add' ? 'Include' : 'Exclude'}
            </Button>
          ))}
        </div>
      )}
      <p className={styles.hint}>
        {selection.busy
          ? selection.status === 'preparing'
            ? 'Preparing selection…'
            : selection.status === 'accepting'
              ? 'Applying mask…'
              : 'Creating selection…'
          : selection.dirty
            ? 'Guides changed. Refine to update the proposal.'
            : selection.proposal
              ? 'Review the coverage before using this mask. Paint/Erase can correct it afterward.'
              : selection.selection
                ? 'Create an automatic selection, then review its coverage before using the mask.'
                : 'Click the object or drag a box, then create a selection. The box guides selection; coverage can extend outside it.'}
      </p>
      {!selection.selection && (
        <div className={styles.guideActions}>
          <span>{selection.points.length}/4 points</span>
          <Button
            variant="quiet"
            disabled={selection.busy || !selection.points.length}
            onClick={selection.removeLast}
          >
            Remove last point
          </Button>
          <Button
            variant="quiet"
            disabled={selection.busy || (!selection.rectangle && !selection.points.length)}
            onClick={selection.clear}
          >
            Clear
          </Button>
        </div>
      )}
      <div className={styles.actions}>
        {!selection.busy && (
          <Button
            variant={!selection.proposal || selection.dirty ? 'primary' : 'secondary'}
            disabled={!selection.canGenerate}
            onClick={() => void selection.generate()}
          >
            {selection.proposal ? 'Update selection' : 'Create selection'}
          </Button>
        )}
        {selection.proposal && (
          <Button
            ref={acceptance}
            variant={!selection.dirty ? 'primary' : 'secondary'}
            disabled={!selection.canAccept}
            onClick={() => void selection.accept()}
          >
            Use mask
          </Button>
        )}
        {selection.busy && selection.status !== 'accepting' && (
          <Button onClick={selection.cancelJob}>Cancel processing</Button>
        )}
        <Button
          variant="quiet"
          disabled={selection.status === 'accepting'}
          onClick={selection.close}
        >
          Cancel selection
        </Button>
      </div>
      {selection.error && (
        <div role="alert" className={styles.error}>
          <span>{selection.error}</span>
          <Button disabled={selection.busy} onClick={retry}>
            Retry selection
          </Button>
        </div>
      )}
      {!selection.context && !selection.busy && !selection.error && (
        <Button onClick={() => void selection.start(selection.target, selection.selection)}>
          Start again
        </Button>
      )}
      <p className={styles.hint}>
        {selection.selection === 'sky'
          ? 'Check small sky openings, fine leaves and bright skyline edges at 100%.'
          : 'Fine hair, feathers and transparent edges may need manual correction.'}
      </p>
    </section>
  )
}

interface Gesture {
  pointer: number
  start: SelectionPoint
  latest: SelectionPoint
  client: SelectionPoint
  geometry: PresentedPreviewGeometry
  mode: 'box' | 'add' | 'subtract'
}

export function ObjectSelectionOverlay({
  selection,
  geometry,
  viewport,
  readGeometry,
}: {
  selection: ObjectSelectionController
  geometry: PresentedPreviewGeometry | undefined
  viewport: Size
  readGeometry: () => PresentedPreviewGeometry | undefined
}) {
  const element = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [draft, setDraft] = useState<SelectionRectangle | null>(null)
  const [cursor, setCursor] = useState<SelectionPoint | null>(null)
  const anchor = useRef<SelectionPoint | null>(null)
  const context = selection.context
  const matching = (presented: PresentedPreviewGeometry | undefined) =>
    !!context &&
    !!presented &&
    context.width === presented.image.width &&
    context.height === presented.image.height &&
    inspectionGeometryMatches(context.geometry, presented.maskGeometry)
  const cancel = useCallback(() => {
    const value = gesture.current
    gesture.current = null
    anchor.current = null
    setDraft(null)
    if (value && element.current?.hasPointerCapture(value.pointer))
      element.current.releasePointerCapture(value.pointer)
  }, [])
  useEffect(() => {
    const root = element.current
    const remove = window.irodori.onWindowBlur(cancel)
    return () => {
      remove()
      const value = gesture.current
      gesture.current = null
      if (value && root?.hasPointerCapture(value.pointer)) root.releasePointerCapture(value.pointer)
    }
  }, [cancel])
  const map = (
    event: PointerEvent<HTMLDivElement>,
    presented: PresentedPreviewGeometry,
    clamp = false,
  ) => {
    const box = event.currentTarget.getBoundingClientRect()
    return selectionDisplayPoint(
      { x: event.clientX - box.left, y: event.clientY - box.top },
      presented,
      { width: box.width, height: box.height },
      clamp,
    )
  }
  const place = (
    point: SelectionPoint,
    mode: 'add' | 'subtract',
    presented: PresentedPreviewGeometry,
  ) => {
    if (!presented.maskGeometry) return
    const canonical = selectionCanonicalPoint(point, presented.maskGeometry)
    if (canonical) selection.addPoint(canonical, point, mode)
    else selection.setError('Choose a point inside the prepared photograph.')
  }
  const box = (start: SelectionPoint, end: SelectionPoint, presented: PresentedPreviewGeometry) => {
    if (!presented.maskGeometry) return
    const mapped = selectionCanonicalBox(start, end, presented.maskGeometry)
    if (mapped) selection.setBox(mapped.rectangle, mapped.box)
    else selection.setError('Draw a larger box inside the prepared photograph.')
  }
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || selection.busy) return
    event.preventDefault()
    event.stopPropagation()
    const presented = readGeometry()
    if (!matching(presented) || !presented) return
    const point = map(event, presented)
    if (!point) return
    element.current?.focus({ preventScroll: true })
    gesture.current = {
      pointer: event.pointerId,
      start: point,
      latest: point,
      client: { x: event.clientX, y: event.clientY },
      geometry: presented,
      mode: selection.mode,
    }
    setCursor(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const value = gesture.current
    if (!value || value.pointer !== event.pointerId) return
    event.stopPropagation()
    const presented = readGeometry()
    if (
      !matching(presented) ||
      !presented ||
      value.geometry.sourceIdentity !== presented.sourceIdentity
    )
      return cancel()
    const point = map(event, presented, true)
    if (!point) return cancel()
    value.latest = point
    setCursor(point)
    if (value.mode === 'box')
      setDraft({
        x: Math.min(value.start.x, point.x),
        y: Math.min(value.start.y, point.y),
        width: Math.abs(value.start.x - point.x),
        height: Math.abs(value.start.y - point.y),
      })
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const value = gesture.current
    if (!value || value.pointer !== event.pointerId) return
    event.stopPropagation()
    const presented = readGeometry()
    if (
      matching(presented) &&
      presented &&
      value.geometry.sourceIdentity === presented.sourceIdentity
    ) {
      const point = map(event, presented, true) ?? value.latest
      if (
        value.mode === 'box' &&
        Math.hypot(event.clientX - value.client.x, event.clientY - value.client.y) >= 3
      )
        box(value.start, point, presented)
      else place(point, value.mode === 'subtract' ? 'subtract' : 'add', presented)
    }
    cancel()
  }
  const visible = matching(geometry) && geometry
  const rectangle = draft ?? selection.rectangle
  const first = visible && rectangle && selectionScreenPoint(rectangle, visible, viewport)
  const last =
    visible &&
    rectangle &&
    selectionScreenPoint(
      { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height },
      visible,
      viewport,
    )
  const keyboardCursor = visible && cursor && selectionScreenPoint(cursor, visible, viewport)
  return (
    <div
      ref={element}
      className={styles.overlay}
      tabIndex={0}
      role="group"
      aria-label="Object selection guides"
      aria-description="Click an object or drag a box. Arrow keys move the guide; Enter places a point or starts and finishes a box. Escape cancels unfinished input."
      data-testid="object-selection-overlay"
      data-matching-grid={!!visible}
      data-selection-mode={selection.mode}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={(event) => {
        event.stopPropagation()
        cancel()
      }}
      onLostPointerCapture={(event) => {
        event.stopPropagation()
        cancel()
      }}
      onBlur={cancel}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (selection.status === 'accepting') return
          if (gesture.current || anchor.current) cancel()
          else selection.close()
          return
        }
        if (selection.busy || event.ctrlKey || event.metaKey || event.altKey) return
        const presented = readGeometry()
        if (!matching(presented) || !presented) return
        const point = cursor ?? { x: presented.image.width / 2, y: presented.image.height / 2 }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          if (event.repeat) return
          if (selection.mode === 'box') {
            if (anchor.current) {
              box(anchor.current, point, presented)
              cancel()
            } else {
              anchor.current = point
              setCursor(point)
              setDraft({ ...point, width: 0, height: 0 })
            }
          } else place(point, selection.mode, presented)
          return
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const amount = event.shiftKey ? 10 : 1
        const next = {
          x: Math.max(
            0.5,
            Math.min(
              presented.image.width - 0.5,
              point.x +
                (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0),
            ),
          ),
          y: Math.max(
            0.5,
            Math.min(
              presented.image.height - 0.5,
              point.y +
                (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0),
            ),
          ),
        }
        setCursor(next)
        if (anchor.current)
          setDraft({
            x: Math.min(anchor.current.x, next.x),
            y: Math.min(anchor.current.y, next.y),
            width: Math.abs(next.x - anchor.current.x),
            height: Math.abs(next.y - anchor.current.y),
          })
      }}
    >
      {first && last && (
        <div
          className={styles.rectangle}
          data-testid="object-selection-box"
          style={{ left: first.x, top: first.y, width: last.x - first.x, height: last.y - first.y }}
        />
      )}
      {visible &&
        selection.points.map((point, index) => {
          const position = selectionScreenPoint(point.display, visible, viewport)
          return (
            <span
              key={index}
              className={`${styles.point} ${point.mode === 'subtract' ? styles.subtract : ''}`}
              aria-label={`${point.mode === 'add' ? 'Include' : 'Exclude'} point ${index + 1}`}
              style={{ left: position.x, top: position.y }}
            >
              {point.mode === 'add' ? '+' : '−'}
            </span>
          )
        })}
      {keyboardCursor && (
        <span
          className={styles.cursor}
          aria-hidden="true"
          style={{ left: keyboardCursor.x, top: keyboardCursor.y }}
        />
      )}
      {!visible && <span className={styles.waiting}>Waiting for the matching photograph…</span>}
    </div>
  )
}
