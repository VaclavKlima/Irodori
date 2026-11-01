import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

// Source-only draft. No counts, source freeze or numerical execution are
// authorized by this file. A separately reviewed external freeze is required
// before any --generate or candidate --check child can start.
const root = resolve('.')
const directory = resolve('scripts/research/strong-noise/reference')
const generator = join(directory, 'chroma-pilot.py')
const candidate = resolve('scripts/research/strong-noise/chroma-pilot-pointwise.py')
const kind = 'chroma-pilot-pointwise-decimal80-host-f64-v1'
const candidateId = 'noise-scaled-k40-c14-pilot-pointwise-r10'
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Group = 'core' | 'alpha' | 'asymmetric' | 'identity' | 'publication'

interface WordOracle {
  kind: string
  scope: string
  coefficientPolicy: string
  coefficientWords: null | Record<string, string[]>
  candidateImported: boolean
}
interface Scene {
  id: string
  width: number
  height: number
  points: number[][]
  pixelOverrides?: { x: number; y: number; rgba32Words: string[] }[]
}
interface Plan {
  referenceKind: string
  candidateId: string
  candidateImported: boolean
  group: Group
  planSha256: string
  sourceBindings: Record<string, string>
  wordOracle: WordOracle
  primaries: string[]
  controls: number[][]
  cases: Scene[]
  configurations: number
  publicationVectors: {
    id: string
    featureHex: string
    proposalHex: string
    normalizedDeltaHex: string
  }[]
  aggregation: string
  stageScalars: number
  stageLayout: string
  guideScalars: number
  pilotStageScalars: number
  pilotStageLayout: string
  sourceHalo: { luminance: number; chroma: number }
  proposalBoundRadii: number[]
  baseLuminanceMaximum: string
  baseChromaMaximum: string
  chromaSigmaFactor: string
  chromaSpatialPolicy: string
  luminanceSearchRadius: number
  chromaSearchRadius: number
  luminanceMatchingRadius: number
  chromaMatchingRadius: number
  luminanceTargetRadius: number
  chromaTargetRadius: number
  guidePolicy: string
  valuePolicy: string
  chromaDistancePolicy: string
  neighborAlphaPolicy: string
  limits: { float64Reference: string; float32CpuGpu: string }
}
interface ReviewedFreeze {
  referenceGenerationApproved: boolean
  referenceKind: string
  sourceBindings: Record<string, string>
  candidateSha256: string
  wordOracle: Omit<WordOracle, 'coefficientWords'>
  groups: Record<Group, { planSha256: string; configurations: number }>
}
interface Result {
  status: string
  referenceKind: string
  candidateId: string
  group: Group
  configurations: number
  generatorSha256: string
  candidateSha256: string
  planSha256: string
  sourceBindings: Record<string, string>
  wordOracle: WordOracle
  coefficientWordsAgreed: boolean
  independentCoefficientWordsChecked: number
  preFinalRgbChannelsChecked: number
  finalRgbChannelsChecked: number
  exactPilotCenterWordsChecked: number
  exactPilotProposalWords64Checked: number
  exactGuideWordsChecked: number
  exactCenterWordsChecked: number
  guidePublicationSeamsChecked: number
  finalPublicationSeamsChecked: number
  chromaNormalizationSeamsChecked: number
  allGridAlphaWordsChecked: number
  allGridTransparentRgbaCopiesChecked: number
  allGridNeutralRgbaCopiesChecked: number
  C0OldC9RgbaWordsChecked: number
  C0OldC9ProposalWordsChecked: number
  C0OldC9StageWordsChecked: number
  C0GuideAbsencesChecked: number
  C0PilotAbsencesChecked: number
  allLuminanceProposalWordsChecked: number
  allLuminanceCenterWordsChecked: number
  nonzeroChromaLuminanceProposalWordsChecked: number
  nonzeroChromaLuminanceCenterWordsChecked: number
  pairedRgbChannelsChecked: number
  pairedProposalWordsChecked: number
  pairedCenterWordsChecked: number
  failures: { kind: string; scene?: string; point?: number[] }[]
}

