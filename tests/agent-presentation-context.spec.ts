import { expect, test } from '@playwright/test'
import {
  readAgentPresentationContext,
  type AgentPresentationOwners,
} from '../src/main/agent/presentation-context'
import { validateAgentPresentationRequest } from '../src/shared/agent-presentation'
import { SDR_TARGET, type DisplayTarget } from '../src/shared/hdr'
import { inspectionHdrCapability } from '../src/shared/inspection'
import type { PreviewDiagnostics, PreviewPresentation } from '../src/shared/preview-diagnostics'

const photoId = 'a'.repeat(64),
  otherPhotoId = 'b'.repeat(64),
  request = { photoId, expectedRevision: 4 }

function fixture() {
  const presentation: PreviewPresentation = {
    photoId,
    revision: 4,
    targetGeneration: 7,
    backend: 'webgpu-hdr',
    mode: 'hdr',
    stage: 'presented',
    reason: 'Extended application frame; physical output is unverified.',
    timings: { uploadMs: 2 },
  }
  const target: DisplayTarget = {
    ...SDR_TARGET,
    generation: 7,
    requested: 'auto',
    mode: 'hdr',
    colorSpace: 'display-p3',
    peak: 4,
    headroom: 4,
    reason: 'Experimental HDR; physical luminance is unverified.',
    presentation,
  }
  const primary: PreviewDiagnostics = {
    photoId,
    revision: 4,
    loadingStage: 'prepared',
    timings: {},
  }
  const owners: AgentPresentationOwners = {
    currentRevision: async (id) => {
      expect(id).toBe(photoId)
      return 4
    },
    readDisplayTarget: () => target,
    readPreviewDiagnostics: () => primary,
    inspectionHdr: structuredClone(inspectionHdrCapability),
  }
  return { target, primary, presentation, owners }
}

test('presentation requests require an explicit confirmed photo and revision', () => {
  expect(validateAgentPresentationRequest(request)).toEqual(request)
  expect(validateAgentPresentationRequest(request)).not.toBe(request)
  for (const value of [null, [], 'photo', {}, { ...request, mode: 'hdr' }])
    expect(() => validateAgentPresentationRequest(value)).toThrow()
  for (const id of ['', otherPhotoId.toUpperCase(), 'a'.repeat(63), '../photo'])
    expect(() => validateAgentPresentationRequest({ ...request, photoId: id })).toThrow('photoId')
  for (const revision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4'])
    expect(() =>
      validateAgentPresentationRequest({ ...request, expectedRevision: revision }),
    ).toThrow('expectedRevision')
})

test('matching HDR and SDR frame reports retain their presented, loading or failed status', async () => {
  for (const mode of ['hdr', 'sdr'] as const)
    for (const stage of ['presented', 'loading', 'failed'] as const) {
      const { owners, presentation } = fixture()
      presentation.mode = mode
      presentation.stage = stage
      presentation.backend = mode === 'hdr' ? 'webgpu-hdr' : 'legacy'
      const result = await readAgentPresentationContext(request, owners)
      expect(result.frame).toEqual({
        status: stage,
        mode,
        backend: presentation.backend,
        reason: presentation.reason,
      })
      expect(result.inspectionHdr).toEqual(inspectionHdrCapability)
      expect(result.workspaceTarget.physicalOutputVerified).toBe(false)
    }
})

test('an HDR workspace target does not establish that the photograph has an HDR frame', async () => {
  const { owners, presentation } = fixture()
  presentation.mode = 'sdr'
  presentation.backend = 'canvas2d-hdr-sdr'
  presentation.reason = 'SDR presentation.'
  const result = await readAgentPresentationContext(request, owners)
  expect(result.workspaceTarget).toMatchObject({
    targetGeneration: 7,
    requestedPreference: 'auto',
    mode: 'hdr',
    colorSpace: 'display-p3',
    headroom: 4,
  })
  expect(result.frame).toEqual({
    status: 'presented',
    mode: 'sdr',
    backend: 'canvas2d-hdr-sdr',
    reason: 'SDR presentation.',
  })
  expect(result.inspectionHdr.available).toBe(false)
})

test('navigation cannot attribute another photograph or a retained old frame to the frozen photo', async () => {
  for (const replaceReport of [false, true]) {
    const { owners, primary, presentation } = fixture()
    primary.photoId = otherPhotoId
    if (replaceReport) {
      presentation.photoId = otherPhotoId
      presentation.reason = 'Another photograph frame.'
    }
    const result = await readAgentPresentationContext(request, owners)
    expect(result.photoId).toBe(photoId)
    expect(result.frame).toEqual({ status: 'not-current' })
    expect(JSON.stringify(result)).not.toContain(otherPhotoId)
    expect(JSON.stringify(result)).not.toContain('Another photograph frame.')
  }
})

test('stale frame revisions, target generations and primary ownership produce no frame attribution', async () => {
  const stale: Array<(value: ReturnType<typeof fixture>) => void> = [
    ({ presentation }) => (presentation.revision = 3),
    ({ presentation }) => (presentation.targetGeneration = 6),
    ({ target }) => (target.generation = 8),
    ({ primary }) => (primary.revision = 3),
    ({ primary }) => (primary.revision = undefined),
    ({ target }) => (target.presentation = undefined),
  ]
  for (const change of stale) {
    const value = fixture()
    change(value)
    const result = await readAgentPresentationContext(request, value.owners)
    expect(result.frame).toEqual({ status: 'not-current' })
  }
})

test('revision conflicts and missing display state refuse without reading or changing preview ownership', async () => {
  const { owners } = fixture()
  let displayReads = 0
  owners.readDisplayTarget = () => {
    displayReads++
    return undefined
  }
  owners.currentRevision = async () => 5
  await expect(readAgentPresentationContext(request, owners)).rejects.toThrow('revision conflict')
  expect(displayReads).toBe(0)
  owners.currentRevision = async () => 4
  await expect(readAgentPresentationContext(request, owners)).rejects.toThrow(
    'Display state unavailable',
  )
  expect(displayReads).toBe(1)
})

test('reading and mutating returned context leaves the shared display, preview and capability owners unchanged', async () => {
  const { owners, target, primary } = fixture()
  const original = structuredClone({ target, primary, hdr: owners.inspectionHdr })
  const result = await readAgentPresentationContext(request, owners)
  expect({ target, primary, hdr: owners.inspectionHdr }).toEqual(original)
  expect(result.inspectionHdr).not.toBe(owners.inspectionHdr)
  result.workspaceTarget.reason = 'Local result change.'
  if (result.frame.status !== 'not-current') result.frame.reason = 'Local frame change.'
  expect({ target, primary, hdr: owners.inspectionHdr }).toEqual(original)
})
