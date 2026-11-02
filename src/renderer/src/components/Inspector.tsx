import { useRef, useState } from 'react'
import { Tabs, TabPanel, IconButton } from './ui/Controls'
import { inspectorReset } from '../../../shared/inspector-reset'
import { Histogram } from './Histogram'
import { PreviewMetadata } from './PreviewMetadata'
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
import { Info, Sun, Crop, Palette, ScanLine, RotateCcw } from 'lucide-react'
import { CropControls } from './CropControls'
import type { CropController } from '../hooks/useCrop'
import type { Photo } from '../../../shared/contracts'
import {
  type InspectorSectionId,
  type InspectorSections,
  type CreativeColorSelection,
  type InspectorGroup,
  type ColorTab,
} from '../../../shared/workspace'
import styles from '../App.module.css'
import inspectorStyles from './Inspector.module.css'

export function Inspector({
  group,
  colorTab,
  onGroupChange,
  onColorTabChange,
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
  group: InspectorGroup
  colorTab: ColorTab
  onGroupChange: (group: InspectorGroup) => void
  onColorTabChange: (tab: ColorTab) => void
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
  const navigation = useRef(0)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')
  const switchTo = async (change: () => void) => {
    const request = ++navigation.current
    const focused = document.activeElement
    if (focused instanceof HTMLInputElement) focused.blur()
    try {
      await edits.flush()
      if (request === navigation.current) change()
    } catch {
      /* The edit owner displays the save error and retains the panel. */
    }
  }
  const reset = async () => {
    if (!photo || !edits.state || crop.active || crop.pending || resetting) return
    setResetting(true)
    setResetError('')
    try {
      const lens = group === 'geometry' ? await window.irodori.getLensSettings(photo.id) : undefined
      await edits.commitPatch(inspectorReset(group, edits.state, lens))
    } catch (error) {
      setResetError(String(error))
    } finally {
      setResetting(false)
    }
  }
  const toggle = (id: InspectorSectionId) => {
    const next = { ...sections, [id]: !sections[id] }
    onSectionsChange(next)
  }
  const title = (id: Exclude<InspectorGroup, 'info'>) => (
    <div className={`${inspectorStyles.title} ${id === 'color' ? inspectorStyles.colorTitle : ''}`}>
      <h2>{id[0].toUpperCase() + id.slice(1)}</h2>
      <IconButton
        className={inspectorStyles.reset}
        icon={RotateCcw}
        label={`Reset ${id[0].toUpperCase() + id.slice(1)}`}
        disabled={
          !previewReady || !edits.state || edits.saving || resetting || crop.active || crop.pending
        }
        onClick={() => void reset()}
      />
    </div>
  )
  return (
    <aside className={styles.inspector} aria-label="Adjustments" data-testid="adjustments-panel">
      <div className={styles.inspectorPinned} data-testid="inspector-pinned">
        <Histogram
          tools={tools}
          ready={previewReady}
          expanded={sections.histogram}
          onToggle={() => toggle('histogram')}
        />
      </div>
      <div className={styles.inspectorBody}>
        <Tabs
          label="Editing groups"
          value={group}
          vertical
          items={[
            { id: 'light', label: 'Light', icon: Sun },
            { id: 'color', label: 'Color', icon: Palette },
            { id: 'detail', label: 'Detail', icon: ScanLine },
            { id: 'geometry', label: 'Geometry', icon: Crop },
            { id: 'info', label: 'Info', icon: Info },
          ]}
          onChange={(next) => void switchTo(() => onGroupChange(next))}
        />
        <div className={inspectorStyles.scroll} data-testid="inspector-scroll">
          <TabPanel id="light" active={group === 'light'}>
            {title('light')}
            <InspectorSection
              id="light-controls"
              title="Light"
              heading="Tonal adjustments"
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
            <button type="button" className={inspectorStyles.fullButton} disabled>
              Advanced curves
            </button>
            <p className={inspectorStyles.hint}>Planned tool</p>
          </TabPanel>
          <TabPanel id="color" active={group === 'color'}>
            {title('color')}
            <div className={inspectorStyles.colorTabs}>
              <Tabs
                label="Color tools"
                value={colorTab}
                items={[
                  { id: 'basic', label: 'Basic' },
                  { id: 'mixer', label: 'Mixer' },
                  { id: 'grading', label: 'Grading' },
                ]}
                onChange={(next) => void switchTo(() => onColorTabChange(next))}
              />
            </div>
            <TabPanel id="basic" active={colorTab === 'basic'}>
              <InspectorSection
                id="color-controls"
                title="Color"
                heading="White balance"
                expanded={sections.color}
                onToggle={() => toggle('color')}
              >
                <WhiteBalance edits={edits} previewReady={previewReady} />
                <WhiteBalancePicker picker={whiteBalancePicker} />
              </InspectorSection>
              <InspectorSection
                id="color-intensity-controls"
                title="Color intensity"
                expanded={sections.colorIntensity}
                onToggle={() => toggle('colorIntensity')}
              >
                <ColorIntensity edits={edits} previewReady={previewReady} />
              </InspectorSection>
            </TabPanel>
            <TabPanel id="mixer" active={colorTab === 'mixer'}>
              <InspectorSection
                id="color-mixer-controls"
                title="Color Mixer"
                heading="Color mixer"
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
            </TabPanel>
            <TabPanel id="grading" active={colorTab === 'grading'}>
              <ColorGradingControls
                edits={edits}
                previewReady={previewReady}
                selection={creativeColor}
                onSelectionChange={onCreativeColorChange}
                expanded={sections.colorGrading}
                onToggle={() => toggle('colorGrading')}
                blendingExpanded={sections.toneBlending}
                onBlendingToggle={() => toggle('toneBlending')}
              />
            </TabPanel>
          </TabPanel>
          <TabPanel id="detail" active={group === 'detail'}>
            {title('detail')}
            <DetailControls
              edits={edits}
              previewReady={previewReady}
              expanded={sections.detail}
              onToggle={() => toggle('detail')}
              sharpeningExpanded={sections.sharpening}
              onSharpeningToggle={() => toggle('sharpening')}
            />
          </TabPanel>
          <TabPanel id="geometry" active={group === 'geometry'}>
            {title('geometry')}
            <InspectorSection
              id="crop-controls"
              title="Crop"
              heading="Crop and straighten"
              expanded={sections.crop}
              onToggle={() => toggle('crop')}
            >
              <CropControls
                crop={crop}
                settings={edits.state?.settings.crop}
                source={photo ? { width: photo.width, height: photo.height } : undefined}
              />
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
          </TabPanel>
          <TabPanel id="info" active={group === 'info'}>
            <section aria-labelledby="photo-metadata-heading">
              <div className={`${inspectorStyles.title} ${inspectorStyles.informationTitle}`}>
                <h2>
                  <button
                    id="photo-metadata-heading"
                    type="button"
                    className={inspectorStyles.informationToggle}
                    aria-label="Metadata"
                    aria-expanded={sections.metadata}
                    aria-controls="photo-metadata"
                    onClick={() => toggle('metadata')}
                  >
                    Information
                  </button>
                </h2>
              </div>
              <div id="photo-metadata" hidden={!sections.metadata}>
                <dl className={inspectorStyles.metadata} data-testid="photo-metadata">
                  <MetadataRow label="Filename" value={photo?.filename} />
                  <MetadataRow
                    label="Dimensions"
                    value={photo ? `${photo.width} × ${photo.height} pixels` : undefined}
                  />
                  <MetadataRow label="Format" value={photo?.format} />
                  <dt>Camera and exposure</dt>
                  <dd>{photo ? <PreviewMetadata photo={photo} /> : '—'}</dd>
                  {Object.entries({
                    Captured: photo?.capturedAt,
                    Focal: photo?.focalLength,
                    'Quick preview': photo
                      ? photo.previewSource === 'decoded'
                        ? 'Rendered from RAW · sRGB'
                        : photo.previewSource === 'embedded'
                          ? 'Embedded preview · sRGB'
                          : 'sRGB'
                      : undefined,
                  })
                    .filter(([, value]) => value)
                    .map(([label, value]) => (
                      <MetadataRow key={label} label={label} value={value} />
                    ))}
                </dl>
              </div>
            </section>
          </TabPanel>
          {resetError && (
            <p className={inspectorStyles.error} role="alert">
              {resetError}
            </p>
          )}
        </div>
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
