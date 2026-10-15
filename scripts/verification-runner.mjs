import { spawn, execFile } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, readlink } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { cpus, totalmem, platform, release, arch } from 'node:os'
import { promisify } from 'node:util'
import { renderSummary } from './verification-report.mjs'
const require = createRequire(import.meta.url)
const exec = promisify(execFile)
export const INCOMPLETE_EXIT_CODE = 2

export async function artifactDirectory(label = 'run') {
  const root = resolve('artifacts/verification')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, `${new Date().toISOString().replaceAll(':', '-')}-${label}-`))
}

// The lock covers the whole invocation, including benchmarks that consume out/.
// A stale lock is retained until its processes have been checked by the operator.
export async function acquireInvocationLock(
  artifacts,
  lockDirectory = resolve('artifacts/verification/.invocation-lock'),
) {
  await mkdir(resolve(lockDirectory, '..'), { recursive: true })
  const token = randomUUID()
  await writeFile(
    join(artifacts, 'owner.json'),
    JSON.stringify(
      { pid: process.pid, token, artifacts, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  )
  try {
    // The link publishes the active location atomically, even before an owner read.
    await symlink(artifacts, lockDirectory, 'dir')
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = await readFile(join(lockDirectory, 'owner.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    throw new Error(
      `Verification already locked by PID ${owner?.pid ?? 'unknown'}; active run: ${owner?.artifacts ?? (await readlink(lockDirectory).catch(() => lockDirectory))}.`,
      { cause: error },
    )
  }
  return async () => {
    const owner = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8'))
    if (owner.token === token) await rm(lockDirectory, { force: true })
  }
}

export function runCommand(command, args, { log, env = process.env, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      resolveResult(signal.reason === 'SIGTERM' ? 143 : 130)
      return
    }
    const output = openSync(log, 'w')
    const child = spawn(command, args, { env, stdio: ['ignore', output, output], detached: true })
    closeSync(output)
    let interruptedCode
    let forceStop
    const stop = (value) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, value)
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(value)
      }
    }
    const interrupt = (value = 'SIGINT') => {
      interruptedCode = value === 'SIGTERM' ? 143 : 130
      stop(value)
      forceStop ??= setTimeout(() => stop('SIGKILL'), 5000)
    }
    const onInterrupt = () => interrupt()
    const onTerminate = () => interrupt('SIGTERM')
    const onAbort = () => interrupt(signal.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
    const cleanup = () => {
      clearTimeout(forceStop)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      signal?.removeEventListener('abort', onAbort)
      // Reap workers that outlive either a successful or failed parent command.
      stop('SIGKILL')
    }
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, value) => {
      cleanup()
      resolveResult(interruptedCode ?? code ?? (value === 'SIGTERM' ? 143 : value ? 130 : 1))
    })
  })
}

async function runtimeInfo() {
  const readCommand = async (command, args) =>
    (await exec(command, args).catch(() => ({ stdout: '' }))).stdout.trim()
  const [revision, dirty, gpu] = await Promise.all([
    readCommand('git', ['rev-parse', 'HEAD']),
    readCommand('git', ['status', '--porcelain']),
    readCommand('lspci', ['-mm']),
  ])
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
    electron: require('electron/package.json').version,
    playwright: require('@playwright/test/package.json').version,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    gpu: gpu.split('\n').filter((line) => /VGA|Display|3D controller/i.test(line)),
    git: { revision, dirty: Boolean(dirty), changes: dirty.split('\n').filter(Boolean) },
  }
}

async function baselineInfo(plan, artifacts) {
  if (!plan.groups.some((g) => g.stage === 'benchmark-preview')) return { status: 'not-required' }
  const path = process.env.LUMA_PREVIEW_BASELINE
  if (!path)
    return {
      status: 'missing',
      reason: 'LUMA_PREVIEW_BASELINE is unset; the 15% uncorrected regression gate is unverified.',
    }
  try {
    const bytes = await readFile(path),
      baseline = JSON.parse(bytes)
    if (
      ['cpu', 'gpu'].some(
        (kind) => !Number.isFinite(baseline.medians?.[kind]) || baseline.medians[kind] <= 0,
      )
    )
      throw new Error('Baseline needs positive CPU and GPU medians.')
    if (
      baseline.sample !==
      basename(process.env.LUMA_RAW_BENCHMARK_FILE ?? 'tests/fixtures/sony-zv1.ARW')
    )
      throw new Error('Baseline sample differs from the selected benchmark sample.')
    const snapshot = join(artifacts, 'baseline.json')
    await writeFile(snapshot, bytes)
    return {
      status: 'available',
      path: resolve(path),
      snapshot,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sample: baseline.sample,
      medians: baseline.medians,
    }
  } catch (error) {
    return {
      status: 'invalid',
      path: resolve(path),
      reason: `Baseline unavailable: ${error.message}`,
    }
  }
}

