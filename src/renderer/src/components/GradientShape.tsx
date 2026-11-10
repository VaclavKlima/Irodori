import { useState } from 'react'
import type { MaskGradient } from '../../../shared/masks'
import type { MasksController } from '../hooks/useMasks'
import { AdjustmentInput } from './AdjustmentInput'
import { InspectorSection } from './InspectorSection'
import { Button } from './ui/Controls'
import styles from './Masks.module.css'

/** Full-photo pixel inputs edit the same geometry as the photograph handles. */
export function GradientShape({ masks }: { masks: MasksController }) {
  const [expanded, setExpanded] = useState(false)
  const gradient = masks.gradientValues
  if (!gradient) return null
  const dimensions = masks.gradientDimensions
  const width = dimensions?.width ?? 1
  const height = dimensions?.height ?? 1
  const change = (next: MaskGradient) => masks.changeGradient(next)
  const field = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (value: number) => void,
    unit = 'px',
  ) => (
    <AdjustmentInput
      key={label}
      label={label}
      value={value}
      min={min}
      max={max}
      step={0.1}
      precision={1}
      unit={unit}
      slider={false}
      disabled={!masks.supported || !dimensions}
      busy={masks.busy}
      resetKey={masks.resetKey}
      onChange={onChange}
      onCommit={masks.commitGradient}
      onCancel={masks.cancel}
    />
  )
  return (
    <div className={styles.section}>
      <h3>Gradient shape</h3>
      <Button
        aria-pressed={masks.editingGradient}
        disabled={!masks.available}
        onClick={() => masks.preference({ brush: false })}
      >
        Edit gradient
      </Button>
      <p className={styles.hint}>
        Drag the handles to move or reshape the gradient. Arrow keys move one photo pixel; Shift
        moves ten. Escape cancels.
      </p>
      {gradient.kind === 'radial' && (
        <AdjustmentInput
          label="Gradient feather"
          value={gradient.feather}
          min={0}
          max={100}
          step={1}
          precision={0}
          unit="%"
          disabled={!masks.supported}
          busy={masks.busy}
          resetKey={masks.resetKey}
          onChange={(feather) => change({ ...gradient, feather })}
          onCommit={masks.commitGradient}
          onCancel={masks.cancel}
        />
      )}
      <InspectorSection
        id="mask-gradient-geometry"
        title="Geometry"
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      >
        {gradient.kind === 'linear' ? (
          (['start', 'end'] as const).flatMap((end) =>
            (['x', 'y'] as const).map((axis) => {
              const dimension = axis === 'x' ? width : height
              return field(
                `${end === 'start' ? 'Start' : 'End'} ${axis.toUpperCase()}`,
                gradient[end][axis] * dimension,
                -dimension,
                2 * dimension,
                (value) =>
                  change({ ...gradient, [end]: { ...gradient[end], [axis]: value / dimension } }),
              )
            }),
          )
        ) : (
          <>
            {(['x', 'y'] as const).map((axis) => {
              const dimension = axis === 'x' ? width : height
              return field(
                `Center ${axis.toUpperCase()}`,
                gradient.center[axis] * dimension,
                -dimension,
                2 * dimension,
                (value) =>
                  change({
                    ...gradient,
                    center: { ...gradient.center, [axis]: value / dimension },
                  }),
              )
            })}
            {field('Width', gradient.radiusX * width * 2, 2, width * 4, (value) =>
              change({ ...gradient, radiusX: value / (2 * width) }),
            )}
            {field('Height', gradient.radiusY * height * 2, 2, height * 4, (value) =>
              change({ ...gradient, radiusY: value / (2 * height) }),
            )}
            {field(
              'Rotation',
              gradient.rotation,
              -180,
              180,
              (rotation) => change({ ...gradient, rotation }),
              '°',
            )}
          </>
        )}
        <p className={styles.hint}>Full-photo pixels, independent of zoom and crop.</p>
      </InspectorSection>
    </div>
  )
}
