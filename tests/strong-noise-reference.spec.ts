import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect, type TestInfo } from '@playwright/test'

const directory = resolve('scripts/research/strong-noise/reference')
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const initialCases = [
  'signed-zero-identity',
  'flat-gray',
  'partial-alpha',
  'hidden-zero-a',
  'hidden-zero-b',
  'one-pixel',
  'signed-hdr',
  'clamped-bias',
  'clamped-zero-variance',
]

async function runPython(args: string[], logs: string): Promise<string> {
  await mkdir(logs, { recursive: true })
  return new Promise((accept, reject) => {
    const child = execFile(
      python,
      args,
      { cwd: process.cwd(), timeout: 240_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(logs, 'stdout.txt'), stdout),
          writeFile(join(logs, 'stderr.txt'), stderr),
        ]).then(() => {
          if (error)
            reject(new Error(`Independent reference command failed: ${stderr}`, { cause: error }))
          else accept(stdout)
        }, reject)
      },
    )
    children.add(child)
  })
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
test('independent binary32 converter preserves signed zeros and nearest-even boundary words', async ({}, info) => {
  const output = info.outputPath('rounding.json')
  await mkdir(info.outputDir, { recursive: true })
  await runPython(
    [join(directory, 'validate-rounding.py'), output],
    info.outputPath('rounding-command'),
  )
  const result = JSON.parse(await readFile(output, 'utf8')) as {
    status: string
    checks: number
    tieVectorPrecision: number
  }
  expect(result.status).toBe('passed')
  expect(result.checks).toBe(1537)
  expect(result.tieVectorPrecision).toBe(300)
})

async function compareReference(cases: string[], info: TestInfo): Promise<void> {
  test.setTimeout(300_000)
  await mkdir(info.outputDir, { recursive: true })
  const planBytes = await readFile(join(directory, 'input-plan.json')),
    plan = JSON.parse(planBytes.toString('utf8')) as {
      math: Record<string, unknown>
      widthPairs: string[][]
      controls: number[][]
      primaries: string[]
    },
    sourceBytes = await readFile(join(directory, 'reference.py')),
    equations = Object.fromEntries(
      Object.entries(plan.math).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    approvalPath = info.outputPath('approval.json'),
    referencePath = info.outputPath('reference.json'),
    comparisonPath = info.outputPath('comparison.json')
  await writeFile(
    approvalPath,
    JSON.stringify({
      referenceGenerationApproved: true,
      inputPlanSha256: sha(planBytes),
      generatorSha256: sha(sourceBytes),
      equationsSha256: sha(JSON.stringify(equations)),
      widthPairs: plan.widthPairs,
      selection: { cases: cases, widthPair: ['0.024', '0.04'] },
      scope: 'Reviewed synthetic research only; no estimator, application or GPU adoption.',
    }),
  )
  await runPython(
    [
      join(directory, 'reference.py'),
      '--approved-freeze',
      approvalPath,
      '--output',
      referencePath,
      '--width-pair',
      '0.024,0.04',
      ...cases.flatMap((id) => ['--case', id]),
    ],
    info.outputPath('generation-command'),
  )
  await runPython(
    [
      join(directory, 'check-reference.py'),
      '--reference',
      referencePath,
      '--output',
      comparisonPath,
    ],
    info.outputPath('comparison-command'),
  )
  const result = JSON.parse(await readFile(comparisonPath, 'utf8')) as {
    status: string
    configurations: number
    preFinalRgbChannelsChecked: number
    finalRgbChannelsChecked: number
    allGridAlphaWordsChecked: number
    allGridTransparentRgbaCopiesChecked: number
    allGridNeutralRgbaCopiesChecked: number
    exactCenterWordsChecked: number
    pairedRgbChannelsChecked: number
    pairedCenterWordsChecked: number
    failures: unknown[]
    selection: { cases: string[]; widthPairs: string[][]; partial: boolean }
  }
  expect(result.status).toBe('passed')
  expect(result.failures).toEqual([])
  expect(result.configurations).toBe(cases.length * plan.controls.length * plan.primaries.length)
  expect(result.preFinalRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.finalRgbChannelsChecked).toBe(result.preFinalRgbChannelsChecked)
  expect(result.allGridAlphaWordsChecked).toBeGreaterThan(0)
  expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.allGridNeutralRgbaCopiesChecked).toBeGreaterThan(0)
  expect(result.exactCenterWordsChecked).toBeGreaterThan(0)
  expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
  expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
  expect(result.selection.cases).toEqual(expect.arrayContaining(cases))
  expect(result.selection.widthPairs).toEqual([['0.024', '0.04']])
  expect(result.selection.partial).toBe(true)
  expect(await readFile(join(directory, 'reference.py'))).toEqual(sourceBytes)
  expect(await readFile(join(directory, 'input-plan.json'))).toEqual(planBytes)
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('patchwise research matches direct Decimal80 with exact staged words and whole-grid alpha copies', async ({}, info) => {
  await compareReference(initialCases, info)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('patchwise tiny and subnormal alpha, global scaling and one-axis cases retain strict reference agreement', async ({}, info) => {
  await compareReference(
    [
      'noise-like-low',
      'partial-alpha',
      'partial-alpha-common-scale',
      'opaque-tiny-alpha',
      'opaque-subnormal-alpha',
      'one-axis',
      'one-horizontal-axis',
    ],
    info,
  )
})
