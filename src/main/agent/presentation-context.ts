import {
  validateAgentPresentationRequest,
  type AgentPresentationContext,
  type AgentPresentationRequest,
} from '../../shared/agent-presentation'
import type { DisplayTarget } from '../../shared/hdr'
import type { PreviewContext } from '../../shared/inspection'
import type { PreviewDiagnostics } from '../../shared/preview-diagnostics'

export interface AgentPresentationOwners {
  currentRevision: (photoId: string) => Promise<number>
  readDisplayTarget: () => DisplayTarget | undefined
  readPreviewDiagnostics: () => PreviewDiagnostics
  inspectionHdr: PreviewContext['hdr']
}

/** Read live presentation owners without changing the workspace or frozen request targets. */
export async function readAgentPresentationContext(
  request: AgentPresentationRequest,
  owners: AgentPresentationOwners,
): Promise<AgentPresentationContext> {
  const { photoId, expectedRevision } = validateAgentPresentationRequest(request)
  const revision = await owners.currentRevision(photoId)
  if (revision !== expectedRevision)
    throw new Error('Presentation context revision conflict. Read confirmed edits and retry.')
  const target = owners.readDisplayTarget()
  if (!target) throw new Error('Display state unavailable.')
  const primary = owners.readPreviewDiagnostics()
  const presentation = target.presentation
  const matches =
    primary.photoId === photoId &&
    primary.revision === expectedRevision &&
    presentation?.photoId === photoId &&
    presentation.revision === expectedRevision &&
    presentation.targetGeneration === target.generation
  return {
    photoId,
    revision,
    workspaceTarget: {
      targetGeneration: target.generation,
      requestedPreference: target.requested,
      mode: target.mode,
      colorSpace: target.colorSpace,
      headroom: target.headroom,
      reason: target.reason,
      physicalOutputVerified: false,
    },
    frame: matches
      ? {
          status: presentation.stage,
          mode: presentation.mode,
          backend: presentation.backend,
          reason: presentation.reason,
        }
      : { status: 'not-current' },
    inspectionHdr: structuredClone(owners.inspectionHdr),
  }
}
