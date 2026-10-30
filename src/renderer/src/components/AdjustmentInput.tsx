import { useEffect, useId, useRef } from 'react'
import styles from './AdjustmentInput.module.css'

interface Props {
  label: string
  value: number
  min: number
  max: number
  step: number
  precision: number
  unit?: string
  disabled?: boolean
  /** A pending owner commit blocks changes without removing the focused input. */
  busy?: boolean
  /** Change when confirmed state replaces a local gesture, including external updates. */
  resetKey?: string | number
  onChange: (value: number) => void
  onCommit: () => void
  onCancel: () => void
}

/** A presentation control; the owner manages drafts, persistence, and history. */
export function AdjustmentInput({
  label,
  value,
  min,
  max,
  step,
  precision,
  unit,
  disabled,
  busy = false,
  resetKey,
  onChange,
  onCommit,
  onCancel,
}: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const editing = useRef(false)
  const rejectedKeys = useRef(new Set<string>())
  const rejectedPointer = useRef(false)
  const blocked = !!disabled || busy
  const adjustmentKeys = [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'PageUp',
    'PageDown',
    'Home',
    'End',
  ]
  const previousReset = useRef(resetKey)
  useEffect(() => {
    const replaced = previousReset.current !== resetKey
    previousReset.current = resetKey
    if (!input.current || (editing.current && !replaced && !busy)) return
    const formatted = value.toFixed(precision)
    if (input.current.value !== formatted) input.current.value = formatted
    input.current.removeAttribute('aria-invalid')
    editing.current = false
  }, [value, precision, resetKey, busy])

  function restoreNumber(element: HTMLInputElement) {
    const formatted = value.toFixed(precision)
    if (element.value !== formatted) element.value = formatted
    element.removeAttribute('aria-invalid')
    editing.current = false
  }

  function cancel() {
    if (blocked) return
    editing.current = false
    if (input.current) restoreNumber(input.current)
    onCancel()
  }
  function commitNumber() {
    if (blocked || !input.current) return
    if (!input.current.validity.valid || input.current.value === '') {
      cancel()
      return
    }
    editing.current = false
    input.current.value = input.current.valueAsNumber.toFixed(precision)
    onCommit()
  }
  return (
    <div className={styles.control} aria-busy={busy || undefined}>
      <div className={styles.heading}>
        <label htmlFor={id}>{label}</label>
        <div className={styles.value}>
          <input
            ref={input}
            className={styles.number}
            type="number"
            inputMode="decimal"
            aria-label={`${label} value`}
            aria-describedby={unit ? `${id}-unit` : undefined}
            min={min}
            max={max}
            step={step}
            defaultValue={value.toFixed(precision)}
            disabled={disabled}
            readOnly={busy}
            onFocus={() => {
              editing.current = !blocked
            }}
            onBeforeInput={(event) => {
              if (blocked) event.preventDefault()
            }}
            onChange={(event) => {
              const element = event.currentTarget
              if (blocked) {
                restoreNumber(element)
                return
              }
              const valid = element.validity.valid && element.value !== ''
              element.setAttribute('aria-invalid', String(!valid))
              editing.current = true
              if (valid) {
                onChange(element.valueAsNumber)
              } else {
                // Discard any earlier valid draft so invalid text cannot save on shutdown.
                onCancel()
              }
            }}
            onBlur={commitNumber}
            onKeyDown={(event) => {
              if (blocked) {
                if (
                  ['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(
                    event.key,
                  )
                )
                  event.preventDefault()
                return
              }
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                if (event.key === 'Escape') cancel()
                else commitNumber()
              }
            }}
          />
          {unit && (
            <span id={`${id}-unit`} className={styles.unit}>
              {unit}
            </span>
          )}
        </div>
      </div>
      <input
        id={id}
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-disabled={blocked}
        aria-valuetext={`${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`}
        onChange={(event) => {
          if (blocked) event.currentTarget.value = String(value)
          else onChange(event.currentTarget.valueAsNumber)
        }}
        onPointerDown={(event) => {
          rejectedPointer.current = blocked
          if (blocked) event.preventDefault()
          else event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerUp={() => {
          if (!blocked && !rejectedPointer.current) onCommit()
        }}
        onPointerCancel={() => {
          if (!blocked && !rejectedPointer.current) onCancel()
        }}
        onLostPointerCapture={() => {
          if (!blocked && !rejectedPointer.current) onCommit()
        }}
        onBlur={() => {
          if (!blocked) onCommit()
        }}
        onKeyUp={(event) => {
          if (rejectedKeys.current.delete(event.key) || blocked) return
          if (adjustmentKeys.includes(event.key)) onCommit()
        }}
        onKeyDown={(event) => {
          if (blocked || rejectedKeys.current.has(event.key)) {
            if (adjustmentKeys.includes(event.key)) rejectedKeys.current.add(event.key)
            if (
              event.key !== 'Tab' &&
              !['Shift', 'Control', 'Alt', 'Meta'].includes(event.key) &&
              !((event.ctrlKey || event.metaKey) && ['a', 'c'].includes(event.key.toLowerCase()))
            )
              event.preventDefault()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
    </div>
  )
}
