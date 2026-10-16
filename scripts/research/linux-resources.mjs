import { spawn, execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Research-only accounting of a freshly spawned command. Never controls the application.
export function parseProcStat(text, pageSize) {
  const close = text.lastIndexOf(')')
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const values = [pid, ...[1, 2, 3, 11, 12, 17, 19, 21].map((index) => Number(fields[index]))]
  if (close < 0 || fields.length < 22 || !values.every(Number.isSafeInteger))
    throw new Error('Invalid /proc stat record.')
  const [
    ,
    parentPid,
    processGroup,
    sessionId,
    userTicks,
    systemTicks,
    threads,
    startTicks,
    rssPages,
  ] = values
  return {
    pid,
    parentPid,
    processGroup,
    sessionId,
    identity: `${pid}:${startTicks}`,
    state: fields[0],
    cpuTicks: userTicks + systemTicks,
    threads,
    rssBytes: Math.max(0, rssPages) * pageSize,
  }
}

const ioFields = ['rchar', 'wchar', 'read_bytes', 'write_bytes', 'cancelled_write_bytes']
export function parseProcIo(text) {
  const values = Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const [key, value] = line.split(':')
        return [key, Number(value.trim())]
      }),
  )
  if (!ioFields.every((field) => Number.isSafeInteger(values[field]) && values[field] >= 0))
    throw new Error('Invalid /proc io record.')
  return Object.fromEntries(ioFields.map((field) => [field, values[field]]))
}

export function ownedProcesses(records, rootIdentity, known = new Set()) {
  const selected = new Map()
  for (const record of records)
    if (record.identity === rootIdentity || known.has(record.identity))
      selected.set(record.pid, record)
  let changed = true
  while (changed) {
    changed = false
    for (const record of records)
      if (!selected.has(record.pid) && selected.has(record.parentPid)) {
        selected.set(record.pid, record)
        changed = true
      }
  }
  return [...selected.values()]
}

export class ResourceAccounting {
  processes = new Map()
  ioThreads = new Map()
  ioThreadReadFailures = 0
  samples = 0
  peakRssBytes = 0
  peakThreads = 0
  peakProcesses = 0
  samplerWallMs = 0
  maxSamplerWallMs = 0
  maxSampleGapMs = 0
  lastAt = null
  series = []
  seriesOmitted = 0
  constructor(clockTicks, maxSeries = 3600) {
    this.clockTicks = clockTicks
    this.maxSeries = maxSeries
  }
  observe(records, atMs, samplerWallMs = 0) {
    this.samples++
    this.samplerWallMs += samplerWallMs
    this.maxSamplerWallMs = Math.max(this.maxSamplerWallMs, samplerWallMs)
    if (this.lastAt !== null)
      this.maxSampleGapMs = Math.max(this.maxSampleGapMs, atMs - this.lastAt)
    this.lastAt = atMs
    const live = records.filter((record) => !['Z', 'X'].includes(record.state))
    const rssBytes = live.reduce((sum, record) => sum + record.rssBytes, 0)
    const threads = live.reduce((sum, record) => sum + record.threads, 0)
    this.peakRssBytes = Math.max(this.peakRssBytes, rssBytes)
    this.peakThreads = Math.max(this.peakThreads, threads)
    this.peakProcesses = Math.max(this.peakProcesses, live.length)
    for (const record of records) {
      const previous = this.processes.get(record.identity)
      this.processes.set(record.identity, {
        pid: record.pid,
        cpuTicks: Math.max(record.cpuTicks, previous?.cpuTicks ?? 0),
        ioObserved: Boolean(record.ioThreads?.length || previous?.ioObserved),
      })
      this.ioThreadReadFailures += record.ioThreadReadFailures ?? 0
      for (const { identity, io } of record.ioThreads ?? []) {
        const previousIo = this.ioThreads.get(identity)
        this.ioThreads.set(
          identity,
          Object.fromEntries(
            ioFields.map((field) => [field, Math.max(io[field], previousIo?.[field] ?? 0)]),
          ),
        )
      }
    }
    // Keep one-second context bounded independently of the sample interval.
    if (!this.series.length || atMs - this.series.at(-1).atMs >= 1000) {
      if (this.series.length < this.maxSeries)
        this.series.push({ atMs, rssBytes, threads, processes: live.length })
      else this.seriesOmitted++
    }
  }
  report() {
    const processes = [...this.processes.values()]
    const ioThreads = [...this.ioThreads.values()]
    return {
      samples: this.samples,
      observedProcesses: processes.length,
      sampledPeakAggregateRssBytes: this.peakRssBytes,
      sampledPeakAggregateThreads: this.peakThreads,
      sampledPeakAggregateProcesses: this.peakProcesses,
      observedOwnCpuMs:
        (processes.reduce((sum, record) => sum + record.cpuTicks, 0) * 1000) / this.clockTicks,
      observedIoBytes: ioThreads.length
        ? Object.fromEntries(
            ioFields.map((field) => [field, ioThreads.reduce((sum, io) => sum + io[field], 0)]),
          )
        : null,
      observedIoThreads: ioThreads.length,
      processesWithoutIo: processes.filter((record) => !record.ioObserved).length,
      ioThreadReadFailures: this.ioThreadReadFailures,
      samplerWallMs: this.samplerWallMs,
      maxSamplerWallMs: this.maxSamplerWallMs,
      maxSampleGapMs: this.maxSampleGapMs,
      contextSeries: this.series,
      contextSeriesOmitted: this.seriesOmitted,
    }
  }
}

