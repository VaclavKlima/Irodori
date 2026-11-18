import { useMemo } from 'react'
import type { DiagnosticImage, PhotoDiagnosticsResult } from '../../../shared/photo-diagnostics'
import type { PresentedPreviewGeometry, Size } from '../preview/geometry'
import { inspectionScreenPoint } from '../preview/inspection-geometry'
import styles from './PhotoPreview.module.css'

/** Project the bounded overlay onto the last submitted photograph, including its pan and zoom. */
export function DiagnosticOverlay({
  result,
  label,
  geometry,
  viewport,
}: {
  result: PhotoDiagnosticsResult
  label: DiagnosticImage['label']
  geometry: PresentedPreviewGeometry
  viewport: Size
}) {
  const image = result.images.find((item) => item.label === label)
  const url = useMemo(() => image && `data:image/png;base64,${image.data}`, [image])
  if (
    !image ||
    geometry.image.width !== result.nativeGrid.width ||
    geometry.image.height !== result.nativeGrid.height ||
    !geometry.viewport.width ||
    !geometry.viewport.height
  )
    return null
  const { x, y, width, height } = result.bounds
  const origin = inspectionScreenPoint({ x, y }, geometry, viewport)
  const opposite = inspectionScreenPoint({ x: x + width, y: y + height }, geometry, viewport)
  return (
    <img
      className={styles.diagnosticOverlay}
      data-testid={`diagnostics-${label}-overlay`}
      data-revision={result.revision}
      data-grid-identity={result.gridIdentity}
      aria-hidden="true"
      alt=""
      draggable={false}
      src={url}
      style={{
        left: origin.x,
        top: origin.y,
        width: opposite.x - origin.x,
        height: opposite.y - origin.y,
      }}
    />
  )
}
