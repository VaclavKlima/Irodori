import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

const directory = resolve('scripts/research/strong-noise/reference')
const generator = join(directory, 'chroma-uniform.py')
const candidate = resolve('scripts/research/strong-noise/chroma-uniform-patchwise.py')
const kind = 'chroma-uniform-patchwise-decimal80-v1'
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Plan {
  referenceKind: string
  candidateId: string
  planSha256: string
  candidateImported: boolean
  group: string
  cases: { id: string }[]
  primaries: string[]
  controls: number[][]
  configurations: number
  baseLuminanceMaximum: string
  baseChromaMaximum: string
  chromaSigmaFactor: string
  chromaSpatialPolicy: string
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
  failures: { kind: string }[]
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
            else reject(new Error('The independent C11 checker accepted Gaussian chroma weights.'))
          } else if (error)
            reject(
              new Error(`Uniform-chroma numeric reference failed: ${stderr}`, { cause: error }),
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
  expect(plan.candidateId).toBe('noise-scaled-k40-chroma-uniform')
  expect(plan.candidateImported).toBe(false)
  expect(plan.primaries).toEqual(['srgb', 'rec2020'])
  expect(plan.configurations).toBe(expectedCount)
  expect([plan.baseLuminanceMaximum, plan.baseChromaMaximum, plan.chromaSigmaFactor]).toEqual([
    '0.024',
    '0.024',
    '0.4',
  ])
  expect(plan.chromaSpatialPolicy).toBe('uniform-search-v1')
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
        'Declared small C11 mathematical vectors only; no quality, GPU, estimator or photo run.',
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
test('uniform chroma matches direct Decimal80 stages and strict RGB across strengths, signed HDR and clamped geometry', async ({}, info) => {
  test.setTimeout(300_000)
  await compare('core', 108, info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('uniform chroma preserves transparent words and alpha-scaled RGB, proposals and all published patch words', async ({}, info) => {
  test.setTimeout(300_000)
  const result = await compare('alpha', 84, info)
  expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.pairedProposalWordsChecked).toBeGreaterThan(0)
  expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('independent uniform-chroma reference covers asymmetric controls and rejects Gaussian chroma substitution', async ({}, info) => {
  test.setTimeout(300_000)
  await compare('asymmetric', 12, info)
  const wrong = info.outputPath('wrong-gaussian.py'),
    comparison = info.outputPath('wrong-gaussian-comparison.json')
  await writeFile(
    wrong,
    `import importlib.util\nspec=importlib.util.spec_from_file_location('old_gaussian',${JSON.stringify(resolve('scripts/research/strong-noise/noise-scaled-patchwise.py'))})\nold=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(old)\nOFFSETS=old.patchwise.OFFSETS\ndef denoise(*args,**kwargs):\n    output,diagnostics=old.denoise(*args,**kwargs)\n    diagnostics['chromaSpatialPolicy']='uniform-search-v1'\n    return output,diagnostics\n`,
  )
  await command(
    ['--check', info.outputPath('reference.json'), '--candidate', wrong, '--output', comparison],
    info.outputPath('wrong-gaussian-command'),
    true,
  )
  const rejected = JSON.parse(await readFile(comparison, 'utf8')) as Result
  expect(rejected.status).toBe('failed')
  expect(
    rejected.failures.some((failure) =>
      ['center-publication-word', 'strict-pre-final-rgb'].includes(failure.kind),
    ),
  ).toBe(true)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('C zero remains byte-identical to unchanged C9 k40 across every old small recipe and declared strength', async ({}, info) => {
  test.setTimeout(300_000)
  const result = await compare('identity', 180, info)
  expect(result.C0OldC9StageWordsChecked).toBeGreaterThan(0)
  expect(result.preFinalRgbChannelsChecked).toBe(0)
})