function snapshot(rootIdentity, known, pageSize) {
  // These tiny virtual files are read in the separate sampler process. Hundreds of
  // asynchronous reads per sample would add thread-pool scheduling and allocation.
  const records = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      records.push(parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'), pageSize))
    } catch {
      // A process can exit between directory enumeration and reading its record.
    }
  }
  const selected = ownedProcesses(records, rootIdentity, known)
  for (const record of selected) {
    known.add(record.identity)
    record.ioThreads = []
    record.ioThreadReadFailures = 0
    try {
      // /proc/pid/io includes reaped children. The task path uses own-thread
      // counters instead (Linux fs/proc/base.c do_io_accounting, whole=false).
      for (const tid of readdirSync(`/proc/${record.pid}/task`)) {
        const base = `/proc/${record.pid}/task/${tid}`
        try {
          const thread = parseProcStat(readFileSync(`${base}/stat`, 'utf8'), pageSize)
          const io = parseProcIo(readFileSync(`${base}/io`, 'utf8'))
          const latest = parseProcStat(readFileSync(`${base}/stat`, 'utf8'), pageSize)
          if (latest.identity === thread.identity)
            record.ioThreads.push({ identity: thread.identity, io })
          else record.ioThreadReadFailures++
        } catch {
          record.ioThreadReadFailures++
        }
      }
      const latest = parseProcStat(readFileSync(`/proc/${record.pid}/stat`, 'utf8'), pageSize)
      // Never attach a reused PID's thread counters to its previous lifetime.
      if (latest.identity === record.identity) Object.assign(record, latest)
      else record.ioThreads = []
    } catch {
      record.ioThreadReadFailures++
      record.ioThreads = []
    }
  }
  return selected
}

