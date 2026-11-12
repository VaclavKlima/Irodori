import type { DisplayTarget } from './hdr'
import type { PreviewContext } from './inspection'
import type { PreviewPresentation } from './preview-diagnostics'

export interface AgentPresentationRequest {
  photoId: string
  expectedRevision: number
}

export type AgentPresentationFrame =
  | { status: 'not-current' }
  | {
      /** Last reported application frame, not a physical display measurement. */
      status: PreviewPresentation['stage']
      mode: PreviewPresentation['mode']
      backend: PreviewPresentation['backend']
      reason: string
    }

export interface AgentPresentationContext {
  photoId: string
  revision: number
  /** Live workspace target; its mode does not establish the requested photo's frame mode. */
  workspaceTarget: {
    targetGeneration: number
    requestedPreference: DisplayTarget['requested']
    mode: DisplayTarget['mode']
    colorSpace: DisplayTarget['colorSpace']
    headroom: DisplayTarget['headroom']
    reason: string
    physicalOutputVerified: false
  }
  frame: AgentPresentationFrame
  inspectionHdr: PreviewContext['hdr']
}

export function validateAgentPresentationRequest(value: unknown): AgentPresentationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Supply photoId and expectedRevision for presentation context.')
  const request = value as Record<string, unknown>
  if (Object.keys(request).sort().join(',') !== 'expectedRevision,photoId')
    throw new Error('Presentation context accepts only photoId and expectedRevision.')
  if (typeof request.photoId !== 'string' || !/^[a-f0-9]{64}$/.test(request.photoId))
    throw new Error('photoId must be a confirmed 64-character lowercase hexadecimal photograph ID.')
  if (!Number.isSafeInteger(request.expectedRevision) || (request.expectedRevision as number) < 0)
    throw new Error('expectedRevision must be a nonnegative safe integer from confirmed edits.')
  return { photoId: request.photoId, expectedRevision: request.expectedRevision as number }
}
