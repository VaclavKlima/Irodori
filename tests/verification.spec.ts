/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import type { FullConfig, FullResult, TestCase, TestResult } from '@playwright/test/reporter'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  scopes,
  selectPlan,
  suites,
  targets,
  type VerificationPlan,
} from '../scripts/verification-plan'
import {
  artifactDirectory,
  executePlan,
  runCommand,
  INCOMPLETE_EXIT_CODE,
} from '../scripts/verification-runner.mjs'
import { renderDetails, renderSummary, SUMMARY_MAX_BYTES } from '../scripts/verification-report.mjs'
import type { CaseResult, VerificationResult } from '../scripts/verification-types'
import VerificationReporter from '../scripts/verification-reporter'

const files = (args: string[]) => selectPlan(args).groups.flatMap((group) => group.files)
const mockRun: typeof runCommand = async (_command, args, options) => {
  await writeFile(options.log, 'retained stage evidence\n')
  if (args.some((arg) => arg.startsWith('--project='))) {
    const benchmark = options.env?.IRODORI_PREVIEW_BENCHMARK === '1'
    const tests: CaseResult[] = args
      .filter((arg) => arg.endsWith('.spec.ts'))
      .map((file) => ({
        target: suites.find((s) => s.file === file)!.target,
        title: `case for ${file}`,
        file,
        line: 1,
        status: 'passed',
        durationMs: 123,
        worker: 0,
        errors: [],
        annotations: [],
        evidence: [],
        rerun: `npx playwright test '${file}' --grep 'exact case$'`,
        benchmarks: benchmark
          ? [
              {
                family: 'preview',
                measurements: { p95Ms: 7, samples: 60 },
                gates: [{ metric: 'p95Ms', operator: '<=', limit: 33 }],
                evidence: [],
              },
            ]
          : [],
      }))
    const directory = join(options.env!.IRODORI_VERIFICATION_DIR!, options.env!.IRODORI_TEST_GROUP!)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({
        uiMode: options.env!.IRODORI_TEST_UI_MODE,
        passed: tests.length,
        failed: 0,
        skipped: 0,
        interrupted: 0,
        tests,
        errors: [],
        workers: 2,
        status: 'passed',
        durationMs: 123,
      }),
    )
  }
  return 0
}
const harness = (plan: VerificationPlan, directory: string, run = mockRun, signal?: AbortSignal) =>
  executePlan(plan, { directory, run, lockDirectory: join(directory, '.lock'), signal })

const reportCase = (overrides: Partial<CaseResult> = {}): CaseResult => ({
  target: 'verification',
  title: 'synthetic report case',
  file: 'tests/verification.spec.ts',
  line: 1,
  status: 'passed',
  durationMs: 123,
  worker: 0,
  errors: [],
  annotations: [],
  evidence: [],
  rerun: "npx playwright test 'tests/verification.spec.ts' --grep 'synthetic report case$'",
  benchmarks: [],
  ...overrides,
})

const reportResult = (overrides: Partial<VerificationResult> = {}): VerificationResult => ({
  scope: 'targets',
  uiMode: 'background',
  plan: selectPlan(['--target', 'verification', '--background']),
  targets: ['verification'],
  exitCode: 0,
  status: 'passed',
  passed: 1,
  failed: 0,
  skipped: 0,
  interrupted: 0,
  durationMs: 1234,
  artifacts: '/tmp/synthetic-verification',
  stages: [
    {
      name: 'node',
      phase: 'functional',
      status: 'passed',
      code: 0,
      durationMs: 1234,
      log: '/tmp/synthetic-verification/node.log',
      targets: ['verification'],
      workers: 2,
      rerun: "npx playwright test 'tests/verification.spec.ts' --project=node",
    },
  ],
  tests: [reportCase()],
  benchmarks: [],
  incomplete: [],
  warnings: [],
  runtime: {
    platform: 'linux',
    node: 'v24.0.0',
    gpu: ['Synthetic adapter'],
    git: { revision: '1234567890abcdef1234567890abcdef12345678', dirty: true, changes: [] },
  },
  baseline: { status: 'not-required' },
  ...overrides,
})

function expectCompactReport(report: string) {
  expect(SUMMARY_MAX_BYTES).toBe(4096)
  expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
  expect(report).toContain('](details.md)')
  expect(report).toContain('](result.json)')
  expect(report).not.toContain('\uFFFD')
}

async function withBaseline(path: string | undefined, action: () => Promise<void>) {
  const previous = process.env.IRODORI_PREVIEW_BASELINE
  if (path) process.env.IRODORI_PREVIEW_BASELINE = path
  else delete process.env.IRODORI_PREVIEW_BASELINE
  try {
    await action()
  } finally {
    if (previous) process.env.IRODORI_PREVIEW_BASELINE = previous
    else delete process.env.IRODORI_PREVIEW_BASELINE
  }
}

async function withUiMode(mode: string | undefined, action: () => Promise<void>) {
  const previous = process.env.IRODORI_TEST_UI_MODE
  if (mode === undefined) delete process.env.IRODORI_TEST_UI_MODE
  else process.env.IRODORI_TEST_UI_MODE = mode
  try {
    await action()
  } finally {
    if (previous === undefined) delete process.env.IRODORI_TEST_UI_MODE
    else process.env.IRODORI_TEST_UI_MODE = previous
  }
}

test('every spec has one unique target and group; fast checks exclude build, Electron, RAW and benchmarks', async () => {
  const specs = (await readdir('tests'))
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `tests/${file}`)
    .sort()
  expect(suites.map((suite) => suite.file).sort()).toEqual(specs)
  expect(new Set(targets).size).toBe(targets.length)
  const fast = selectPlan(['--fast'])
  expect(fast.groups.map((group) => group.name)).toEqual(['node'])
  expect(fast.build).toBe(false)
  expect(fast.mcp).toBe(false)
  expect(fast.benchmark).toBe(false)
  expect(files(['--full'])).toHaveLength(
    specs.length - suites.filter((s) => s.group === 'benchmark' || s.explicitOnly).length,
  )
  expect(selectPlan(['--full']).mcp).toBe(true)
  expect(files(['--all'])).toHaveLength(specs.length - suites.filter((s) => s.explicitOnly).length)
  expect(selectPlan(['--all']).mcp).toBe(true)
})