function assertWordOracle(oracle: WordOracle, hasNumericWords: boolean) {
  expect(oracle.kind).toBe('host-f64-operation-graph-v1')
  expect(oracle.scope).toBe('host-runtime-libm-v1')
  expect(oracle.coefficientPolicy).toBe(
    'independent-Decimal80-primary-solve-rounded-to-binary64-v1',
  )
  expect(oracle.candidateImported).toBe(false)
  if (!hasNumericWords) {
    expect(oracle.coefficientWords).toBeNull()
    return
  }
  expect(oracle.coefficientWords).not.toBeNull()
  expect(Object.keys(oracle.coefficientWords!).sort()).toEqual(['rec2020', 'srgb'])
  for (const primary of ['srgb', 'rec2020']) {
    const words = oracle.coefficientWords![primary]
    expect(words).toHaveLength(3)
    for (const word of words) expect(word).toMatch(/^[a-f0-9]{16}$/)
  }
}

function assertPlan(plan: Plan, group: Group) {
  expect(plan.referenceKind).toBe(kind)
  expect(plan.candidateId).toBe(candidateId)
  expect(plan.candidateImported).toBe(false)
  expect(plan.group).toBe(group)
  expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(plan.primaries).toEqual(['srgb', 'rec2020'])
  assertWordOracle(plan.wordOracle, false)
  expect([plan.baseLuminanceMaximum, plan.baseChromaMaximum, plan.chromaSigmaFactor]).toEqual([
    '0.024',
    '0.024',
    '0.4',
  ])
  expect(plan.aggregation).toBe('normalized-l9-patch-c1-owner-estimates-f32-zero-v1')
  expect([plan.stageScalars, plan.guideScalars, plan.pilotStageScalars]).toEqual([11, 3, 59])
  expect(plan.stageLayout).toBe('l9-row-major-c1-ab-owner-v1')
  expect(plan.pilotStageLayout).toBe('l9-row-major-c25-ab-row-major-v1')
  expect(plan.sourceHalo).toEqual({ luminance: 5, chroma: 24 })
  expect(plan.proposalBoundRadii).toEqual([3, 10, 10])
  expect(plan.chromaSpatialPolicy).toBe('uniform-search-v1')
  expect([plan.luminanceSearchRadius, plan.chromaSearchRadius]).toEqual([3, 10])
  expect([
    plan.luminanceMatchingRadius,
    plan.chromaMatchingRadius,
    plan.luminanceTargetRadius,
    plan.chromaTargetRadius,
  ]).toEqual([1, 0, 1, 0])
  expect(plan.guidePolicy).toBe('fixed-c14-100-100-preinverse-feature-rn32-v1')
  expect(plan.valuePolicy).toBe('original-features-only-v1')
  expect(plan.chromaDistancePolicy).toBe('pointwise-pilot-l08-ab-sum-hc-no-bias-v1')
  expect(plan.neighborAlphaPolicy).toBe('squared-visible-neighbor-v1')
  expect(plan.limits.float64Reference).toContain('2e-12 + 2e-11 * abs(reference)')
  expect(plan.limits.float32CpuGpu).toContain('2e-6 + 2e-5 * abs(reference)')
  if (group === 'publication') {
    expect(plan.cases).toEqual([])
    expect(plan.controls).toEqual([])
    const ids = plan.publicationVectors.map((vector) => vector.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(plan.configurations).toBe(ids.length)
    expect(ids.length).toBeGreaterThan(0)
    for (const vector of plan.publicationVectors)
      for (const field of ['featureHex', 'proposalHex', 'normalizedDeltaHex'] as const)
        expect(vector[field]).toMatch(/^-?0x[0-9a-f]+\.[0-9a-f]+p[+-][0-9]+$/i)
  } else {
    // Counts derive from the complete declared cross product and must also
    // agree with root's separate reviewed freeze before numerical work.
    expect(plan.configurations).toBe(
      plan.cases.length * plan.primaries.length * plan.controls.length,
    )
    expect(plan.publicationVectors).toEqual([])
    expect(plan.controls).toEqual(
      group === 'asymmetric'
        ? [
            [1, 100],
            [100, 1],
            [25, 75],
            [75, 25],
            [50, 0],
            [0, 50],
          ]
        : [0, 1, 25, 50, 75, 100].map((amount) => [amount, group === 'identity' ? 0 : amount]),
    )
  }
  if (group === 'core') {
    const halo = plan.cases.find((scene) => scene.id === 'pilot-pointwise-context-halo24')
    expect(halo).toBeDefined()
    expect([halo!.width, halo!.height]).toEqual([49, 9])
    expect(halo!.points).toEqual([[12, 4]])
    expect(halo!.pixelOverrides?.[0]).toEqual({
      x: 36,
      y: 4,
      rgbaDecimal: ['0.25', '0.125', '0.0625', '1'],
      rgba32Words: ['3e800000', '3e000000', '3d800000', '3f800000'],
    })
    expect(36 - 12).toBe(plan.sourceHalo.chroma)
    expect(36 - 12).toBeGreaterThan(plan.proposalBoundRadii[1])
    expect(plan.cases.map((scene) => scene.id)).toContain('full-target-context-halo14')
    expect(plan.cases.map((scene) => scene.id)).toContain('matching-context-only')
    expect(plan.cases.map((scene) => scene.id)).toContain('wide-search-support')
  }
}

async function command(args: string[], output: string, expectFailure = false) {
  await mkdir(output, { recursive: true })
  return new Promise<string>((accept, reject) => {
    const child = execFile(
      python,
      ['-B', generator, ...args],
      { timeout: 600_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(output, 'stdout.txt'), stdout),
          writeFile(join(output, 'stderr.txt'), stderr),
        ]).then(() => {
          if (expectFailure) {
            if (error && error.code === 1) accept(stdout)
            else
              reject(new Error('Counterfeit checker did not exit with its numeric-failure code.'))
          } else if (error)
            reject(new Error('Independent C15 reference failed: ' + stderr, { cause: error }))
          else accept(stdout)
        }, reject)
      },
    )
    children.add(child)
  })
}

