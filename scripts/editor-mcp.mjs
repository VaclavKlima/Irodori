import { agentTools } from '../src/main/agent/policy.ts'
import { presetGroupKeys } from '../src/shared/preset-controls.ts'
import { presetIcons, presetColors } from '../src/shared/preset-appearance.ts'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profile =
  process.env.IRODORI_PROFILE ??
  (process.platform === 'win32'
    ? join(process.env.APPDATA ?? homedir(), 'Irodori')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Irodori')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Irodori'))
const photoId = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const expectedRevision = { type: 'integer', minimum: 0 }
const schema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const inspection = schema(
  {
    region: schema({
      units: { enum: ['pixels', 'normalized'] },
      x: { type: 'number', minimum: 0 },
      y: { type: 'number', minimum: 0 },
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
      gridIdentity: { type: 'string' },
    }),
    resolutionPercent: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
    encoding: {
      oneOf: [
        schema(
          { format: { const: 'jpeg' }, quality: { type: 'integer', minimum: 1, maximum: 100 } },
          ['format'],
        ),
        schema({ format: { const: 'png' } }),
      ],
    },
    comparison: { enum: ['after', 'before', 'pair'] },
    hdr: { type: 'boolean' },
  },
  [],
)
const mergeSettings = schema({
  mode: { enum: ['hdr', 'noise'] },
  referenceId: photoId,
  autoAlign: { type: 'boolean' },
  autoCrop: { type: 'boolean' },
  deghost: { type: 'boolean' },
  strength: { type: 'integer', minimum: 0, maximum: 100 },
})
const reviewId = { type: 'string' }
const browseQuery = schema({
  search: { type: 'string', maxLength: 500 },
  grouping: { enum: ['date', 'month', 'year'] },
})
const colorAmount = { type: 'integer', minimum: -100, maximum: 100 }
const curveChannel = { enum: ['master', 'red', 'green', 'blue'] }
const curvePoints = {
  type: 'array',
  minItems: 2,
  maxItems: 16,
  items: schema({
    input: { type: 'number', minimum: -16, maximum: 64 },
    output: { type: 'number', minimum: -16, maximum: 64 },
  }),
}
const colorMixerRange = schema(
  { hue: colorAmount, saturation: colorAmount, luminance: colorAmount },
  [],
)
const gradingTone = schema(
  {
    hue: { type: 'number', minimum: 0, maximum: 359.9, multipleOf: 0.1 },
    saturation: { type: 'integer', minimum: 0, maximum: 100 },
    luminance: colorAmount,
  },
  [],
)
const exportOptionsSchema = schema(
  {
    version: { const: 1 },
    output: { enum: ['auto', 'sdr', 'hdr'] },
    quality: { type: 'integer', minimum: 1, maximum: 100 },
    size: {
      oneOf: [
        schema({ mode: { const: 'original' } }),
        schema(
          {
            mode: { const: 'longest' },
            edge: { type: 'integer', minimum: 1, maximum: 32768 },
            allowEnlargement: { type: 'boolean', default: false },
            method: { const: 'lanczos3', default: 'lanczos3' },
          },
          ['mode', 'edge'],
        ),
        schema(
          {
            mode: { const: 'fit' },
            width: { type: 'integer', minimum: 1, maximum: 32768 },
            height: { type: 'integer', minimum: 1, maximum: 32768 },
            allowEnlargement: { type: 'boolean', default: false },
            method: { const: 'lanczos3', default: 'lanczos3' },
          },
          ['mode', 'width', 'height'],
        ),
      ],
    },
    names: {
      oneOf: [
        schema({ mode: { const: 'original' }, suffix: { type: 'string', maxLength: 100 } }),
        schema({
          mode: { const: 'sequence' },
          prefix: { type: 'string', minLength: 1, maxLength: 100 },
        }),
      ],
    },
    metadata: { enum: ['camera-copyright', 'copyright', 'none'] },
    existing: { enum: ['rename', 'skip'] },
    outputSharpening: {
      enum: ['off', 'low', 'standard', 'high'],
      default: 'off',
      description:
        'Export-only sharpening at final output size. Standard is the suggested starting point when sharpening is requested without a strength. Does not change saved detail sharpening.',
    },
  },
  ['version', 'output', 'quality', 'size', 'names', 'metadata', 'existing'],
)
let tools = [
  {
    name: 'irodori_get_editor_context',
    description:
      'Read the active photograph, confirmed revisions, frozen selection page, workspace, transient editing state and development mode. Selection paging never retargets an active managed request.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'irodori_get_preview_context',
    description:
      'Read authoritative oriented, lens-corrected, cropped photo dimensions and grid identity, inspection formats, payload limits and HDR availability. Coordinates are independent of screen zoom/pan. Read before requesting a region.',
    inputSchema: schema({ photoId, expectedRevision }),
  },
  {
    name: 'irodori_get_photo_preview',
    description:
      'Inspect the complete photograph or a grid-bound pixel/normalized region. Optional inspection controls resolutionPercent independently from JPEG quality or lossless SDR PNG, comparison after/before/pair, and strict HDR. 100 percent is photo-native; omitted resolution fits the selected extent within 1024 pixels without enlargement. Before is a neutral rendition of the confirmed revision with current crop/lens geometry, not a historical revision. Extended payload limits are 8 MiB per image and 16 MiB per pair; oversized requests fail without reducing quality/resolution. HDR delivery requires a qualified client; SDR images cannot establish physical HDR luminance. Omit inspection for legacy whole-image SDR JPEG 1024/q80/1 MiB.',
    inputSchema: schema({ photoId, expectedRevision, inspection }, ['photoId', 'expectedRevision']),
  },
  {
    name: 'irodori_get_output_proof',
    description:
      'Encode/decode a frozen export using shared Output preview including output sharpening. Prepare export first; use a unique UUID proofToken. Optional inspection shares photo region/grid, resolution, JPEG/PNG, matched neutral Before/After and HDR contracts. Regions map into the decoded export grid; 100 percent is export-native and may differ from photo-native. Both complete pair members are separately encoded/decoded with identical export settings before region extraction. Export JPEG quality in options and transfer JPEG quality in inspection are independent. No destination/history/preference writes. Omit inspection for legacy compact SDR overview. HDR vision remains capability gated.',
    inputSchema: schema(
      {
        preparationId: { type: 'string' },
        photoId,
        options: exportOptionsSchema,
        proofToken: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
        inspection,
      },
      ['preparationId', 'photoId', 'options', 'proofToken'],
    ),
  },
  {
    name: 'irodori_get_edit_clipboard',
    description:
      'Read the session-local copied-edit source and available groups; copied settings remain main-owned.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_copy_edits',
    description:
      'Flush pending edits for this photo and copy its confirmed settings into a frozen session clipboard. Later source edits do not change the copy.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_prepare_paste_edits',
    description:
      'Freeze the complete destination selection, revisions and explicit groups. Defaults in the UI exclude crop, white balance and lens. Reports incompatible targets without silently dropping them. No photograph is changed.',
    inputSchema: schema({
      pasteRequest: schema({
        clipboardId: { type: 'string' },
        photoIds: { type: 'array', minItems: 1, maxItems: 100000, items: photoId },
        groups: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              'light',
              'curves',
              'color',
              'mixer',
              'grading',
              'noise',
              'sharpening',
              'crop',
              'white-balance',
              'lens',
            ],
          },
        },
      }),
    }),
  },
  {
    name: 'irodori_dispose_paste_preparation',
    description: 'Discard an unused paste preparation without changing photos.',
    inputSchema: schema({ preparationId: { type: 'string' } }),
  },
  {
    name: 'irodori_start_paste_edits',
    description:
      'Apply a prepared frozen copy as a bounded cancellable background task. Revision conflicts and incompatible targets are retained per photo. Each changed photo receives one ordinary Undo/Redo step. Restart retains completed results and does not replay unfinished edits.',
    inputSchema: schema({ preparationId: { type: 'string' } }),
  },
  {
    name: 'irodori_get_edit_application_results',
    description:
      'Read retained per-photo results in frozen selection order, including applied, unchanged, conflicts, unavailable, failed and unfinished outcomes.',
    inputSchema: schema({ taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'taskId',
    ]),
  },

  {
    name: 'irodori_get_export_capabilities',
    description:
      'Read JPEG export capabilities, supported output-sharpening strengths and default, and pinned operator, codec and rendering versions. HDR export is independent of the current monitor.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_export_preferences',
    description:
      'Read the remembered authorized destination ID and its availability, and Last custom settings. Destination paths cannot be supplied through MCP; the user authorizes folders in the application.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_prepare_export',
    description:
      'Prepare the complete ordered photo ID set and freeze committed revisions without source leases. Returns a preparation ID, target count and HDR eligibility. Preparation expires after 15 minutes.',
    inputSchema: schema({ ids: { type: 'array', minItems: 1, maxItems: 100000, items: photoId } }),
  },
  {
    name: 'irodori_dispose_export_preparation',
    description: 'Discard an unused export preparation without changing export preferences.',
    inputSchema: schema({ preparationId: { type: 'string' } }),
  },
  {
    name: 'irodori_start_export',
    description:
      'Revalidate a preparation and authorized destination, atomically accept immutable JPEG output settings and source leases, and enqueue a background task. Custom outputSharpening selects off, low, standard or high at the final output size without changing photo edits; omitted means off. Quick presets use Auto output and sharpening off. Explicit HDR rejects unsupported sources. Custom options require version, output, quality, size, names, metadata and existing fields; the same application validator serves UI and MCP. No arbitrary write paths or replacement are allowed.',
    inputSchema: schema({
      exportRequest: schema(
        {
          preparationId: { type: 'string' },
          destinationId: { type: 'string' },
          action: { enum: ['maximum', 'high', 'smaller', 'custom', 'last-custom'] },
          options: exportOptionsSchema,
        },
        ['preparationId', 'destinationId', 'action'],
      ),
    }),
  },
  {
    name: 'irodori_get_export_results',
    description:
      'Read retained per-file export results in frozen selection order, including exported, skipped, failed and cancelled outcomes, plus the frozen output-sharpening strength and operator version.',
    inputSchema: schema({ taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'taskId',
    ]),
  },
  {
    name: 'irodori_get_photo_actions_context',
    description:
      'Read canonical photo, selection and persisted photo-group targets, counts, revisions, target equivalence and per-command availability. Uses stored catalog facts only; no decoding. Unrelated imports may update revisions without changing targetIdentity. Mutations still revalidate their targets.',
    inputSchema: schema({
      photoId: { anyOf: [photoId, { type: 'null' }] },
      selectedIds: { type: 'array', items: photoId, uniqueItems: true },
    }),
  },
  {
    name: 'irodori_get_browse_summary',
    description:
      'Read matching Library sections and selected counts by camera calendar date, month, or year. Search uses case-insensitive literal terms across filename, camera, lens, format and capture date.',
    inputSchema: schema(
      { query: browseQuery, selectedIds: { type: 'array', items: photoId, uniqueItems: true } },
      ['query'],
    ),
  },
  {
    name: 'irodori_get_browse_chunk',
    description:
      'Read 60 individual photos in capture date descending order, including hidden stack members and merge results. Optional catalog revision rejects stale reads.',
    inputSchema: schema(
      { query: browseQuery, offset: { type: 'integer', minimum: 0 }, expectedRevision },
      ['query'],
    ),
  },
  {
    name: 'irodori_locate_browse_photo',
    description:
      'Locate a photo in the current Library search order without changing selection or active photo.',
    inputSchema: schema({ query: browseQuery, photoId, expectedRevision }, ['query', 'photoId']),
  },
  {
    name: 'irodori_get_browse_range',
    description:
      'Read inclusive individual photo references in search order. Browser ranges never expand stacks; a missing anchor falls back to the target.',
    inputSchema: schema({ query: browseQuery, fromId: photoId, toId: photoId }),
  },
  {
    name: 'irodori_get_browse_section',
    description:
      'Read every matching photo reference in a date, month, year or unknown section, including unloaded photos.',
    inputSchema: schema({ query: browseQuery, sectionKey: { type: 'string' } }),
  },
  {
    name: 'irodori_list_stacks',
    description: 'Read stack summaries and the gallery revision for manual grouping.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_photo_stack',
    description: 'Read a photo’s stack and its current revision.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_get_stack_members',
    description: 'Read 60 ordered stack members, cover first.',
    inputSchema: schema({ stackId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'stackId',
    ]),
  },
  {
    name: 'irodori_get_stack_snapshot',
    description:
      'Read every current stack member in persisted order, including originals and previous merge results. Requires the displayed stack revision; stale or missing stacks fail.',
    inputSchema: schema({ stackId: { type: 'string' }, expectedRevision }),
  },
  {
    name: 'irodori_group_photos',
    description:
      'Group ungrouped photos with a selected cover. expectedRevision comes from list_stacks.',
    inputSchema: schema({
      ids: { type: 'array', items: photoId, minItems: 2, uniqueItems: true },
      coverId: photoId,
      expectedRevision,
    }),
  },
  {
    name: 'irodori_ungroup_stack',
    description:
      'Ungroup a stack, remembering this manual choice for automatic scans. Requires the stack revision.',
    inputSchema: schema({ stackId: { type: 'string' }, expectedRevision }),
  },
  {
    name: 'irodori_remove_from_stack',
    description: 'Remove one member without deleting its photo. Requires the stack revision.',
    inputSchema: schema({ photoId, expectedRevision }),
  },
  {
    name: 'irodori_set_stack_cover',
    description: 'Choose a member as cover using the stack revision.',
    inputSchema: schema({ stackId: { type: 'string' }, photoId, expectedRevision }),
  },
  {
    name: 'irodori_set_stack_expanded',
    description:
      'Persist inline expansion using the stack revision; preserves selections and active photo.',
    inputSchema: schema({
      stackId: { type: 'string' },
      expanded: { type: 'boolean' },
      expectedRevision,
    }),
  },
  {
    name: 'irodori_get_gallery_summary',
    description:
      'Read visible/stored totals and coherent catalog/stack revisions without decoding originals.',
    inputSchema: schema({ selectedIds: { type: 'array', items: photoId } }, []),
  },
  {
    name: 'irodori_get_gallery_chunk',
    description: 'Read up to 60 gallery records at a coherent catalog and stack revision.',
    inputSchema: schema({
      offset: { type: 'integer', minimum: 0 },
      galleryRevision: schema({ catalogRevision: expectedRevision, revision: expectedRevision }),
    }),
  },
  {
    name: 'irodori_list_gallery',
    description: 'Read 60 visible photo rows, with parent stack and stored-photo totals.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'irodori_locate_gallery_photo',
    description: 'Locate or navigate a visible row; hidden photos use their cover position.',
    inputSchema: schema({ photoId, direction: { type: 'integer', enum: [-1, 0, 1] } }, ['photoId']),
  },
  {
    name: 'irodori_get_gallery_range',
    description:
      'Read an inclusive gallery range in gallery order. Included covers select all current stack members, including collapsed or unloaded members, in persisted order. Hidden boundaries use their covers; member-only ranges remain individual.',
    inputSchema: schema({ fromId: photoId, toId: photoId }),
  },
  {
    name: 'irodori_group_capture_sequences',
    description:
      'Start a cancellable metadata-only scan of managed originals for verified Sony ZV-1A ARW continuous captures. BRK remains unverified.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_active_merge_review',
    description: 'Read the active merge review without starting or recomputing processing.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_merge_diagnostics',
    description:
      'Read alignment diagnostics and structured failure for the current review revision, including after failure. No paths are returned.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'irodori_create_merge_review',
    description:
      'Validate 2–32 Sony RAW photo IDs and lease their sources for HDR or noise stacking.',
    inputSchema: schema({
      ids: { type: 'array', items: photoId, minItems: 2, maxItems: 32, uniqueItems: true },
      mode: { enum: ['hdr', 'noise'] },
    }),
  },
  {
    name: 'irodori_update_merge_review',
    description:
      'Update bounded merge settings using the current review revision; cancels superseded preparation.',
    inputSchema: schema({ reviewId, expectedRevision, settings: mergeSettings }),
  },
  {
    name: 'irodori_request_merge_preview',
    description:
      'Prepare and validate the native merge. Returns full-resolution result, reference and overlay URLs and the reviewed recipe.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'irodori_start_merge',
    description:
      'Freeze the prepared recipe and publish a new editable master as a background task.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'irodori_dispose_merge_review',
    description: 'Cancel review preparation and release source leases.',
    inputSchema: schema({ reviewId }),
  },
  {
    name: 'irodori_get_merge_provenance',
    description: 'Read permanent recipe, source capture metadata and source availability.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_list_tasks',
    description: 'Read background task progress and result photo IDs.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_task_errors',
    description: 'Read up to 60 background task errors.',
    inputSchema: schema({ taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'taskId',
    ]),
  },
  {
    name: 'irodori_cancel_task',
    description: 'Cancel a background task, waiting for durable publication when necessary.',
    inputSchema: schema({ taskId: { type: 'string' } }),
  },
  {
    name: 'irodori_dismiss_task',
    description: 'Dismiss a finished task.',
    inputSchema: schema({ taskId: { type: 'string' } }),
  },
  {
    name: 'irodori_get_preview_diagnostics',
    description:
      'Read preview preparation, cache, loading and presentation diagnostics for the active photo.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_display_state',
    description:
      'Read the requested preference, detected monitor/adapter capabilities, target, actual frame presentation and unverified physical-output status.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_set_preview_preference',
    description: 'Set workspace Auto, HDR, or SDR preference without changing photo edits.',
    inputSchema: schema({ preference: { enum: ['auto', 'hdr', 'sdr'] } }),
  },
  {
    name: 'irodori_get_photo_statistics',
    description:
      'Exact committed statistics. Omit domain for compatible SDR sRGB bins. working-hdr is scene-linear; content-hdr is fixed Rec.2020 HDR content; output is the presented rendition. Current display diagnostics require targetGeneration from display state.',
    inputSchema: schema(
      {
        photoId,
        expectedRevision,
        domain: { enum: ['working-hdr', 'content-hdr', 'output'] },
        target: { enum: ['sdr', 'current'] },
        targetGeneration: { type: 'integer', minimum: 0 },
      },
      ['photoId', 'expectedRevision'],
    ),
  },
  {
    name: 'irodori_get_photo_pixel',
    description:
      'Sample committed HDR edits at integer native-image coordinates, including merged masters. working-hdr is scene-linear; content-hdr is fixed Rec.2020 HDR content; output is the presented rendition. Returns linear RGB, alpha and brightness relative to reference white. Current output requires targetGeneration from display state.',
    inputSchema: schema(
      {
        photoId,
        expectedRevision,
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        domain: { enum: ['working-hdr', 'content-hdr', 'output'] },
        target: { enum: ['sdr', 'current'] },
        targetGeneration: { type: 'integer', minimum: 0 },
      },
      ['photoId', 'expectedRevision', 'x', 'y', 'domain'],
    ),
  },
  {
    name: 'irodori_list_photos',
    description: 'List imported photos, 60 per chunk.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'irodori_get_edit_capabilities',
    description:
      'Read supported global color operators, versioned semantics, source domains, range/tone IDs, parameter units and limits. White-balance provider support is returned by irodori_get_edits for each photo.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_get_edits',
    description: 'Read confirmed settings and revision.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_get_crop_context',
    description:
      'Read authoritative oriented and lens-corrected native dimensions, crop geometry and the confirmed revision. Use this source geometry when constructing a crop patch; export never fits invalid framing automatically.',
    inputSchema: schema({ photoId, expectedRevision }),
  },
  {
    name: 'irodori_propose_white_balance',
    description:
      'Read a neutral white-balance proposal from a supported single RAW capture before creative edits. Coordinates refer to the oriented, lens-corrected native image. Inspect validity, then apply its combined whiteBalance with irodori_update_edits at the same expected revision.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      sample: schema({
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        diameter: { type: 'integer', enum: [7, 15, 31] },
      }),
    }),
  },
  {
    name: 'irodori_sample_curve_tone',
    description:
      'Read a revision-bound 5 by 5 tone sample from the prepared working source, after white balance and Light. Master samples linear luminance before Master; RGB samples its working-space channel after Master. Normalized coordinates refer to the uncropped, oriented and lens-corrected source. Transparent samples are ignored. This operation changes no edits.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      curveSample: schema({
        channel: curveChannel,
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
      }),
    }),
  },
  {
    name: 'irodori_get_edit_history',
    description: 'Read ordered settings snapshots and history cursor.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_get_mask_context',
    description:
      'Read revision-bound canonical/current cropped-output dimensions and map up to 128 normalized compact-preview positions to canonical source coordinates for brush strokes. Main applies the exact crop/lens/flip pull mapping; the response omits full geometry. Reuse prepared source data; no photo edit.',
    inputSchema: schema(
      {
        photoId,
        expectedRevision,
        points: {
          type: 'array',
          maxItems: 128,
          items: schema({
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
          }),
        },
      },
      ['photoId', 'expectedRevision'],
    ),
  },
  {
    name: 'irodori_get_object_selection_context',
    description:
      'Read object-selection capabilities and the frozen photograph/revision/grid. Optionally map a normalized current-photo box and points into canonical source coordinates. Use returned canonical box/points for selection prompts; no edit or inference.',
    inputSchema: schema(
      {
        photoId,
        expectedRevision,
        box: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: { type: 'number', minimum: 0, maximum: 1 },
        },
        points: {
          type: 'array',
          maxItems: 128,
          items: schema({
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
          }),
        },
      },
      ['photoId', 'expectedRevision'],
    ),
  },
  {
    name: 'irodori_create_object_selection',
    description:
      'Generate a SAM 2 object proposal using the confirmed canonical grid and box/positive/negative points. Returns a native canonical black/white coverage image separately from metadata. Does not edit history. Optional maskId preserves its manual strokes and controls. Six slots maximum; box uses two. Inspect before explicit acceptance; Paint/Erase repairs approximate edges.',
    inputSchema: schema(
      {
        photoId,
        expectedRevision,
        gridIdentity: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        maskId: { type: 'string', format: 'uuid' },
        prompts: schema(
          {
            box: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              items: { type: 'number', minimum: 0, maximum: 1 },
            },
            positivePoints: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
            negativePoints: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
          ['positivePoints', 'negativePoints'],
        ),
      },
      ['photoId', 'expectedRevision', 'gridIdentity', 'prompts'],
    ),
  },
  {
    name: 'irodori_accept_object_selection',
    description:
      'Accept an inspected proposal as one shared Undo step. Creates a named Object mask or replaces the requested mask base while retaining manual strokes, controls and ordering. Refuses stale revision/source/grid. No model execution on history or export.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      proposalId: { type: 'string', format: 'uuid' },
    }),
  },
  {
    name: 'irodori_cancel_object_selection',
    description:
      'Cancel pending object inference and discard its temporary proposal without changing accepted masks or history.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'irodori_mutate_masks',
    description:
      'Commit bounded mask operations as one photo-wide Undo step. Top-first list order applies bottom-to-top. Partial color updates accept relative temperature, tint and saturation, each integer -100 to +100 with 0 neutral. Positive temperature warms and positive tint adds magenta; these are relative units, not Kelvin or camera white balance. Each mask applies color balance, Light, then saturation and blends coverage once. Global white balance is unchanged. Geometry is normalized to the oriented uncorrected source, radius is a fraction of its shorter dimension. Whole-mask edge updates accept featherPx (0–64 in half-pixel steps) and shiftPx (-16–16 integer canonical source pixels); positive shift grows the affected region after inversion. Coverage order is base plus Paint/Erase, inversion, shift, then feather. These controls do not recover missing fine detail. Read current masks and revision with irodori_get_edits. Use the separate object-selection tools for AI proposals; gradients and range masks remain unavailable.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      maskMutation: schema({
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            type: 'object',
            oneOf: [
              schema({
                kind: { const: 'create' },
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string', minLength: 1, maxLength: 100 },
              }),
              schema(
                {
                  kind: { const: 'update' },
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string', minLength: 1, maxLength: 100 },
                  enabled: { type: 'boolean' },
                  inverted: { type: 'boolean' },
                  color: schema(
                    {
                      temperature: colorAmount,
                      tint: colorAmount,
                      saturation: colorAmount,
                    },
                    [],
                  ),
                  edge: schema(
                    {
                      featherPx: { type: 'number', minimum: 0, maximum: 64, multipleOf: 0.5 },
                      shiftPx: { type: 'integer', minimum: -16, maximum: 16 },
                    },
                    [],
                  ),
                  light: schema(
                    {
                      exposureEv: { type: 'number', minimum: -5, maximum: 5, multipleOf: 0.01 },
                      contrast: colorAmount,
                      highlights: colorAmount,
                      shadows: colorAmount,
                      whites: colorAmount,
                      blacks: colorAmount,
                    },
                    [],
                  ),
                },
                ['kind', 'id'],
              ),
              schema({
                kind: { const: 'duplicate' },
                id: { type: 'string', format: 'uuid' },
                newId: { type: 'string', format: 'uuid' },
                name: { type: 'string', minLength: 1, maxLength: 100 },
              }),
              schema({ kind: { const: 'delete' }, id: { type: 'string', format: 'uuid' } }),
              schema({
                kind: { const: 'reorder' },
                ids: {
                  type: 'array',
                  maxItems: 32,
                  uniqueItems: true,
                  items: { type: 'string', format: 'uuid' },
                },
              }),
              schema({
                kind: { const: 'stroke' },
                id: { type: 'string', format: 'uuid' },
                stroke: schema({
                  mode: { enum: ['add', 'subtract'] },
                  radius: { type: 'number', exclusiveMinimum: 0, maximum: 0.5 },
                  feather: { type: 'number', minimum: 0, maximum: 1 },
                  points: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 4096,
                    items: schema({
                      x: { type: 'number', minimum: 0, maximum: 1 },
                      y: { type: 'number', minimum: 0, maximum: 1 },
                    }),
                  },
                }),
              }),
            ],
          },
        },
      }),
    }),
  },
  {
    name: 'irodori_update_edits',
    description:
      'Commit one nondestructive edit using the expected revision. Mixer ranges and grading tones accept partial fields and retain other settings. One call is one photo-wide history entry. Conflicts require reloading settings; irodori_get_edit_capabilities describes units and ranges.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      patch: schema(
        {
          curves: schema(
            {
              version: { const: 1 },
              master: curvePoints,
              red: curvePoints,
              green: curvePoints,
              blue: curvePoints,
            },
            [],
          ),
          exposureEv: { type: 'number', minimum: -5, maximum: 5, multipleOf: 0.01 },
          contrast: { type: 'integer', minimum: -100, maximum: 100 },
          highlights: { type: 'integer', minimum: -100, maximum: 100 },
          shadows: { type: 'integer', minimum: -100, maximum: 100 },
          whites: { type: 'integer', minimum: -100, maximum: 100 },
          blacks: { type: 'integer', minimum: -100, maximum: 100 },
          saturation: { type: 'integer', minimum: -100, maximum: 100 },
          vibrance: { type: 'integer', minimum: -100, maximum: 100 },
          noiseReduction: schema(
            {
              version: { const: 1 },
              luminance: { type: 'integer', minimum: 0, maximum: 100 },
              chroma: { type: 'integer', minimum: 0, maximum: 100 },
            },
            [],
          ),
          detailSharpening: schema(
            {
              version: { const: 1 },
              amount: { type: 'integer', minimum: 0, maximum: 100 },
              radius: {
                type: 'number',
                minimum: 0.5,
                maximum: 3,
                multipleOf: 0.1,
                description: 'Gaussian radius in prepared source pixels, before crop and resize.',
              },
              threshold: { type: 'integer', minimum: 0, maximum: 100 },
            },
            [],
          ),
          colorMixer: schema(
            {
              version: { const: 1 },
              ranges: schema(
                Object.fromEntries(
                  ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].map(
                    (id) => [id, colorMixerRange],
                  ),
                ),
                [],
              ),
            },
            [],
          ),
          colorGrading: schema(
            {
              version: { const: 1 },
              tones: schema(
                Object.fromEntries(
                  ['shadows', 'midtones', 'highlights'].map((id) => [id, gradingTone]),
                ),
                [],
              ),
              blending: { type: 'integer', minimum: 0, maximum: 100 },
              balance: colorAmount,
            },
            [],
          ),
          crop: schema({
            version: { const: 1 },
            quarterTurns: { type: 'integer', enum: [0, 1, 2, 3] },
            angle: { type: 'number', minimum: -45, maximum: 45, multipleOf: 0.01 },
            centerX: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
            centerY: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
            width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
            aspectRatio: {
              oneOf: [{ type: 'null' }, { type: 'number', minimum: 1 / 32768, maximum: 32768 }],
            },
          }),

          whiteBalance: {
            oneOf: [
              schema({ mode: { const: 'as-shot' } }),
              schema({
                mode: { const: 'custom' },
                kelvin: { type: 'integer', minimum: 2000, maximum: 25000, multipleOf: 50 },
                tint: { type: 'integer', minimum: -100, maximum: 100 },
              }),
            ],
          },
          lens: schema(
            {
              distortion: { type: 'boolean' },
              vignetting: { type: 'boolean' },
              chromaticAberration: { type: 'boolean' },
            },
            [],
          ),
        },
        [],
      ),
    }),
  },
  ...['undo', 'redo'].map((direction) => ({
    name: `irodori_${direction}_edit`,
    description: `${direction === 'undo' ? 'Undo' : 'Redo'} one shared edit.`,
    inputSchema: schema({ photoId, expectedRevision }),
  })),
]
const presetId = { type: 'string', format: 'uuid' }
const expectedPresetRevision = { type: 'integer', minimum: 1 }
const presetAppearance = {
  ...schema(
    {
      icon: {
        type: 'string',
        enum: presetIcons.map((icon) => icon.id),
        description: presetIcons.map((icon) => `${icon.id}: ${icon.label}`).join('; '),
      },
      color: {
        type: 'string',
        enum: presetColors.map((color) => color.id),
        description: presetColors.map((color) => `${color.id}: ${color.label}`).join('; '),
      },
    },
    [],
  ),
  minProperties: 1,
  description:
    'Optional visual marker only. New presets default to general/neutral; omitted fields on updates retain their current values. Choose a suitable scenario and named color for a new look, such as sunset/amber for Golden Hour. No photo processing is implied.',
}
const presetGroups = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  uniqueItems: true,
  items: {
    enum: [
      'light',
      'curves',
      'color',
      'mixer',
      'grading',
      'noise',
      'sharpening',
      'crop',
      'white-balance',
      'lens',
    ],
  },
}
// Keep source an explicit object: object unions without a top-level type become
// `unknown | unknown` in the Console's generated tool declarations.
const completeGroup = (value) => {
  if (value.type === 'object')
    return {
      ...value,
      required: Object.keys(value.properties),
      properties: Object.fromEntries(
        Object.entries(value.properties).map(([key, field]) => [key, completeGroup(field)]),
      ),
    }
  return value.const !== undefined
    ? { ...value, type: typeof value.const === 'number' ? 'integer' : typeof value.const }
    : value
}
const presetFields = Object.fromEntries(
  Object.entries(
    tools.find((tool) => tool.name === 'irodori_update_edits').inputSchema.properties.patch
      .properties,
  ).map(([key, field]) => [
    key,
    key === 'lens' ? { ...field, minProperties: 1 } : completeGroup(field),
  ]),
)
presetFields.whiteBalance = {
  ...schema(
    {
      mode: { type: 'string', enum: ['as-shot', 'custom'] },
      kelvin: { type: 'integer', minimum: 2000, maximum: 25000, multipleOf: 50 },
      tint: { type: 'integer', minimum: -100, maximum: 100 },
    },
    ['mode'],
  ),
  allOf: [
    {
      if: { properties: { mode: { const: 'custom' } } },
      then: { required: ['kelvin', 'tint'] },
      else: { properties: { kelvin: false, tint: false } },
    },
  ],
}
presetFields.crop.properties.aspectRatio = {
  type: ['number', 'null'],
  minimum: 1 / 32768,
  maximum: 32768,
}
const presetSource = {
  ...schema(
    {
      mode: { type: 'string', enum: ['photo', 'explicit'] },
      photoId,
      groups: presetGroups,
      settingsVersion: { type: 'integer', enum: [12, 13, 14, 15, 16] },
      values: {
        ...schema(presetFields, []),
        description:
          'Complete included groups only. Every nested control and version is required. Values for excluded groups are rejected.',
      },
      referencePhotoId: photoId,
    },
    ['mode', 'groups'],
  ),
  description:
    'Photo capture: {mode:"photo",photoId,groups}. Explicit look: {mode:"explicit",settingsVersion:16,groups,values}; referencePhotoId is required for white-balance/lens. No photo is changed. All included groups must be complete.',
  allOf: [
    {
      if: { properties: { mode: { const: 'photo' } } },
      then: {
        required: ['photoId'],
        properties: { settingsVersion: false, values: false, referencePhotoId: false },
      },
      else: {
        required: ['settingsVersion', 'values'],
        properties: { photoId: false },
        allOf: [
          ...Object.entries(presetGroupKeys).map(([group, keys]) => ({
            if: { properties: { groups: { contains: { const: group } } } },
            then: { properties: { values: { required: keys } } },
            else: {
              properties: {
                values: { properties: Object.fromEntries(keys.map((key) => [key, false])) },
              },
            },
          })),
          {
            if: { properties: { groups: { contains: { enum: ['white-balance', 'lens'] } } } },
            then: { required: ['referencePhotoId'] },
          },
        ],
      },
    },
  ],
}
tools.push(
  {
    name: 'irodori_list_presets',
    description:
      'List local presets, including their scenario icon and named color, alphabetically by name in bounded searchable chunks (60 rows). Use the store revision to detect ordering changes. This never changes photos or grants deletion permission.',
    inputSchema: schema(
      {
        presetQuery: schema(
          {
            search: { type: 'string', maxLength: 500 },
            offset: { type: 'integer', minimum: 0 },
            expectedStoreRevision: { type: 'integer', minimum: 0 },
          },
          [],
        ),
      },
      [],
    ),
  },
  {
    name: 'irodori_get_preset',
    description:
      'Inspect a complete stored preset definition, appearance, included groups, compatibility and its independent preset revision. Inspection never changes a photo.',
    inputSchema: schema({ presetId }),
  },
  {
    name: 'irodori_create_preset',
    description:
      'Save a unique trimmed name from confirmed photo edits or a complete explicit look. Use source.mode="photo" with photoId/groups, or source.mode="explicit" with settingsVersion:16, groups and values. For example, groups:["color"] needs values:{saturation:5,vibrance:22}. Choose appearance:{icon,color} to match the requested intent when creating a look, such as sunset/amber for Golden Hour. No photo or clipboard changes. Camera-dependent explicit groups require a verified referencePhotoId. Store no calibration tables or paths.',
    inputSchema: schema({
      presetRequest: schema(
        {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          source: presetSource,
          appearance: presetAppearance,
        },
        ['name', 'source'],
      ),
    }),
  },
  {
    name: 'irodori_update_preset',
    description:
      'Edit a preset name, appearance or definition at expectedPresetRevision. Appearance accepts a partial {icon,color}; omitted fields retain their current values. Preserve the marker unless the user asks to change it. Replacement source uses mode="photo" with photoId/groups or mode="explicit" with settingsVersion:16, groups and complete values. Preset revisions are independent of photo-edit revisions. No photo/history changes; accepted jobs keep the old frozen definition.',
    inputSchema: schema({
      presetRequest: schema(
        {
          presetId,
          expectedPresetRevision,
          name: { type: 'string', minLength: 1, maxLength: 100 },
          source: presetSource,
          appearance: presetAppearance,
        },
        ['presetId', 'expectedPresetRevision'],
      ),
    }),
  },
  {
    name: 'irodori_delete_preset',
    description:
      'Delete exactly this preset ID at expectedPresetRevision. An explicit user instruction to delete the identified preset authorizes deletion without another prompt. Otherwise identify its name and ID, ask in Console and wait for agreement. Listing, creating or applying presets grants no deletion permission. The server enforces identity/revision, not inferred conversational consent. Applied history and accepted jobs survive deletion.',
    inputSchema: schema({ presetId, expectedPresetRevision }),
  },
  {
    name: 'irodori_prepare_preset_application',
    description:
      'Freeze the preset definition and complete destination photo IDs/revisions, including hidden/unloaded selections. Report incompatibilities without dropping targets. No photo changes.',
    inputSchema: schema({
      presetApplication: schema({
        presetId,
        expectedPresetRevision,
        photoIds: {
          type: 'array',
          minItems: 1,
          maxItems: 100000,
          uniqueItems: true,
          items: photoId,
        },
      }),
    }),
  },
  {
    name: 'irodori_start_preset_application',
    description:
      'Apply a frozen preset preparation through the shared cancellable edit-application service. Each changed photo receives one Undo step; unchanged photos receive none. Conflicts, incompatible and unfinished targets retain results across restart.',
    inputSchema: schema({ preparationId: { type: 'string' } }),
  },
  {
    name: 'irodori_dispose_preset_preparation',
    description: 'Discard an unused preset preparation without changing photos or presets.',
    inputSchema: schema({ preparationId: { type: 'string' } }),
  },
)
const managed = process.env.IRODORI_AGENT_CONNECTION !== undefined
if (managed) {
  const allowed = new Set(agentTools)
  tools = tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      ...tool,
      inputSchema: schema(
        { ...tool.inputSchema.properties, requestId: { type: 'string', format: 'uuid' } },
        [...tool.inputSchema.required, 'requestId'],
      ),
    }))
}
const server = new Server(
  { name: 'irodori-editor', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!tools.some((tool) => tool.name === request.params.name))
      throw new Error('Unknown editor tool.')
    const connection = JSON.parse(
      managed
        ? process.env.IRODORI_AGENT_CONNECTION
        : await readFile(join(profile, 'editor', 'connection.json'), 'utf8'),
    )
    if (
      connection.version !== 1 ||
      !Number.isInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(connection.token)
    )
      throw new Error('Invalid editor connection file.')
    const response = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request.params.arguments, operation: request.params.name }),
      signal: AbortSignal.timeout(
        request.params.name === 'irodori_request_merge_preview' ? 1800000 : 120000,
      ),
      redirect: 'error',
    })
    const result = await response.json()
    if (result.failure)
      return {
        isError: true,
        content: [{ type: 'text', text: result.failure.message }],
        structuredContent: result.failure,
      }
    if (!response.ok || result.error) throw new Error(result.error ?? 'Editor request failed.')
    if (request.params.name === 'irodori_create_object_selection') {
      const { data, ...metadata } = result.result
      if (
        typeof data !== 'string' ||
        data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
        Buffer.from(data, 'base64').byteLength > 8 * 1024 * 1024 ||
        metadata.mimeType !== 'image/png'
      )
        throw new Error('Invalid object-selection coverage image.')
      return {
        content: [
          { type: 'text', text: JSON.stringify(metadata) },
          { type: 'image', mimeType: 'image/png', data },
        ],
        structuredContent: metadata,
      }
    }
    if (['irodori_get_photo_preview', 'irodori_get_output_proof'].includes(request.params.name)) {
      if (Array.isArray(result.result.members)) {
        const { members, ...metadata } = result.result
        if (members.length < 1 || members.length > 2) throw new Error('Invalid inspection members.')
        let total = 0
        const content = []
        const labelled = []
        for (const member of members) {
          const { data, ...details } = member
          if (
            typeof data !== 'string' ||
            data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
            !['image/jpeg', 'image/png'].includes(member.mimeType)
          )
            throw new Error('Invalid inspection image payload.')
          const bytes = Buffer.from(data, 'base64').byteLength
          if (bytes > 8 * 1024 * 1024 || bytes !== member.byteLength)
            throw new Error('Invalid inspection image length.')
          total += bytes
          labelled.push(details)
          content.push(
            { type: 'text', text: JSON.stringify({ ...metadata, ...details }) },
            { type: 'image', mimeType: member.mimeType, data },
          )
        }
        if (total > 16 * 1024 * 1024) throw new Error('Inspection pair exceeds 16 MiB.')
        return { content, structuredContent: { ...metadata, members: labelled } }
      }
      const { data, ...metadata } = result.result
      if (
        typeof data !== 'string' ||
        data.length > 1398104 ||
        Buffer.from(data, 'base64').byteLength > 1024 * 1024
      )
        throw new Error('Invalid compact photo preview payload.')
      return {
        content: [
          { type: 'text', text: JSON.stringify(metadata) },
          { type: 'image', mimeType: 'image/jpeg', data },
        ],
        structuredContent: metadata,
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.result) }],
      structuredContent: result.result,
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error) }] }
  }
})
await server.connect(new StdioServerTransport())