export async function measureCommand(command, args, output, intervalMs = 100) {
  if (process.platform !== 'linux') throw new Error('This research sampler requires Linux /proc.')
  if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 10000)
    throw new Error('Sampling interval must be an integer from 10 to 10000 ms.')
  const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
  const pageSize = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim())
  if (![clockTicks, pageSize].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid kernel accounting units.')
  const startedAt = new Date().toISOString(),
    at = performance.now(),
    cpuAt = process.cpuUsage()
  // A private process group lets interruption reach descendants even between samples.
  const child = spawn(command, args, { stdio: 'inherit', detached: true })
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  let rootIdentity
  try {
    rootIdentity = parseProcStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'), pageSize).identity
  } catch {
    rootIdentity = `${child.pid}:unobserved`
  }
  const known = new Set(),
    accounting = new ResourceAccounting(clockTicks)
  let done = false
  void exit.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  let interruptedSignal = null
  const forward = (signal) => {
    interruptedSignal ??= signal
    // The leader is still our unreaped child or an observed member retains its
    // identity. Do not signal a process group based solely on a recycled PID.
    const alive = snapshot(rootIdentity, known, pageSize)
    if (!alive.length) return
    if (
      alive.some((record) => record.processGroup === child.pid && record.sessionId === child.pid)
    ) {
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (const record of alive) {
      if (record.processGroup === child.pid && record.sessionId === child.pid) continue
      try {
        // Detached descendants need individual delivery. Recheck identity directly
        // before signalling rather than trusting a PID from an earlier sample.
        if (
          parseProcStat(readFileSync(`/proc/${record.pid}/stat`, 'utf8'), pageSize).identity ===
          record.identity
        )
          process.kill(record.pid, signal)
      } catch (error) {
        if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error
      }
    }
  }
  const interrupt = () => forward('SIGINT'),
    terminate = () => forward('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let outcome
  let killTimer
  try {
    do {
      const sampleAt = performance.now()
      const records = snapshot(rootIdentity, known, pageSize)
      accounting.observe(records, performance.now() - at, performance.now() - sampleAt)
      if (interruptedSignal && !killTimer) killTimer = setTimeout(() => forward('SIGKILL'), 5000)
      if (!done)
        await Promise.race([
          exit,
          new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs)),
        ])
    } while (!done)
    outcome = await exit
  } finally {
    clearTimeout(killTimer)
    // A group leader may exit before a descendant handles the forwarded signal.
    if (interruptedSignal) forward('SIGKILL')
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    const report = {
      version: 1,
      command: [command, ...args],
      cwd: process.cwd(),
      startedAt,
      wallMs: performance.now() - at,
      outcome: outcome ?? 'command launch failed',
      intervalMs,
      clockTicksPerSecond: clockTicks,
      pageSize,
      rootIdentity,
      interruptedSignal,
      ...accounting.report(),
      samplerOwnCpuUs: process.cpuUsage(cpuAt),
      limitations: [
        'CPU sums maximum observed own-process utime+stime; child CPU fields are excluded. IO sums maximum own-thread counters from /proc/pid/task/tid/io for each TID/start-tick identity; /proc/pid/io is excluded because it also includes waited-for children. Short-lived unobserved processes/threads and work after final samples are omitted: totals are lower bounds.',
        'Descendants are discovered by parent relationships; previously observed reparented processes retain identity. PID reuse is separated by kernel start ticks. Processes escaping before first observation may be missed.',
        'Interruption signals the private command process group and identity-checked observed detached descendants. Linux Node has no pidfd signal API: identity checks reduce but cannot atomically eliminate a PID-reuse race.',
        'RSS and thread peaks are sampled, not exact peaks. Summed RSS counts shared pages in every process; this is not unique physical memory or VRAM.',
        'rchar/wchar include logical file and pipe IO, not disk traffic alone. read_bytes/write_bytes are kernel storage accounting, affected by filesystem caches; cancelled_write_bytes is reported separately.',
        'Missing task IO records make IO partial. Counters include command startup and observed descendants; they are whole-invocation totals, not per-job measurements. Thread enumeration and counter reads are not atomic.',
        'Sampling perturbs the workload. samplerWallMs includes proc reads; samplerOwnCpuUs includes wrapper execution. Requested interval plus collection work determines actual gaps.',
        'Unrelated desktop workloads, device-wide VRAM, physical scanout and luminance are not measured.',
      ],
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  }
  return outcome
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    separator = args.indexOf('--'),
    options = args.slice(0, separator)
  if (separator < 0 || !options.includes('--output') || !args[separator + 1])
    throw new Error(
      'Usage: node scripts/research/linux-resources.mjs --output artifact.json [--interval-ms 100] -- command args',
    )
  const output = resolve(options[options.indexOf('--output') + 1])
  const intervalAt = options.indexOf('--interval-ms')
  const outcome = await measureCommand(
    args[separator + 1],
    args.slice(separator + 2),
    output,
    intervalAt < 0 ? 100 : Number(options[intervalAt + 1]),
  )
  process.exitCode =
    outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : outcome.signal === 'SIGTERM' ? 143 : 1)
}
