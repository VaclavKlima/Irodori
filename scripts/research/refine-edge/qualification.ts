/** Frozen research gates; this module never activates an application operator. */
import protocol from '../../../assets/tests/references/refine-edge/protocol.json' with { type: 'json' }
import inputs from '../../../assets/tests/references/object-selection/inputs.json' with { type: 'json' }

export const REFINE_EDGE_PROTOCOL_SHA256 =
  'b52be86361e3d9364ac85f9d3bf96ce0c97ab5a806475a2dead12530d9f638e2'

type Check = 'passed' | 'failed' | 'incomplete'
export interface RefineEdgeFixture {
  id: string
  sceneId: string
  sha256: string
  actualSha256: string
  split: 'development' | 'confirmation'
  tracked: boolean
  reviewed: boolean
  permissionVerified: boolean
}
export interface RefineEdgeReview {
  id: string
  views: string[]
  usable: boolean
  regression: boolean
  gainClasses: string[]
  defectsRecorded: boolean
}
export interface RefineEdgeEvidence {
  candidateId?: string
  protocolSha256?: string
  frozenBeforeExecution?: boolean
  tunedAfterConfirmation?: boolean
  claimsUnseenHoldout?: boolean
  baselineHashes?: { inputs: string; protocol: string; independentReference: string }
  license?: {
    code: 'verified' | 'incompatible' | 'unverified'
    weights: 'verified' | 'not-required' | 'incompatible' | 'unverified'
  }
  fixtures?: RefineEdgeFixture[]
  runtime?: {
    platform: string
    adapter: string
    status: Check
    provider: 'webgpu' | 'cuda' | 'cpu' | 'unknown'
    cpuFallbackDisabled: boolean
    heavyCpuNodes: number
    resourcePolicy: string
    resourceOverride: boolean
    automaticSnapshotSha256: string
  }
  checks?: Partial<
    Record<
      | 'parity'
      | 'nativeShape'
      | 'fractionalCoverage'
      | 'resourceRefusal'
      | 'cancellation'
      | 'cleanup',
      Check
    >
  >
  reviews?: RefineEdgeReview[]
}

