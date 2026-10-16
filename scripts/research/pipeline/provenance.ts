import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { cpus, totalmem, release, arch, platform } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export async function provenance(sources: string[]) {
  const result = await exec('git', ['rev-parse', 'HEAD'])
  const status = await exec('git', ['status', '--porcelain'])
  return {
    revision: result.stdout.trim(),
    dirty: Boolean(status.stdout.trim()),
    build: 'research TypeScript via Playwright; production modules unchanged',
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    packageLockSha256: sha(await readFile('package-lock.json')),
    runtimePackages: Object.fromEntries(
      await Promise.all(
        ['webgpu', 'sharp', '@colorhythm/libraw-wasm', 'electron'].map(async (name) => [
          name,
          JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version,
        ]),
      ),
    ),
    sources: Object.fromEntries(
      await Promise.all(sources.map(async (path) => [path, sha(await readFile(path))])),
    ),
    fileSystemCache: 'uncontrolled; no privileged cache purge',
    driverCache: 'uncontrolled',
    physicalScanout: 'not measured',
    physicalLuminance: 'not measured',
  }
}
export async function sampleProcesses(pids: number[]) {
  try {
    const { stdout } = await exec('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')])
    const processes = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [pid, rssKiB, cpuClock] = line.trim().split(/\s+/)
        return { pid: Number(pid), rssBytes: Number(rssKiB) * 1024, cpuClock }
      })
    let sampledThreads: number | null = null
    if (platform() === 'darwin') {
      const { stdout: threads } = await exec('ps', ['-M', '-p', pids.join(',')])
      sampledThreads = Math.max(0, threads.trim().split('\n').length - 1)
    } else if (platform() === 'linux') {
      const counts = await Promise.all(
        pids.map(async (pid) =>
          Number(
            (await readFile(`/proc/${pid}/status`, 'utf8')).match(/^Threads:\s+(\d+)/m)?.[1] ?? NaN,
          ),
        ),
      )
      if (counts.every(Number.isFinite)) sampledThreads = counts.reduce((sum, n) => sum + n, 0)
    }
    return {
      processes,
      aggregateRssBytes: processes.reduce((sum, p) => sum + p.rssBytes, 0),
      sampledThreads,
      limitation: 'point-in-time RSS and coarse OS CPU clock; not a peak or per-job CPU time',
    }
  } catch (error) {
    return { unavailable: (error as Error).message, aggregateRssBytes: null, sampledThreads: null }
  }
}
