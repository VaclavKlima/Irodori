import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const referenceKind = 'noise-scaled-patchwise-decimal80-v1'
const directory = resolve('scripts/research/strong-noise/reference')
const planPath = resolve('assets/tests/references/detail/strong-noise/noise-scaled-input-plan.json')
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

interface ReferencePlan {
  referenceKind: string
  math: Record<string, unknown>
  primaries: string[]
  sigmaFactors: string[]
  baseLuminanceMaximum: string
  baseChromaMaximum: string
  controls: number[][]
  cases: { id: string; width: number; height: number; points: number[][] }[]
  pairChecks: unknown[]
  sharedReference: { sha256: string; inputPlanSha256: string }
}
async function runPython(args: string[], logs: string): Promise<void> {
  await mkdir(logs, { recursive: true })
  await new Promise<void>((accept, reject) => {
    const child = execFile(
      python,
      args,
      { timeout: 240_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(logs, 'stdout.txt'), stdout),
          writeFile(join(logs, 'stderr.txt'), stderr),
        ]).then(() => {
          if (error)
            reject(new Error(`Independent C8 reference failed: ${stderr}`, { cause: error }))
          else accept()
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

for (const factor of ['0.4', '0.55']) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  test(`source-variance chroma factor ${factor} matches independent Decimal80 width compilation and exact patch stages`, async ({}, info) => {
    test.setTimeout(300_000)
    await mkdir(info.outputDir, { recursive: true })
    const planBytes = await readFile(planPath),
      plan = JSON.parse(planBytes.toString('utf8')) as ReferencePlan,
      sharedPlanBytes = await readFile(join(directory, 'input-plan.json')),
      sharedPlan = JSON.parse(sharedPlanBytes.toString('utf8')) as ReferencePlan,
      generatorPath = join(directory, 'noise-scaled-reference.py'),
      generatorBytes = await readFile(generatorPath),
      sharedGeneratorBytes = await readFile(join(directory, 'reference.py')),
      checkerBytes = await readFile(join(directory, 'check-reference.py')),
      candidateBytes = await readFile('scripts/research/strong-noise/noise-scaled-patchwise.py'),
      equations = Object.fromEntries(
        Object.entries(plan.math).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      equationText = JSON.stringify(equations),
      approvalPath = info.outputPath('approval.json'),
      referencePath = info.outputPath('reference.json'),
      comparisonPath = info.outputPath('comparison.json')
    expect(plan.referenceKind).toBe(referenceKind)
    expect(plan.sigmaFactors).toEqual(['0.4', '0.55'])
    expect([plan.baseLuminanceMaximum, plan.baseChromaMaximum]).toEqual(['0.024', '0.024'])
    expect(plan.cases).toHaveLength(15)
    expect(plan.controls).toHaveLength(23)
    expect(plan.primaries).toEqual(['srgb', 'rec2020'])
    expect(plan.cases).toEqual(sharedPlan.cases)
    expect(plan.controls).toEqual(sharedPlan.controls)
    expect(plan.pairChecks).toEqual(sharedPlan.pairChecks)
    expect([...equationText].every((character) => character.charCodeAt(0) <= 127)).toBe(true)
    expect(plan.sharedReference.sha256).toBe(sha(sharedGeneratorBytes))
    expect(plan.sharedReference.inputPlanSha256).toBe(sha(sharedPlanBytes))
    await writeFile(
      approvalPath,
      JSON.stringify({
        referenceGenerationApproved: true,
        referenceKind,
        inputPlanSha256: sha(planBytes),
        generatorSha256: sha(generatorBytes),
        sharedGeneratorSha256: sha(sharedGeneratorBytes),
        equationsSha256: sha(equationText),
        sigmaFactors: plan.sigmaFactors,
        selection: { cases: plan.cases.map((scene) => scene.id), sigmaFactors: [factor] },
        scope:
          'Declared synthetic C8 reference only; no estimator, application, GPU or photographic adoption.',
      }),
    )
    await runPython(
      [
        generatorPath,
        '--approved-freeze',
        approvalPath,
        '--input-plan',
        planPath,
        '--factor',
        factor,
        '--output',
        referencePath,
      ],
      info.outputPath('generation-command'),
    )
    await runPython(
      [
        join(directory, 'check-reference.py'),
        '--reference',
        referencePath,
        '--input-plan',
        planPath,
        '--method',
        'noise-scaled',
        '--output',
        comparisonPath,
      ],
      info.outputPath('comparison-command'),
    )
    const result = JSON.parse(await readFile(comparisonPath, 'utf8')) as {
      status: string
      referenceKind: string
      configurations: number
      compiledChromaWidthsChecked: number
      preFinalRgbChannelsChecked: number
      finalRgbChannelsChecked: number
      allGridAlphaWordsChecked: number
      allGridNeutralRgbaCopiesChecked: number
      allGridTransparentRgbaCopiesChecked: number
      exactCenterWordsChecked: number
      pairedRgbChannelsChecked: number
      pairedProposalWordsChecked: number
      pairedCenterWordsChecked: number
      selection: { cases: string[]; sigmaFactors: string[]; partial: boolean }
      failures: unknown[]
    }
    const configurations = plan.cases.length * plan.primaries.length * plan.controls.length,
      points = plan.cases.reduce((count, scene) => count + scene.points.length, 0),
      pixels = plan.cases.reduce((count, scene) => count + scene.width * scene.height, 0),
      controlsPerGrid = plan.primaries.length * plan.controls.length
    expect(result.status).toBe('passed')
    expect(result.referenceKind).toBe(referenceKind)
    expect(result.failures).toEqual([])
    expect(result.configurations).toBe(configurations)
    expect(result.compiledChromaWidthsChecked).toBe(
      configurations - plan.cases.length * plan.primaries.length,
    )
    expect(result.preFinalRgbChannelsChecked).toBe(points * controlsPerGrid * 3)
    expect(result.finalRgbChannelsChecked).toBe(result.preFinalRgbChannelsChecked)
    expect(result.allGridAlphaWordsChecked).toBe(pixels * controlsPerGrid)
    expect(result.allGridNeutralRgbaCopiesChecked).toBe(pixels * plan.primaries.length)
    expect(result.allGridTransparentRgbaCopiesChecked).toBeGreaterThan(0)
    expect(result.exactCenterWordsChecked).toBeGreaterThan(0)
    expect(result.pairedRgbChannelsChecked).toBeGreaterThan(0)
    expect(result.pairedProposalWordsChecked).toBeGreaterThan(0)
    expect(result.pairedCenterWordsChecked).toBeGreaterThan(0)
    expect(result.selection.cases).toEqual(plan.cases.map((scene) => scene.id))
    expect(result.selection.sigmaFactors).toEqual([factor])
    expect(result.selection.partial).toBe(true)
    for (const [path, bytes] of [
      [planPath, planBytes],
      [generatorPath, generatorBytes],
      [join(directory, 'reference.py'), sharedGeneratorBytes],
      [join(directory, 'input-plan.json'), sharedPlanBytes],
      [join(directory, 'check-reference.py'), checkerBytes],
      ['scripts/research/strong-noise/noise-scaled-patchwise.py', candidateBytes],
    ] as const)
      expect(await readFile(path)).toEqual(bytes)
  })
}