export function assessRefineEdgeEvidence(evidence: RefineEdgeEvidence) {
  const blockers: string[] = []
  const missing: string[] = []
  const rejected: string[] = []
  const candidate = protocol.candidates.find((item) => item.id === evidence.candidateId)
  if (!candidate) missing.push('A frozen candidate must be identified.')
  if (evidence.protocolSha256 !== REFINE_EDGE_PROTOCOL_SHA256)
    missing.push('Frozen protocol hash is unverified.')
  if (evidence.frozenBeforeExecution !== true)
    missing.push('Protocol freeze before candidate execution is unverified.')
  if (evidence.tunedAfterConfirmation === true)
    blockers.push('Candidate was tuned after confirmation release.')
  else if (evidence.tunedAfterConfirmation !== false)
    missing.push('No tuning after confirmation release is unverified.')
  if (evidence.claimsUnseenHoldout === true)
    blockers.push('Previously seen confirmation scenes cannot be claimed as unseen.')
  else if (evidence.claimsUnseenHoldout !== false)
    missing.push('Confirmation-scene disclosure is missing.')
  for (const [key, expected] of Object.entries({
    inputs: protocol.baseline.inputsSha256,
    protocol: protocol.baseline.protocolSha256,
    independentReference: protocol.baseline.independentReferenceSha256,
  }))
    if (
      evidence.baselineHashes?.[key as keyof NonNullable<RefineEdgeEvidence['baselineHashes']>] !==
      expected
    )
      missing.push(`Unchanged independent baseline hash is unverified: ${key}`)

  if (evidence.license?.code === 'incompatible' || evidence.license?.weights === 'incompatible')
    blockers.push('Candidate license is incompatible with the required use.')
  if (evidence.license?.code !== 'verified') missing.push('Candidate code license is unverified.')
  const weightsAllowed =
    evidence.license?.weights === 'verified' ||
    (candidate?.id === 'guided-r8-eps001' && evidence.license?.weights === 'not-required')
  if (!weightsAllowed) missing.push('Candidate weight permission is unverified.')

  const runtime = evidence.runtime
  if (!runtime) missing.push('Actual-device runtime evidence is missing.')
  else {
    if (!runtime.platform.trim() || !runtime.adapter.trim())
      missing.push('Actual platform and physical adapter must be recorded.')
    if (
      runtime.status === 'failed' ||
      runtime.provider !== 'webgpu' ||
      runtime.cpuFallbackDisabled !== true ||
      runtime.heavyCpuNodes !== 0
    )
      blockers.push('Strict GPU execution on the recorded device is unproven or failed.')
    else if (runtime.status !== 'passed') missing.push('Actual-device GPU execution is incomplete.')
    if (runtime.resourceOverride || runtime.resourcePolicy !== 'Automatic')
      blockers.push('Automatic resource admission cannot be overridden or relaxed.')
    if (!/^[a-f0-9]{64}$/.test(runtime.automaticSnapshotSha256))
      missing.push('Automatic resource snapshot hash is missing.')
  }

  const fixtureIds = new Set<string>()
  const sceneIds = new Set<string>()
  const hashes = new Set<string>()
  const fixtures = (evidence.fixtures ?? []).filter((fixture) => {
    const expected = inputs.images.find((image) => image.id === fixture.id)
    const split = expected?.split === 'holdout' ? 'confirmation' : 'development'
    if (
      !expected ||
      fixture.sceneId !== expected.sceneId ||
      fixture.sha256 !== expected.sha256 ||
      fixture.actualSha256 !== expected.sha256 ||
      fixture.split !== split ||
      !fixture.tracked ||
      !fixture.reviewed ||
      !fixture.permissionVerified ||
      fixtureIds.has(fixture.id) ||
      sceneIds.has(fixture.sceneId) ||
      hashes.has(fixture.sha256)
    )
      return false
    fixtureIds.add(fixture.id)
    sceneIds.add(fixture.sceneId)
    hashes.add(fixture.sha256)
    return true
  })
  const development = fixtures.filter((fixture) => fixture.split === 'development').length
  const confirmation = fixtures.filter((fixture) => fixture.split === 'confirmation').length
  if (fixtures.length !== protocol.corpus.requiredScenes)
    missing.push(
      `Verified distinct frozen scenes: ${fixtures.length}/${protocol.corpus.requiredScenes}`,
    )
  if (development !== protocol.corpus.developmentScenes)
    missing.push(`Development scenes: ${development}/${protocol.corpus.developmentScenes}`)
  if (confirmation !== protocol.corpus.confirmationScenes)
    missing.push(
      `Previously seen confirmation scenes: ${confirmation}/${protocol.corpus.confirmationScenes}`,
    )

  for (const check of [
    'parity',
    'nativeShape',
    'fractionalCoverage',
    'resourceRefusal',
    'cancellation',
    'cleanup',
  ] as const) {
    if (evidence.checks?.[check] === 'failed') blockers.push(`Candidate check failed: ${check}`)
    else if (evidence.checks?.[check] !== 'passed')
      missing.push(`Candidate check incomplete: ${check}`)
  }
  const gains = new Set<string>()
  for (const id of protocol.corpus.sceneIds) {
    const reports = evidence.reviews?.filter((review) => review.id === id) ?? []
    const review = reports.length === 1 ? reports[0] : undefined
    if (!review || !fixtureIds.has(id)) {
      missing.push(`One photographic review is required for verified scene: ${id}`)
      continue
    }
    if (
      !protocol.review.required.every((view) => review.views.includes(view)) ||
      !review.defectsRecorded
    )
      missing.push(`Fit/native proof views and defect review are incomplete: ${id}`)
    if (review.usable !== true) rejected.push(`Scene is unusable or unqualified: ${id}`)
    if (review.regression !== false)
      rejected.push(`Scene regresses or lacks a no-regression finding: ${id}`)
    if (review.usable === true && review.regression === false) {
      const coverage = inputs.images.find((image) => image.id === id)!.coverage
      const classCoverage: Record<string, string[]> = {
        fur: ['fur'],
        'hair-like': ['hair-outline'],
        feather: ['bird', 'feather-boundary'],
        foliage: ['plant-thin-structures'],
        'hard-edge': ['rigid-object'],
      }
      for (const category of review.gainClasses)
        if (classCoverage[category]?.some((tag) => coverage.includes(tag))) gains.add(category)
    }
  }
  for (const category of protocol.review.broadAdoption.requiredGainClasses)
    if (!gains.has(category)) rejected.push(`Broad improvement is unproven: ${category}`)
  return {
    status: blockers.length
      ? 'blocked'
      : missing.length
        ? 'incomplete'
        : rejected.length
          ? 'rejected'
          : 'qualified-for-implementation-planning',
    blockers,
    missing,
    rejected,
    distinctScenes: fixtures.length,
    developmentScenes: development,
    confirmationScenes: confirmation,
    productionActivated: false,
    otherDeviceAcceptance: 'incomplete',
  }
}
