import { useState } from 'react'
import { Crop, RotateCcw, RotateCw } from 'lucide-react'
import type { CropController } from '../hooks/useCrop'
import { quarterTurnedSize } from '../../../shared/crop'
import { AdjustmentInput } from './AdjustmentInput'
import styles from './CropControls.module.css'

const ratios = [
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:2', 3 / 2],
  ['16:9', 16 / 9],
] as const
const closeRatio = (a: number | null, b: number) => a !== null && Math.abs(a - b) <= 1e-12 * b

export function CropControls({ crop }: { crop: CropController }) {
  const [custom, setCustom] = useState(false)
  const draft = crop.draft,
    context = crop.context,
    turned = context && draft ? quarterTurnedSize(context.source, draft.quarterTurns) : null,
    originalRatio = turned ? turned.width / turned.height : 1,
    disabled = crop.pending || crop.stale,
    aspectValue =
      !draft || draft.aspectRatio === null
        ? 'free'
        : custom
          ? 'custom'
          : closeRatio(draft.aspectRatio, originalRatio)
            ? 'original'
            : (ratios.find(([, value]) => closeRatio(draft.aspectRatio, value))?.[0] ?? 'custom')
  return (
    <div className={styles.tool}>
      <button
        type="button"
        disabled={!crop.supported || crop.pending}
        aria-pressed={crop.active}
        onClick={() => (crop.active ? crop.cancel() : void crop.start())}
      >
        <Crop size={13} aria-hidden="true" /> Crop and straighten
      </button>
      {crop.active && draft && context && turned && (
        <div className={styles.controls}>
          <p id="crop-instructions">
            Drag the frame or its corners. Arrow keys move a focused handle; Shift moves ten pixels.
            Apply accepts the shown framing.
          </p>
          <label className={styles.aspect}>
            Aspect ratio
            <select
              value={aspectValue}
              disabled={disabled}
              onChange={(event) => {
                const value = event.currentTarget.value
                setCustom(value === 'custom')
                crop.aspect(
                  value === 'free'
                    ? null
                    : value === 'original'
                      ? originalRatio
                      : value === 'custom'
                        ? (draft.aspectRatio ?? 3 / 2)
                        : ratios.find(([label]) => label === value)![1],
                )
              }}
            >
              <option value="free">Free</option>
              <option value="original">Original</option>
              {ratios.map(([label]) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          {aspectValue === 'custom' && (
            <AdjustmentInput
              label="Custom ratio"
              value={draft.aspectRatio!}
              min={0.000001}
              max={32768}
              step={0.000001}
              precision={6}
              unit=":1"
              resetKey={crop.epoch}
              disabled={disabled}
              onChange={(value) => crop.aspect(value, true)}
              onCommit={crop.commitGesture}
              onCancel={crop.cancelGesture}
            />
          )}
          <div className={styles.actions} role="group" aria-label="Rotate crop">
            <button
              type="button"
              aria-label="Rotate crop counterclockwise"
              disabled={disabled}
              onClick={() => crop.rotate(-1)}
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              aria-label="Rotate crop clockwise"
              disabled={disabled}
              onClick={() => crop.rotate(1)}
            >
              <RotateCw size={13} />
            </button>
            <span>{draft.quarterTurns * 90}°</span>
          </div>
          <AdjustmentInput
            label="Straighten"
            value={draft.angle}
            min={-45}
            max={45}
            step={0.01}
            precision={2}
            unit="°"
            resetKey={crop.epoch}
            disabled={disabled}
            onChange={(value) => crop.field('angle', value)}
            onCommit={crop.commitGesture}
            onCancel={crop.cancelGesture}
          />
          {(['centerX', 'centerY', 'width', 'height'] as const).map((key) => {
            const horizontal = key === 'centerX' || key === 'width',
              size = horizontal ? turned.width : turned.height,
              position = key === 'centerX' || key === 'centerY'
            return (
              <AdjustmentInput
                key={key}
                label={
                  {
                    centerX: 'Crop center X',
                    centerY: 'Crop center Y',
                    width: 'Crop width',
                    height: 'Crop height',
                  }[key]
                }
                value={draft[key] * size}
                min={position ? 0.5 : 1}
                max={position ? size - 0.5 : size}
                step={0.01}
                precision={2}
                unit="px"
                resetKey={crop.epoch}
                disabled={disabled}
                onChange={(value) => crop.field(key, value)}
                onCommit={crop.commitGesture}
                onCancel={crop.cancelGesture}
              />
            )
          })}
          <p role="status">
            {crop.pending
              ? 'Applying crop…'
              : `${crop.geometry!.width} × ${crop.geometry!.height} pixels`}
          </p>
          <p>
            Angle, size and aspect changes fit the frame inside the photo. Originals remain
            preserved.
          </p>
          <div className={styles.actions}>
            <button type="button" disabled={disabled} onClick={crop.reset}>
              Reset crop
            </button>
            <button
              type="button"
              disabled={disabled || !!crop.error}
              onClick={() => void crop.apply()}
            >
              Apply crop
            </button>
            <button type="button" disabled={crop.applying} onClick={crop.cancel}>
              Cancel crop
            </button>
          </div>
        </div>
      )}
      {crop.error && (
        <p className={styles.error} role="alert">
          {crop.error}
        </p>
      )}
      {!crop.active && crop.pending && <p role="status">Preparing crop…</p>}
    </div>
  )
}