test('instrumented diagnostics require explicit target selection', () => {
  const diagnostic = 'tests/editor-pacing-diagnostic.spec.ts'
  expect(files(['--target', 'editor-pacing-diagnostic'])).toContain(diagnostic)
  for (const args of [
    ['--fast'],
    ['--full'],
    ['--all'],
    ['--benchmark-all'],
    ['--hdr-benchmark'],
    ['preview'],
    ['ui'],
  ])
    expect(files(args)).not.toContain(diagnostic)
})

test('unadopted denoising studies stay available only through deliberate targets', () => {
  const studies = suites.filter(
    (suite) =>
      suite.target.startsWith('strong-noise-') && suite.target !== 'strong-noise-study-audit',
  )
  expect(studies).not.toHaveLength(0)
  for (const study of studies) {
    expect(files(['--target', study.target])).toContain(study.file)
    for (const mode of ['--fast', '--full', '--all', '--functional'])
      expect(files([mode])).not.toContain(study.file)
  }
  for (const mode of ['--fast', '--full', '--all'])
    expect(files([mode])).toContain('tests/strong-noise-study-audit.spec.ts')
  expect(selectPlan(['--full']).targets).toEqual(
    expect.arrayContaining(['detail-quality', 'spatial-detail-gpu']),
  )
})

test('explicit targets add only cheap checks, deduplicate and reject unknown or mixed selections', () => {
  const args = ['--target', 'adjustment-wiring']
  expect(files(args)).toEqual([...files(['--fast']), 'tests/adjustment-wiring.spec.ts'])
  expect(selectPlan([...args, ...args])).toEqual(selectPlan(args))
  expect(selectPlan([...args, '--target', 'preview']).requestedTargets).toEqual([
    'adjustment-wiring',
    'preview',
  ])
  expect(selectPlan(['--target', 'mcp-import']).mcp).toBe(true)
  expect(() => selectPlan(['--target', 'missing'])).toThrow('Unknown')
  expect(() => selectPlan(['--target'])).toThrow('missing')
  expect(() => selectPlan([...args, 'ui'])).toThrow()
  expect(() => selectPlan(['--full', ...args])).toThrow()
})

test('global UI mode flags preserve every selector and reject conflicting modes', async () => {
  await withUiMode(undefined, async () => {
    for (const selection of [
      ['--target', 'adjustment-wiring', '--target', 'preview'],
      ['ui', 'preview'],
      ...[
        '--fast',
        '--full',
        '--all',
        '--functional',
        '--mcp',
        '--editor',
        '--benchmark',
        '--hdr-benchmark',
        '--merge-benchmark',
        '--export-benchmark',
        '--benchmark-all',
      ].map((mode) => [mode]),
      ['--adjustment-benchmark', 'highlights'],
    ]) {
      const expected = selectPlan(selection)
      expect(expected.uiMode).toBe('background')
      for (const mode of ['background', 'foreground'] as const) {
        for (const args of [
          [`--${mode}`, '--plan', ...selection],
          [selection[0], `--${mode}`, ...selection.slice(1), '--plan'],
          [...selection, '--plan', `--${mode}`],
        ])
          expect(selectPlan(args)).toEqual({ ...expected, uiMode: mode })
      }
    }
    expect(() => selectPlan(['--background', '--fast', '--foreground'])).toThrow(
      'mutually exclusive',
    )
  })
  await withUiMode('foreground', async () => {
    expect(selectPlan(['--fast']).uiMode).toBe('foreground')
    expect(selectPlan(['--fast', '--background']).uiMode).toBe('background')
  })
  await withUiMode('invalid', async () => {
    expect(() => selectPlan(['--fast'])).toThrow('IRODORI_TEST_UI_MODE')
    expect(selectPlan(['--foreground', '--fast']).uiMode).toBe('foreground')
  })
})

test('explicit scope unions and benchmark families preserve gates without overlapping phases', () => {
  for (const scope of scopes) {
    expect(files([scope, scope])).toEqual(files([scope]))
    expect(files([scope])).toEqual(expect.arrayContaining(files(['--fast'])))
  }
  expect(new Set(files(['ui', 'preview', 'adjustments']))).toEqual(
    new Set([...files(['ui']), ...files(['preview']), ...files(['adjustments'])]),
  )
  expect(files(['ui'])).not.toContain('tests/import-raw.spec.ts')
  expect(selectPlan(['mcp']).mcp).toBe(true)
  expect(() => selectPlan([])).toThrow('Choose scopes')
  expect(() => selectPlan(['prevue'])).toThrow('Choose scopes')
  expect(() => selectPlan(['--adjustment-benchmark', 'unknown'])).toThrow()
  for (const name of [
    'exposure',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'temperature',
  ]) {
    const plan = selectPlan(['--adjustment-benchmark', name])
    expect(plan.grep).toBe(`warmed RAW ${name} gestures`)
    expect(plan.groups.flatMap((group) => group.files)).toEqual([
      'tests/adjustment-benchmark.spec.ts',
    ])
  }
  for (const [mode, file] of [
    ['--benchmark', 'preview'],
    ['--hdr-benchmark', 'hdr'],
    ['--merge-benchmark', 'merge'],
    ['--export-benchmark', 'export'],
  ])
    expect(files([mode])).toEqual([
      ...(file === 'hdr'
        ? [
            'tests/editor-navigation-responsiveness-benchmark.spec.ts',
            'tests/editor-responsiveness-benchmark.spec.ts',
            'tests/editor-responsiveness-interference.spec.ts',
            'tests/editor-spatial-responsiveness-benchmark.spec.ts',
          ]
        : []),
      `tests/${file}-benchmark.spec.ts`,
      ...(file === 'hdr'
        ? [
            'tests/hdr-interaction-benchmark.spec.ts',
            'tests/hdr-slider-benchmark.spec.ts',
            'tests/mac-workability-batching.spec.ts',
            'tests/mac-workability-benchmark.spec.ts',
            'tests/mac-workability-interference.spec.ts',
          ]
        : []),
      ...(file === 'merge'
        ? [
            'tests/merge-preview-benchmark.spec.ts',
            'tests/merge-three-raw-benchmark.spec.ts',
            'tests/merge-workflow-benchmark.spec.ts',
          ]
        : []),
    ])
  expect(selectPlan(['--benchmark-all']).groups).toHaveLength(6)
  expect(files(['--target', 'research-presentation'])).toContain(
    'tests/research-presentation.spec.ts',
  )
  expect(files(['--full'])).not.toContain('tests/research-presentation.spec.ts')
  expect(selectPlan(['--target', 'research-measurements']).groups.at(-1)).toMatchObject({
    stage: 'benchmark-research',
    workers: 1,
  })
  const all = selectPlan(['--all'])
  expect(
    all.groups
      .filter(
        (g) => ['node', 'service', 'electron'].includes(g.name) && !g.stage.endsWith('-exclusive'),
      )
      .every((g) => g.workers === 2),
  ).toBe(true)
  expect(
    all.groups
      .filter((g) => ['raw-gpu', 'benchmark'].includes(g.name))
      .every((g) => g.workers === 1),
  ).toBe(true)
})

