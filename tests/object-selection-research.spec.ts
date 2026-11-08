import { expect, test } from '@playwright/test'
import protocol from '../assets/tests/references/object-selection/protocol.json' with { type: 'json' }
import {
  assessObjectSelectionEvidence,
  type StudyEvidence,
  type StudyScene,
} from '../scripts/research/object-selection/qualification'

const scenes = (): StudyScene[] =>
  Array.from({ length: 12 }, (_, index) => ({
    sceneId: `scene-${index}`,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    split: index < 9 ? 'development' : 'holdout',
    coverage: [...protocol.corpus.requiredCoverage],
    reviewed: true,
    tracked: true,
    permissionVerified: true,
  }))
const complete = (): StudyEvidence => ({
  platforms: protocol.runtime.requiredPlatforms.map((platform) => ({
    platform,
    status: 'passed',
    provider: 'webgpu',
    cpuFallbackDisabled: true,
    heavyCpuNodes: 0,
  })),
  scenes: scenes(),
  modelParity: 'passed',
  manualCorrection: 'passed',
  nativeReview: 'passed',
})
test('a tiny GPU smoke success never qualifies a model or missing platform/cohort', () => {
  const result = assessObjectSelectionEvidence(protocol, {
    platforms: complete().platforms!.slice(0, 1),
  })
  expect(result.status).toBe('incomplete')
  expect(result.missing).toContain('Runtime evidence missing: linux-x64-radeon-vulkan')
  expect(result.missing).toContain('Model export/reference parity is unqualified.')
  expect(result.missing).toContain('Reviewed distinct scenes: 0/12')
  expect(result.productionActivated).toBe(false)
})
test('CPU fallback or unproven heavy-node assignment blocks further qualification', () => {
  for (const patch of [
    { provider: 'cpu' },
    { cpuFallbackDisabled: false },
    { heavyCpuNodes: undefined },
    { heavyCpuNodes: 1 },
    { status: 'failed' },
  ]) {
    const evidence = complete()
    Object.assign(evidence.platforms![0], patch)
    expect(assessObjectSelectionEvidence(protocol, evidence).status).toBe('blocked')
  }
})
test('repeated exposures and repeated bytes cannot pad a twelve-scene cohort', () => {
  const evidence = complete()
  evidence.scenes![1].sceneId = evidence.scenes![0].sceneId
  evidence.scenes![2].sha256 = evidence.scenes![0].sha256
  const result = assessObjectSelectionEvidence(protocol, evidence)
  expect(result.distinctScenes).toBe(10)
  expect(result.status).toBe('incomplete')
})
test('private, untracked or unreviewed inputs never count as acceptance fixtures', () => {
  for (const patch of [
    { privateExploration: true },
    { tracked: false },
    { reviewed: false },
    { permissionVerified: false },
    { sha256: 'unverified' },
  ]) {
    const evidence = complete()
    Object.assign(evidence.scenes![0], patch)
    expect(assessObjectSelectionEvidence(protocol, evidence).distinctScenes).toBe(11)
  }
})
test('held-out scenes and each required photographic category remain explicit gates', () => {
  const evidence = complete()
  for (const scene of evidence.scenes!) {
    scene.split = 'development'
    scene.coverage = ['fur']
  }
  const result = assessObjectSelectionEvidence(protocol, evidence)
  expect(result.status).toBe('incomplete')
  expect(result.missing).toContain('Reviewed held-out scenes: 0/3')
  expect(result.missing).toContain('Photographic coverage missing: bird')
})
test('complete evidence qualifies planning and does not activate a production model', () => {
  expect(assessObjectSelectionEvidence(protocol, complete())).toEqual({
    status: 'qualified-for-implementation-planning',
    blockers: [],
    missing: [],
    distinctScenes: 12,
    heldOutScenes: 3,
    productionActivated: false,
  })
})