async function reviewedApproval(plan: Plan, group: Group, info: TestInfo) {
  const path = process.env.IRODORI_C15_NUMERIC_APPROVAL
  if (!path)
    throw new Error(
      'C15 numerical execution has no reviewed freeze. Set IRODORI_C15_NUMERIC_APPROVAL only after root approves the independent sources, exact-word contract and group counts.',
    )
  const freeze = JSON.parse(await readFile(resolve(path), 'utf8')) as ReviewedFreeze
  expect(freeze.referenceGenerationApproved).toBe(true)
  expect(freeze.referenceKind).toBe(kind)
  expect(freeze.sourceBindings).toEqual(plan.sourceBindings)
  expect(freeze.wordOracle).toEqual({
    kind: plan.wordOracle.kind,
    scope: plan.wordOracle.scope,
    coefficientPolicy: plan.wordOracle.coefficientPolicy,
    candidateImported: false,
  })
  const reviewedGroup = freeze.groups[group]
  expect(reviewedGroup).toEqual({
    planSha256: plan.planSha256,
    configurations: plan.configurations,
  })
  expect(freeze.candidateSha256).toBe(sha(await readFile(candidate)))
  for (const [relative, digest] of Object.entries(plan.sourceBindings)) {
    const actual = resolve(relative)
    expect(actual.startsWith(root + sep), 'Reference source must belong to this checkout.').toBe(
      true,
    )
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(sha(await readFile(actual))).toBe(digest)
  }
  const approval = info.outputPath('approval.json')
  await writeFile(
    approval,
    JSON.stringify({
      ...freeze,
      group,
      planSha256: plan.planSha256,
      generatorSha256: sha(await readFile(generator)),
      sharedGeneratorSha256: sha(await readFile(join(directory, 'reference.py'))),
      sharedInputPlanSha256: sha(await readFile(join(directory, 'input-plan.json'))),
      scope:
        'Reviewed C15 mathematical vectors only. Host-F64/libm word model and independent Decimal80 RGB gates remain distinct. No estimator, photograph, GPU, quality or performance acceptance.',
    }),
  )
  return approval
}