test('one shared build, sequential phases, benchmark-only flags and measurement collection', async ({}, info) => {
  const baseline = info.outputPath('baseline.json')
  await writeFile(
    baseline,
    JSON.stringify({ sample: 'sony-zv1.ARW', medians: { cpu: 2000, gpu: 1000 } }),
  )
  await withBaseline(baseline, async () => {
    const commands: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const result = await harness(
      selectPlan(['--all', '--foreground']),
      info.outputPath('shared-build'),
      async (command, args, options) => {
        commands.push({ args, env: options.env! })
        return mockRun(command, args, options)
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.uiMode).toBe('foreground')
    expect(commands.every((c) => c.env.IRODORI_TEST_UI_MODE === 'foreground')).toBe(true)
    expect(result.stages.every((s) => s.rerun.includes('IRODORI_TEST_UI_MODE=foreground'))).toBe(
      true,
    )
    expect(await readFile(join(result.artifacts, 'summary.md'), 'utf8')).toContain(
      'UI mode: `foreground`',
    )
    expect(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8')).uiMode).toBe(
      'foreground',
    )
    expect(commands.filter((c) => c.args.join(' ') === 'run --silent build')).toHaveLength(1)
    const mcp = commands.findIndex((c) => c.args[0] === 'scripts/check-mcp.mjs')
    expect(commands.slice(mcp + 1)).toHaveLength(6)
    for (const c of commands.slice(mcp + 1)) {
      expect(c.env.IRODORI_PREVIEW_BENCHMARK).toBe('1')
      expect(c.env.IRODORI_TEST_TRACE).toBe('0')
      expect(c.env.IRODORI_TEST_GROUP).toMatch(/^benchmarks\//)
      expect(c.args).toContain('--workers=1')
    }
    expect(commands.slice(0, mcp).every((c) => c.env.IRODORI_PREVIEW_BENCHMARK === '0')).toBe(true)
    expect(result.benchmarks).toHaveLength(
      suites.filter((suite) => suite.family && !suite.explicitOnly).length,
    )
    expect(result.baseline).toMatchObject({
      status: 'available',
      path: baseline,
      sha256: expect.any(String),
    })
    const failed = await harness(
      selectPlan(['--all']),
      info.outputPath('collect-benchmarks'),
      async (command, args, options) => {
        await mockRun(command, args, options)
        return options.env?.IRODORI_TEST_GROUP === 'benchmarks/preview' ? 9 : 0
      },
    )
    expect(failed.exitCode).toBe(9)
    expect(failed.stages.find((s) => s.name === 'benchmark-preview')!.rerun).toContain(
      'IRODORI_PREVIEW_BENCHMARK=1 IRODORI_TEST_TRACE=0',
    )
    expect(failed.stages.filter((s) => s.phase === 'benchmark').map((s) => s.status)).toEqual([
      'failed',
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
    ])
  })
})

test('ordinary preview UI targets participate in regression scopes and retain exclusive GPU groups', () => {
  const ordinaryTargets = [
    'interactive-preview-ui',
    'interactive-preview-lifecycle',
    'hdr-presentation-cache-ui',
  ]
  for (const args of [['--full'], ['--all'], ['--functional'], ['preview'], ['ui']]) {
    const plan = selectPlan(args)
    expect(plan.targets).toEqual(expect.arrayContaining(ordinaryTargets))
    for (const target of ordinaryTargets) {
      const group = plan.groups.find((group) => group.targets.includes(target))
      expect(group).toMatchObject({ name: 'raw-gpu', workers: 1 })
      expect(group!.files).toContain(`tests/${target}.spec.ts`)
    }
  }
  for (const target of ordinaryTargets) {
    const plan = selectPlan(['--target', target])
    expect(plan.targets).toContain(target)
    expect(plan.groups.find((group) => group.targets.includes(target))).toMatchObject({
      name: 'raw-gpu',
      workers: 1,
    })
    expect(plan.targets.filter((id) => ordinaryTargets.includes(id))).toEqual([target])
  }
  expect(selectPlan(['--full']).targets).toEqual(
    expect.arrayContaining(['interactive-preview-gpu', 'interactive-preview-quality']),
  )
})

test('comprehensive failure collection preserves codes and a failed build blocks only dependent tests', async ({}, info) => {
  for (const failing of ['lint', 'build', '--project=node']) {
    const result = await harness(
      selectPlan(['--full']),
      info.outputPath(failing.replaceAll('-', '')),
      async (command, args, options) => {
        await mockRun(command, args, options)
        return args.includes(failing) ? 7 : 0
      },
    )
    expect(result.exitCode).toBe(7)
    expect(result.stages.find((s) => s.name === 'node')!.status).toBe(
      failing === '--project=node' ? 'failed' : 'passed',
    )
    expect(result.stages.find((s) => s.name === 'mcp')!.status).toBe(
      failing === 'build' ? 'blocked' : 'passed',
    )
    expect(
      result.stages.filter((s) => s.status === 'blocked').every((s) => s.name !== 'node'),
    ).toBe(true)
  }
  const routine = await harness(
    selectPlan(['--target', 'adjustment-wiring']),
    info.outputPath('routine'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      return args.includes('--project=node') ? 9 : 0
    },
  )
  expect(routine.exitCode).toBe(9)
  expect(routine.stages.find((s) => s.name === 'electron')!.status).toBe('skipped')
})

test('missing baseline, skipped hardware, and missing reports are incomplete, with distinct status', async ({}, info) => {
  await withBaseline(undefined, async () => {
    const missing = await harness(selectPlan(['--benchmark']), info.outputPath('missing-baseline'))
    expect(missing.exitCode).toBe(INCOMPLETE_EXIT_CODE)
    expect(missing.status).toBe('incomplete')
    expect(missing.incomplete.join(' ')).toContain('15%')
    const summary = await readFile(join(missing.artifacts, 'summary.md'), 'utf8')
    expectCompactReport(summary)
    expect(summary).toContain('INCOMPLETE')
    expect(summary).toContain('missing')
    expect(summary).toContain('15%')
  })
  const invalidPath = info.outputPath('invalid-baseline.json')
  await writeFile(invalidPath, JSON.stringify({ sample: 'wrong.ARW', medians: { cpu: 1, gpu: 1 } }))
  await withBaseline(invalidPath, async () => {
    const invalid = await harness(selectPlan(['--benchmark']), info.outputPath('invalid-baseline'))
    expect(invalid.baseline.status).toBe('invalid')
    expect(invalid.exitCode).toBe(INCOMPLETE_EXIT_CODE)
    expect(invalid.baseline.reason).toContain('sample differs')
  })
  const skipped = await harness(
    selectPlan(['--fast']),
    info.outputPath('skipped-hardware'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      if (args.some((arg) => arg.startsWith('--project='))) {
        const path = join(
          options.env!.IRODORI_VERIFICATION_DIR!,
          options.env!.IRODORI_TEST_GROUP!,
          'summary.json',
        )
        const summary = JSON.parse(await readFile(path, 'utf8'))
        summary.passed--
        summary.skipped++
        summary.tests[0].status = 'skipped'
        summary.tests[0].annotations = [{ type: 'skip', description: 'No hardware adapter.' }]
        await writeFile(path, JSON.stringify(summary))
      }
      return 0
    },
  )
  expect(skipped.exitCode).toBe(INCOMPLETE_EXIT_CODE)
  const skippedSummary = await readFile(join(skipped.artifacts, 'summary.md'), 'utf8')
  expectCompactReport(skippedSummary)
  expect(skippedSummary).toContain('No hardware adapter.')
  const absent = await harness(
    selectPlan(['--fast']),
    info.outputPath('missing-reports'),
    async () => 0,
  )
  expect(absent.status).toBe('incomplete')
  expect(absent.incomplete.join(' ')).toContain('no test report')
  const absentSummary = await readFile(join(absent.artifacts, 'summary.md'), 'utf8')
  expectCompactReport(absentSummary)
  expect(absentSummary).toContain('no test report')
  expect(await readFile(join(absent.artifacts, 'details.md'), 'utf8')).toContain('no test report')
  const exitTwoFailure = await harness(
    selectPlan(['--fast', '--background']),
    info.outputPath('command-exit-two'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      return args.includes('lint') ? 2 : 0
    },
  )
  expect(exitTwoFailure.exitCode).toBe(2)
  expect(exitTwoFailure.status).toBe('failed')
  expect(exitTwoFailure.stages.find((stage) => stage.name === 'lint')!.status).toBe('failed')
})

test('compact report keeps the decision and details retain failure diagnostics, timings and provenance', async ({}, info) => {
  const result = await harness(
    { ...selectPlan(['--fast']), uiMode: 'background' },
    info.outputPath('report'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      if (!args.some((arg) => arg.startsWith('--project='))) return 0
      const path = join(
        options.env!.IRODORI_VERIFICATION_DIR!,
        options.env!.IRODORI_TEST_GROUP!,
        'summary.json',
      )
      const summary = JSON.parse(await readFile(path, 'utf8'))
      summary.passed--
      summary.failed++
      summary.tests[0].status = 'failed'
      summary.tests[0].errors = ['concise failing assertion']
      summary.tests[0].evidence = [info.outputPath('diagnostics.txt')]
      await writeFile(path, JSON.stringify(summary))
      return 9
    },
  )
  const report = await readFile(join(result.artifacts, 'summary.md'), 'utf8')
  const details = await readFile(join(result.artifacts, 'details.md'), 'utf8')
  expectCompactReport(report)
  for (const text of [
    'FAILED',
    `${result.passed} passed`,
    '1 failed',
    '0 skipped',
    '0 interrupted',
    'exit 9',
    'Requested targets',
    'UI mode: `background`',
    'Stages',
    'Baseline',
    'Revision:',
    'dirty',
    'concise failing assertion',
    result.tests[0].rerun,
  ])
    expect(report).toContain(text)
  for (const text of [
    'concise failing assertion',
    '--grep',
    'diagnostics.txt',
    'Ten slowest tests',
    'Workers',
    'revision',
    'dirty',
    'Baseline provenance',
  ])
    expect(details).toContain(text)
  expect(details).toContain('](result.json)')
  expect(details).toContain(result.targets.at(-1)!)
  expect(result.tests.some((t) => t.durationMs === 123)).toBe(true)
  const slowTable = details.split('## Ten slowest tests')[1].split('## Baseline provenance')[0]
  expect(slowTable.match(/\| (passed|failed) \|/g)).toHaveLength(10)
  expect(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8'))).toEqual(result)
})

test('summary prioritizes a failed or interrupted case, then a stage, then deferred work and warnings', () => {
  const deferred = reportCase({
    status: 'skipped',
    annotations: [{ type: 'skip', description: 'Deferred secondary diagnosis.' }],
  })
  for (const status of ['failed', 'interrupted'] as const) {
    const primary = reportCase({ status, errors: ['Primary case diagnosis.'] })
    const result = reportResult({
      status: 'failed',
      exitCode: 9,
      passed: 0,
      failed: status === 'failed' ? 2 : 1,
      interrupted: status === 'interrupted' ? 1 : 0,
      skipped: 1,
      tests: [
        deferred,
        primary,
        reportCase({ status: 'failed', errors: ['Later case diagnosis.'] }),
      ],
      incomplete: ['Incomplete secondary diagnosis.'],
      warnings: ['Warning secondary diagnosis.'],
    })
    result.stages[0] = {
      ...result.stages[0],
      status: 'failed',
      code: 9,
      error: 'Stage secondary diagnosis.',
    }
    const summary = renderSummary(result)
    expectCompactReport(summary)
    expect(summary).toContain('Primary case diagnosis.')
    expect(summary).toContain(primary.rerun)
    for (const secondary of [
      'Deferred secondary diagnosis.',
      'Later case diagnosis.',
      'Incomplete secondary diagnosis.',
      'Warning secondary diagnosis.',
      'Stage secondary diagnosis.',
    ])
      expect(summary).not.toContain(secondary)
    const details = renderDetails(result)
    for (const secondary of [
      'Deferred secondary diagnosis.',
      'Later case diagnosis.',
      'Incomplete secondary diagnosis.',
      'Warning secondary diagnosis.',
      'Stage secondary diagnosis.',
    ])
      expect(details).toContain(secondary)
  }
  for (const status of ['failed', 'interrupted'] as const) {
    const result = reportResult({ tests: [], passed: 0, status, exitCode: 143 })
    result.stages[0] = {
      ...result.stages[0],
      status,
      code: 143,
      error: 'Primary stage diagnosis.',
    }
    const summary = renderSummary(result)
    expectCompactReport(summary)
    expect(summary).toContain('Primary stage diagnosis.')
    expect(summary).toContain(result.stages[0].rerun)
    expect(renderDetails(result)).toContain(result.stages[0].rerun)
  }
  const incomplete = renderSummary(
    reportResult({
      status: 'incomplete',
      exitCode: INCOMPLETE_EXIT_CODE,
      passed: 0,
      skipped: 1,
      tests: [deferred],
      warnings: ['Warning secondary diagnosis.'],
    }),
  )
  expectCompactReport(incomplete)
  expect(incomplete).toContain('Deferred secondary diagnosis.')
  expect(incomplete).not.toContain('Warning secondary diagnosis.')
  const warning = renderSummary(reportResult({ warnings: ['Primary budget warning.'] }))
  expectCompactReport(warning)
  expect(warning).toContain('Primary budget warning.')
  expect(warning).not.toContain('exact rerun')
})

test('summary preserves exact fenced commands and details retain the slowest ten and baseline provenance', () => {
  const rerun = "npx playwright test --grep 'literal ``` marker$'"
  const issue = reportCase({
    status: 'failed',
    title: 'Diagnostic `title` | [with] <markup>',
    errors: ['Assertion failed.\n```sh\nthis-is-diagnostic-text\n```'],
    rerun,
  })
  const summary = renderSummary(
    reportResult({ status: 'failed', exitCode: 1, passed: 0, failed: 1, tests: [issue] }),
  )
  expectCompactReport(summary)
  expect(summary).toContain(rerun)
  expect(summary).toContain(`\n\`\`\`\`sh\n${rerun}\n\`\`\`\``)
  expect(summary).not.toContain('\n```sh\nthis-is-diagnostic-text')

  const baseline = {
    status: 'available' as const,
    path: '/tmp/original-baseline.json',
    snapshot: '/tmp/synthetic-verification/baseline.json',
    sha256: 'd'.repeat(64),
    sample: 'sony-zv1.ARW',
    medians: { cpu: 2000, gpu: 1000 },
  }
  const result = reportResult({
    passed: 12,
    tests: Array.from({ length: 12 }, (_, index) =>
      reportCase({ title: `ranked-case-${index}`, durationMs: (index + 1) * 100 }),
    ),
    baseline,
  })
  const details = renderDetails(result)
  const slowTable = details.split('## Ten slowest tests')[1].split('\n## ')[0]
  expect(slowTable.match(/\| passed \|/g)).toHaveLength(10)
  expect(slowTable.indexOf('ranked-case-11')).toBeLessThan(slowTable.indexOf('ranked-case-10'))
  expect(slowTable).not.toContain('ranked-case-0 |')
  expect(slowTable).not.toContain('ranked-case-1 |')
  for (const value of [baseline.path, baseline.snapshot, baseline.sha256, baseline.sample])
    expect(details).toContain(value)
  expect(details).toContain('Synthetic adapter')
  expect(renderSummary(result)).toContain('Baseline: `available`')
})

test('oversized Unicode lists and diagnostics stay bounded while details retain every issue and command', () => {
  const description = 'Photograph \u{1F4F7} \u{1F308} \u6771\u4EAC e\u0301 '.repeat(500)
  const command = `npx playwright test 'oversized-command-${description}' --grep 'exact$'`
  const tests = Array.from({ length: 120 }, (_, index) =>
    reportCase({
      target: `target-${index}`,
      title: `case-${index}: ${description}`,
      status: index < 60 ? 'failed' : 'skipped',
      errors: index < 60 ? [`failure-${index}: ${description}`] : [],
      annotations:
        index < 60 ? [] : [{ type: 'skip', description: `skip-${index}: ${description}` }],
      evidence: [`/tmp/synthetic-verification/evidence-${index}.txt`],
      rerun: index === 0 ? command : `npx playwright test --grep 'case-${index}$'`,
      foregroundRerun: index >= 60 ? `IRODORI_TEST_UI_MODE=foreground ${command}` : undefined,
    }),
  )
  const result = reportResult({
    scope: description,
    status: 'failed',
    exitCode: 9,
    passed: 0,
    failed: 60,
    skipped: 60,
    tests,
    targets: Array.from(
      { length: 200 },
      (_, index) => `selected-${index}-${'\u{1F4F7}\u6771\u4EAC'.repeat(10)}`,
    ),
    incomplete: Array.from({ length: 40 }, (_, index) => `incomplete-${index}: ${description}`),
    warnings: Array.from({ length: 40 }, (_, index) => `warning-${index}: ${description}`),
  })
  result.plan = { ...result.plan, requestedTargets: result.targets }
  result.stages = Array.from({ length: 40 }, (_, index) => ({
    ...result.stages[0],
    name: `stage-${index}`,
    status: 'failed' as const,
    code: 9,
    reason: `stage-reason-${index}: ${description}`,
    error: `stage-error-${index}: ${description}`,
    targets: result.targets,
  }))
  const original = structuredClone(result)
  const summary = renderSummary(result)
  const details = renderDetails(result)
  expectCompactReport(summary)
  expect(summary).toContain('60 failed')
  expect(summary).toContain('60 skipped')
  expect(summary).toContain('failure-0:')
  expect(summary).not.toContain('oversized-command-')
  expect(summary).not.toContain('```sh')
  for (const retained of [
    command,
    tests[59].errors[0],
    tests[119].annotations[0].description!,
    'evidence-119.txt',
    result.incomplete.at(-1)!,
    result.warnings.at(-1)!,
    result.stages.at(-1)!.error!,
    result.targets.at(-1)!,
  ])
    expect(details).toContain(retained)
  expect(result).toEqual(original)
})

test('large measurement payloads remain in result JSON while reports retain outcomes, gates and evidence', async ({}, info) => {
  const measurements = {
    p95Ms: 999_999,
    histogram: Array.from({ length: 4000 }, (_, index) => `raw-measurement-only-${index}`),
  }
  const result = await harness(
    selectPlan(['--fast']),
    info.outputPath('large-measurements'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      if (!args.some((arg) => arg.startsWith('--project='))) return 0
      const path = join(
        options.env!.IRODORI_VERIFICATION_DIR!,
        options.env!.IRODORI_TEST_GROUP!,
        'summary.json',
      )
      const summary = JSON.parse(await readFile(path, 'utf8'))
      summary.tests[0].title = 'recorded passing benchmark with an out-of-limit metric'
      summary.tests[0].benchmarks = [
        {
          family: 'preview',
          measurements,
          gates: [{ metric: 'p95Ms', operator: '<=', limit: 33 }],
          evidence: [join(options.env!.IRODORI_VERIFICATION_DIR!, 'benchmark-evidence.txt')],
        },
      ]
      await writeFile(path, JSON.stringify(summary))
      return 0
    },
  )
  const summary = await readFile(join(result.artifacts, 'summary.md'), 'utf8')
  const details = await readFile(join(result.artifacts, 'details.md'), 'utf8')
  const saved = JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8'))
  expectCompactReport(summary)
  expect(result.status).toBe('passed')
  expect(result.failed).toBe(0)
  expect(summary).toContain('PASSED')
  expect(summary).toContain('0 failed')
  expect(details).toContain('p95Ms <= 33')
  expect(details).toContain('benchmark-evidence.txt')
  expect(details).toContain('recorded passing benchmark with an out-of-limit metric — passed')
  expect(details).toContain('](result.json)')
  for (const report of [summary, details]) expect(report).not.toContain('raw-measurement-only-')
  expect(saved).toEqual(result)
  expect(saved.benchmarks[0].measurements).toEqual(measurements)
  expect(saved.tests[0].benchmarks[0].measurements).toEqual(measurements)

  const failed = reportResult({
    status: 'failed',
    exitCode: 1,
    passed: 0,
    failed: 1,
    tests: [
      reportCase({
        status: 'failed',
        title: 'recorded failed benchmark with an in-limit metric',
        errors: ['Independent benchmark assertion failed.'],
        benchmarks: [{ ...result.benchmarks[0], measurements: { p95Ms: 1 } }],
      }),
    ],
    benchmarks: [{ ...result.benchmarks[0], measurements: { p95Ms: 1 } }],
  })
  expect(renderSummary(failed)).toContain('FAILED')
  const failedDetails = renderDetails(failed)
  expect(failedDetails).toContain('Independent benchmark assertion failed.')
  expect(failedDetails).toContain('recorded failed benchmark with an in-limit metric — failed')
})

test('routine budget warnings retain all selected work without terminating tests', async ({}, info) => {
  let time = 0,
    commands = 0
  const directory = info.outputPath('budget')
  const result = await executePlan(selectPlan(['--target', 'adjustment-wiring']), {
    directory,
    lockDirectory: join(directory, '.lock'),
    now: () => time,
    run: async (command, args, options) => {
      commands++
      await mockRun(command, args, options)
      if (args.includes('--project=node')) time += 61_000
      return 0
    },
  })
  expect(commands).toBe(6)
  expect(result.exitCode).toBe(0)
  expect(result.durationMs).toBe(61_000)
  expect(result.warnings.join(' ')).toContain('60 seconds')
  expect(result.stages.every((s) => s.status === 'passed')).toBe(true)
})

test('reporter maps shared helper declarations to the owning suite and preserves nested case reruns', async ({}, info) => {
  for (const nested of [false, true]) {
    const uiMode = nested ? 'foreground' : 'background'
    await withUiMode(uiMode, async () => {
      const directory = info.outputPath(`reporter-${nested}`)
      const reporter = new VerificationReporter({ outputDir: directory })
      const fileSuite = {
        type: 'file',
        location: { file: resolve('tests/adjustment-engine.spec.ts') },
        parent: { type: 'project' },
        project: () => ({ name: 'service' }),
      }
      const parent = nested
        ? { type: 'describe', parent: fileSuite, project: fileSuite.project }
        : fileSuite
      const declared = {
        title: 'png agrees',
        parent,
        expectedStatus: 'passed',
        annotations: [],
        location: { file: resolve('tests/adjustment-engine.helpers.ts'), line: 11 },
        titlePath: () => [
          '',
          'service',
          'adjustment-engine.spec.ts',
          ...(nested ? ['nested'] : []),
          'png agrees',
        ],
      } as unknown as TestCase
      const measurements = {
        family: 'preview',
        measurements: { syntheticReporterRecord: true, samples: 4 },
        gates: [],
        evidence: [],
      }
      reporter.onBegin({ workers: 2 } as FullConfig)
      reporter.onTestEnd(declared, {
        status: 'passed',
        duration: 22,
        workerIndex: 1,
        errors: [],
        attachments: [
          { name: 'benchmark:preview', body: Buffer.from(JSON.stringify(measurements)) },
        ],
      } as unknown as TestResult)
      reporter.onEnd({ status: 'passed', duration: 22 } as FullResult)
      const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
      expect(summary.uiMode).toBe(uiMode)
      expect(summary.errors).toEqual([])
      expect(summary.tests[0]).toMatchObject({
        target: 'adjustment-engine',
        file: 'tests/adjustment-engine.spec.ts',
        definitionFile: 'tests/adjustment-engine.helpers.ts',
        line: 11,
        durationMs: 22,
        worker: 1,
        benchmarks: [measurements],
      })
      expect(summary.tests[0].rerun).toContain("'tests/adjustment-engine.spec.ts'")
      expect(summary.tests[0].rerun).toContain(`IRODORI_TEST_UI_MODE=${uiMode}`)
      const pattern = new RegExp(summary.tests[0].rerun.split("--grep '")[1].slice(0, -1))
      const title = `${nested ? 'nested ' : ''}png agrees`
      expect(pattern.test(`service adjustment-engine.spec.ts ${title}`)).toBe(true)
      expect(pattern.test(`service adjustment-engine.spec.ts ${title} @foreground`)).toBe(true)
      expect(pattern.test(`service adjustment-engine.spec.ts ${title} changed`)).toBe(false)
    })
  }
})

test('selected native skips remain incomplete and provide an explicit foreground case rerun', async ({}, info) => {
  const directory = info.outputPath('native-reporter')
  await withUiMode('background', async () => {
    const reporter = new VerificationReporter({ outputDir: directory })
    const fileSuite = {
      type: 'file',
      location: { file: resolve('tests/preview.spec.ts') },
      parent: { type: 'project' },
      project: () => ({ name: 'electron' }),
    }
    const reason = 'Native pointer lock requires --foreground.'
    reporter.onBegin({ workers: 1 } as FullConfig)
    reporter.onTestEnd(
      {
        title: 'native pointer lock',
        parent: fileSuite,
        expectedStatus: 'passed',
        annotations: [
          { type: 'requires-foreground', description: reason },
          { type: 'skip', description: reason },
        ],
        location: { file: fileSuite.location.file, line: 59 },
        titlePath: () => ['', 'electron', 'preview.spec.ts', 'native pointer lock'],
      } as unknown as TestCase,
      {
        status: 'skipped',
        duration: 0,
        workerIndex: -1,
        errors: [],
        attachments: [],
      } as unknown as TestResult,
    )
    reporter.onEnd({ status: 'passed', duration: 0 } as FullResult)
    const benchmarkReporter = new VerificationReporter({
      outputDir: info.outputPath('early-benchmark-reporter'),
    })
    benchmarkReporter.onBegin({ workers: 1 } as FullConfig)
    benchmarkReporter.onTestEnd(
      {
        title: 'visible presentation',
        parent: {
          ...fileSuite,
          location: { file: resolve('tests/preview-benchmark.spec.ts') },
          project: () => ({ name: 'benchmark' }),
        },
        expectedStatus: 'skipped',
        annotations: [
          { type: 'requires-foreground', description: 'Visible presentation benchmark.' },
          { type: 'skip', description: 'Foreground required: visible presentation benchmark.' },
        ],
        location: { file: resolve('tests/preview-benchmark.spec.ts'), line: 16 },
        titlePath: () => ['', 'benchmark', 'preview-benchmark.spec.ts', 'visible presentation'],
      } as unknown as TestCase,
      {
        status: 'skipped',
        duration: 0,
        workerIndex: -1,
        errors: [],
        attachments: [],
      } as unknown as TestResult,
    )
    benchmarkReporter.onEnd({ status: 'passed', duration: 0 } as FullResult)
  })
  const earlyBenchmark = JSON.parse(
    await readFile(join(info.outputPath('early-benchmark-reporter'), 'summary.json'), 'utf8'),
  )
  expect(earlyBenchmark.skipped).toBe(1)
  expect(earlyBenchmark.tests[0].foregroundRerun).toContain('IRODORI_TEST_UI_MODE=foreground')
  expect(earlyBenchmark.tests[0].foregroundRerun).toContain(
    'IRODORI_PREVIEW_BENCHMARK=1 IRODORI_TEST_TRACE=0',
  )
  const nativeSummary = await readFile(join(directory, 'summary.json'), 'utf8')
  const nativeCase = JSON.parse(nativeSummary).tests[0]
  expect(nativeCase.rerun).toContain('IRODORI_TEST_UI_MODE=background')
  expect(nativeCase.foregroundRerun).toContain('IRODORI_TEST_UI_MODE=foreground')
  const nativePattern = new RegExp(nativeCase.foregroundRerun.split("--grep '")[1].slice(0, -1))
  expect(nativePattern.test('electron preview.spec.ts native pointer lock @foreground')).toBe(true)
  expect(
    nativePattern.test('electron preview.spec.ts native pointer lock changed @foreground'),
  ).toBe(false)
  expect(nativeCase.foregroundRerun).toContain('--workers=1')
  const result = await harness(
    selectPlan(['--target', 'preview', '--background']),
    info.outputPath('native-skip'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      if (args.includes('tests/preview.spec.ts'))
        await writeFile(
          join(
            options.env!.IRODORI_VERIFICATION_DIR!,
            options.env!.IRODORI_TEST_GROUP!,
            'summary.json',
          ),
          nativeSummary,
        )
      return 0
    },
  )
  expect(result.uiMode).toBe('background')
  expect(result.status).toBe('incomplete')
  expect(result.exitCode).toBe(INCOMPLETE_EXIT_CODE)
  expect(result.failed).toBe(0)
  expect(result.skipped).toBe(1)
  const report = await readFile(join(result.artifacts, 'summary.md'), 'utf8')
  expect(report).toContain('Native pointer lock requires --foreground.')
  expect(report).toContain(nativeCase.foregroundRerun)
})

test('a concurrent invocation exits with the active run location and never executes commands', async ({}, info) => {
  const directory = info.outputPath('active'),
    lockDirectory = info.outputPath('repository-lock')
  let started!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = executePlan(selectPlan(['--functional']), {
    directory,
    lockDirectory,
    run: async (command, args, options) => {
      if (args.includes('build')) {
        started()
        await gate
      }
      return mockRun(command, args, options)
    },
  })
  await ready
  let called = false
  try {
    await expect(
      executePlan(selectPlan(['--fast']), {
        directory: info.outputPath('second'),
        lockDirectory,
        run: async () => {
          called = true
          return 0
        },
      }),
    ).rejects.toThrow(directory)
    expect(called).toBe(false)
  } finally {
    release()
    await first
  }
  await expect(access(lockDirectory)).rejects.toThrow()
})

test('interruption stops further stages, preserves a partial report and releases the lock', async ({}, info) => {
  const controller = new AbortController()
  let commands = 0
  const result = await harness(
    selectPlan(['--functional']),
    info.outputPath('interrupted'),
    async (_command, _args, options) => {
      commands++
      await writeFile(options.log, 'partial build evidence\n')
      controller.abort('SIGTERM')
      return 143
    },
    controller.signal,
  )
  expect(commands).toBe(1)
  expect(result.exitCode).toBe(143)
  expect(result.status).toBe('interrupted')
  expect(result.stages.find((s) => s.name === 'build')!.status).toBe('interrupted')
  expect(result.stages.slice(1).every((s) => s.code === null)).toBe(true)
  const summary = await readFile(join(result.artifacts, 'summary.md'), 'utf8')
  const details = await readFile(join(result.artifacts, 'details.md'), 'utf8')
  expectCompactReport(summary)
  expect(summary).toContain('INTERRUPTED')
  expect(summary).toContain(result.stages[0].rerun)
  expect(details).toContain('build.log')
  expect(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8'))).toEqual(result)
  await expect(access(join(result.artifacts, '.lock'))).rejects.toThrow()
})

test('run artifacts survive later runs; dry plans create no artifacts or lock; occupied ports fail before launch', async ({}, info) => {
  const first = await artifactDirectory('harness'),
    second = await artifactDirectory('harness')
  const profile = await mkdtemp(join(tmpdir(), 'irodori-launcher-check-')),
    server = createServer()
  try {
    expect(first).not.toBe(second)
    const planLog = info.outputPath('plan.log')
    const beforePlan = await readdir('artifacts/verification')
    const planEnv = { ...process.env }
    delete planEnv.FORCE_COLOR
    for (const args of [
      ['ui', 'preview', 'ui'],
      ['--foreground', '--target', 'adjustment-wiring'],
      ['--target', 'preview', '--background'],
    ]) {
      expect(
        await runCommand(process.execPath, ['scripts/verify.mjs', '--plan', ...args], {
          log: planLog,
          env: planEnv,
        }),
      ).toBe(0)
      expect(JSON.parse(await readFile(planLog, 'utf8'))).toEqual(
        JSON.parse(JSON.stringify(selectPlan(args))),
      )
    }
    expect(await readdir('artifacts/verification')).toEqual(beforePlan)
    await writeFile(join(first, 'evidence.json'), 'benchmark evidence')
    expect(await readFile(join(first, 'evidence.json'), 'utf8')).toBe('benchmark evidence')
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? resolve() : reject(error),
      )
      server.listen(9222, '127.0.0.1', resolve)
    })
    expect(
      await runCommand(
        process.execPath,
        ['scripts/dev-mcp.mjs', '--', `--user-data-dir=${profile}`],
        { log: info.outputPath('launcher.log') },
      ),
    ).toBe(1)
    expect(await readFile(info.outputPath('launcher.log'), 'utf8')).toContain(
      'Port 9222 is already in use',
    )
    expect(await readdir(profile)).toEqual([])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await Promise.all(
      [first, second, profile].map((path) => rm(path, { recursive: true, force: true })),
    )
  }
  await expect(access(profile)).rejects.toThrow()
})

async function developmentLauncherFixture(runtime: string) {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-dev-launcher-'))
  // Mock Vite never opens a debug server; keep its probe independent of a real dev session.
  const launcher = (await readFile('scripts/dev-mcp.mjs', 'utf8')).replace(
    "probe.listen(9222, '127.0.0.1', resolve)",
    "probe.listen(0, '127.0.0.1', resolve)",
  )
  await Promise.all(
    ['scripts', 'node_modules/electron', 'node_modules/electron-vite/bin'].map((path) =>
      mkdir(join(directory, path), { recursive: true }),
    ),
  )
  await Promise.all([
    writeFile(join(directory, 'scripts/dev-mcp.mjs'), launcher),
    writeFile(join(directory, 'node_modules/electron/package.json'), '{"main":"index.cjs"}'),
    writeFile(join(directory, 'node_modules/electron/index.cjs'), runtime),
    writeFile(
      join(directory, 'node_modules/electron-vite/bin/electron-vite.js'),
      `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync('vite-started', 'started');
const runtime = fs.readFileSync(path.join(__dirname, '../../electron/path.txt'), 'utf8');
fs.writeFileSync('vite.json', JSON.stringify({ runtime, args: process.argv.slice(2) }));`,
    ),
  ])
  return directory
}

test('development launcher prepares a missing Electron runtime before Vite and preserves arguments', async ({}, info) => {
  const directory = await developmentLauncherFixture(
    `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'prepared-runtime');
module.exports = 'prepared-runtime';`,
  )
  try {
    await expect(access(join(directory, 'node_modules/electron/path.txt'))).rejects.toThrow()
    const args = ['--', `--user-data-dir=${join(directory, 'isolated profile')}`]
    expect(
      await runCommand(process.execPath, [join(directory, 'scripts/dev-mcp.mjs'), ...args], {
        log: info.outputPath('prepared-runtime.log'),
      }),
    ).toBe(0)
    expect(JSON.parse(await readFile(join(directory, 'vite.json'), 'utf8'))).toEqual({
      runtime: 'prepared-runtime',
      args: ['dev', '--remote-debugging-port=9222', ...args],
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('development launcher reports runtime installation failures without starting Vite', async ({}, info) => {
  const directory = await developmentLauncherFixture(
    `throw new Error('Runtime download failed in isolated installer');`,
  )
  try {
    const log = info.outputPath('runtime-failure.log')
    expect(
      await runCommand(process.execPath, [join(directory, 'scripts/dev-mcp.mjs')], { log }),
    ).toBe(1)
    const output = await readFile(log, 'utf8')
    expect(output).toContain(
      'Could not prepare the Electron runtime: Runtime download failed in isolated installer',
    )
    expect(output).toContain('Run npm run setup:electron and try again.')
    await expect(access(join(directory, 'vite-started'))).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function exited(pid: number) {
  try {
    return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'
  } catch {
    return true
  }
}

test('command failures preserve status and detail; completion and interruption kill descendants', async ({}, info) => {
  expect(
    await runCommand(
      process.execPath,
      ['-e', 'console.error("preserved failure detail"); process.exit(9)'],
      { log: info.outputPath('exit.log') },
    ),
  ).toBe(9)
  expect(await readFile(info.outputPath('exit.log'), 'utf8')).toContain('preserved failure detail')
  for (const interrupt of [false, true]) {
    const pidFile = info.outputPath(`${interrupt}.pid`),
      controller = new AbortController()
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));${interrupt ? "process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)" : 'child.unref()'}`
    const command = runCommand(process.execPath, ['-e', script, pidFile], {
      log: info.outputPath(`${interrupt}.log`),
      signal: controller.signal,
    })
    if (interrupt) {
      await expect
        .poll(() =>
          access(pidFile)
            .then(() => true)
            .catch(() => false),
        )
        .toBe(true)
      controller.abort()
    }
    expect(await command).toBe(interrupt ? 130 : 0)
    await expect
      .poll(() => readFile(pidFile, 'utf8').then((value) => exited(Number(value))))
      .toBe(true)
  }
})
