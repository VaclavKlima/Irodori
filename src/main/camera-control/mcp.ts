import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CameraError, identifier, keys, object, settings } from './model.ts'
import type { CameraService } from './service.ts'

const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }
const stringSettings = {
  type: 'object',
  maxProperties: 32,
  additionalProperties: { type: 'string', maxLength: 200 },
}
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
})
export const cameraTools = [
  {
    name: 'irodori_camera_list',
    description:
      'Discover attached USB cameras and backend diagnostics. Includes retained settings recovery records. Does not open a library or release a shutter.',
    inputSchema: schema({}),
  },
  {
    name: 'irodori_camera_list_actions',
    description:
      'Inspect one exact camera: settings, choices, availability, parameter schemas and advertised/read/write-readback/capture evidence. Native burst and bracketing remain unavailable.',
    inputSchema: schema({ cameraId: id }),
  },
  {
    name: 'irodori_camera_open_session',
    description:
      'Claim one discovered camera and optionally apply initial photographic settings with readback. recoverSessionId explicitly restores a retained journal only on the same serial-identified camera. No automatic shutter retry.',
    inputSchema: schema({ cameraId: id, initialSettings: stringSettings, recoverSessionId: id }, [
      'cameraId',
    ]),
  },
  {
    name: 'irodori_camera_execute_action',
    description:
      'Execute read-settings {}, read-card-inventory {}, apply-settings {settings}, capture {settings}, or exposure-sequence {steps:[settings,...]} advertised for this session. Sequences use 1–32 separate shutter releases. Required requestId deduplicates across restart. Returns an operation ID; poll its result. Originals and manifests stay under artifacts/camera; no automatic library import.',
    inputSchema: schema({
      sessionId: id,
      action: {
        enum: [
          'read-settings',
          'read-card-inventory',
          'apply-settings',
          'capture',
          'exposure-sequence',
        ],
      },
      parameters: { type: 'object' },
      requestId: id,
    }),
  },
  {
    name: 'irodori_camera_get_operation',
    description:
      'Read retained progress, requested/readback settings, original paths, hashes, metadata, partial downloads, uncertainty and restoration outcomes.',
    inputSchema: schema({ operationId: id }),
  },
  {
    name: 'irodori_camera_cancel_operation',
    description:
      'Stop future work, finish an in-flight shutter/download safely, retain completed originals, and restore touched settings. An uncertain shutter release is never repeated.',
    inputSchema: schema({ operationId: id }),
  },
  {
    name: 'irodori_camera_close_session',
    description:
      'Stop pending work, restore touched settings when unchanged externally, release the camera and report restoration conflicts/failures. Retains recovery journals after failures.',
    inputSchema: schema({ sessionId: id }),
  },
]
export function createCameraMcpServer(service: CameraService) {
  const server = new Server(
    { name: 'irodori-camera-development', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cameraTools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const input = object(request.params.arguments ?? {})
      let result: unknown
      switch (request.params.name) {
        case 'irodori_camera_list':
          keys(input, [])
          result = await service.list()
          break
        case 'irodori_camera_list_actions':
          keys(input, ['cameraId'])
          result = await service.listActions(identifier(input.cameraId))
          break
        case 'irodori_camera_open_session':
          keys(input, ['cameraId', 'initialSettings', 'recoverSessionId'], ['cameraId'])
          result = await service.openSession(
            identifier(input.cameraId),
            settings(input.initialSettings ?? {}),
            input.recoverSessionId === undefined ? undefined : identifier(input.recoverSessionId),
          )
          break
        case 'irodori_camera_execute_action':
          keys(input, ['sessionId', 'action', 'parameters', 'requestId'])
          result = await service.executeAction(
            identifier(input.sessionId),
            input.action,
            input.parameters,
            identifier(input.requestId),
          )
          break
        case 'irodori_camera_get_operation':
          keys(input, ['operationId'])
          result = await service.getOperation(identifier(input.operationId))
          break
        case 'irodori_camera_cancel_operation':
          keys(input, ['operationId'])
          result = await service.cancelOperation(identifier(input.operationId))
          break
        case 'irodori_camera_close_session':
          keys(input, ['sessionId'])
          result = await service.closeSession(identifier(input.sessionId))
          break
        default:
          throw new CameraError('unknown-tool', 'Unknown camera tool.')
      }
      const structuredContent = result as Record<string, unknown>
      return {
        structuredContent,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    } catch (error) {
      return {
        isError: true,
        structuredContent: {
          code: error instanceof CameraError ? error.code : 'camera-error',
          message: String(error),
        },
        content: [{ type: 'text' as const, text: String(error) }],
      }
    }
  })
  return server
}