async function compare(group: Group, info: TestInfo) {
  await mkdir(info.outputDir, { recursive: true })
  const plan = JSON.parse(
    await command(['--plan', '--group', group], info.outputPath('plan-command')),
  ) as Plan
  assertPlan(plan, group)
  if (group !== 'publication') {
    const baseline = JSON.parse(await readFile(join(directory, 'input-plan.json'), 'utf8')) as {
      cases: Scene[]
    }
    const names =
      group === 'core'
        ? new Set([
            'signed-zero-identity',
            'flat-gray',
            'noise-like-low',
            'signed-hdr',
            'one-pixel',
            'one-axis',
            'one-horizontal-axis',
            'clamped-bias',
            'clamped-zero-variance',
          ])
        : group === 'alpha'
          ? new Set([
              'hidden-zero-a',
              'hidden-zero-b',
              'partial-alpha',
              'partial-alpha-common-scale',
              'noise-like-low',
              'opaque-tiny-alpha',
              'opaque-subnormal-alpha',
            ])
          : group === 'asymmetric'
            ? new Set(['noise-like-low'])
            : new Set(baseline.cases.map((scene) => scene.id))
    const original = baseline.cases
      .filter((scene) => names.has(scene.id))
      .map((scene) => (group === 'identity' ? { ...scene, points: [] } : scene))
    expect(plan.cases.slice(0, original.length)).toEqual(original)
    if (group !== 'core') expect(plan.cases).toHaveLength(original.length)
  }
  const approval = await reviewedApproval(plan, group, info)
  const reference = info.outputPath('reference.json')
  const comparison = info.outputPath('comparison.json')
  await command(
    ['--generate', '--group', group, '--approved-freeze', approval, '--output', reference],
    info.outputPath('generation-command'),
  )
  const generated = JSON.parse(await readFile(reference, 'utf8')) as Plan & {
    scenes?: {
      id: string
      width: number
      height: number
      inputRgba32leHex: string
      cases: {
        luminance: number
        chroma: number
        points: {
          x: number
          y: number
          proposalBoundRadii: number[]
          localFeatureRanges: string[]
          featureRangesRadius3: string[]
        }[]
      }[]
    }[]
  }
  expect(generated.candidateImported).toBe(false)
  expect(generated.referenceKind).toBe(kind)
  expect(generated.planSha256).toBe(plan.planSha256)
  expect(generated.sourceBindings).toEqual(plan.sourceBindings)
  assertWordOracle(generated.wordOracle, true)
  for (const field of [
    'aggregation',
    'stageScalars',
    'stageLayout',
    'guideScalars',
    'pilotStageScalars',
    'pilotStageLayout',
    'sourceHalo',
    'proposalBoundRadii',
  ] as const)
    expect(generated[field]).toEqual(plan[field])
  if (group !== 'publication') {
    expect(generated.scenes!.map((scene) => scene.id)).toEqual(plan.cases.map((scene) => scene.id))
    expect(generated.scenes!.reduce((sum, scene) => sum + scene.cases.length, 0)).toBe(
      plan.configurations,
    )
  }
  if (group === 'core') {
    const halo = generated.scenes!.find((scene) => scene.id === 'pilot-pointwise-context-halo24')!
    const words = Buffer.from(halo.inputRgba32leHex, 'hex')
    expect([halo.width, halo.height]).toEqual([49, 9])
    expect(
      [0, 1, 2, 3].map((channel) => words.readUInt32LE(((4 * halo.width + 36) * 4 + channel) * 4)),
    ).toEqual([0x3e800000, 0x3e000000, 0x3d800000, 0x3f800000])
    const wide = generated.scenes!.find((scene) => scene.id === 'wide-search-support')!
    for (const configuration of wide.cases.filter(
      (value) => value.luminance === 100 && value.chroma === 100,
    )) {
      const owner = configuration.points.find((point) => point.x === 12 && point.y === 1)!
      expect(owner.proposalBoundRadii).toEqual([3, 10, 10])
      expect(owner.localFeatureRanges[0]).toBe(owner.featureRangesRadius3[0])
      for (const component of [1, 2])
        expect(Number(owner.localFeatureRanges[component])).toBeGreaterThan(
          Number(owner.featureRangesRadius3[component]) * (1 + 2 ** -24) + 2 ** -150,
        )
    }
  }
  await command(
    ['--check', reference, '--output', comparison],
    info.outputPath('comparison-command'),
  )
  const result = JSON.parse(await readFile(comparison, 'utf8')) as Result
  expect(result.status).toBe('passed')
  expect(result.referenceKind).toBe(kind)
  expect(result.candidateId).toBe(candidateId)
  expect(result.group).toBe(group)
  expect(result.planSha256).toBe(plan.planSha256)
  expect(result.configurations).toBe(plan.configurations)
  expect(result.sourceBindings).toEqual(plan.sourceBindings)
  expect(result.generatorSha256).toBe(sha(await readFile(generator)))
  expect(result.candidateSha256).toBe(sha(await readFile(candidate)))
  expect(result.failures).toEqual([])
  assertWordOracle(result.wordOracle, true)
  expect(result.wordOracle.coefficientWords).toEqual(generated.wordOracle.coefficientWords)
  expect(result.coefficientWordsAgreed).toBe(true)
  expect(result.independentCoefficientWordsChecked).toBe(6)
  if (group === 'publication') {
    expect(result.guidePublicationSeamsChecked).toBe(plan.configurations)
    expect(result.finalPublicationSeamsChecked).toBe(plan.configurations)
    expect(result.chromaNormalizationSeamsChecked).toBe(plan.configurations)
  } else {
    const sourcePixels = plan.cases.reduce((sum, scene) => sum + scene.width * scene.height, 0)
    const activePixels =
      sourcePixels * plan.primaries.length * plan.controls.filter(([, chroma]) => chroma > 0).length
    expect(result.allGridAlphaWordsChecked).toBe(
      sourcePixels * plan.primaries.length * plan.controls.length,
    )
    expect(result.exactPilotCenterWordsChecked).toBe(activePixels * 59)
    expect(result.exactPilotProposalWords64Checked).toBe(activePixels * 3)
    expect(result.exactGuideWordsChecked).toBe(activePixels * 3)
    expect(result.exactCenterWordsChecked).toBe(activePixels * 11)
    const c0Controls = plan.controls.filter(([, chroma]) => chroma === 0)
    const c0Pixels = sourcePixels * plan.primaries.length * c0Controls.length
    const c0Configurations = plan.cases.length * plan.primaries.length * c0Controls.length
    expect(result.C0OldC9RgbaWordsChecked).toBe(c0Pixels * 4)
    expect(result.C0OldC9ProposalWordsChecked).toBe(c0Pixels * 3)
    expect(result.C0OldC9StageWordsChecked).toBe(
      sourcePixels *
        plan.primaries.length *
        c0Controls.filter(([luminance]) => luminance > 0).length *
        27,
    )
    expect(result.C0GuideAbsencesChecked).toBe(c0Configurations)
    expect(result.C0PilotAbsencesChecked).toBe(c0Configurations)
    expect(result.allLuminanceProposalWordsChecked).toBeGreaterThan(0)
    expect(result.allLuminanceCenterWordsChecked).toBeGreaterThan(0)
    if (group !== 'asymmetric') expect(result.allGridNeutralRgbaCopiesChecked).toBeGreaterThan(0)
    if (group === 'identity') {
      expect(result.preFinalRgbChannelsChecked).toBe(0)
      expect(result.exactPilotCenterWordsChecked).toBe(0)
      expect(result.exactGuideWordsChecked).toBe(0)
    } else {
      expect(result.preFinalRgbChannelsChecked).toBeGreaterThan(0)
      expect(result.finalRgbChannelsChecked).toBe(result.preFinalRgbChannelsChecked)
      expect(result.exactPilotCenterWordsChecked).toBeGreaterThan(0)
      expect(result.exactGuideWordsChecked).toBeGreaterThan(0)
      expect(result.exactCenterWordsChecked).toBeGreaterThan(0)
      expect(result.nonzeroChromaLuminanceProposalWordsChecked).toBeGreaterThan(0)
      expect(result.nonzeroChromaLuminanceCenterWordsChecked).toBeGreaterThan(0)
    }
  }
  return { plan, result, reference }
}

