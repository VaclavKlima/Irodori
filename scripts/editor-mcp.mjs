import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profile =
  process.env.LUMA_PROFILE ??
  (process.platform === 'win32'
    ? join(process.env.APPDATA ?? homedir(), 'Luma')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Luma')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Luma'))
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
const tools = [
  {
    name: 'luma_list_stacks',
    description: 'Read stack summaries and the gallery revision for manual grouping.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_get_photo_stack',
    description: 'Read a photo’s stack and its current revision.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_get_stack_members',
    description: 'Read 60 ordered stack members, cover first.',
    inputSchema: schema({ stackId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'stackId',
    ]),
  },
  {
    name: 'luma_get_stack_snapshot',
    description:
      'Read every current stack member in persisted order, including originals and previous merge results. Requires the displayed stack revision; stale or missing stacks fail.',
    inputSchema: schema({ stackId: { type: 'string' }, expectedRevision }),
  },
  {
    name: 'luma_group_photos',
    description:
      'Group ungrouped photos with a selected cover. expectedRevision comes from list_stacks.',
    inputSchema: schema({
      ids: { type: 'array', items: photoId, minItems: 2, uniqueItems: true },
      coverId: photoId,
      expectedRevision,
    }),
  },
  {
    name: 'luma_ungroup_stack',
    description:
      'Ungroup a stack, remembering this manual choice for automatic scans. Requires the stack revision.',
    inputSchema: schema({ stackId: { type: 'string' }, expectedRevision }),
  },
  {
    name: 'luma_remove_from_stack',
    description: 'Remove one member without deleting its photo. Requires the stack revision.',
    inputSchema: schema({ photoId, expectedRevision }),
  },
  {
    name: 'luma_set_stack_cover',
    description: 'Choose a member as cover using the stack revision.',
    inputSchema: schema({ stackId: { type: 'string' }, photoId, expectedRevision }),
  },
  {
    name: 'luma_set_stack_expanded',
    description:
      'Persist inline expansion using the stack revision; preserves selections and active photo.',
    inputSchema: schema({
      stackId: { type: 'string' },
      expanded: { type: 'boolean' },
      expectedRevision,
    }),
  },
  {
    name: 'luma_list_gallery',
    description: 'Read 60 visible photo rows, with parent stack and stored-photo totals.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'luma_locate_gallery_photo',
    description: 'Locate or navigate a visible row; hidden photos use their cover position.',
    inputSchema: schema({ photoId, direction: { type: 'integer', enum: [-1, 0, 1] } }, ['photoId']),
  },
  {
    name: 'luma_get_gallery_range',
    description:
      'Read an inclusive gallery range in gallery order. Included covers select all current stack members, including collapsed or paginated members, in persisted order. Hidden boundaries use their covers; member-only ranges remain individual.',
    inputSchema: schema({ fromId: photoId, toId: photoId }),
  },
  {
    name: 'luma_group_capture_sequences',
    description:
      'Start a cancellable metadata-only scan of managed originals for verified Sony ZV-1A ARW continuous captures. BRK remains unverified.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_get_active_merge_review',
    description: 'Read the active merge review without starting or recomputing processing.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_get_merge_diagnostics',
    description:
      'Read alignment diagnostics and structured failure for the current review revision, including after failure. No paths are returned.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'luma_create_merge_review',
    description:
      'Validate 2–32 Sony RAW photo IDs and lease their sources for HDR or noise stacking.',
    inputSchema: schema({
      ids: { type: 'array', items: photoId, minItems: 2, maxItems: 32, uniqueItems: true },
      mode: { enum: ['hdr', 'noise'] },
    }),
  },
  {
    name: 'luma_update_merge_review',
    description:
      'Update bounded merge settings using the current review revision; cancels superseded preparation.',
    inputSchema: schema({ reviewId, expectedRevision, settings: mergeSettings }),
  },
  {
    name: 'luma_request_merge_preview',
    description:
      'Prepare and validate the native merge. Returns full-resolution result, reference and overlay URLs and the reviewed recipe.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'luma_start_merge',
    description:
      'Freeze the prepared recipe and publish a new editable master as a background task.',
    inputSchema: schema({ reviewId, expectedRevision }),
  },
  {
    name: 'luma_dispose_merge_review',
    description: 'Cancel review preparation and release source leases.',
    inputSchema: schema({ reviewId }),
  },
  {
    name: 'luma_get_merge_provenance',
    description: 'Read permanent recipe, source capture metadata and source availability.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_list_tasks',
    description: 'Read background task progress and result photo IDs.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_get_task_errors',
    description: 'Read a page of background task errors.',
    inputSchema: schema({ taskId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, [
      'taskId',
    ]),
  },
  {
    name: 'luma_cancel_task',
    description: 'Cancel a background task, waiting for durable publication when necessary.',
    inputSchema: schema({ taskId: { type: 'string' } }),
  },
  {
    name: 'luma_dismiss_task',
    description: 'Dismiss a finished task.',
    inputSchema: schema({ taskId: { type: 'string' } }),
  },
  {
    name: 'luma_get_preview_diagnostics',
    description:
      'Read preview preparation, cache, loading and presentation diagnostics for the active photo.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_get_display_state',
    description:
      'Read the requested preference, detected monitor/adapter capabilities, target, actual frame presentation and unverified physical-output status.',
    inputSchema: schema({}),
  },
  {
    name: 'luma_set_preview_preference',
    description: 'Set workspace Auto, HDR, or SDR preference without changing photo edits.',
    inputSchema: schema({ preference: { enum: ['auto', 'hdr', 'sdr'] } }),
  },
  {
    name: 'luma_get_photo_statistics',
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
    name: 'luma_get_photo_pixel',
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
    name: 'luma_list_photos',
    description: 'List imported photos, 60 per page.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'luma_get_edits',
    description: 'Read confirmed settings and revision.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_get_edit_history',
    description: 'Read ordered settings snapshots and history cursor.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_update_edits',
    description:
      'Commit one nondestructive edit using the expected revision. Conflicts require reloading settings.',
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
    name: `luma_${direction}_edit`,
    description: `${direction === 'undo' ? 'Undo' : 'Redo'} one shared edit.`,
    inputSchema: schema({ photoId, expectedRevision }),
  })),
]
const server = new Server(
  { name: 'luma-editor', version: '1.0.0' },
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
        request.params.name === 'luma_request_merge_preview' ? 1800000 : 120000,
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
