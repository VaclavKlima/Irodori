import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

const script = resolve('scripts/research/strong-noise/mean-guard-reference.py')
const candidate = resolve('scripts/research/strong-noise/mean-guard-patchwise.py')
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Comparison {
  status: string
  configurations: number
  statisticFieldsChecked: number
  exactRationalGroupingProofs: number
  guardChecks: number
  inactiveDistanceWordsPreserved: number
  zeroCoverageCases: number
  minimumPositiveCoverage: number | null
  maximumNormalizedStatisticsError: number
  equivalencePairs: string[][]
  generatorSha256: string
  candidateSha256: string
  filterExecutions: number
  gpuExecutions: number
  adoptionClaim: boolean
}

async function command(args: string[], directory: string, failure = false): Promise<string> {
  await mkdir(directory, { recursive: true })
  return new Promise<string>((accept, reject) => {
    const child = execFile(
      python,
      ['-B', script, ...args],
      { timeout: 30_000, maxBuffer: 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(directory, 'stdout.txt'), stdout),
          writeFile(join(directory, 'stderr.txt'), stderr),
        ]).then(() => {
          if (failure) {
            if (error) accept(stderr)
            else reject(new Error('The independent checker accepted a deliberately wrong helper.'))
          } else if (error)
            reject(new Error(`Patch-mean numerical check failed: ${stderr}`, { cause: error }))
          else accept(stdout)
        }, reject)
      },
    )
    children.add(child)
  })
}

async function compare(group: string, info: TestInfo): Promise<Comparison> {
  await mkdir(info.outputDir, { recursive: true })
  const reference = info.outputPath('reference.json'),
    comparison = info.outputPath('comparison.json')
  const plan = JSON.parse(
    await command(['--plan', '--group', group], info.outputPath('plan-command')),
  ) as { configurations: number; candidateImported: boolean; inputPlanSha256: string }
  expect(plan.candidateImported).toBe(false)
  await command(
    ['--reference', '--group', group, '--output', reference],
    info.outputPath('reference-command'),
  )
  const generated = JSON.parse(await readFile(reference, 'utf8')) as {
    candidateImported: boolean
    inputPlanSha256: string
    generatorSha256: string
  }
  expect(generated.candidateImported).toBe(false)
  expect(generated.inputPlanSha256).toBe(plan.inputPlanSha256)
  expect(generated.generatorSha256).toBe(hash(await readFile(script)))
  await command(['--check', reference, '--output', comparison], info.outputPath('check-command'))
  const result = JSON.parse(await readFile(comparison, 'utf8')) as Comparison
  expect(result.status).toBe('passed')
  expect(result.configurations).toBe(plan.configurations)
  expect(result.statisticFieldsChecked).toBe(result.configurations * 4)
  expect(result.exactRationalGroupingProofs).toBe(result.configurations)
  expect(result.maximumNormalizedStatisticsError).toBeLessThanOrEqual(1)
  expect(result.generatorSha256).toBe(hash(await readFile(script)))
  expect(result.candidateSha256).toBe(hash(await readFile(candidate)))
  expect([result.filterExecutions, result.gpuExecutions, result.adoptionClaim]).toEqual([
    0,
    0,
    false,
  ])
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
test('patch means independently prove adjacent 2/27, nonoverlapping 2/9 and self-zero covariance', async ({}, info) => {
  const result = await compare('analytic', info)
  expect(result.configurations).toBe(14)
  expect(result.minimumPositiveCoverage).toBe(9)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('globally clamped odd grids and one-dimensional borders preserve exact rational pair grouping', async ({}, info) => {
  const result = await compare('geometry', info)
  expect(result.configurations).toBe(735)
  expect(result.zeroCoverageCases).toBe(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('fractional and subnormal alpha preserve normalized means while hidden nonfinite features stay excluded', async ({}, info) => {
  const result = await compare('alpha', info)
  expect(result.configurations).toBe(90)
  expect(result.equivalencePairs).toHaveLength(2)
  expect(result.zeroCoverageCases).toBeGreaterThanOrEqual(18)
  expect(result.minimumPositiveCoverage).toBeGreaterThan(0)
  expect(result.minimumPositiveCoverage).toBeLessThan(1e-80)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('chroma guard follows the Decimal80 variance formula, preserves inactive words and rejects wrong helpers', async ({}, info) => {
  const result = await compare('guard', info)
  expect(result.guardChecks).toBe(45)
  expect(result.inactiveDistanceWordsPreserved).toBeGreaterThan(0)
  for (const mutation of ['covariance', 'guard']) {
    const fake = info.outputPath(`wrong-${mutation}.py`),
      output = info.outputPath(`wrong-${mutation}.json`)
    await writeFile(
      fake,
      `import importlib.util\nspec=importlib.util.spec_from_file_location('real_helper',${JSON.stringify(candidate)})\nreal=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(real)\ndef patch_mean_statistics(*args):\n    result=real.patch_mean_statistics(*args)\n    ${mutation === 'covariance' ? "result['sumBetaSquared'] *= 3" : 'pass'}\n    return result\ndef guarded_chroma_distance(distance,statistics,va,vb):\n    return ${mutation === 'guard' ? 'distance' : 'real.guarded_chroma_distance(distance,statistics,va,vb)'}\n`,
    )
    const stderr = await command(
      ['--check', info.outputPath('reference.json'), '--candidate', fake, '--output', output],
      info.outputPath(`wrong-${mutation}-command`),
      true,
    )
    expect(stderr).toContain('AssertionError')
  }
})