const numericFailures = new Set([
  'pilot-center-publication-word',
  'guide-publication-word',
  'center-publication-word',
  'pilot-publication-not-f32',
  'pilot-center-publication-not-f32',
  'guide-publication-not-f32',
  'center-publication-not-f32',
  'final-publication-not-f32',
  'strict-pre-final-rgb',
  'final-rgb',
])

async function rejected(
  reference: string,
  wrong: string,
  name: string,
  info: TestInfo,
  required?: (failure: Result['failures'][number]) => boolean,
) {
  const comparison = info.outputPath(name + '-comparison.json')
  await command(
    ['--check', reference, '--candidate', wrong, '--output', comparison],
    info.outputPath(name + '-command'),
    true,
  )
  const result = JSON.parse(await readFile(comparison, 'utf8')) as Result
  expect(result.status).toBe('failed')
  expect(result.failures.some((failure) => numericFailures.has(failure.kind))).toBe(true)
  if (required) expect(result.failures.some(required)).toBe(true)
}

function pythonWrapper(body: string[]) {
  return (
    [
      'import importlib.util',
      'spec=importlib.util.spec_from_file_location("c15_wrong", ' + JSON.stringify(candidate) + ')',
      'real=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(real)',
      'OFFSETS=real.OFFSETS',
      'EXPECTED_CANDIDATE=real.EXPECTED_CANDIDATE',
      'def publish_guide_component(*args):return real.publish_guide_component(*args)',
      'def publish_delta_component(*args):return real.publish_delta_component(*args)',
      'def publish_chroma_component(*args):return real.publish_chroma_component(*args)',
      ...body,
    ].join('\n') + '\n'
  )
}

