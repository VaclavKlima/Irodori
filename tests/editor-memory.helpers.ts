import type { ElectronApplication } from '@playwright/test'
import { open, readdir, realpath } from 'node:fs/promises'

type MemoryKind = 'totalBytes' | 'residentBytes' | 'sharedBytes' | 'activeBytes' | 'purgeableBytes'
type Regions = Record<string, Partial<Record<MemoryKind, number>>>
interface ProcessMemory {
  pid: number
  parentPid: number
  role: string
  roleSource: string
  startTimeTicks: string
  identityVerified: true
  pssBytes: number | null
  rssBytes: number | null
  previewWorkerAncestor: number | null
}
interface DrmClient {
  device: string
  clientId: string
  driver: string
  pids: number[]
  descriptors: number
  memory: Regions | null
}
const pciAddress = /^[a-f\d]{4}:[a-f\d]{2}:[a-f\d]{2}\.[a-f\d]$/i
const processLimit = 256
const fileLimit = 8192
const ownedRoots = new WeakMap<ElectronApplication, { pid: number; startTimeTicks: string }>()

async function boundedText(path: string, limit = 65536) {
  const handle = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw new Error('Memory telemetry text exceeded its bound.')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
function bytes(value: string, unit = '') {
  const multiplier = unit === 'KiB' || unit === 'kB' ? 1024n : unit === 'MiB' ? 1048576n : 1n
  const result = BigInt(value) * multiplier
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Memory counter is not exact.')
  return Number(result)
}
function processIdentity(text: string) {
  const end = text.lastIndexOf(')')
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  const pid = Number(text.slice(0, text.indexOf(' '))),
    parentPid = Number(fields[1])
  // /proc/PID/stat field 22 is starttime; field 3 begins after the final comm parenthesis.
  const startTimeTicks = fields[19]
  if (
    end < 0 ||
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(parentPid) ||
    !/^\d+$/.test(startTimeTicks ?? '')
  )
    throw new Error('Invalid owned process identity.')
  return { pid, parentPid, startTimeTicks }
}
function drmMemory(text: string) {
  const memory: Regions = {}
  let aliases = 0
  const kinds: Record<string, MemoryKind> = {
    total: 'totalBytes',
    resident: 'residentBytes',
    memory: 'residentBytes',
    shared: 'sharedBytes',
    active: 'activeBytes',
    purgeable: 'purgeableBytes',
  }
  // Parse the deprecated amdgpu memory alias first; the canonical resident field wins.
  const lines = text
    .split('\n')
    .sort((a, b) => Number(!a.startsWith('drm-memory-')) - Number(!b.startsWith('drm-memory-')))
  for (const line of lines) {
    const match =
      /^drm-(total|resident|memory|shared|active|purgeable)-([^:\s]+):\s*(\d+)\s*(KiB|MiB|B|bytes)?\s*$/.exec(
        line,
      )
    if (!match) {
      if (/^drm-(total|resident|memory|shared|active|purgeable)-/.test(line))
        throw new Error('Unsupported DRM memory counter/unit.')
      continue
    }
    const [, kind, region, value, unit] = match
    const values = (memory[region] ??= {})
    if (kind === 'resident' && values.residentBytes !== undefined) aliases++
    values[kinds[kind]] = bytes(value, unit)
  }
  return { memory, aliases }
}

/** Explicit isolated snapshots only. PSS, RSS and DRM counters are separate scopes. */
export async function sampleEditorMemory(app: ElectronApplication, phase: string) {
  const startedAt = new Date().toISOString(),
    started = performance.now()
  const errors: { pid?: number; operation: string; message: string }[] = []
  let omittedErrors = 0,
    treeComplete = true,
    fdinfoComplete = true
  const error = (operation: string, reason: unknown, pid?: number) => {
    if (['snapshot', 'owned descendant discovery', 'owned process discovery'].includes(operation))
      treeComplete = false
    if (operation.includes('fdinfo') || operation === 'DRM identity') fdinfoComplete = false
    if (errors.length < 128) errors.push({ pid, operation, message: String(reason).slice(0, 256) })
    else omittedErrors++
  }
  const processes: ProcessMemory[] = [],
    clients = new Map<string, DrmClient>()
  let rootPid: number | null = null,
    deprecatedMetricAliasesRemoved = 0
  try {
    const child = app.process()
    rootPid = child.pid ?? null
    if (process.platform !== 'linux' || !rootPid) throw new Error('Linux app PID is unavailable.')
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('The owned Electron process has exited.')
    const roles = new Map<number, string>()
    try {
      for (const item of await app.evaluate(({ app }) =>
        app.getAppMetrics().map(({ pid, type }) => ({ pid, type })),
      ))
        roles.set(item.pid, item.type)
    } catch (reason) {
      error('Electron process roles', reason)
    }
    if (!roles.has(rootPid)) throw new Error('Live Electron root ownership could not be confirmed.')
    const pending = [{ pid: rootPid, parentPid: 0, previewWorkerAncestor: null as number | null }]
    const visited = new Set<number>()
    while (pending.length && visited.size < processLimit) {
      const candidate = pending.shift()!
      if (visited.has(candidate.pid)) continue
      visited.add(candidate.pid)
      const { pid } = candidate,
        base = `/proc/${pid}`
      try {
        const identity = processIdentity(await boundedText(`${base}/stat`)),
          { parentPid } = identity
        if (identity.pid !== pid || (pid !== rootPid && parentPid !== candidate.parentPid))
          throw new Error('Owned process exited or changed ancestry during discovery.')
        const previousRoot: { pid: number; startTimeTicks: string } | undefined =
          pid === rootPid ? ownedRoots.get(app) : undefined
        if (
          previousRoot &&
          (previousRoot.pid !== pid || previousRoot.startTimeTicks !== identity.startTimeTicks)
        )
          throw new Error('The Electron root PID was reused; snapshot discarded.')
        const descendants: typeof pending = [],
          observations: { client: DrmClient; aliases: number }[] = []
        let role = pid === rootPid ? 'main' : (roles.get(pid) ?? 'app-descendant')
        let roleSource =
          pid === rootPid
            ? 'app.process().pid'
            : roles.has(pid)
              ? 'Electron app metrics'
              : 'owned descendant'
        let previewWorkerAncestor = candidate.previewWorkerAncestor
        try {
          const arguments_ = (await boundedText(`${base}/cmdline`, 16384)).split('\0')
          if (arguments_.some((value) => /(?:^|\/)preview-worker\.(?:js|cjs)$/.test(value))) {
            role = 'preview-worker'
            roleSource = 'owned process worker entry'
            previewWorkerAncestor = pid
          } else if (/(?:^|\/)irodori-cpu-render$/.test(arguments_[0] ?? '')) {
            role = 'native-cpu-render'
            roleSource = 'owned native CPU executable'
          } else if (!roles.has(pid) && pid !== rootPid) {
            const type = arguments_.find((value) =>
              /^--type=(?:renderer|gpu-process|zygote|utility)$/.test(value),
            )
            if (type) {
              role = type.slice(7)
              roleSource = 'owned Electron process kind'
            } else if (previewWorkerAncestor) role = 'preview-worker-descendant'
          }
        } catch (reason) {
          error('owned process classification', reason, pid)
        }
        const row: ProcessMemory = {
          pid,
          parentPid,
          role,
          roleSource,
          startTimeTicks: identity.startTimeTicks,
          identityVerified: true,
          previewWorkerAncestor,
          pssBytes: null,
          rssBytes: null,
        }
        try {
          const smaps = await boundedText(`${base}/smaps_rollup`)
          const pss = /^Pss:\s+(\d+)\s+kB$/m.exec(smaps),
            rss = /^Rss:\s+(\d+)\s+kB$/m.exec(smaps)
          if (pss) row.pssBytes = bytes(pss[1], 'kB')
          if (rss) row.rssBytes = bytes(rss[1], 'kB')
          if (!pss || !rss) throw new Error('smaps_rollup lacks PSS/RSS fields.')
        } catch (reason) {
          error('smaps_rollup', reason, pid)
        }
        try {
          const tasks = (await readdir(`${base}/task`)).filter((id) => /^\d+$/.test(id))
          if (tasks.length > fileLimit) throw new Error('Owned task count exceeded sampling bound.')
          for (const task of tasks)
            for (const child of (await boundedText(`${base}/task/${task}/children`))
              .trim()
              .split(/\s+/)) {
              const childPid = Number(child)
              if (Number.isSafeInteger(childPid) && childPid > 0)
                descendants.push({ pid: childPid, parentPid: pid, previewWorkerAncestor })
            }
        } catch (reason) {
          error('owned descendant discovery', reason, pid)
        }
        try {
          const descriptors = (await readdir(`${base}/fdinfo`)).filter((fd) => /^\d+$/.test(fd))
          if (descriptors.length > fileLimit)
            throw new Error('Owned fdinfo count exceeded sampling bound.')
          for (const fd of descriptors) {
            try {
              const text = await boundedText(`${base}/fdinfo/${fd}`)
              const driver = /^drm-driver:\s*(\S+)$/m.exec(text)?.[1]
              if (!driver) continue
              const clientId = /^drm-client-id:\s*(\d+)$/m.exec(text)?.[1]
              const device = /^drm-pdev:\s*(\S+)$/m.exec(text)?.[1]
              // Without the standardized identity, do not invent a deduplication key.
              if (!clientId || !device || !pciAddress.test(device)) {
                error(
                  'DRM identity',
                  'DRM descriptor has no verified PCI device/client identity.',
                  pid,
                )
                continue
              }
              const parsed = drmMemory(text)
              observations.push({
                aliases: parsed.aliases,
                client: {
                  device: device.toLowerCase(),
                  clientId: BigInt(clientId).toString(),
                  driver,
                  pids: [pid],
                  descriptors: 1,
                  memory: Object.keys(parsed.memory).length ? parsed.memory : null,
                },
              })
            } catch (reason) {
              error('owned fdinfo', reason, pid)
            }
          }
        } catch (reason) {
          error('owned fdinfo discovery', reason, pid)
        }
        const after = processIdentity(await boundedText(`${base}/stat`))
        if (
          after.pid !== pid ||
          after.startTimeTicks !== identity.startTimeTicks ||
          after.parentPid !== parentPid
        )
          throw new Error(
            'Owned process identity changed; staged memory and DRM observations discarded.',
          )
        processes.push(row)
        if (pid === rootPid) ownedRoots.set(app, { pid, startTimeTicks: identity.startTimeTicks })
        pending.push(...descendants)
        for (const { client, aliases } of observations) {
          const key = `${client.device}:${client.clientId}`,
            previous = clients.get(key)
          deprecatedMetricAliasesRemoved += aliases
          // Aliases refer to one kernel client. Keep the last whole observation, not a sum.
          clients.set(key, {
            ...client,
            pids: [...new Set([...(previous?.pids ?? []), pid])],
            descriptors: (previous?.descriptors ?? 0) + 1,
          })
        }
      } catch (reason) {
        error('owned process discovery', reason, pid)
      }
    }
    if (pending.length)
      error('owned descendant discovery', 'Process count exceeded sampling bound.')
  } catch (reason) {
    error('snapshot', reason)
  }
  const drmClients = [...clients.values()]
  const globalVram: {
    device: string
    totalBytes: number | null
    usedBytes: number | null
    source: string
    error?: string
  }[] = []
  const gpuDevices = new Set(drmClients.map((client) => client.device))
  if (process.platform === 'linux') {
    try {
      // Global hardware counters only: no other process, command line or application is inspected.
      for (const card of (await readdir('/sys/class/drm')).filter((name) =>
        /^card\d+$/.test(name),
      )) {
        const device = (await realpath(`/sys/class/drm/${card}/device`)).split('/').at(-1)!
        if (pciAddress.test(device)) gpuDevices.add(device.toLowerCase())
      }
    } catch (reason) {
      error('global GPU inventory', reason)
    }
  }
  for (const device of gpuDevices) {
    const sample = {
      device,
      totalBytes: null as number | null,
      usedBytes: null as number | null,
      source:
        'Linux PCI sysfs mem_info_vram_total/mem_info_vram_used; global unattributed device context',
    }
    try {
      const base = `/sys/bus/pci/devices/${device}`
      const total = (await boundedText(`${base}/mem_info_vram_total`)).trim(),
        used = (await boundedText(`${base}/mem_info_vram_used`)).trim()
      if (!/^\d+$/.test(total) || !/^\d+$/.test(used))
        throw new Error('Invalid global VRAM counter.')
      sample.totalBytes = bytes(total)
      sample.usedBytes = bytes(used)
      globalVram.push(sample)
    } catch (reason) {
      globalVram.push({ ...sample, error: String(reason).slice(0, 256) })
    }
  }
  const sum = (field: 'pssBytes' | 'rssBytes') => {
    const observed = processes.filter((row) => row[field] !== null)
    return {
      observedBytes: observed.length
        ? observed.reduce((total, row) => total + row[field]!, 0)
        : null,
      observedProcesses: observed.length,
      complete: treeComplete && processes.length > 0 && observed.length === processes.length,
    }
  }
  return {
    version: 'editor-owned-memory-snapshot-v1',
    phase,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    platform: process.platform,
    rootPid,
    treeComplete,
    processCount: processes.length,
    processes,
    pss: sum('pssBytes'),
    rss: sum('rssBytes'),
    drm: {
      clients: drmClients,
      uniqueClientCount: drmClients.length,
      discoveryComplete: fdinfoComplete && treeComplete,
      memoryComplete:
        fdinfoComplete &&
        treeComplete &&
        drmClients.length > 0 &&
        drmClients.every((client) => client.memory !== null),
      descriptorAliasesRemoved: drmClients.reduce(
        (total, client) => total + client.descriptors - 1,
        0,
      ),
      deprecatedMetricAliasesRemoved,
      unavailable:
        drmClients.length === 0
          ? 'No identified app-owned DRM clients were observable.'
          : drmClients.every((client) => client.memory === null)
            ? 'Identified DRM clients did not expose memory counters.'
            : null,
    },
    globalVram,
    globalVramUnavailable: globalVram.length
      ? null
      : 'No PCI DRM identity was available for global VRAM context.',
    errors,
    omittedErrors,
    scope:
      'Before/after app-owned descendant snapshots, not proven peaks or planned allocation bytes. Discovery is not atomic; exits or ownership changes remain unavailable. PSS apportions shared resident pages; RSS sums are separate and are not physical usage. DRM fields are deduplicated by PCI device/client-id and deprecated resident aliases, but different clients may share buffers. Do not add DRM fields, PSS or global VRAM into a physical total. Global VRAM includes other applications without identifying them.',
    references: [
      'https://docs.kernel.org/filesystems/proc.html',
      'https://docs.kernel.org/gpu/drm-usage-stats.html',
      'https://docs.kernel.org/gpu/amdgpu/driver-misc.html',
    ],
  }
}
