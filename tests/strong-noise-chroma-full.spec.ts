import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

const directory = resolve('scripts/research/strong-noise/reference')
const generator = join(directory, 'chroma-full.py')
const candidate = resolve('scripts/research/strong-noise/chroma-full-patchwise.py')
const kind = 'chroma-full-patchwise-decimal80-v1'
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Plan {
  referenceKind: string
  candidateId: string
  planSha256: string
  candidateImported: boolean
  group: string
  cases: {
    id: string
    width: number
    height: number
    points: number[][]
    pixelOverrides?: { x: number; y: number; rgba32Words: string[] }[]
  }[]
  primaries: string[]
  controls: number[][]
  configurations: number
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
  aggregation: string
  stageScalars: number
  stageLayout: string
  sourceHalo: { luminance: number; chroma: number }
  proposalBoundRadii: number[]
}
interface Result {
  status: string
  referenceKind: string
  group: string
  configurations: number
  generatorSha256: string
  candidateSha256: string
  planSha256: string
  preFinalRgbChannelsChecked: number
  finalRgbChannelsChecked: number
  allGridAlphaWordsChecked: number
  allGridTransparentRgbaCopiesChecked: number
  allGridNeutralRgbaCopiesChecked: number
  exactCenterWordsChecked: number
  pairedRgbChannelsChecked: number
  pairedProposalWordsChecked: number
  pairedCenterWordsChecked: number
  C0OldC9RgbaWordsChecked: number
  C0OldC9ProposalWordsChecked: number
  C0OldC9StageWordsChecked: number
  allLuminanceProposalWordsChecked: number
  allLuminanceCenterWordsChecked: number
  nonzeroChromaLuminanceProposalWordsChecked: number
  nonzeroChromaLuminanceCenterWordsChecked: number
  failures: { kind: string; scene?: string }[]
}

async function command(args: string[], output: string, expectFailure = false): Promise<string> {
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
            if (error) accept(stdout)
            else
              reject(
                new Error(
                  'The independent C14 checker accepted a deliberately wrong radius or operator.',
                ),
              )
          } else if (error)
            reject(
              new Error(`Independent full-patch numeric reference failed: ${stderr}`, {
                cause: error,
              }),
            )
          else accept(stdout)
        }, reject)
      },
    )
    children.add(child)
  })
}

