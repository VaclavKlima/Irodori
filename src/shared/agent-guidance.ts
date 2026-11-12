import { AGENT_PREVIEW_LIMIT } from './agent'
import { SETTINGS_VERSION } from './edits'
import { defaultExportOptions } from './export'
import { INSPECTION_IMAGE_LIMIT, INSPECTION_PAIR_LIMIT } from './inspection'
import { defaultLuminanceMaskRange, maskRangeCapabilities } from './mask-ranges'
import { maskCapabilities } from './masks'
import { objectSelectionCapabilities } from './object-selection'
import { outputSharpeningCapabilities } from './output-sharpening'
import { toneCurveCapabilities } from './tone-curves'
import { whiteBalanceSampleSizes } from './white-balance-picker'

export const editingGuidanceTopics = [
  'tone',
  'color',
  'white-balance',
  'crop',
  'mask-brush',
  'mask-object',
  'mask-range',
  'mask-compound',
  'detail',
  'inspection',
  'export',
  'presets',
] as const
export type EditingGuidanceTopic = (typeof editingGuidanceTopics)[number]
export interface EditingGuidanceRequest {
  topic: EditingGuidanceTopic
}
export interface EditingGuidanceExample {
  tool: string
  args: Record<string, unknown>
  note: string
}
export interface EditingGuidance {
  version: 1
  topic: EditingGuidanceTopic
  purpose: string
  workflow: string[]
  relatedTools: string[]
  limitations: string[]
  examples: EditingGuidanceExample[]
}

const photoId = 'a'.repeat(64)
const maskId = '00000000-0000-0000-0000-000000000001'
const componentId = '00000000-0000-0000-0000-000000000002'
const example = (
  tool: string,
  args: Record<string, unknown>,
  note: string,
): EditingGuidanceExample => ({
  tool,
  args,
  note: `${note} Template only: replace IDs, revision and context identities with current values. Managed Console calls also require the current requestId.`,
})
const relativeMaskColor = `Local color:{temperature,tint,saturation} accepts relative integers ${maskCapabilities.color.min} to ${maskCapabilities.color.max}, neutral ${maskCapabilities.color.default}. Positive temperature warms; positive tint adds magenta. These are creative units, not Kelvin or camera white balance. Global white balance is unchanged.`
const maskEdges = `Whole-mask edge:{featherPx,shiftPx} uses canonical source pixels: Feather ${maskCapabilities.edge.featherPx.min}–${maskCapabilities.edge.featherPx.max} in ${maskCapabilities.edge.featherPx.step}-pixel steps, Expand/Contract ${maskCapabilities.edge.shiftPx.min}–${maskCapabilities.edge.shiftPx.max} in integer pixels. Positive shift grows the affected region after inversion. These controls do not recover missing hair, feathers or physical transparency.`
const maskCreation =
  'Create a neutral root with a flat operation {kind:"create",id:<fresh UUID>,name:<name>} and optionally one gradient or range. Put Light/Color, inversion and other controls in a separate {kind:"update",id:<same UUID>,...} operation; both can share one operations batch and Undo step. The creation field is id, not maskId; op/type discriminators and a nested mask object are invalid. Read confirmed masks/revision after acceptance.'

