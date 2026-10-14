import type { Photo } from '../../../shared/contracts'
import styles from './PreviewMetadata.module.css'

export function PreviewMetadata({ photo }: { photo: Photo }) {
  const equipment = [photo.camera, photo.lens].filter((value) => value?.trim())
  const exposure =
    photo.assetKind === 'derived'
      ? ['Merged photo']
      : [photo.shutter, photo.aperture, photo.iso?.trim() ? `ISO ${photo.iso}` : undefined].filter(
          (value) => value?.trim(),
        )
  return (
    <div className={styles.metadata} data-testid="preview-metadata" aria-label="Photo metadata">
      {equipment.length > 0 && (
        <div className={styles.equipment} data-testid="preview-equipment">
          {equipment.map((value, index) => (
            <span className={styles.equipmentField} key={index} title={value}>
              {value}
            </span>
          ))}
        </div>
      )}
      {exposure.length > 0 && (
        <div className={styles.exposure} data-testid="preview-exposure">
          {exposure.map((value, index) => (
            <span key={index} title={value}>
              {value}
            </span>
          ))}
        </div>
      )}
      {!equipment.length && !exposure.length && <span>Metadata unavailable</span>}
    </div>
  )
}
