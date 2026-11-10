import { useEffect, useRef, type ReactNode } from 'react'
import type { DisplayTarget } from '../../../shared/hdr'
import styles from './DisplayDetails.module.css'
export function DisplayDetails({
  controls,
  target,
  photoId,
  hdr,
  hdrJpeg,
}: {
  controls?: ReactNode
  target: DisplayTarget
  photoId?: string
  hdr: boolean
  hdrJpeg?: import('../../../shared/lens').ProcessingMetadata['hdrJpeg']
}) {
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (details.current && !details.current.contains(event.target as Node))
        details.current.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  const presentation =
    target.presentation?.photoId === photoId &&
    target.presentation?.targetGeneration === target.generation
      ? target.presentation
      : undefined
  const mode = presentation?.stage === 'presented' ? presentation.mode : undefined
  const presented = mode ? presentation : undefined
  const fallback =
    mode === 'sdr' &&
    (presented?.backend === 'canvas2d-hdr-sdr' || ((hdr || hdrJpeg) && target.requested === 'hdr'))
  const colorSpace = presented?.backend === 'webgpu-hdr' ? target.colorSpace : 'sRGB'
  const precision = presented?.backend === 'webgpu-hdr' ? 'Float32' : '8-bit'
  const label = fallback
    ? 'SDR fallback'
    : mode
      ? mode.toUpperCase()
      : presentation?.stage === 'failed'
        ? 'Unavailable'
        : photoId
          ? 'Loading'
          : 'SDR'
  const reason =
    hdrJpeg?.state === 'sdr-only'
      ? hdrJpeg.reason
      : !hdr
        ? 'Display-referred image.'
        : presentation?.reason || target.reason
  const caps = target.capabilities
  return (
    <div className={styles.container}>
      <details
        ref={details}
        className={styles.details}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && details.current?.open) {
            event.stopPropagation()
            details.current.open = false
            details.current.querySelector('summary')?.focus()
          }
        }}
      >
        <summary aria-label="Display details" aria-description={label}>
          {label}
        </summary>
        <div className={styles.panel}>
          {controls}
          <div data-selectable-text tabIndex={0} aria-label="Display diagnostics">
            <strong>Display details</strong>
            <p>
              Requested: {target.requested.toUpperCase()} · Presented:{' '}
              {mode?.toUpperCase() ?? 'No frame yet'}
            </p>
            <p>{reason}</p>
            {hdrJpeg?.state === 'supported' && (
              <p>ISO HDR JPEG · Authored HDR and SDR renditions.</p>
            )}
            <p>
              Frame:{' '}
              {presented
                ? `${colorSpace} · ${precision}`
                : !photoId || presentation?.stage === 'failed'
                  ? 'Unavailable'
                  : 'Preparing'}
            </p>
            <p>
              Monitor: {caps?.monitor?.label ?? 'Unavailable'}
              {caps?.monitor &&
                ` · ${caps.monitor.width} × ${caps.monitor.height} · ${caps.monitor.scale}× scale`}
            </p>
            <p>
              Reported headroom:{' '}
              {caps?.headroomStops === null || caps?.headroomStops === undefined
                ? 'Unavailable'
                : `${caps.headroomStops.toFixed(3)} stops (${(2 ** caps.headroomStops).toFixed(2)}×)`}
            </p>
            <p>
              Adapter:{' '}
              {caps?.adapter
                ? [caps.adapter.vendor, caps.adapter.architecture, caps.adapter.description]
                    .filter(Boolean)
                    .join(' · ')
                : 'Unavailable'}
            </p>
            <p>
              Extended canvas: {caps?.extended ? 'Supported' : 'Unavailable'} · Permission:{' '}
              {caps?.permission ?? 'Unknown'}
            </p>
            <p>
              Renderer: {presentation?.backend ?? 'Preparing'} · Target generation:{' '}
              {target.generation}
            </p>
            <p>Physical luminance is unverified.</p>
          </div>
        </div>
      </details>
    </div>
  )
}