async function compare(group: string, expectedCount: number, info: TestInfo): Promise<Result> {
  await mkdir(info.outputDir, { recursive: true })
  const plan = JSON.parse(
      await command(['--plan', '--group', group], info.outputPath('plan-command')),
    ) as Plan,
    approval = info.outputPath('approval.json'),
    reference = info.outputPath('reference.json'),
    comparison = info.outputPath('comparison.json')
  expect(plan.referenceKind).toBe(kind)
  expect(plan.candidateId).toBe('noise-scaled-k40-chroma-r10-full5')
  expect(plan.candidateImported).toBe(false)
  expect(plan.primaries).toEqual(['srgb', 'rec2020'])
  expect(plan.configurations).toBe(expectedCount)
  expect([plan.baseLuminanceMaximum, plan.baseChromaMaximum, plan.chromaSigmaFactor]).toEqual([
    '0.024',
    '0.024',
    '0.4',
  ])
  expect(plan.chromaSpatialPolicy).toBe('uniform-search-v1')
  expect([plan.luminanceSearchRadius, plan.chromaSearchRadius]).toEqual([3, 10])
  expect(plan.proposalBoundRadii).toEqual([3, 10, 10])
  expect([
    plan.luminanceMatchingRadius,
    plan.chromaMatchingRadius,
    plan.luminanceTargetRadius,
    plan.chromaTargetRadius,
  ]).toEqual([1, 2, 1, 2])
  expect(plan.aggregation).toBe('normalized-component-patch-estimates-f32-zero-v1')
  expect(plan.stageScalars).toBe(59)
  expect(plan.stageLayout).toBe('l9-row-major-c25-ab-row-major-v1')
  expect(plan.sourceHalo).toEqual({ luminance: 5, chroma: 14 })
  if (group === 'core') {
    const wide = plan.cases.find((scene) => scene.id === 'wide-search-support')
    expect(wide?.width).toBe(25)
    expect(wide?.height).toBe(3)
    expect(wide?.points).toEqual([
      [0, 1],
      [12, 1],
      [24, 1],
    ])
    expect(wide?.pixelOverrides?.[0]).toMatchObject({
      x: 21,
      y: 1,
      rgba32Words: ['3e800000', '3e000000', '3d800000', '3f800000'],
    })
    const context = plan.cases.find((scene) => scene.id === 'matching-context-only')
    expect([context?.width, context?.height]).toEqual([29, 7])
    expect(context?.points).toEqual([[12, 3]])
    expect(context?.pixelOverrides?.[0]).toMatchObject({
      x: 25,
      y: 3,
      rgba32Words: ['3e800000', '3e000000', '3d800000', '3f800000'],
    })
    expect(25 - 12).toBeGreaterThan(plan.chromaSearchRadius)
    expect(25 - 12).toBeLessThan(plan.sourceHalo.chroma)
    const full = plan.cases.find((scene) => scene.id === 'full-target-context-halo14')
    expect([full?.width, full?.height]).toEqual([31, 9])
    expect(full?.points).toEqual([[12, 4]])
    expect(full?.pixelOverrides?.[0]).toMatchObject({
      x: 26,
      y: 4,
      rgba32Words: ['3e800000', '3e000000', '3d800000', '3f800000'],
    })
    expect(26 - 12).toBeGreaterThan(plan.chromaSearchRadius)
    expect(26 - 12).toBe(plan.sourceHalo.chroma)
  }
  await writeFile(
    approval,
    JSON.stringify({
      referenceGenerationApproved: true,
      referenceKind: kind,
      generatorSha256: sha(await readFile(generator)),
      sharedGeneratorSha256: sha(await readFile(join(directory, 'reference.py'))),
      sharedInputPlanSha256: sha(await readFile(join(directory, 'input-plan.json'))),
      planSha256: plan.planSha256,
      group,
      scope:
        'Declared small C14 mathematical vectors only; no quality, GPU, estimator or photo run.',
    }),
  )
  await command(
    ['--generate', '--group', group, '--approved-freeze', approval, '--output', reference],
    info.outputPath('generation-command'),
  )
  const generated = JSON.parse(await readFile(reference, 'utf8')) as {
    candidateImported: boolean
    chromaSpatialPolicy: string
    aggregation: string
    stageScalars: number
    stageLayout: string
    scenes: { id: string; cases: unknown[] }[]
  }
  expect(generated.candidateImported).toBe(false)
  expect(generated.chromaSpatialPolicy).toBe('uniform-search-v1')
  expect(generated.aggregation).toBe(plan.aggregation)
  expect(generated.stageScalars).toBe(plan.stageScalars)
  expect(generated.stageLayout).toBe(plan.stageLayout)
  expect(generated.scenes.map((scene) => scene.id)).toEqual(plan.cases.map((scene) => scene.id))
  expect(generated.scenes.reduce((sum, scene) => sum + scene.cases.length, 0)).toBe(expectedCount)
  await command(
    ['--check', reference, '--output', comparison],
    info.outputPath('comparison-command'),
  )
  const result = JSON.parse(await readFile(comparison, 'utf8')) as Result
  expect(result.status).toBe('passed')
  expect(result.referenceKind).toBe(kind)
  expect(result.group).toBe(group)
  expect(result.planSha256).toBe(plan.planSha256)
  expect(result.configurations).toBe(expectedCount)
  expect(result.generatorSha256).toBe(sha(await readFile(generator)))
  expect(result.candidateSha256).toBe(sha(await readFile(candidate)))
  expect(result.failures).toEqual([])
  expect(result.allGridAlphaWordsChecked).toBeGreaterThan(0)
  if (group !== 'asymmetric') expect(result.allGridNeutralRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.C0OldC9RgbaWordsChecked).toBeGreaterThan(0)
  expect(result.C0OldC9ProposalWordsChecked).toBeGreaterThan(0)
  expect(result.allLuminanceProposalWordsChecked).toBeGreaterThan(0)
  expect(result.allLuminanceCenterWordsChecked).toBeGreaterThan(0)
  if (group !== 'identity') {
    expect(result.nonzeroChromaLuminanceProposalWordsChecked).toBeGreaterThan(0)
    expect(result.nonzeroChromaLuminanceCenterWordsChecked).toBeGreaterThan(0)
  }
  if (group !== 'identity') {
    expect(result.preFinalRgbChannelsChecked).toBeGreaterThan(0)
    expect(result.finalRgbChannelsChecked).toBe(result.preFinalRgbChannelsChecked)
    expect(result.exactCenterWordsChecked).toBeGreaterThan(0)
  }
  return result
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
test('independent full 5x5 chroma targets preserve original L and reject wrong target, matching, search and halo', async ({}, info) => {
  test.setTimeout(900_000)
  await compare('core', 144, info)
  const reference = JSON.parse(await readFile(info.outputPath('reference.json'), 'utf8')) as {
    scenes: {
      id: string
      width: number
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
  const wide = reference.scenes.find((scene) => scene.id === 'wide-search-support')!
  const bytes = Buffer.from(wide.inputRgba32leHex, 'hex')
  expect([0, 1, 2, 3].map((c) => bytes.readUInt32LE(((1 * wide.width + 21) * 4 + c) * 4))).toEqual([
    0x3e800000, 0x3e000000, 0x3d800000, 0x3f800000,
  ])
  for (const config of wide.cases.filter(
    (config) => config.luminance === 100 && config.chroma === 100,
  )) {
    const center = config.points.find((point) => point.x === 12 && point.y === 1)!
    expect(center.proposalBoundRadii).toEqual([3, 10, 10])
    expect(center.localFeatureRanges[0]).toBe(center.featureRangesRadius3[0])
    for (const component of [1, 2]) {
      // The old R3 domain excludes a real R10 source difference. This does not
      // assert that the final normalized proposal reaches that farthest value.
      const oldBound = Number(center.featureRangesRadius3[component]) * (1 + 2 ** -24) + 2 ** -150
      expect(Number(center.localFeatureRanges[component])).toBeGreaterThan(oldBound)
    }
  }
  const full = reference.scenes.find((scene) => scene.id === 'full-target-context-halo14')!
  const fullBytes = Buffer.from(full.inputRgba32leHex, 'hex')
  expect(
    [0, 1, 2, 3].map((c) => fullBytes.readUInt32LE(((4 * full.width + 26) * 4 + c) * 4)),
  ).toEqual([0x3e800000, 0x3e000000, 0x3d800000, 0x3f800000])
  const source = await readFile(candidate, 'utf8')
  const mutations = [
    ['wrong-c-target1', 'C_TARGET_RADIUS = 2', 'C_TARGET_RADIUS = 1'],
    ['wrong-c-match1', 'C_MATCH_RADIUS = 2', 'C_MATCH_RADIUS = 1'],
    ['wrong-l-match2', 'L_MATCH_RADIUS = 1', 'L_MATCH_RADIUS = 2'],
    ['wrong-c-search3', 'C_SEARCH_RADIUS = 10', 'C_SEARCH_RADIUS = 3'],
    ['wrong-gaussian-operator', 'wc = alpha[q] * math.exp', 'wc = spatial * alpha[q] * math.exp'],
  ]
  for (const [name, original, replacement] of mutations) {
    expect(source.split(original)).toHaveLength(2)
    const wrong = info.outputPath(`${name}.py`),
      comparison = info.outputPath(`${name}-comparison.json`)
    await writeFile(
      wrong,
      source
        .replace(original, replacement)
        .replace(
          'HERE = Path(__file__).resolve().parent',
          `HERE = Path(${JSON.stringify(resolve('scripts/research/strong-noise'))})`,
        ),
    )
    await command(
      ['--check', info.outputPath('reference.json'), '--candidate', wrong, '--output', comparison],
      info.outputPath(`${name}-command`),
      true,
    )
    const rejected = JSON.parse(await readFile(comparison, 'utf8')) as Result
    expect(rejected.status).toBe('failed')
    if (name === 'wrong-c-target1') {
      // A shorter target/gather must change actual RGB at the frozen halo14
      // vector. Stage shape or policy labels alone cannot satisfy this proof.
      expect(
        rejected.failures.some(
          (failure) =>
            failure.scene === 'full-target-context-halo14' &&
            ['strict-pre-final-rgb', 'final-rgb'].includes(failure.kind),
        ),
      ).toBe(true)
    } else {
      expect(
        rejected.failures.some(
          (failure) =>
            [
              'center-publication-word',
              'strict-pre-final-rgb',
              'final-rgb',
              'old-C9-L-stage-identity',
              'old-C9-L-proposal-identity',
            ].includes(failure.kind) &&
            (name !== 'wrong-c-match1' || failure.scene === 'matching-context-only'),
        ),
      ).toBe(true)
    }
  }
  const shortContext = info.outputPath('wrong-context-halo13.py'),
    shortComparison = info.outputPath('wrong-context-halo13-comparison.json')
  await writeFile(
    shortContext,
    `import importlib.util\nspec=importlib.util.spec_from_file_location('real_full_patch',${JSON.stringify(candidate)})\nreal=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(real)\nOFFSETS=real.OFFSETS\ndef denoise(*args,**kwargs):\n    values=list(args)\n    if values[2:4]==[31,9]:\n        frame=[p[:] for p in values[1]]\n        for y in range(9):\n            for x in range(26,31):frame[y*31+x]=frame[y*31+25][:]\n        values[1]=frame\n    return real.denoise(*values,**kwargs)\n`,
  )
  await command(
    [
      '--check',
      info.outputPath('reference.json'),
      '--candidate',
      shortContext,
      '--output',
      shortComparison,
    ],
    info.outputPath('wrong-context-halo13-command'),
    true,
  )
  const shortResult = JSON.parse(await readFile(shortComparison, 'utf8')) as Result
  expect(shortResult.status).toBe('failed')
  expect(
    shortResult.failures.some(
      (failure) =>
        failure.scene === 'full-target-context-halo14' &&
        ['strict-pre-final-rgb', 'final-rgb'].includes(failure.kind),
    ),
  ).toBe(true)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('independent full chroma patches preserve transparent words and alpha-scaled RGB, proposals and all published patch words', async ({}, info) => {
  test.setTimeout(900_000)
  const result = await compare('alpha', 84, info)
  expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.pairedProposalWordsChecked).toBeGreaterThan(0)
  expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('independent full chroma patch reference preserves asymmetric amount controls and fixed numeric limits', async ({}, info) => {
  test.setTimeout(900_000)
  await compare('asymmetric', 12, info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('C zero remains byte-identical to unchanged C9 k40 across every old small recipe and declared strength', async ({}, info) => {
  test.setTimeout(900_000)
  const result = await compare('identity', 180, info)
  expect(result.C0OldC9StageWordsChecked).toBeGreaterThan(0)
  expect(result.preFinalRgbChannelsChecked).toBe(0)
})
