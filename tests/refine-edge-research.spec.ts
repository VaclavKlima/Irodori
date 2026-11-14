import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import protocol from '../assets/tests/references/refine-edge/protocol.json' with { type: 'json' }
import crops from '../assets/tests/references/refine-edge/crops.json' with { type: 'json' }
import inputs from '../assets/tests/references/object-selection/inputs.json' with { type: 'json' }
import {
  assessRefineEdgeEvidence,
  REFINE_EDGE_PROTOCOL_SHA256,
  type RefineEdgeEvidence,
} from '../scripts/research/refine-edge/qualification'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const complete = (): RefineEdgeEvidence => ({
  candidateId: 'guided-r8-eps001',
  protocolSha256: REFINE_EDGE_PROTOCOL_SHA256,
  frozenBeforeExecution: true,
  tunedAfterConfirmation: false,
  claimsUnseenHoldout: false,
  baselineHashes: {
    inputs: protocol.baseline.inputsSha256,
    protocol: protocol.baseline.protocolSha256,
    independentReference: protocol.baseline.independentReferenceSha256,
  },
  license: { code: 'verified', weights: 'not-required' },
  fixtures: inputs.images.map((image) => ({
    id: image.id,
    sceneId: image.sceneId,
    sha256: image.sha256,
    actualSha256: image.sha256,
    split: image.split === 'holdout' ? 'confirmation' : 'development',
    tracked: image.tracked,
    reviewed: image.reviewed,
    permissionVerified: image.permissionVerified,
  })),
  runtime: {
    platform: 'linux-x64',
    adapter: 'Explicit test adapter; this gate fixture is not hardware evidence',
    status: 'passed',
    provider: 'webgpu',
    cpuFallbackDisabled: true,
    heavyCpuNodes: 0,
    resourcePolicy: 'Automatic',
    resourceOverride: false,
    automaticSnapshotSha256: 'a'.repeat(64),
  },
  checks: {
    parity: 'passed',
    nativeShape: 'passed',
    fractionalCoverage: 'passed',
    resourceRefusal: 'passed',
    cancellation: 'passed',
    cleanup: 'passed',
  },
  reviews: inputs.images.map((image) => ({
    id: image.id,
    views: [...protocol.review.required],
    usable: true,
    regression: false,
    gainClasses:
      (
        {
          'd01-fog-dog': ['fur'],
          'd06-wig': ['hair-like'],
          'h11-robin': ['feather'],
          'h10-shore-pine': ['foliage'],
          'd05-paper-edge': ['hard-edge'],
        } as Record<string, string[]>
      )[image.id] ?? [],
    defectsRecorded: true,
  })),
})

test('study and independent baselines are pinned without changing the old protocol', async () => {
  expect(hash(await readFile('assets/tests/references/refine-edge/protocol.json'))).toBe(
    REFINE_EDGE_PROTOCOL_SHA256,
  )
  for (const [path, expected] of [
    [protocol.baseline.inputs, protocol.baseline.inputsSha256],
    [protocol.baseline.protocol, protocol.baseline.protocolSha256],
    [protocol.baseline.independentReference, protocol.baseline.independentReferenceSha256],
  ])
    expect(hash(await readFile(path))).toBe(expected)
  expect(protocol.corpus.sceneIds).toEqual(inputs.images.map((image) => image.id))
  expect(protocol.baseline.comparator).toEqual({ feather: 4, shift: 0 })
  expect(protocol.candidates[0]).toMatchObject({ modelEdge: 1024, radius: 8, epsilon: 0.001 })
  expect(protocol.candidates[1]).toMatchObject({ fast: false, L: 900 })
})

test('all twelve original fixtures are tracked and match their reviewed permitted bytes', async () => {
  const paths = inputs.images.map((image) => image.source)
  expect(
    execFileSync('git', ['ls-files', '--error-unmatch', '--', ...paths], { encoding: 'utf8' })
      .trim()
      .split('\n'),
  ).toHaveLength(12)
  for (const image of inputs.images) {
    expect(image.permissionVerified && image.reviewed && image.tracked).toBe(true)
    expect(hash(await readFile(image.source))).toBe(image.sha256)
  }
})

test('offline +1 EV diagnostics preserve zero coverage and alpha while retaining fractional edits', async () => {
  const { diagnosticPixels } = (await import(
    pathToFileURL(resolve('scripts/research/refine-edge/render-proofs.mjs')).href
  )) as {
    diagnosticPixels: (
      rgba: Uint8Array,
      coverage: Uint8Array,
      mode: 'overlay' | 'plus-one-ev',
    ) => Uint8Array
  }
  const unchanged = Buffer.from(Array.from({ length: 256 }, (_, value) => value))
  for (const mode of ['overlay', 'plus-one-ev'] as const)
    expect(Buffer.from(diagnosticPixels(unchanged, new Uint8Array(64), mode))).toEqual(unchanged)
  // IEC sRGB transfer at twice linear light gives 175.5556, rounded to 176; half coverage is 154.
  const source = Buffer.from([128, 128, 128, 37, 128, 128, 128, 83, 128, 128, 128, 219])
  expect(
    Array.from(diagnosticPixels(source, Uint8Array.from([0, 128, 255]), 'plus-one-ev')),
  ).toEqual([128, 128, 128, 37, 154, 154, 154, 83, 176, 176, 176, 219])
  expect(() => diagnosticPixels(source, new Uint8Array(2), 'plus-one-ev')).toThrow(
    'Invalid native diagnostic coverage',
  )
})

