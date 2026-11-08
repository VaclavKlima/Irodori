/** Research gates only. No application renderer or edit service imports this module. */
interface Protocol {
  runtime: { requiredPlatforms: readonly string[] }
  corpus: { requiredScenes: number; holdoutScenes: number; requiredCoverage: readonly string[] }
}
export interface StudyScene {
  sceneId: string
  sha256: string
  split: string
  coverage: string[]
  reviewed: boolean
  tracked: boolean
  permissionVerified: boolean
  privateExploration?: boolean
}
export interface StudyEvidence {
  platforms?: {
    platform: string
    status: string
    provider?: string
    cpuFallbackDisabled?: boolean
    heavyCpuNodes?: number
  }[]
  scenes?: StudyScene[]
  modelParity?: string
  manualCorrection?: string
  nativeReview?: string
}
export function assessObjectSelectionEvidence(protocol: Protocol, evidence: StudyEvidence) {
  const expectedPlatforms = protocol.runtime.requiredPlatforms
  const platformReports = evidence.platforms ?? []
  const blockers = []
  const missing = []
  for (const platform of expectedPlatforms) {
    const report = platformReports.find((entry) => entry.platform === platform)
    if (!report) {
      missing.push(`Runtime evidence missing: ${platform}`)
      continue
    }
    if (report.status !== 'passed') blockers.push(`Strict GPU runtime unavailable: ${platform}`)
    else if (report.provider !== 'webgpu' || report.cpuFallbackDisabled !== true)
      blockers.push(`Strict GPU assignment is unproven: ${platform}`)
    else if (report.heavyCpuNodes !== 0)
      blockers.push(`Heavy CPU assignment is not excluded: ${platform}`)
  }
  const scenes = evidence.scenes ?? []
  const eligible = scenes.filter(
    (scene) =>
      scene.reviewed === true &&
      scene.tracked === true &&
      scene.permissionVerified === true &&
      /^[a-f0-9]{64}$/.test(scene.sha256 ?? '') &&
      scene.privateExploration !== true,
  )
  const ids = new Set<string>()
  const hashes = new Set<string>()
  const unique = eligible.filter((scene) => {
    if (!scene.sceneId || ids.has(scene.sceneId) || hashes.has(scene.sha256)) return false
    ids.add(scene.sceneId)
    hashes.add(scene.sha256)
    return true
  })
  if (unique.length < protocol.corpus.requiredScenes)
    missing.push(`Reviewed distinct scenes: ${unique.length}/${protocol.corpus.requiredScenes}`)
  const holdout = unique.filter((scene) => scene.split === 'holdout')
  if (holdout.length < protocol.corpus.holdoutScenes)
    missing.push(`Reviewed held-out scenes: ${holdout.length}/${protocol.corpus.holdoutScenes}`)
  for (const category of protocol.corpus.requiredCoverage)
    if (!unique.some((scene) => scene.coverage?.includes(category)))
      missing.push(`Photographic coverage missing: ${category}`)
  if (evidence.modelParity !== 'passed')
    missing.push('Model export/reference parity is unqualified.')
  if (evidence.manualCorrection !== 'passed')
    missing.push('Manual correction/persistence is unqualified.')
  if (evidence.nativeReview !== 'passed') missing.push('Native photographic review is unqualified.')
  return {
    status: blockers.length
      ? 'blocked'
      : missing.length
        ? 'incomplete'
        : 'qualified-for-implementation-planning',
    blockers,
    missing,
    distinctScenes: unique.length,
    heldOutScenes: holdout.length,
    productionActivated: false,
  }
}
