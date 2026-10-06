import { Histogram } from './Histogram'
import { WhiteBalance } from './WhiteBalance'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { Shadows } from './Shadows'
import { Whites } from './Whites'
import { Blacks } from './Blacks'
import { Highlights } from './Highlights'
import { Contrast } from './Contrast'
import { Exposure } from './Exposure'
import type { EditController } from '../hooks/useEdits'
import { LensCorrections } from './LensCorrections'
import { useState } from 'react'
import { ChevronDown, ChevronRight, Info, SlidersHorizontal, Sun, Thermometer } from 'lucide-react'
import type { Photo } from '../../../shared/contracts'
import styles from '../App.module.css'

export function Inspector({
  photo,
  edits,
  previewReady,
  tools,
}: {
  photo: Photo | null
  edits: EditController
  previewReady: boolean
  tools: PreviewTools
}) {
  const [lightOpen, setLightOpen] = useState(true)
  const [metadataOpen, setMetadataOpen] = useState(true)
  const [lensOpen, setLensOpen] = useState(false)
  return (
    <aside className={styles.inspector} aria-label="Adjustments" data-testid="adjustments-panel">
      <div className={styles.panelHeading}>
        <h2>
          <SlidersHorizontal size={14} /> Adjustments
        </h2>
      </div>
      <div className={styles.inspectorScroll}>
        <Histogram tools={tools} ready={previewReady} />
        <p className={styles.demoNote}>
          Exposure, contrast, highlights, shadows, whites, blacks, white balance for verified RAWs,
          and lens corrections are available. Other adjustments are coming later.
        </p>
        <section className={styles.adjustmentSection}>
          <button
            className={styles.sectionToggle}
            aria-expanded={lightOpen}
            aria-controls="light-controls"
            onClick={() => setLightOpen(!lightOpen)}
          >
            <Sun size={14} />
            Light{lightOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {lightOpen && (
            <div className={styles.sectionContent} id="light-controls">
              <Exposure edits={edits} previewReady={previewReady} />
              <Contrast edits={edits} previewReady={previewReady} />
              <Highlights edits={edits} previewReady={previewReady} />
              <Shadows edits={edits} previewReady={previewReady} />
              <Whites edits={edits} previewReady={previewReady} />
              <Blacks edits={edits} previewReady={previewReady} />
            </div>
          )}
        </section>
        <section className={styles.adjustmentSection}>
          <div className={styles.sectionToggle}>
            <Thermometer size={14} />
            Color
          </div>
          <div className={styles.sectionContent}>
            <WhiteBalance edits={edits} previewReady={previewReady} />
          </div>
        </section>
        {photo && (
          <LensCorrections
            key={photo.id}
            photoId={photo.id}
            flushEdits={edits.flush}
            expanded={lensOpen}
            onToggle={() => setLensOpen(!lensOpen)}
          />
        )}
        <section className={styles.adjustmentSection}>
          <button
            className={styles.sectionToggle}
            aria-expanded={metadataOpen}
            aria-controls="photo-metadata"
            onClick={() => setMetadataOpen(!metadataOpen)}
          >
            <Info size={14} />
            Metadata{metadataOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {metadataOpen && (
            <div className={styles.sectionContent} id="photo-metadata">
              <dl className={styles.metadata} data-testid="photo-metadata">
                {Object.entries({
                  Filename: photo?.filename,
                  Camera: photo?.camera,
                  Lens: photo?.lens,
                  Captured: photo?.capturedAt,
                  Dimensions: photo ? `${photo.width} × ${photo.height}` : undefined,
                  Format: photo?.format,
                  Aperture: photo?.aperture,
                  Shutter: photo?.shutter,
                  ISO: photo?.iso,
                  Focal: photo?.focalLength,
                  'Quick preview': photo
                    ? photo.previewSource === 'decoded'
                      ? 'Rendered from RAW · sRGB'
                      : photo.previewSource === 'embedded'
                        ? 'Embedded preview · sRGB'
                        : 'sRGB'
                    : undefined,
                }).map(([label, value]) => (
                  <MetadataRow key={label} label={label} value={value} />
                ))}
              </dl>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function MetadataRow({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </>
  )
}
