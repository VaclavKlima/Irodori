import type { DisplayTarget } from '../../../shared/hdr'
import styles from './DisplayDetails.module.css'
export function DisplayDetails({
  target,
  photoId,
  hdr,
}: {
  target: DisplayTarget
  photoId?: string
  hdr: boolean
}) {
  const presentation =
    target.presentation?.photoId === photoId &&
    target.presentation?.targetGeneration === target.generation
      ? target.presentation
      : undefined
  const mode = presentation?.stage === 'presented' ? presentation.mode : undefined
  const presented = mode ? presentation : undefined
  const fallback =
    mode === 'sdr' &&
    (presented?.backend === 'canvas2d-hdr-sdr' || (hdr && target.requested === 'hdr'))
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
  const reason = !hdr ? 'Display-referred image.' : presentation?.reason || target.reason
  const caps = target.capabilities
  return (
    <div className={styles.container}>
      <details className={styles.details}>
        <summary aria-label="Display details" aria-description={label}>
          {label}
        </summary>
        <div className={styles.panel}>
          <strong>Display details</strong>
          <p>
            Requested: {target.requested.toUpperCase()} · Presented:{' '}
            {mode?.toUpperCase() ?? 'No frame yet'}
          </p>
          <p>{reason}</p>
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
      </details>
    </div>
  )
}
