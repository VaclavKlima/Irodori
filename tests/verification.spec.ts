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
import type { CaseResult } from '../scripts/verification-types'
import VerificationReporter from '../scripts/verification-reporter'

const files = (args: string[]) => selectPlan(args).groups.flatMap((group) => group.files)
const mockRun: typeof runCommand = async (_command, args, options) => {
  await writeFile(options.log, 'retained stage evidence\n')
  if (args.some((arg) => arg.startsWith('--project='))) {
    const benchmark = options.env?.LUMA_PREVIEW_BENCHMARK === '1'
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
    const directory = join(options.env!.LUMA_VERIFICATION_DIR!, options.env!.LUMA_TEST_GROUP!)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({
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

async function withBaseline(path: string | undefined, action: () => Promise<void>) {
  const previous = process.env.LUMA_PREVIEW_BASELINE
  if (path) process.env.LUMA_PREVIEW_BASELINE = path
  else delete process.env.LUMA_PREVIEW_BASELINE
  try {
    await action()
  } finally {
    if (previous) process.env.LUMA_PREVIEW_BASELINE = previous
    else delete process.env.LUMA_PREVIEW_BASELINE
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
    specs.length - suites.filter((s) => s.group === 'benchmark').length,
  )
  expect(selectPlan(['--full']).mcp).toBe(true)
  expect(files(['--all'])).toHaveLength(specs.length)
  expect(selectPlan(['--all']).mcp).toBe(true)
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
  ])
    expect(files([mode])).toEqual([
      `tests/${file}-benchmark.spec.ts`,
      ...(file === 'hdr'
        ? ['tests/hdr-interaction-benchmark.spec.ts', 'tests/hdr-slider-benchmark.spec.ts']
        : []),
      ...(file === 'merge' ? ['tests/merge-preview-benchmark.spec.ts'] : []),
    ])
  expect(selectPlan(['--benchmark-all']).groups).toHaveLength(4)
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
      selectPlan(['--all']),
      info.outputPath('shared-build'),
      async (command, args, options) => {
        commands.push({ args, env: options.env! })
        return mockRun(command, args, options)
      },
    )
    expect(result.exitCode).toBe(0)
    expect(commands.filter((c) => c.args.join(' ') === 'run --silent build')).toHaveLength(1)
    const mcp = commands.findIndex((c) => c.args[0] === 'scripts/check-mcp.mjs')
    expect(commands.slice(mcp + 1)).toHaveLength(4)
    for (const c of commands.slice(mcp + 1)) {
      expect(c.env.LUMA_PREVIEW_BENCHMARK).toBe('1')
      expect(c.env.LUMA_TEST_TRACE).toBe('0')
      expect(c.env.LUMA_TEST_GROUP).toMatch(/^benchmarks\//)
      expect(c.args).toContain('--workers=1')
    }
    expect(commands.slice(0, mcp).every((c) => c.env.LUMA_PREVIEW_BENCHMARK === '0')).toBe(true)
    expect(result.benchmarks).toHaveLength(suites.filter((suite) => suite.family).length)
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
        return options.env?.LUMA_TEST_GROUP === 'benchmarks/preview' ? 9 : 0
      },
    )
    expect(failed.exitCode).toBe(9)
    expect(failed.stages.find((s) => s.name === 'benchmark-preview')!.rerun).toContain(
      'LUMA_PREVIEW_BENCHMARK=1 LUMA_TEST_TRACE=0',
    )
    expect(failed.stages.filter((s) => s.phase === 'benchmark').map((s) => s.status)).toEqual([
      'failed',
      'passed',
      'passed',
      'passed',
    ])
  })
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
          options.env!.LUMA_VERIFICATION_DIR!,
          options.env!.LUMA_TEST_GROUP!,
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
  expect(await readFile(join(skipped.artifacts, 'summary.md'), 'utf8')).toContain(
    'No hardware adapter.',
  )
  const absent = await harness(
    selectPlan(['--fast']),
    info.outputPath('missing-reports'),
    async () => 0,
  )
  expect(absent.status).toBe('incomplete')
  expect(absent.incomplete.join(' ')).toContain('no test report')
})

test('compact report retains failed cases, reruns, timings, evidence, hardware and revision', async ({}, info) => {
  const result = await harness(
    selectPlan(['--fast']),
    info.outputPath('report'),
    async (command, args, options) => {
      await mockRun(command, args, options)
      if (!args.some((arg) => arg.startsWith('--project='))) return 0
      const path = join(
        options.env!.LUMA_VERIFICATION_DIR!,
        options.env!.LUMA_TEST_GROUP!,
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
    expect(report).toContain(text)
  expect(result.tests.some((t) => t.durationMs === 123)).toBe(true)
  const slowTable = report.split('## Ten slowest tests')[1].split('## Baseline provenance')[0]
  expect(slowTable.match(/\| (passed|failed) \|/g)).toHaveLength(10)
  expect(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8')).exitCode).toBe(9)
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
      attachments: [{ name: 'benchmark:preview', body: Buffer.from(JSON.stringify(measurements)) }],
    } as unknown as TestResult)
    reporter.onEnd({ status: 'passed', duration: 22 } as FullResult)
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
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
    expect(summary.tests[0].rerun).toContain(nested ? "'nested png agrees$'" : "'png agrees$'")
  }
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
  expect(await readFile(join(result.artifacts, 'summary.md'), 'utf8')).toContain('INTERRUPTED')
  await expect(access(join(result.artifacts, '.lock'))).rejects.toThrow()
})

test('run artifacts survive later runs; dry plans create no artifacts or lock; occupied ports fail before launch', async ({}, info) => {
  const first = await artifactDirectory('harness'),
    second = await artifactDirectory('harness')
  const profile = await mkdtemp(join(tmpdir(), 'luma-launcher-check-')),
    server = createServer()
  try {
    expect(first).not.toBe(second)
    const planLog = info.outputPath('plan.log')
    const beforePlan = await readdir('artifacts/verification')
    const planEnv = { ...process.env }
    delete planEnv.FORCE_COLOR
    for (const args of [
      ['ui', 'preview', 'ui'],
      ['--target', 'adjustment-wiring'],
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
