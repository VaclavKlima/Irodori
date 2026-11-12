import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  defaultColorMaskRange,
  maskRangeColorFromHex,
  maskRangeColorToHex,
  type MaskRange,
  type MaskRangeColorSample,
} from '../../../shared/mask-ranges'
import type { MasksController } from '../hooks/useMasks'
import { AdjustmentInput } from './AdjustmentInput'
import { Button, IconButton } from './ui/Controls'
import styles from './MaskRangeControls.module.css'

function EnterColor({ value, apply }: { value: string; apply: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <form
      className={styles.entry}
      onSubmit={(event) => {
        event.preventDefault()
        if (input.current) apply(input.current.value)
      }}
    >
      <label>
        Sample color
        <input
          ref={input}
          aria-label="Sample color value"
          defaultValue={value}
          maxLength={7}
          spellCheck={false}
        />
      </label>
      <Button type="submit">Use color</Button>
    </form>
  )
}

/** Range controls own temporary input only; shared mask edits own persistence and Undo. */
export function MaskRangeControls({ masks }: { masks: MasksController }) {
  const [selectedSample, setSelectedSample] = useState(0)
  const [position, setPosition] = useState({ x: 50, y: 50 })
  const range = masks.rangeValues
  const color = range?.kind === 'color' ? range : null
  const luminance = range?.kind === 'luminance' ? range : null
  const count = color?.samples.length ?? 0
  const index = Math.min(selectedSample, count)
  const enabled = masks.rangeAvailable
  const update = (value: MaskRange) => masks.changeRange(value)
  const applyColorSample = (sample: MaskRangeColorSample) => {
    const value = color ?? defaultColorMaskRange(sample)
    const samples = [...value.samples]
    samples[index] = sample
    update({ ...value, samples })
    masks.commitRange()
    masks.stopRangePicking()
  }
  const sample = () => masks.pickRangeSample(index)
  return (
    <section
      className={styles.section}
      aria-label={masks.rangeKind === 'color' ? 'Color range controls' : 'Luminance range controls'}
    >
      <div className={styles.heading}>
        <h3>{masks.rangeKind === 'color' ? 'Color range' : 'Luminance range'}</h3>
        <Button disabled={!enabled} aria-pressed={masks.rangePicking} onClick={sample}>
          {masks.rangeKind === 'color' ? 'Sample color' : 'Sample brightness'}
        </Button>
      </div>
      {masks.rangePicking && (
        <p className={styles.hint}>Click the photograph to sample its source. Escape cancels.</p>
      )}
      {masks.rangeSamplePending && (
        <p className={styles.hint} role="status">
          Reading source sample…
        </p>
      )}
      {masks.rangeKind === 'color' ? (
        <>
          <div className={styles.samples} role="group" aria-label="Range color samples">
            {color?.samples.map((sample, i) => (
              <button
                key={i}
                className={styles.swatch}
                style={{ backgroundColor: maskRangeColorToHex(sample) }}
                aria-label={`Color sample ${i + 1}`}
                aria-pressed={i === index}
                disabled={!enabled}
                onClick={() => setSelectedSample(i)}
              >
                {i + 1}
              </button>
            ))}
            <IconButton
              icon={Plus}
              label="Add color sample"
              disabled={!enabled || count >= 5}
              onClick={() => {
                setSelectedSample(count)
                masks.pickRangeSample(count)
              }}
            />
            <span className={styles.hint}>{count} of 5 samples</span>
            <IconButton
              icon={X}
              label="Remove color sample"
              disabled={!enabled || count <= 1 || index >= count}
              onClick={() => {
                if (!color) return
                update({ ...color, samples: color.samples.filter((_, i) => i !== index) })
                masks.commitRange()
                setSelectedSample(Math.max(0, index - 1))
              }}
            />
          </div>
          {!color && (
            <p className={styles.hint}>
              Sample a source color or enter one below to preview this range.
            </p>
          )}
          <AdjustmentInput
            label="Range"
            value={color?.range ?? 20}
            min={0}
            max={100}
            step={1}
            precision={0}
            disabled={!enabled || !color}
            resetKey={masks.resetKey}
            onChange={(value) => color && update({ ...color, range: value })}
            onCommit={masks.commitRange}
            onCancel={masks.cancelRangeChange}
          />
          <AdjustmentInput
            label="Softness"
            value={color?.softness ?? 25}
            min={0}
            max={100}
            step={1}
            precision={0}
            disabled={!enabled || !color}
            resetKey={masks.resetKey}
            onChange={(value) => color && update({ ...color, softness: value })}
            onCommit={masks.commitRange}
            onCancel={masks.cancelRangeChange}
          />
          <p className={styles.hint}>Matches source colors across brightness levels.</p>
          <details className={styles.disclosure}>
            <summary>Enter color</summary>
            <fieldset disabled={!enabled} className={styles.fieldset}>
              <EnterColor
                key={`${index}:${JSON.stringify(color?.samples[index])}`}
                value={
                  color?.samples[index] ? maskRangeColorToHex(color.samples[index]) : '#808080'
                }
                apply={(value) => {
                  try {
                    applyColorSample(maskRangeColorFromHex(value))
                  } catch (error) {
                    masks.setError(String(error))
                  }
                }}
              />
            </fieldset>
          </details>
        </>
      ) : (
        luminance && (
          <>
            <AdjustmentInput
              label="Lower"
              unit="%"
              value={luminance.lower}
              min={0}
              max={luminance.upper ?? Number.MAX_VALUE}
              step={0.1}
              precision={1}
              slider={false}
              disabled={!enabled}
              resetKey={masks.resetKey}
              onChange={(value) => update({ ...luminance, lower: value })}
              onCommit={masks.commitRange}
              onCancel={masks.cancelRangeChange}
            />
            <AdjustmentInput
              label="Upper"
              unit="%"
              value={luminance.upper ?? Math.max(100, luminance.lower)}
              min={luminance.lower}
              max={Number.MAX_VALUE}
              step={0.1}
              precision={1}
              slider={false}
              disabled={!enabled || luminance.upper === null}
              resetKey={masks.resetKey}
              onChange={(value) => update({ ...luminance, upper: value })}
              onCommit={masks.commitRange}
              onCancel={masks.cancelRangeChange}
            />
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={luminance.upper === null}
                disabled={!enabled}
                onChange={(event) => {
                  update({
                    ...luminance,
                    upper: event.target.checked ? null : Math.max(100, luminance.lower),
                  })
                  masks.commitRange()
                }}
              />
              All brighter values
            </label>
            <AdjustmentInput
              label="Softness"
              value={luminance.softness}
              min={0}
              max={100}
              step={1}
              precision={0}
              disabled={!enabled}
              resetKey={masks.resetKey}
              onChange={(value) => update({ ...luminance, softness: value })}
              onCommit={masks.commitRange}
              onCancel={masks.cancelRangeChange}
            />
            <p className={styles.hint}>100% = source white. HDR can exceed 100%.</p>
          </>
        )
      )}
      <details className={styles.disclosure}>
        <summary>Sample position</summary>
        <AdjustmentInput
          label="Sample X"
          unit="%"
          value={position.x}
          min={0}
          max={100}
          step={0.1}
          precision={1}
          slider={false}
          disabled={!enabled}
          onChange={(x) => setPosition((p) => ({ ...p, x }))}
          onCommit={() => undefined}
          onCancel={() => setPosition((p) => ({ ...p, x: 50 }))}
        />
        <AdjustmentInput
          label="Sample Y"
          unit="%"
          value={position.y}
          min={0}
          max={100}
          step={0.1}
          precision={1}
          slider={false}
          disabled={!enabled}
          onChange={(y) => setPosition((p) => ({ ...p, y }))}
          onCommit={() => undefined}
          onCancel={() => setPosition((p) => ({ ...p, y: 50 }))}
        />
        <Button
          disabled={!enabled}
          onClick={() => masks.sampleRangeAt({ x: position.x / 100, y: position.y / 100 }, index)}
        >
          Sample this position
        </Button>
      </details>
      {masks.rangeCreating && (
        <div className={styles.actions}>
          <Button disabled={!enabled || !masks.rangePreviewReady} onClick={masks.acceptRange}>
            {masks.rangeAcceptLabel}
          </Button>
          <Button disabled={masks.busy} onClick={masks.cancel}>
            Cancel range
          </Button>
        </div>
      )}
    </section>
  )
}
