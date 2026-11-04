import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import {
  compileToneCurve,
  curveChannels,
  evaluateToneCurve,
  identityToneCurves,
  type ToneCurve,
} from '../../../shared/tone-curves'
import {
  addCurvePoint,
  curveGraphPosition,
  curveGraphValue,
  moveCurvePoint,
  type CurveRange,
  type CurveView,
} from '../../../shared/curve-graph'
import type { ToneCurvesController } from '../hooks/useToneCurves'
import { AdjustmentInput } from './AdjustmentInput'
import { InspectorSection } from './InspectorSection'
import { Button } from './ui/Controls'
import styles from './ToneCurves.module.css'

const title = (value: string) => value[0].toUpperCase() + value.slice(1)
const plotStart = 20,
  plotSize = 220
export function ToneCurves({ curves: c }: { curves: ToneCurvesController }) {
  const id = useId(),
    graph = useRef<SVGSVGElement>(null)
  const pointer = useRef<{
    id: number
    range: CurveRange
    points: ToneCurve
    index: number
  } | null>(null)
  const keyboard = useRef(false)
  const [pointListOpen, setPointListOpen] = useState(false)
  const [rangeGesture, setRangeGesture] = useState<{ key: string; range: CurveRange } | null>(null)
  const disabled = !c.supported,
    blocked = disabled || c.busy || c.pending
  const point = c.points[c.selected]
  const stableRange = rangeGesture?.key === c.resetKey ? rangeGesture.range : c.range
  const freezeRange = () => setRangeGesture({ key: c.resetKey, range: { ...stableRange } })
  const position = (value: number) => plotStart + plotSize * curveGraphPosition(value, stableRange)
  const compiled = compileToneCurve(c.points)
  const path = Array.from({ length: 257 }, (_, i) => {
    const input = curveGraphValue(i / 256, stableRange)
    return `${i ? 'L' : 'M'}${plotStart + (plotSize * i) / 256},${256 - position(evaluateToneCurve(compiled, input))}`
  }).join(' ')
  const { setGraphPixels } = c
  useEffect(() => {
    const node = graph.current
    if (!node) return
    const resize = new ResizeObserver(() =>
      setGraphPixels((node.getBoundingClientRect().width * plotSize) / 256),
    )
    resize.observe(node)
    return () => resize.disconnect()
  }, [setGraphPixels])
  useEffect(
    () => () => {
      const g = pointer.current
      pointer.current = null
      keyboard.current = false
      if (g && graph.current?.hasPointerCapture(g.id)) graph.current.releasePointerCapture(g.id)
    },
    [c.resetKey],
  )
  const cancel = () => {
    setRangeGesture(null)
    const g = pointer.current
    pointer.current = null
    keyboard.current = false
    if (g && graph.current?.hasPointerCapture(g.id)) graph.current.releasePointerCapture(g.id)
    c.cancel()
  }
  const update = (next: ToneCurve) => {
    freezeRange()
    void c.change(next)
  }
  const coordinate = (event: PointerEvent<SVGSVGElement>, range: CurveRange) => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      input: Math.max(
        -16,
        Math.min(
          64,
          curveGraphValue(
            (((event.clientX - box.left) / box.width) * 256 - plotStart) / plotSize,
            range,
          ),
        ),
      ),
      output: Math.max(
        -16,
        Math.min(
          64,
          curveGraphValue(
            (256 - ((event.clientY - box.top) / box.height) * 256 - plotStart) / plotSize,
            range,
          ),
        ),
      ),
    }
  }
  const release = (event: PointerEvent<SVGSVGElement>) => {
    const g = pointer.current
    if (!g || g.id !== event.pointerId) return
    pointer.current = null
    setRangeGesture(null)
    if (event.currentTarget.hasPointerCapture(g.id)) event.currentTarget.releasePointerCapture(g.id)
    void c.commit()
  }
  const select = async (index: number) => {
    await c.commit()
    c.setSelected(index)
  }
  const remove = () => {
    if (blocked || c.points.length <= 2) return
    update(c.points.filter((_, i) => i !== c.selected))
    c.setSelected(Math.min(c.selected, c.points.length - 2))
    void c.commit()
  }
  return (
    <>
      <div className={styles.channels} role="group" aria-label="Curve channel">
        {curveChannels.map((channel) => (
          <Button
            key={channel}
            aria-pressed={c.channel === channel}
            disabled={c.busy}
            onClick={() => void c.switchChannel(channel)}
          >
            {title(channel)}
          </Button>
        ))}
      </div>
      <div className={styles.view}>
        <label htmlFor={`${id}-view`}>Graph view</label>
        <select
          id={`${id}-view`}
          value={c.view}
          disabled={rangeGesture?.key === c.resetKey || c.pending}
          onChange={(event) => c.setView(event.currentTarget.value as CurveView)}
        >
          <option value="standard">Standard</option>
          <option value="hdr">HDR</option>
          <option value="fit">Fit points</option>
        </select>
      </div>
      <svg
        ref={graph}
        className={styles.graph}
        viewBox="0 0 256 256"
        role="application"
        aria-label={`${title(c.channel)} curve graph`}
        aria-describedby={`${id}-help`}
        aria-disabled={blocked}
        tabIndex={disabled ? -1 : 0}
        data-testid="curve-graph"
        data-channel={c.channel}
        data-point-count={c.points.length}
        data-range-min={stableRange.min}
        data-range-max={stableRange.max}
        onPointerDown={(event) => {
          if (blocked || event.button !== 0 || !event.isPrimary || pointer.current) return
          event.preventDefault()
          event.currentTarget.focus()
          c.cancelTarget()
          const sample = coordinate(event, c.range),
            box = event.currentTarget.getBoundingClientRect()
          let index = -1,
            distance = 10
          c.points.forEach((p, i) => {
            const d =
              (Math.hypot(
                curveGraphPosition(p.input, c.range) - curveGraphPosition(sample.input, c.range),
                curveGraphPosition(p.output, c.range) - curveGraphPosition(sample.output, c.range),
              ) *
                box.width *
                plotSize) /
              256
            if (d < distance) {
              distance = d
              index = i
            }
          })
          let points = c.points
          if (index < 0) {
            try {
              const added = addCurvePoint(points, sample.input, sample.output)
              points = added.points
              index = added.index
              update(points)
            } catch (error) {
              c.setError(String(error))
              return
            }
          }
          c.setSelected(index)
          pointer.current = { id: event.pointerId, range: { ...c.range }, points, index }
          freezeRange()
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const g = pointer.current
          if (!g || event.pointerId !== g.id || blocked) return
          const next = moveCurvePoint(g.points, g.index, coordinate(event, g.range))
          g.points = next
          update(next)
        }}
        onPointerUp={release}
        onLostPointerCapture={release}
        onPointerCancel={(event) => {
          if (pointer.current?.id === event.pointerId) cancel()
        }}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (blocked) {
            if (
              [
                'Escape',
                'Delete',
                'Backspace',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                'ArrowLeft',
                'ArrowRight',
                'ArrowUp',
                'ArrowDown',
              ].includes(event.key)
            )
              event.preventDefault()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
            c.cancelTarget()
            return
          }
          if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            void select(
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? c.points.length - 1
                  : (c.selected + (event.key === 'PageDown' ? 1 : c.points.length - 1)) %
                    c.points.length,
            )
            return
          }
          if (['Delete', 'Backspace'].includes(event.key)) {
            event.preventDefault()
            remove()
            return
          }
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault()
          keyboard.current = true
          const step = event.shiftKey ? 0.01 : 0.0001
          update(
            moveCurvePoint(
              c.points,
              c.selected,
              event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                ? { input: point.input + (event.key === 'ArrowRight' ? step : -step) }
                : { output: point.output + (event.key === 'ArrowUp' ? step : -step) },
            ),
          )
        }}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') && keyboard.current) {
            keyboard.current = false
            setRangeGesture(null)
            void c.commit()
          }
        }}
        onBlur={() => {
          if (keyboard.current) {
            keyboard.current = false
            setRangeGesture(null)
            void c.commit()
          }
        }}
      >
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect x={plotStart} y={256 - plotStart - plotSize} width={plotSize} height={plotSize} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${id}-clip)`}>
          {[0, 0.18, 1, ...(c.view === 'hdr' ? [2, 4, 8, 16] : [])]
            .filter((value) => value >= stableRange.min && value <= stableRange.max)
            .map((value) => (
              <path
                key={value}
                className={styles.grid}
                d={`M${position(value)} 16V236M20 ${256 - position(value)}H240`}
              />
            ))}
          <path className={styles.identity} d="M20 236L240 16" />
          <path className={styles.curve} d={path} />
          {c.points.map((p, i) => (
            <circle
              key={i}
              className={styles.point}
              cx={position(p.input)}
              cy={256 - position(p.output)}
              r={i === c.selected ? 4.5 : 3}
              aria-label={`Point ${i + 1}: Input ${(p.input * 100).toFixed(2)}%, Output ${(p.output * 100).toFixed(2)}%`}
              aria-pressed={i === c.selected}
            />
          ))}
        </g>
        {[0, 1, ...(c.view === 'hdr' ? [2, 4, 8, 16] : [])]
          .filter((value) => value >= stableRange.min && value <= stableRange.max)
          .map((value) => (
            <text
              key={value}
              className={styles.tick}
              x={position(value)}
              y={250}
              textAnchor="middle"
            >
              {value > 1 ? `+${Math.log2(value)}` : value === 1 ? '100%' : '0'}
            </text>
          ))}
      </svg>
      <p className={styles.help}>
        Signed-log axes · 100% = reference white{c.view === 'hdr' ? ' · +1…+4 stops' : ''}. View
        changes do not change edits.
      </p>
      <div className={styles.numeric}>
        {(['input', 'output'] as const).map((key) => (
          <AdjustmentInput
            key={key}
            label={`Curve ${title(key)}`}
            value={point[key] * 100}
            min={
              key === 'input' && c.selected > 0
                ? (c.points[c.selected - 1].input + 0.0001) * 100
                : -1600
            }
            max={
              key === 'input' && c.selected + 1 < c.points.length
                ? (c.points[c.selected + 1].input - 0.0001) * 100
                : 6400
            }
            step={0.000001}
            precision={4}
            unit="%"
            slider={false}
            resetKey={`${c.numericResetKey}:${c.selected}`}
            disabled={disabled}
            busy={c.busy || c.pending}
            onChange={(value) =>
              update(moveCurvePoint(c.points, c.selected, { [key]: value / 100 }))
            }
            onCommit={() => {
              setRangeGesture(null)
              void c.commit()
            }}
            onCancel={cancel}
          />
        ))}
      </div>
      <div className={styles.actions}>
        <Button
          aria-pressed={c.active}
          disabled={disabled || c.busy}
          onClick={() => void c.toggleTarget()}
        >
          Target tones on photo
        </Button>
        <Button
          disabled={blocked}
          onClick={() => {
            c.cancelTarget()
            void c.change(identityToneCurves[c.channel]).then(() => c.commit())
            c.setSelected(0)
          }}
        >
          Reset {title(c.channel)} curve
        </Button>
      </div>
      <InspectorSection
        id={`${id}-points`}
        title={`Point list (${c.points.length}/16)`}
        expanded={pointListOpen}
        onToggle={() => setPointListOpen((value) => !value)}
      >
        <div className={styles.points}>
          {c.points.map((p, i) => (
            <Button key={i} aria-pressed={i === c.selected} onClick={() => void select(i)}>
              {i + 1} · {(p.input * 100).toFixed(4)}% → {(p.output * 100).toFixed(4)}%
              {[p.input, p.output].some(
                (value) => value < stableRange.min || value > stableRange.max,
              )
                ? ' · Off plot'
                : ''}
            </Button>
          ))}
          <Button disabled={blocked || c.points.length <= 2} onClick={remove}>
            Delete selected point
          </Button>
        </div>
      </InspectorSection>
      <p id={`${id}-help`} className={styles.help}>
        Click to add; drag to move. Page Up/Down selects points; arrows move them (Shift: larger
        steps). Delete removes; Escape cancels. Keep 2–16 points; endpoints move too.
      </p>
      {c.message && (
        <p className={styles.help} role="status">
          {c.message}
        </p>
      )}
      {c.error && (
        <p className={styles.error} role="alert">
          {c.error}
        </p>
      )}
    </>
  )
}