test.afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((accept) => {
          if (child.exitCode !== null || child.signalCode !== null) return accept()
          child.once('close', () => accept())
          child.kill('SIGTERM')
        }),
    ),
  )
  children.clear()
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('independent pilot guidance preserves original values and rejects wrong guidance, publication and halo', async ({}, info) => {
  test.setTimeout(900_000)
  const { reference } = await compare('core', info)
  const definitions: [string, string[]][] = [
    [
      'raw-source-guide',
      [
        'def wrong(model,features,alpha,pilot):',
        '    return [[model.f32(v) for v in features[p]] if alpha[p]>0 else [0.0]*3 for p in range(len(features))]',
        'real._build_guide=wrong',
      ],
    ],
    [
      'guide-values-instead-of-original',
      [
        'original=real._pointwise_chroma',
        'def wrong(model,features,guide,alpha,width,height,h_c):',
        '    return original(model,guide,guide,alpha,width,height,h_c)',
        'real._pointwise_chroma=wrong',
      ],
    ],
    [
      'unpublished-pilot',
      [
        'original=real._component_feature_proposals',
        'class Unpublished:',
        '    def __init__(self,model):self.model=model',
        '    def __getattr__(self,name):return getattr(self.model,name)',
        '    def f32(self,value):return value',
        'def wrong(model,*args):return original(Unpublished(model),*args)',
        'real._component_feature_proposals=wrong',
      ],
    ],
    [
      'unpublished-guide',
      ['real.publish_guide_component=lambda model,feature,proposal: feature+proposal'],
    ],
    [
      'rgb-roundtrip-guide',
      [
        'context={}',
        'def wrong(model,features,alpha,pilot):',
        '    source,coeff=context["source"],context["coeff"]',
        '    result=[]',
        '    for p,rgb in enumerate(source):',
        '        if alpha[p]==0:result.append([0.0]*3);continue',
        '        y=real.math.fsum(a*b for a,b in zip(rgb[:3],coeff));s=real.math.hypot(y,.18)',
        '        dl,da,db=(model.change(y,.18,pilot[p][0]),model.change(rgb[0]-y,s,pilot[p][1]),model.change(rgb[2]-y,s,pilot[p][2]))',
        '        rounded=[model.f32(v) for v in (rgb[0]+dl+da,rgb[1]+dl-(coeff[0]*da+coeff[2]*db)/coeff[1],rgb[2]+dl+db)]',
        '        result.append([model.f32(v) for v in model.encode(rounded,coeff)])',
        '    return result',
        'real._build_guide=wrong',
      ],
    ],
  ]
  for (const [name, body] of definitions) {
    const wrong = info.outputPath(name + '.py')
    const call =
      name === 'rgb-roundtrip-guide'
        ? [
            'def denoise(*args,**kwargs):',
            '    context["source"],context["coeff"]=args[1],args[4]',
            '    return real.denoise(*args,**kwargs)',
          ]
        : ['denoise=real.denoise']
    await writeFile(wrong, pythonWrapper([...body, ...call]))
    await rejected(reference, wrong, name, info)
  }
  const wrong = info.outputPath('short-halo23.py')
  await writeFile(
    wrong,
    pythonWrapper([
      'def denoise(*args,**kwargs):',
      '    values=list(args)',
      '    if values[2:4]==[49,9]:',
      '        frame=[pixel[:] for pixel in values[1]]',
      '        for y in range(9):',
      '            for x in range(36,49):frame[y*49+x]=frame[y*49+35][:]',
      '        values[1]=frame',
      '    return real.denoise(*values,**kwargs)',
    ]),
  )
  await rejected(
    reference,
    wrong,
    'short-halo23',
    info,
    (failure) =>
      failure.scene === 'pilot-pointwise-context-halo24' &&
      failure.point?.[0] === 12 &&
      failure.point?.[1] === 4 &&
      ['strict-pre-final-rgb', 'final-rgb'].includes(failure.kind),
  )
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('pilot guidance preserves hidden and common-scaled alpha state with squared neighbor weights and uncapped self', async ({}, info) => {
  test.setTimeout(900_000)
  const { result, reference } = await compare('alpha', info)
  expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.pairedProposalWordsChecked).toBeGreaterThan(0)
  expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
  const source = await readFile(candidate, 'utf8')
  const needle = 'weight = alpha[v] * alpha[v] * math.exp('
  expect(source.split(needle)).toHaveLength(2)
  for (const [name, replacement] of [
    ['linear-alpha', 'weight = alpha[v] * math.exp('],
    ['capped-self', 'weight = (.5 if v == p else 1.0) * alpha[v] * alpha[v] * math.exp('],
  ]) {
    const wrong = info.outputPath(name + '.py')
    await writeFile(
      wrong,
      source
        .replace(needle, replacement)
        .replace(
          'HERE = Path(__file__).resolve().parent',
          'HERE = Path(' + JSON.stringify(resolve('scripts/research/strong-noise')) + ')',
        ),
    )
    await rejected(reference, wrong, name, info)
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('pilot pointwise reference preserves asymmetric controls and unchanged strict RGB limits', async ({}, info) => {
  test.setTimeout(900_000)
  await compare('asymmetric', info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('C zero preserves exact old C9 words, physical stage presence and absence of pilot and guide', async ({}, info) => {
  test.setTimeout(900_000)
  await compare('identity', info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('declared Float64 addition then guide RN32 and canonical delta publication retain tie and zero semantics', async ({}, info) => {
  test.setTimeout(900_000)
  await compare('publication', info)
})
