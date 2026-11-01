import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

const directory = resolve('scripts/research/strong-noise/reference')
const generator = join(directory, 'chroma-wide.py')
const candidate = resolve('scripts/research/strong-noise/chroma-wide-patchwise.py')
const kind = 'chroma-wide-search-patchwise-decimal80-v1'
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
  failures: { kind: string; scene?: string }[]
}

async function command(args: string[], output: string, expectFailure = false): Promise<string> {
  await mkdir(output, { recursive: true })
  return new Promise<string>((accept, reject) => {
    const child = execFile(
      python,
      ['-B', generator, ...args],
      { timeout: 240_000, maxBuffer: 2 * 1024 ** 2 },
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
                  'The independent C12 checker accepted a deliberately wrong radius or operator.',
                ),
              )
          } else if (error)
            reject(new Error(`Wider-chroma numeric reference failed: ${stderr}`, { cause: error }))
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
  expect(plan.candidateId).toBe('noise-scaled-k40-chroma-uniform-r10')
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
        'Declared small C12 mathematical vectors only; no quality, GPU, estimator or photo run.',
    }),
  )
  await command(
    ['--generate', '--group', group, '--approved-freeze', approval, '--output', reference],
    info.outputPath('generation-command'),
  )
  const generated = JSON.parse(await readFile(reference, 'utf8')) as {
    candidateImported: boolean
    chromaSpatialPolicy: string
    scenes: { id: string; cases: unknown[] }[]
  }
  expect(generated.candidateImported).toBe(false)
  expect(generated.chromaSpatialPolicy).toBe('uniform-search-v1')
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
test('wider chroma independently checks R10 support, R3 luminance, distinct bounds and wrong-operator rejection', async ({}, info) => {
  test.setTimeout(300_000)
  await compare('core', 120, info)
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
  const source = await readFile(candidate, 'utf8')
  const mutations = [
    ['wrong-r3', 'C_SEARCH_RADIUS = 10', 'C_SEARCH_RADIUS = 3'],
    ['same-l-radius', 'L_SEARCH_RADIUS = 3', 'L_SEARCH_RADIUS = 10'],
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
    expect(
      rejected.failures.some(
        (failure) =>
          failure.scene === 'wide-search-support' &&
          ['center-publication-word', 'strict-pre-final-rgb'].includes(failure.kind),
      ),
    ).toBe(true)
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('wider chroma preserves transparent words and alpha-scaled RGB, proposals and all published patch words', async ({}, info) => {
  test.setTimeout(300_000)
  const result = await compare('alpha', 84, info)
  expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.pairedProposalWordsChecked).toBeGreaterThan(0)
  expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('wider chroma reference preserves asymmetric amount controls and fixed numeric limits', async ({}, info) => {
  test.setTimeout(300_000)
  await compare('asymmetric', 12, info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('C zero remains byte-identical to unchanged C9 k40 across every old small recipe and declared strength', async ({}, info) => {
  test.setTimeout(300_000)
  const result = await compare('identity', 180, info)
  expect(result.C0OldC9StageWordsChecked).toBeGreaterThan(0)
  expect(result.preFinalRgbChannelsChecked).toBe(0)
})