test('frozen native crops retain corpus source hashes, complete scene coverage and in-bounds coordinates', async () => {
  expect(hash(await readFile('assets/tests/references/refine-edge/crops.json'))).toBe(
    '0a0a898ed8d33ecd9634ad615727f3cc8eb215d32d059177eddc5e8174497e0a',
  )
  expect(crops.protocolSha256).toBe(REFINE_EDGE_PROTOCOL_SHA256)
  expect(crops.cases.map((entry) => entry.id)).toEqual(protocol.corpus.sceneIds)
  for (const entry of crops.cases) {
    expect(entry.sourceSha256).toBe(inputs.images.find((image) => image.id === entry.id)!.sha256)
    expect(Number.isSafeInteger(entry.width) && entry.width > 0).toBe(true)
    expect(Number.isSafeInteger(entry.height) && entry.height > 0).toBe(true)
    expect(entry.regions.length).toBeGreaterThanOrEqual(2)
    expect(new Set(entry.regions.map((region) => region.name)).size).toBe(entry.regions.length)
    for (const region of entry.regions) {
      expect([region.x, region.y, region.width, region.height].every(Number.isSafeInteger)).toBe(
        true,
      )
      expect(region.x).toBeGreaterThanOrEqual(0)
      expect(region.y).toBeGreaterThanOrEqual(0)
      expect(region.width).toBeGreaterThan(0)
      expect(region.height).toBeGreaterThan(0)
      expect(region.x + region.width).toBeLessThanOrEqual(entry.width)
      expect(region.y + region.height).toBeLessThanOrEqual(entry.height)
    }
  }
})

test('missing results and synthetic parity alone never qualify photographic adoption', () => {
  const result = assessRefineEdgeEvidence({
    candidateId: 'guided-r8-eps001',
    checks: { parity: 'passed' },
  })
  expect(result.status).toBe('incomplete')
  expect(result.distinctScenes).toBe(0)
  expect(result.productionActivated).toBe(false)
})

test('fixed confirmation split cannot be relabeled unseen, retuned or padded with repeated bytes', () => {
  for (const patch of [{ claimsUnseenHoldout: true }, { tunedAfterConfirmation: true }])
    expect(assessRefineEdgeEvidence({ ...complete(), ...patch }).status).toBe('blocked')
  const evidence = complete()
  evidence.fixtures![10] = { ...evidence.fixtures![9] }
  expect(assessRefineEdgeEvidence(evidence)).toMatchObject({
    status: 'incomplete',
    confirmationScenes: 2,
  })
})

test('wrong original bytes, missing permission and license gaps cannot qualify', () => {
  for (const patch of [
    { actualSha256: 'b'.repeat(64) },
    { permissionVerified: false },
    { tracked: false },
    { reviewed: false },
  ]) {
    const evidence = complete()
    Object.assign(evidence.fixtures![0], patch)
    expect(assessRefineEdgeEvidence(evidence)).toMatchObject({
      status: 'incomplete',
      distinctScenes: 11,
    })
  }
  const unlicensed = complete()
  unlicensed.license = { code: 'verified', weights: 'incompatible' }
  expect(assessRefineEdgeEvidence(unlicensed).status).toBe('blocked')
  const cascade = { ...complete(), candidateId: 'cascadepsp-l900-full' }
  expect(assessRefineEdgeEvidence(cascade).status).toBe('incomplete')
})

test('CPU execution, missing actual adapter and resource overrides cannot become GPU acceptance', () => {
  for (const patch of [
    { provider: 'cpu' },
    { provider: 'cuda' },
    { heavyCpuNodes: 1 },
    { cpuFallbackDisabled: false },
    { status: 'failed' },
    { resourceOverride: true },
    { resourcePolicy: 'Custom' },
  ]) {
    const evidence = complete()
    Object.assign(evidence.runtime!, patch)
    expect(assessRefineEdgeEvidence(evidence).status).toBe('blocked')
  }
  const evidence = complete()
  evidence.runtime!.adapter = ''
  expect(assessRefineEdgeEvidence(evidence).status).toBe('incomplete')
})

test('failed or incomplete cancellation, cleanup, resource, shape and fractional gates stay explicit', () => {
  for (const check of [
    'parity',
    'nativeShape',
    'fractionalCoverage',
    'resourceRefusal',
    'cancellation',
    'cleanup',
  ] as const) {
    const evidence = complete()
    evidence.checks![check] = 'failed'
    expect(assessRefineEdgeEvidence(evidence).status).toBe('blocked')
    evidence.checks![check] = 'incomplete'
    expect(assessRefineEdgeEvidence(evidence).status).toBe('incomplete')
  }
})

test('broad adoption rejects one regression, unusable scene or missing class gain', () => {
  for (const patch of [{ regression: true }, { usable: false }]) {
    const evidence = complete()
    Object.assign(evidence.reviews![11], patch)
    expect(assessRefineEdgeEvidence(evidence).status).toBe('rejected')
  }
  const evidence = complete()
  evidence.reviews![0].gainClasses = ['hard-edge']
  expect(assessRefineEdgeEvidence(evidence).status).toBe('rejected')
  // Copying every class label onto a dog does not establish other edge classes.
  for (const review of evidence.reviews!) review.gainClasses = []
  evidence.reviews![0].gainClasses = [...protocol.review.broadAdoption.requiredGainClasses]
  expect(assessRefineEdgeEvidence(evidence).status).toBe('rejected')
  evidence.reviews![1].views = ['fit-overlay']
  expect(assessRefineEdgeEvidence(evidence).status).toBe('incomplete')
})

test('complete local evidence permits implementation planning while other devices remain incomplete', () => {
  expect(assessRefineEdgeEvidence(complete())).toMatchObject({
    status: 'qualified-for-implementation-planning',
    blockers: [],
    missing: [],
    rejected: [],
    distinctScenes: 12,
    developmentScenes: 9,
    confirmationScenes: 3,
    productionActivated: false,
    otherDeviceAcceptance: 'incomplete',
  })
})
