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
const tools = [
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
      'Read JPEG export capabilities, pinned codec and rendering versions. HDR export is independent of the current monitor.',
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
      'Revalidate a preparation and authorized destination, atomically accept immutable JPEG output settings and source leases, and enqueue a background task. Quick presets use Auto output. Explicit HDR rejects unsupported sources. Custom options require version, output, quality, size, names, metadata and existing fields; the same application validator serves UI and MCP. No arbitrary write paths or replacement are allowed.',
    inputSchema: schema({
      exportRequest: schema(
        {
          preparationId: { type: 'string' },
          destinationId: { type: 'string' },
          action: { enum: ['maximum', 'high', 'smaller', 'custom', 'last-custom'] },
          options: schema({
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
          }),
        },
        ['preparationId', 'destinationId', 'action'],
      ),
    }),
  },
  {
    name: 'irodori_get_export_results',
    description:
      'Read retained per-file export results in frozen selection order, including exported, skipped, failed and cancelled outcomes.',
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
    name: 'irodori_get_edit_history',
    description: 'Read ordered settings snapshots and history cursor.',
    inputSchema: schema({ photoId }),
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
      await readFile(join(profile, 'editor', 'connection.json'), 'utf8'),
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
    return {
      content: [{ type: 'text', text: JSON.stringify(result.result) }],
      structuredContent: result.result,
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error) }] }
  }
})
await server.connect(new StdioServerTransport())