export async function executePlan(
  plan,
  { directory, run = runCommand, lockDirectory, signal, now = Date.now } = {},
) {
  const started = now()
  const artifacts = resolve(
    directory ??
      (await artifactDirectory(
        plan.comprehensive ? 'checkpoint' : plan.benchmark ? 'benchmark' : 'check',
      )),
  )
  await mkdir(artifacts, { recursive: true })
  const unlock = await acquireInvocationLock(artifacts, lockDirectory)
  const controller = new AbortController()
  const interrupt = () => controller.abort('SIGINT'),
    terminate = () => controller.abort('SIGTERM')
  const abort = () => controller.abort(signal.reason)
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const result = {
    scope: plan.label,
    uiMode: plan.uiMode,
    plan,
    targets: plan.targets,
    exitCode: 0,
    status: 'passed',
    passed: 0,
    failed: 0,
    skipped: 0,
    interrupted: 0,
    durationMs: 0,
    artifacts,
    stages: [],
    tests: [],
    benchmarks: [],
    incomplete: [],
    warnings: [],
    runtime: {},
    baseline: { status: 'not-required' },
  }
  let failureCode = 0,
    buildFailed = false
  const baseEnv = {
    ...process.env,
    LUMA_VERIFICATION_DIR: artifacts,
    LUMA_PREVIEW_BENCHMARK: '0',
    LUMA_TEST_UI_MODE: plan.uiMode,
  }
  delete baseEnv.LUMA_TEST_GROUP
  const stage = async (
    name,
    phase,
    command,
    args,
    { env = baseEnv, targets = [], workers = 0, requiresBuild = false } = {},
  ) => {
    const start = now(),
      log = join(artifacts, `${name}.log`)
    const record = {
      name,
      phase,
      status: 'passed',
      code: null,
      durationMs: 0,
      log,
      targets,
      workers,
      rerun: `LUMA_TEST_UI_MODE=${plan.uiMode} ${[command, ...args].map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(' ')}`,
    }
    if (phase === 'benchmark')
      record.rerun = `LUMA_PREVIEW_BENCHMARK=1 LUMA_TEST_TRACE=0 ${env.LUMA_PREVIEW_BASELINE ? `LUMA_PREVIEW_BASELINE='${env.LUMA_PREVIEW_BASELINE.replaceAll("'", "'\\''")}' ` : ''}${record.rerun}`
    result.stages.push(record)
    if (
      controller.signal.aborted ||
      (requiresBuild && buildFailed) ||
      (failureCode && !plan.continueOnFailure)
    ) {
      record.status = requiresBuild && buildFailed ? 'blocked' : 'skipped'
      record.reason = controller.signal.aborted
        ? 'Invocation interrupted.'
        : record.status === 'blocked'
          ? 'Required build did not complete successfully; output is unavailable.'
          : 'Earlier stage failed; rerun the failure first.'
      await writeFile(log, record.reason + '\n')
      return record
    }
    try {
      record.code = await run(command, args, { log, env, signal: controller.signal })
    } catch (error) {
      record.code = 1
      record.error = error.message
      await writeFile(log, String(error) + '\n', { flag: 'a' })
    }
    record.durationMs = now() - start
    if (controller.signal.aborted || [130, 143].includes(record.code)) {
      controller.abort(record.code === 143 ? 'SIGTERM' : 'SIGINT')
      record.status = 'interrupted'
    } else if (record.code) {
      record.status = 'failed'
      failureCode ||= record.code
      const excerpt = await readFile(log, 'utf8').catch(() => '')
      record.error ??= excerpt
        .replaceAll(String.fromCharCode(27), '')
        .replace(/\[[0-9;]*m/g, '')
        .trim()
        .split('\n')
        .slice(-12)
        .join('\n')
        .slice(-2000)
      console.error(`${name} failed (${record.code}). See ${log}`)
    }
    return record
  }
  try {
    ;[result.runtime, result.baseline] = await Promise.all([
      runtimeInfo(),
      baselineInfo(plan, artifacts),
    ])
    if (result.baseline.status === 'available')
      baseEnv.LUMA_PREVIEW_BASELINE = result.baseline.snapshot
    if (['missing', 'invalid'].includes(result.baseline.status)) {
      result.incomplete.push(result.baseline.reason)
      // Invalid evidence cannot be used by the optional baseline assertions.
      delete baseEnv.LUMA_PREVIEW_BASELINE
    }
    if (plan.staticChecks)
      await Promise.all(
        ['typecheck', 'lint', 'format:check'].map((name) =>
          stage(name.replace(':', '-'), 'static', 'npm', ['run', '--silent', name]),
        ),
      )
    if (plan.build) {
      const build = await stage('build', 'build', 'npm', ['run', '--silent', 'build'])
      buildFailed = build.status !== 'passed'
    }
    const groupStage = async (group) => {
      const args = [
        require.resolve('@playwright/test/cli'),
        'test',
        `--project=${group.name}`,
        ...group.files,
        `--workers=${group.workers}`,
      ]
      if (plan.grep && group.phase === 'benchmark') args.push('--grep', plan.grep)
      const record = await stage(group.stage, group.phase, process.execPath, args, {
        env: {
          ...baseEnv,
          LUMA_TEST_GROUP: group.directory,
          LUMA_PREVIEW_BENCHMARK: group.phase === 'benchmark' ? '1' : '0',
          ...(group.phase === 'benchmark' ? { LUMA_TEST_TRACE: '0' } : {}),
        },
        targets: group.targets,
        workers: group.workers,
        requiresBuild: group.name !== 'node',
      })
      if (record.code === null) return
      const summary = await readFile(join(artifacts, group.directory, 'summary.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null)
      if (!summary || !Array.isArray(summary.tests) || !Array.isArray(summary.errors)) {
        if (record.status === 'passed') record.status = 'incomplete'
        result.incomplete.push(
          `${group.stage}: no test report was produced, or its structure is invalid.`,
        )
        return
      }
      for (const key of ['passed', 'failed', 'skipped', 'interrupted'])
        result[key] += summary[key] ?? 0
      result.tests.push(...summary.tests)
      for (const test of summary.tests) result.benchmarks.push(...test.benchmarks)
      if (summary.skipped)
        result.incomplete.push(
          `${group.stage}: ${summary.skipped} selected tests skipped (see reasons).`,
        )
      if (
        summary.tests.some((test) =>
          test.errors.some((error) =>
            /No hardware GPU adapter|Required hardware GPU is unavailable/.test(error),
          ),
        )
      )
        result.incomplete.push(`${group.stage}: required hardware GPU verification is unavailable.`)
      if (summary.errors.length) {
        record.error = summary.errors.join('\n')
        if (!record.code) {
          record.status = 'failed'
          failureCode ||= 1
        }
      }
      if (summary.failed && !record.code) {
        record.status = 'failed'
        failureCode ||= 1
      }
      if (!summary.tests.length) result.incomplete.push(`${group.stage}: no selected tests ran.`)
      if (
        group.phase === 'benchmark' &&
        summary.tests.some((t) => t.status === 'passed' && !t.benchmarks.length)
      )
        result.incomplete.push(
          `${group.stage}: a passing benchmark has no structured measurements.`,
        )
    }
    for (const group of plan.groups.filter((g) => g.phase === 'functional')) await groupStage(group)
    if (plan.mcp)
      await stage('mcp', 'functional', process.execPath, ['scripts/check-mcp.mjs', '--isolated'], {
        targets: ['mcp-import'],
        workers: 1,
        requiresBuild: true,
      })
    for (const group of plan.groups.filter((g) => g.phase === 'benchmark')) await groupStage(group)
  } catch (error) {
    failureCode ||= 1
    result.incomplete.push(`Runner error: ${error.message}`)
  } finally {
    result.durationMs = now() - started
    const interruptedCode = controller.signal.reason === 'SIGTERM' ? 143 : 130
    result.status = controller.signal.aborted
      ? 'interrupted'
      : failureCode
        ? 'failed'
        : result.incomplete.length
          ? 'incomplete'
          : 'passed'
    result.exitCode = controller.signal.aborted
      ? interruptedCode
      : failureCode || (result.incomplete.length ? INCOMPLETE_EXIT_CODE : 0)
    if (plan.routine && result.durationMs > 60_000)
      result.warnings.push(
        'Routine verification exceeded 60 seconds. Review the ten slowest tests below; no assertions were removed or cut short.',
      )
    if (plan.label === '--fast' && result.durationMs > 15_000)
      result.warnings.push('Fast checks exceeded the 15 second target.')
    try {
      await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n')
      await writeFile(join(artifacts, 'summary.md'), renderSummary(result))
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      signal?.removeEventListener('abort', abort)
      await unlock()
    }
  }
  console.log(
    `${result.status.toUpperCase()} [${plan.label}; ${plan.uiMode}]: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped; ${(result.durationMs / 1000).toFixed(1)}s\nReport: ${join(artifacts, 'summary.md')}`,
  )
  for (const warning of result.warnings) console.warn(warning)
  return result
}
