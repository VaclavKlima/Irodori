import { useEffect, useId, useRef, type PointerEvent } from 'react'
import type { GradingTone } from '../../../shared/color-grading'
import styles from './CreativeColorControls.module.css'

const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
const hue = (value: number) => (Math.round((((value % 360) + 360) % 360) * 10) / 10) % 360

/** Two-dimensional gesture; the adjacent numeric controls expose the same authored values. */
export function GradingWheel({
  label,
  value,
  disabled,
  resetKey,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string
  value: GradingTone
  disabled: boolean
  resetKey?: number
  onChange: (value: Pick<GradingTone, 'hue' | 'saturation'>) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const description = useId()
  const current = useRef(value),
    pointer = useRef<number | null>(null),
    keyboard = useRef(false),
    wheel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    current.current = value
  }, [value])
  useEffect(() => {
    const element = wheel.current
    return () => {
      const id = pointer.current
      pointer.current = null
      keyboard.current = false
      if (id !== null && element?.hasPointerCapture(id)) element.releasePointerCapture(id)
    }
  }, [resetKey])
  const change = (next: Pick<GradingTone, 'hue' | 'saturation'>) => {
    current.current = { ...current.current, ...next }
    onChange(next)
  }
  const sample = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect(),
      x = event.clientX - box.x - box.width / 2,
      y = event.clientY - box.y - box.height / 2,
      saturation = Math.min(100, Math.round((Math.hypot(x, y) / (box.width * 0.48)) * 100))
    change({
      hue: saturation === 0 ? current.current.hue : hue((Math.atan2(y, x) * 180) / Math.PI),
      saturation,
    })
  }
  const commitPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return
    pointer.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit()
  }
  const cancel = () => {
    const id = pointer.current
    pointer.current = null
    keyboard.current = false
    if (id !== null && wheel.current?.hasPointerCapture(id)) wheel.current.releasePointerCapture(id)
    onCancel()
  }
  const angle = (value.hue * Math.PI) / 180,
    radius = value.saturation * 0.48
  return (
    <div className={styles.wheelControl}>
      <div
        ref={wheel}
        className={styles.wheel}
        role="slider"
        aria-label={`${label} color wheel`}
        aria-valuemin={0}
        aria-valuemax={359.9}
        aria-valuenow={value.hue}
        aria-valuetext={`${value.hue.toFixed(1)} degrees, saturation ${value.saturation}`}
        aria-describedby={description}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || pointer.current !== null) return
          event.preventDefault()
          event.currentTarget.focus()
          pointer.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
          sample(event)
        }}
        onPointerMove={(event) => {
          if (!disabled && pointer.current === event.pointerId) sample(event)
        }}
        onPointerUp={commitPointer}
        onLostPointerCapture={commitPointer}
        onPointerCancel={(event) => {
          if (pointer.current === event.pointerId) cancel()
        }}
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
            return
          }
          if (!keys.includes(event.key)) return
          event.preventDefault()
          keyboard.current = true
          const previous = current.current,
            step = event.shiftKey ? 10 : 1
          change({
            hue: hue(
              previous.hue +
                (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            ),
            saturation:
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 100
                  : Math.max(
                      0,
                      Math.min(
                        100,
                        previous.saturation +
                          (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0),
                      ),
                    ),
          })
        }}
        onKeyUp={(event) => {
          if (keys.includes(event.key) && keyboard.current) {
            keyboard.current = false
            onCommit()
          }
        }}
        onBlur={() => {
          if (keyboard.current) {
            keyboard.current = false
            onCommit()
          }
        }}
      >
        <span
          className={styles.wheelMarker}
          style={{
            left: `${50 + radius * Math.cos(angle)}%`,
            top: `${50 + radius * Math.sin(angle)}%`,
          }}
        />
      </div>
      <p id={description} className={styles.help}>
        Left/Right: hue · Up/Down: saturation. Shift: larger steps. Escape: cancel.
      </p>
    </div>
  )
}
