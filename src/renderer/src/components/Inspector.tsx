import { Histogram } from './Histogram'
import { WhiteBalance } from './WhiteBalance'
import { WhiteBalancePicker } from './WhiteBalancePicker'
import type { WhiteBalancePickerController } from '../hooks/useWhiteBalancePicker'
import { ColorIntensity } from './ColorIntensity'
import { DetailControls } from './DetailControls'
import { ColorMixerControls, ColorGradingControls } from './CreativeColorControls'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { Shadows } from './Shadows'
import { Whites } from './Whites'
import { Blacks } from './Blacks'
import { Highlights } from './Highlights'
import { Contrast } from './Contrast'
import { Exposure } from './Exposure'
import type { EditController } from '../hooks/useEdits'
import { LensCorrections } from './LensCorrections'
import { InspectorSection } from './InspectorSection'
import {
  Info,
  SlidersHorizontal,
  Sun,
  Thermometer,
  Crop,
  Palette,
  CircleDot,
  ScanLine,
} from 'lucide-react'
import { CropControls } from './CropControls'
import type { CropController } from '../hooks/useCrop'
import type { Photo } from '../../../shared/contracts'
import {
  type InspectorSectionId,
  type InspectorSections,
  type CreativeColorSelection,
} from '../../../shared/workspace'
import styles from '../App.module.css'

export function Inspector({
  photo,
  edits,
  previewReady,
  tools,
  sections,
  onSectionsChange,
  creativeColor,
  onCreativeColorChange,
  suspended = false,
  whiteBalancePicker,
  crop,
}: {
  photo: Photo | null
  edits: EditController
  previewReady: boolean
  tools: PreviewTools
  sections: InspectorSections
  onSectionsChange: (sections: InspectorSections) => void
  creativeColor: CreativeColorSelection
  onCreativeColorChange: (selection: CreativeColorSelection) => void
  suspended?: boolean
  whiteBalancePicker: WhiteBalancePickerController
  crop: CropController
}) {
  const toggle = (id: InspectorSectionId) => {
    const next = { ...sections, [id]: !sections[id] }
    onSectionsChange(next)
  }
  return (
    <aside className={styles.inspector} aria-label="Adjustments" data-testid="adjustments-panel">
      <div className={styles.panelHeading}>
        <h2>
          <SlidersHorizontal size={14} /> Adjustments
        </h2>
      </div>
      <div className={styles.inspectorPinned} data-testid="inspector-pinned">
        <Histogram
          tools={tools}
          ready={previewReady}
          expanded={sections.histogram}
          onToggle={() => toggle('histogram')}
        />
      </div>
      <div className={styles.inspectorScroll} data-testid="inspector-scroll">
        <InspectorSection
          id="crop-controls"
          title="Crop"
          icon={Crop}
          expanded={sections.crop}
          onToggle={() => toggle('crop')}
        >
          <CropControls crop={crop} />
        </InspectorSection>
        <InspectorSection
          id="light-controls"
          title="Light"
          icon={Sun}
          expanded={sections.light}
          onToggle={() => toggle('light')}
        >
          <Exposure edits={edits} previewReady={previewReady} />
          <Contrast edits={edits} previewReady={previewReady} />
          <Highlights edits={edits} previewReady={previewReady} />
          <Shadows edits={edits} previewReady={previewReady} />
          <Whites edits={edits} previewReady={previewReady} />
          <Blacks edits={edits} previewReady={previewReady} />
        </InspectorSection>
        <InspectorSection
          id="color-controls"
          title="Color"
          icon={Thermometer}
          expanded={sections.color}
          onToggle={() => toggle('color')}
        >
          <WhiteBalance edits={edits} previewReady={previewReady} />
          <WhiteBalancePicker picker={whiteBalancePicker} />
          <ColorIntensity edits={edits} previewReady={previewReady} />
        </InspectorSection>
        <InspectorSection
          id="color-mixer-controls"
          title="Color Mixer"
          icon={Palette}
          expanded={sections.colorMixer}
          onToggle={() => toggle('colorMixer')}
        >
          <ColorMixerControls
            edits={edits}
            previewReady={previewReady}
            selection={creativeColor}
            onSelectionChange={onCreativeColorChange}
          />
        </InspectorSection>
        <InspectorSection
          id="color-grading-controls"
          title="Color Grading"
          icon={CircleDot}
          expanded={sections.colorGrading}
          onToggle={() => toggle('colorGrading')}
        >
          <ColorGradingControls
            edits={edits}
            previewReady={previewReady}
            selection={creativeColor}
            onSelectionChange={onCreativeColorChange}
          />
        </InspectorSection>
        <InspectorSection
          id="detail-controls"
          title="Detail"
          icon={ScanLine}
          expanded={sections.detail}
          onToggle={() => toggle('detail')}
        >
          <DetailControls edits={edits} previewReady={previewReady} />
        </InspectorSection>
        {photo && (
          <LensCorrections
            key={photo.id}
            photoId={photo.id}
            flushEdits={edits.flush}
            expanded={sections.lens}
            onToggle={() => toggle('lens')}
            suspended={suspended}
          />
        )}
        <InspectorSection
          id="photo-metadata"
          title="Metadata"
          icon={Info}
          expanded={sections.metadata}
          onToggle={() => toggle('metadata')}
        >
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
        </InspectorSection>
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