const guidance: Record<EditingGuidanceTopic, Omit<EditingGuidance, 'version' | 'topic'>> = {
  tone: {
    purpose: 'Shape tonal hierarchy and contrast for the intended subject and mood.',
    workflow: [
      'Read confirmed settings and edit capabilities. Choose global Light changes for scene-wide balance and spatial masks when only a region needs adjustment.',
      `Use Master/RGB curves when their shape serves the look. Curves have ${toneCurveCapabilities.minPoints}–${toneCurveCapabilities.maxPoints} ordered points in linear reference-white coordinates; ${toneCurveCapabilities.referenceWhite} is white and HDR values can exceed it. Read capabilities before constructing a curve.`,
      'Use irodori_sample_curve_tone for revision-bound working-source samples. Its normalized coordinates address the uncropped, oriented and lens-corrected source. Master samples luminance before Master; RGB samples the channel after Master.',
      'Group related changes into one partial patch, inspect the confirmed photo and use available statistics to distinguish deliberate deep shadows or bright lights from lost important detail.',
    ],
    relatedTools: [
      'irodori_get_edits',
      'irodori_get_edit_capabilities',
      'irodori_update_edits',
      'irodori_sample_curve_tone',
      'irodori_get_photo_statistics',
    ],
    limitations: [
      'A histogram or a neutral Before image does not establish the user’s intended style or a historical starting grade.',
    ],
    examples: [
      example(
        'irodori_update_edits',
        { photoId, expectedRevision: 0, patch: { exposureEv: 0.3, highlights: -15 } },
        'Related global tone adjustments form one Undo step; choose actual amounts from the photograph.',
      ),
    ],
  },
  color: {
    purpose:
      'Create coherent color relationships while respecting the subject and requested style.',
    workflow: [
      'Inspect existing color and the requested natural or expressive direction. Use global Saturation/Vibrance, the eight-range mixer and three-way grading according to the visual goal; do not force every control.',
      'Mixer ranges and grading tones accept partial fields and retain unspecified settings. Discover their complete field names, units and bounds with edit capabilities and the typed tool schema.',
      relativeMaskColor,
      'Use a spatial mask for a regional color goal. Color ranges isolate matching canonical-source colors and can be combined with spatial coverage when needed.',
    ],
    relatedTools: [
      'irodori_get_edit_capabilities',
      'irodori_update_edits',
      'irodori_mutate_masks',
      'irodori_sample_mask_range',
    ],
    limitations: [
      'Depth masks, local Vibrance, mixer, grading, clarity and dehaze remain unavailable. Do not describe a global color range as a spatial selection.',
    ],
    examples: [
      example(
        'irodori_update_edits',
        { photoId, expectedRevision: 0, patch: { saturation: -5, vibrance: 12 } },
        'This is a partial color patch, not a requirement to change both controls.',
      ),
    ],
  },
  'white-balance': {
    purpose: 'Separate source white balance from deliberate creative color treatment.',
    workflow: [
      'Read the photo’s white-balance capability and current settings. A technically neutral starting point can help evaluation, but do not remove intentional scene lighting merely to make every light white.',
      `For a supported single RAW, irodori_propose_white_balance accepts normalized oriented/lens-corrected source x/y and sample diameter ${whiteBalanceSampleSizes.join(', ')}. Inspect proposal validity before applying its combined whiteBalance at the same revision.`,
      'Retain fixed merged-master characterization. Use relative local mask Temperature/Tint or supported global creative color controls for the requested mood instead of treating them as camera calibration.',
    ],
    relatedTools: [
      'irodori_get_edits',
      'irodori_get_edit_capabilities',
      'irodori_propose_white_balance',
      'irodori_update_edits',
    ],
    limitations: [
      'Neutral-patch sampling can explicitly refuse dark, clipped, uneven or unsupported samples. A refusal does not authorize a fabricated white-balance measurement.',
    ],
    examples: [
      example(
        'irodori_propose_white_balance',
        {
          photoId,
          expectedRevision: 0,
          sample: { x: 0.5, y: 0.5, diameter: whiteBalanceSampleSizes[0] },
        },
        'Select a genuinely neutral, sufficiently lit source area and inspect the proposal status.',
      ),
    ],
  },
  crop: {
    purpose:
      'Use composition and geometry to support the photograph without losing the intended subject.',
    workflow: [
      'Read irodori_get_crop_context for authoritative oriented/lens-corrected dimensions and current crop geometry before building a complete crop patch.',
      'Consider subject placement, distracting edges and horizon when the request grants broad composition editing. Preserve deliberate framing for a precise tonal/color request.',
      'After crop, rotation or straighten changes, refresh preview and mask context before mapping new image positions. Geometry never follows screen zoom/pan.',
    ],
    relatedTools: [
      'irodori_get_crop_context',
      'irodori_update_edits',
      'irodori_get_preview_context',
      'irodori_get_mask_context',
    ],
    limitations: [
      'Never change a crop while a transient crop session is open. Stale region/grid context must be refreshed rather than silently replaced.',
    ],
    examples: [
      example(
        'irodori_get_crop_context',
        { photoId, expectedRevision: 0 },
        'Use the returned geometry to construct a valid complete crop; no crop is applied by this read.',
      ),
    ],
  },
  'mask-brush': {
    purpose: 'Paint or erase precise editable coverage and apply local Light/Color controls.',
    workflow: [
      'Read current masks/revision, then map normalized compact-preview or current cropped-output points through irodori_get_mask_context. Use the returned canonical source points for stroke operations; stored strokes are already canonical.',
      maskCreation,
      `Paint uses mode:"add"; Erase uses mode:"subtract". A stroke includes radius, feather and 1–${maskCapabilities.maxStrokePoints} points. Radius is a positive fraction of the canonical source’s shorter dimension; feather and x/y use normalized units. Read the schema for bounds.`,
      'Use componentId for a coverage part and strokeTarget:"primary" or "result" for its correction chain. Untargeted strokes address the root result. Include valid IDs and all required stroke fields.',
      relativeMaskColor,
      maskEdges,
      'Inspect an existing root with irodori_get_mask_preview using view:"coverage", "overlay" or "pair" and optional inspection region/resolutionPercent. It returns lossless PNGs of stored mask shape, including disabled or neutral-adjustment masks; read enabled/adjustmentsNeutral and verify the actual photo effect separately. Group related mutation operations as one photo-wide Undo step.',
    ],
    relatedTools: [
      'irodori_get_edits',
      'irodori_get_mask_context',
      'irodori_mutate_masks',
      'irodori_get_mask_preview',
      'irodori_get_photo_preview',
    ],
    limitations: [
      'Never use compact-preview pixel coordinates as native source coordinates. Edge softness is not recovered detail. A rejected batch creates no usable edit to claim as applied.',
    ],
    examples: [
      example(
        'irodori_mutate_masks',
        {
          photoId,
          expectedRevision: 0,
          maskMutation: {
            operations: [
              {
                kind: 'stroke',
                id: maskId,
                strokeTarget: 'result',
                stroke: {
                  mode: 'subtract',
                  radius: 0.025,
                  feather: 0.5,
                  points: [{ x: 0.5, y: 0.5 }],
                },
              },
            ],
          },
        },
        'The example erases result coverage. Replace its point with a mapped canonical point and use an existing mask ID.',
      ),
      example(
        'irodori_get_mask_preview',
        {
          photoId,
          expectedRevision: 0,
          maskId,
          view: 'pair',
          inspection: { resolutionPercent: 25 },
        },
        'Read the stored root’s grayscale coverage and labelled SDR overlay without changing its settings.',
      ),
    ],
  },
  'mask-object': {
    purpose: 'Create an inspected object-selection proposal with a frozen editable destination.',
    workflow: [
      'Read irodori_get_object_selection_context for current photo/revision/grid and mapped canonical box/points, then request a point/box proposal with irodori_create_object_selection.',
      `The current model is ${objectSelectionCapabilities.model}; it supports ${objectSelectionCapabilities.maxPromptSlots} prompt slots and a box uses two. Freeze selectionTarget as new-mask, new-component or replace-component before inference.`,
      'Inspect the separate native canonical coverage image before irodori_accept_object_selection commits it. Destination Light/Color, primary/result corrections and other coverage parts keep their existing owners.',
      'After acceptance, use the returned confirmed revision and accepted root UUID id in a kind:"update" operation through irodori_mutate_masks to apply local Light/Color. Accepting coverage alone does not brighten or darken the photograph.',
      'Use positive/negative prompts and manual Paint/Erase for observed holes, spill and unwanted fragments. Cancel unused pending proposals with irodori_cancel_object_selection.',
    ],
    relatedTools: [
      'irodori_get_object_selection_context',
      'irodori_create_object_selection',
      'irodori_accept_object_selection',
      'irodori_cancel_object_selection',
      'irodori_mutate_masks',
      'irodori_get_mask_preview',
    ],
    limitations: [
      'Inference scores do not establish finished mask quality or physical alpha. Generated bases, gradients and ranges are mutually exclusive; source replacement must be explicit. Do not promise dedicated sky/background classification or fine-detail matting that capabilities do not expose.',
    ],
    examples: [
      example(
        'irodori_get_object_selection_context',
        { photoId, expectedRevision: 0 },
        'This read supplies the revision/grid and capabilities before requesting inference.',
      ),
    ],
  },
  'mask-range': {
    purpose: 'Select stable source colors or luminance independently of later creative edits.',
    workflow: [
      'Ranges use the neutral canonical source before creative edits. Global/local edits and SDR/HDR display do not move their selection. Read mask context for the exact revision and renderingIdentity before sampling.',
      maskCreation,
      `irodori_sample_mask_range reads a clipped ${maskRangeCapabilities.sampleDiameter} × ${maskRangeCapabilities.sampleDiameter} native source neighborhood. Its point is normalized CURRENT CROPPED OUTPUT; returned color:{a,b} is brightness-normalized Oklab a/L,b/L, never RGB or ordinary Oklab.`,
      `Color ranges union one to ${maskRangeCapabilities.maxColorSamples} samples. Integer Range is ${maskRangeCapabilities.range.min}–${maskRangeCapabilities.range.max}; integer Softness is ${maskRangeCapabilities.softness.min}–${maskRangeCapabilities.softness.max}. Undefined black color directs you to a luminance range.`,
      `Luminance bounds use source-white percentages: ${maskRangeCapabilities.luminance.referenceWhite}=white, HDR may exceed it, and upper:null means all brighter values. A range update replaces the complete range record.`,
      'Changing an existing generated/gradient/range source kind requires replacePrimary:true and preserves corrections, operands and root adjustments. Inspect the range base/coverage and its photo effect.',
    ],
    relatedTools: [
      'irodori_get_mask_context',
      'irodori_sample_mask_range',
      'irodori_mutate_masks',
      'irodori_get_mask_preview',
    ],
    limitations: [
      'A source-color match alone does not restrict location. Intersect with spatial coverage when the photographic goal is regional. Resource refusals do not authorize a global substitute or an automatic CPU retry.',
    ],
    examples: [
      example(
        'irodori_mutate_masks',
        {
          photoId,
          expectedRevision: 0,
          maskMutation: {
            operations: [
              {
                kind: 'create',
                id: maskId,
                name: 'Source luminance selection',
                range: { ...defaultLuminanceMaskRange },
              },
            ],
          },
        },
        'Use a fresh mask ID and source-white bounds appropriate to the intended light range.',
      ),
    ],
  },
  'mask-compound': {
    purpose:
      'Combine and refine editable spatial/range coverage without duplicating local adjustments.',
    workflow: [
      maskCreation,
      `Each node evaluates primary source/strokes, ordered enabled operands, result corrections, inversion, shift and feather. Add uses ${maskCapabilities.compound.add}, Subtract ${maskCapabilities.compound.subtract}, Intersect ${maskCapabilities.compound.intersect}. Starting coverage never moves when operands reorder.`,
      'component-add/copy/update/duplicate/remove/reorder edit owned nested parts. Copies have fresh IDs and independently editable geometry; they share immutable content without a live dependency on their source. Only coverage is copied; destination Light/Color applies once.',
      `Limits include disabled parts: ${maskCapabilities.maxNodesPerMask} nodes per root, ${maskCapabilities.maxNodesPerPhoto} per photograph and depth ${maskCapabilities.maxDepth}. Top-first mask list order applies the top row last.`,
      `Linear gradients fade full start to zero end. Radial gradients select inside; centers/endpoints use ${maskCapabilities.gradient.pointMin}–${maskCapabilities.gradient.pointMax}, radii at most ${maskCapabilities.gradient.radialRadiusMax}, rotation ${maskCapabilities.gradient.rotation.min}–${maskCapabilities.gradient.rotation.max} degrees and Feather integer ${maskCapabilities.gradient.feather.min}–${maskCapabilities.gradient.feather.max}. Separation and both radii need at least ${maskCapabilities.gradient.minimumSourcePixels} source pixel.`,
      'Read mask context with allowOutsidePhoto:true only when mapping extended gradient points; ordinary brush points stay within the photo. Gradient updates replace the whole geometry.',
      maskEdges,
    ],
    relatedTools: ['irodori_get_mask_context', 'irodori_mutate_masks', 'irodori_get_mask_preview'],
    limitations: [
      'One node cannot simultaneously contain a generated base, gradient and range. Controls preserve composition order; do not flatten editable coverage or copy source Light/Color into the destination implicitly.',
    ],
    examples: [
      example(
        'irodori_mutate_masks',
        {
          photoId,
          expectedRevision: 0,
          maskMutation: {
            operations: [
              {
                kind: 'create',
                id: maskId,
                name: 'Editable spatial selection',
                gradient: {
                  kind: 'radial',
                  center: { x: 0.5, y: 0.5 },
                  radiusX: 0.2,
                  radiusY: 0.2,
                  rotation: 0,
                  feather: maskCapabilities.gradient.feather.default,
                },
              },
              { kind: 'update', id: maskId, light: { exposureEv: 0.25 } },
            ],
          },
        },
        'Creation and local adjustment use separate operations with the same fresh UUID in one accepted batch. This demonstrates syntax, not a photo recipe; choose mapped geometry and adjustments from the actual image.',
      ),
      example(
        'irodori_mutate_masks',
        {
          photoId,
          expectedRevision: 0,
          maskMutation: {
            operations: [
              {
                kind: 'component-add',
                id: maskId,
                componentId,
                name: 'Exclude central region',
                operator: 'subtract',
                gradient: {
                  kind: 'radial',
                  center: { x: 0.5, y: 0.5 },
                  radiusX: 0.2,
                  radiusY: 0.2,
                  rotation: 0,
                  feather: maskCapabilities.gradient.feather.default,
                },
              },
            ],
          },
        },
        'Use an existing root ID and a fresh component ID; map actual geometry before applying.',
      ),
    ],
  },
  detail: {
    purpose: 'Balance actual noise, texture and edge definition at a meaningful viewing scale.',
    workflow: [
      'Inspect a useful native region before choosing luminance/chroma noise reduction or detail sharpening. Distinguish genuine fine texture from noise and inspect halos or smearing after changes.',
      'Read current detail capability bounds, then use partial noiseReduction/detailSharpening patches. Keep unrelated controls and the requested creative style intact.',
      'Inspect the confirmed native result. Use export-native proofing to evaluate output sharpening after resizing; it is separate from saved detail sharpening.',
    ],
    relatedTools: [
      'irodori_get_edit_capabilities',
      'irodori_get_photo_preview',
      'irodori_update_edits',
      'irodori_get_output_proof',
    ],
    limitations: [
      'The compact overview cannot establish native sharpness or noise quality. Do not claim to recover genuinely missing focus/detail or silently replace unsupported local denoising with global denoising.',
    ],
    examples: [
      example(
        'irodori_get_edit_capabilities',
        {},
        'Discover the current supported detail controls and ranges before constructing a patch.',
      ),
    ],
  },
  inspection: {
    purpose: 'Obtain image evidence at the correct revision, spatial extent and rendition.',
    workflow: [
      'Read preview context for authoritative dimensions, grid, encodings and payload limits, and presentation context for selected/effective display mode versus delivered rendition. Coordinates address the complete current oriented/lens-corrected/cropped photo, independently of zoom/pan.',
      'A frozen editor inspection region remains the requested assessment extent. Use its exact photoId/region/gridIdentity; geometry changes need fresh context and a stale region must not silently become the whole photo.',
      'inspection supports pixel/normalized grid-bound regions, resolutionPercent independent of JPEG quality, SDR PNG/JPEG and comparison after/before/pair. 100 percent means photo-native for previews and export-native for decoded output proofs.',
      `Legacy calls omit inspection and return a whole-image 1024-pixel SDR JPEG at quality 80 within ${AGENT_PREVIEW_LIMIT / 1024 ** 2} MiB. Extended image/pair limits are ${INSPECTION_IMAGE_LIMIT / 1024 ** 2}/${INSPECTION_PAIR_LIMIT / 1024 ** 2} MiB. Explicitly reduce extent/resolution/transfer quality after a payload refusal.`,
      'Matched members share the current confirmed revision, geometry, extent, dimensions, encoding and rendition. Before neutralizes tonal/color/local edits and denoise/sharpening while preserving current crop/lens; it is not historical. Compare a captured starting image when preserving or refining an existing grade.',
    ],
    relatedTools: [
      'irodori_get_preview_context',
      'irodori_get_photo_presentation_context',
      'irodori_get_photo_preview',
      'irodori_get_mask_preview',
      'irodori_get_output_proof',
    ],
    limitations: [
      'JPEG quality 100 is lossy. SDR images of HDR sources remain SDR; metadata/statistics do not qualify true HDR image delivery or physical luminance. Never substitute thumbnails or obtain originals by another route.',
    ],
    examples: [
      example(
        'irodori_get_photo_preview',
        {
          photoId,
          expectedRevision: 0,
          inspection: {
            region: {
              units: 'normalized',
              x: 0.3,
              y: 0.3,
              width: 0.2,
              height: 0.2,
              gridIdentity: 'b'.repeat(64),
            },
            resolutionPercent: 100,
            encoding: { format: 'png' },
            comparison: 'pair',
            hdr: false,
          },
        },
        'Use a current requested region and its grid identity; these numeric bounds only illustrate the shape.',
      ),
    ],
  },
  export: {
    purpose:
      'Assess the actual intended output without changing the master or workspace preference.',
    workflow: [
      'Read export capabilities/preferences and create an owned export preparation. Request output proofs with explicit options and a fresh proofToken; release the preparation afterward. Proofs require no destination and change no photo history or Last custom preferences.',
      'For an explicit SDR deliverable, proof the confirmed artistic grade and masks with output:"sdr" even when the editor displays HDR. Existing RAW/merge SDR rendering already performs tone/chroma/gamut mapping; absence of an editor-mode tool is not absence of SDR rendering.',
      'Proofs encode/decode each complete export before extracting regions. Transfer JPEG quality is independent of export JPEG quality; matched members retain identical export options and output sharpening.',
      `Use outputSharpening:${outputSharpeningCapabilities.modes.map((mode) => JSON.stringify(mode)).join(', ')}. For requested output sharpening without a strength, use Standard as the starting point; absent sharpening remains Off. Do not change saved detailSharpening for an export-only request.`,
      'Preserve explicit pixel options between proof and export, report effective sharpening strength/operator version from metadata, and use export-native inspection for detail. Export publication needs the existing destination and authorization.',
    ],
    relatedTools: [
      'irodori_get_export_capabilities',
      'irodori_get_export_preferences',
      'irodori_prepare_export',
      'irodori_get_output_proof',
      'irodori_dispose_export_preparation',
      'irodori_start_export',
    ],
    limitations: [
      'Saturation reduction alone does not establish SDR tone/gamut appearance. Encoded range validity is not proof of retained highlight texture or perceptual equivalence to HDR. True HDR appearance needs qualified image delivery or direct HDR display review.',
    ],
    examples: [
      example(
        'irodori_get_output_proof',
        {
          preparationId: '00000000-0000-0000-0000-000000000003',
          photoId,
          options: { ...defaultExportOptions, output: 'sdr' },
          proofToken: '00000000-0000-0000-0000-000000000004',
        },
        'Prepare this confirmed photo first and use its returned preparationId; this requests an SDR proof, not an export.',
      ),
    ],
  },
  presets: {
    purpose:
      'Save and apply reusable named definitions without confusing management with photo edits.',
    workflow: [
      'Inspection, creation and update of a preset change no photo or clipboard. Application is explicit. Capture confirmed edits with source.mode:"photo", photoId and selected groups; use expectedPresetRevision for preset conflicts separately from photo revisions.',
      `For a look without photo editing, source.mode:"explicit" uses current settingsVersion:${SETTINGS_VERSION}, selected groups and complete values for every selected group. Camera-dependent groups need a verified referencePhotoId in the frozen targets. Correct schema errors rather than guessing field names or declaring preset creation unavailable.`,
      'Choose an exposed scenario icon/color matching intent when creating a preset, such as sunset/amber for Golden Hour. Markers are labels, not processing effects. Preserve appearance during updates unless the user requests a change.',
      'Deleting a preset needs an explicit user instruction for that identified preset or a later in-Console agreement. Otherwise name it, ask and wait. Listing, creation or application never grants deletion permission.',
    ],
    relatedTools: [
      'irodori_list_presets',
      'irodori_get_preset',
      'irodori_create_preset',
      'irodori_update_preset',
      'irodori_delete_preset',
      'irodori_prepare_preset_application',
    ],
    limitations: [
      'Preset history and revisions are independent of photo edits. Omit unselected groups and never copy calibration tables, filesystem paths or unsupported controls into explicit definitions.',
    ],
    examples: [
      example(
        'irodori_create_preset',
        {
          presetRequest: {
            name: 'Muted warm palette',
            source: {
              mode: 'explicit',
              settingsVersion: SETTINGS_VERSION,
              groups: ['color'],
              values: { saturation: -5, vibrance: 12 },
            },
            appearance: { icon: 'sunset', color: 'amber' },
          },
        },
        'This stores a complete color-group definition without applying it to a photograph.',
      ),
    ],
  },
}

export function validateEditingGuidanceRequest(value: unknown): EditingGuidanceRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'topic')
  )
    throw new Error('Editing guidance requires exactly one field: topic.')
  const topic = (value as Record<string, unknown>).topic
  if (typeof topic !== 'string' || !editingGuidanceTopics.includes(topic as EditingGuidanceTopic))
    throw new Error(`Editing guidance topic must be one of: ${editingGuidanceTopics.join(', ')}.`)
  return { topic: topic as EditingGuidanceTopic }
}

/** Read-only operator reference. No photograph, filesystem or session state is accessed. */
export function getEditingGuidance(value: unknown): EditingGuidance {
  const { topic } = validateEditingGuidanceRequest(value)
  return structuredClone({ version: 1 as const, topic, ...guidance[topic] })
}
