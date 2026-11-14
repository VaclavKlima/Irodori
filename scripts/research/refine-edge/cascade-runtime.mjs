// Isolated native ORT research gate. No application/library access or CPU inference retry.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  if (at < 0 || !args[at + 1]) throw new Error(`Provide ${name}.`)
  return resolve(args[at + 1])
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')

async function drmClients() {
  if (process.platform !== 'linux') return []
  const descriptors = await readdir('/proc/self/fdinfo')
  if (descriptors.length > 2048) throw new Error('DRM descriptor bound exceeded.')
  const clients = new Map()
  for (const descriptor of descriptors) {
    let handle
    try {
      handle = await open(`/proc/self/fdinfo/${descriptor}`, 'r')
      const data = Buffer.alloc(65537)
      const { bytesRead } = await handle.read(data, 0, data.length, 0)
      if (bytesRead > 65536) throw new Error('DRM text bound exceeded.')
      const text = data.subarray(0, bytesRead).toString('utf8')
      if (!/^drm-driver:/m.test(text)) continue
      const device = /^drm-pdev:\s*([\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[\da-f])$/im.exec(text)?.[1]
      const id = /^drm-client-id:\s*(\d+)$/m.exec(text)?.[1]
      if (!device || !id) throw new Error('ORT DRM client lacks a physical identity.')
      clients.set(`${device}:${id}`, {
        device: device.toLowerCase(),
        id,
        engines: Object.fromEntries(
          [...text.matchAll(/^drm-engine-([^:\s]+):\s*(\d+)\s+ns\s*$/gm)].map(
            ([, engine, value]) => [engine, value],
          ),
        ),
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    } finally {
      await handle?.close()
    }
  }
  return [...clients.values()]
}

async function runWorker() {
  const manifestPath = option('--manifest'),
    poolingPath = option('--pooling-manifest'),
    output = option('--output')
  const { observeResourceHardware } = await import('../../../src/main/resource-settings.ts')
  const { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } =
    await import('../../../src/shared/resource-policy.ts')
  const require = createRequire(resolve('package.json'))
  const ort = require('onnxruntime-node')
  const report = {
    version: 1,
    status: 'running',
    date: new Date().toISOString(),
    scope:
      'Synthetic native WebGPU/parity/resource gate only; no photographic or production acceptance.',
    cpuFallbackDisabled: true,
    diagnosticVerbose: args.includes('--verbose'),
    driPrime: process.env.DRI_PRIME ?? null,
    host: { platform: process.platform, node: process.version, pid: process.pid },
    runtime: { versions: ort.env.versions, backends: ort.listSupportedBackends() },
    components: [],
    activeDevices: [],
  }
  const started = performance.now()
  try {
    if (!report.runtime.backends.some((entry) => entry.name === 'webgpu' && entry.bundled))
      throw new Error('Bundled native WebGPU unavailable; no CPU retry.')
    for (const file of [...new Set([poolingPath, manifestPath])]) {
      const bytes = await readFile(file),
        manifest = JSON.parse(bytes)
      for (const component of manifest.components) {
        const measured = {
          component: component.component,
          manifest: file,
          manifestSha256: hash(bytes),
          stage: 'admission',
        }
        report.components.push(measured)
        const hardware = await observeResourceHardware()
        const actual =
          report.activeDevices.length === 1
            ? hardware.gpus.find((entry) => entry.adapterId === report.activeDevices[0])
            : null
        const observation = {
          ram: hardware.ram,
          gpu: actual?.totalBytes
            ? {
                status: 'matched',
                adapterId: actual.adapterId,
                totalBytes: actual.totalBytes,
                availableBytes:
                  actual.usedBytes === null ? null : actual.totalBytes - actual.usedBytes,
              }
            : { status: 'unknown', reason: 'adapter-unverified' },
        }
        const policy = resolveResourcePolicy(DEFAULT_RESOURCE_SETTINGS, observation, 0)
        const [, , height, width] = component.inputs[0].shape
        const estimate =
          component.component === 'pooling'
            ? 64 * 1024 ** 2
            : height * width * 64 * 4 * 12 + component.bytes
        measured.admission = {
          settings: DEFAULT_RESOURCE_SETTINGS,
          hardware,
          policy,
          estimatedBytes: { ram: 2 * estimate, vram: estimate },
          scope: 'Conservative managed estimate; opaque GPU residency peak is unavailable.',
        }
        if (estimate > policy.vram.effectiveBytes || 2 * estimate > policy.ram.effectiveBytes)
          throw new Error('Automatic resource policy refused the component; no override.')
        const graph = await readFile(component.path)
        if (graph.length !== component.bytes || hash(graph) !== component.sha256)
          throw new Error('Graph bytes changed.')
        const prefix = join(output, `${component.component}-webgpu`)
        const tensors = [],
          feeds = {}
        let session
        try {
          measured.stage = 'session-create'
          const began = performance.now()
          session = await ort.InferenceSession.create(component.path, {
            executionProviders: [{ name: 'webgpu', validationMode: 'basic' }],
            graphOptimizationLevel: 'all',
            freeDimensionOverrides: component.freeDimensionOverrides ?? {},
            enableProfiling: true,
            profileFilePrefix: prefix,
            logSeverityLevel: args.includes('--verbose') ? 0 : 3,
            extra: {
              session: { disable_cpu_ep_fallback: '1', record_ep_graph_assignment_info: '1' },
            },
          })
          measured.sessionCreationMs = performance.now() - began
          for (const descriptor of component.inputs) {
            const bytes = await readFile(descriptor.path)
            if (
              descriptor.dtype !== 'float32' ||
              bytes.length !== descriptor.bytes ||
              hash(bytes) !== descriptor.sha256
            )
              throw new Error('Input tensor changed.')
            const tensor = new ort.Tensor(
              'float32',
              new Float32Array(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
              ),
              descriptor.shape,
            )
            tensors.push(tensor)
            feeds[descriptor.name] = tensor
          }
          measured.stage = 'inference'
          measured.before = await drmClients()
          const inferenceStarted = performance.now(),
            results = await session.run(feeds)
          measured.inferenceMs = performance.now() - inferenceStarted
          tensors.push(...Object.values(results))
          measured.after = await drmClients()
          const active = measured.after
            .filter((after) => {
              const before = measured.before.find(
                (entry) => entry.device === after.device && entry.id === after.id,
              )
              return Object.entries(after.engines).some(
                ([engine, value]) => BigInt(value) > BigInt(before?.engines[engine] ?? '0'),
              )
            })
            .map((entry) => entry.device)
          measured.activeDevices = [...new Set(active)]
          report.activeDevices = [...new Set([...report.activeDevices, ...measured.activeDevices])]
          if (process.platform === 'linux' && measured.activeDevices.length !== 1)
            throw new Error('ORT inference did not establish one actual physical GPU.')
          measured.outputs = []
          for (const descriptor of component.outputs) {
            const bytes = await readFile(descriptor.path)
            if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
              throw new Error('Original reference changed.')
            const reference = new Float32Array(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
              ),
              tensor = results[descriptor.name]
            if (
              !tensor ||
              tensor.type !== 'float32' ||
              tensor.dims.join() !== descriptor.shape.join()
            )
              throw new Error('Output dimensions/type changed.')
            const actual = tensor.data
            let maxAbsoluteError = 0,
              outOfTolerance = 0,
              maxR8Difference = 0
            for (let index = 0; index < actual.length; index++) {
              if (!Number.isFinite(actual[index]) || !Number.isFinite(reference[index]))
                throw new Error('Nonfinite model/reference value.')
              const error = Math.abs(actual[index] - reference[index])
              maxAbsoluteError = Math.max(maxAbsoluteError, error)
              if (error > 0.001 + 0.001 * Math.abs(reference[index])) outOfTolerance++
              // NumPy's upstream Float32 probability multiply precedes uint8 truncation.
              const pack = (value) => Math.trunc(Math.fround(Math.max(0, Math.min(1, value)) * 255))
              maxR8Difference = Math.max(
                maxR8Difference,
                Math.abs(pack(actual[index]) - pack(reference[index])),
              )
            }
            const path = join(output, `${component.component}-${descriptor.name}.f32`)
            const data = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
            await writeFile(path, data, { flag: 'wx' })
            measured.outputs.push({
              name: descriptor.name,
              shape: tensor.dims,
              samples: actual.length,
              maxAbsoluteError,
              outOfTolerance,
              maxR8Difference,
              path,
              sha256: hash(data),
            })
            if (outOfTolerance || maxR8Difference > 1)
              throw new Error(`Frozen numerical gate failed: ${descriptor.name}.`)
          }
          measured.stage = 'passed'
        } finally {
          for (const tensor of tensors) tensor.dispose()
          if (session) {
            session.endProfiling()
            await session.release()
          }
        }
        const profileFiles = (await readdir(output)).filter(
          (name) => name.startsWith(`${component.component}-webgpu`) && name.endsWith('.json'),
        )
        if (profileFiles.length !== 1)
          throw new Error('Expected exactly one native profile per component.')
        const profile = join(output, profileFiles[0])
        if ((await stat(profile)).size > 32 * 1024 ** 2)
          throw new Error('Profile exceeded read bound.')
        const nodes = JSON.parse(await readFile(profile, 'utf8')).filter(
          (entry) => entry.cat === 'Node' && entry.args?.provider,
        )
        measured.profile = {
          path: profile,
          nodes: nodes.length,
          providers: [...new Set(nodes.map((entry) => entry.args.provider))],
        }
        if (!nodes.length || measured.profile.providers.join() !== 'WebGpuExecutionProvider')
          throw new Error('Profile did not prove exclusive WebGPU assignment.')
      }
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = (error.stack ?? String(error)).slice(0, 10000)
    process.exitCode = 1
  } finally {
    report.durationMs = performance.now() - started
    report.peakProcessRssBytes = process.resourceUsage().maxRSS * 1024
    await json(join(output, 'model-result.json'), report)
    await writeFile(
      join(output, 'summary.md'),
      `# Cascade native GPU gate: ${report.status.toUpperCase()}\n\n${report.error?.split('\n')[0] ?? 'All component reference comparisons and native provider/device gates passed.'}\n\nComponents: ${report.components.map((entry) => `${entry.component}: ${entry.stage}`).join('; ')}. Actual PCI: ${report.activeDevices.join(', ') || 'unproven'}. Duration ${(report.durationMs / 1000).toFixed(2)} s.\n\nNo CPU inference fallback, photographs, production adoption or opaque GPU peak claim. Full evidence: model-result.json.\n`,
    )
  }
}

async function main() {
  if (args.includes('--worker')) return runWorker()
  const output = option('--output')
  await mkdir(output, { recursive: false })
  const { build } = await import('esbuild')
  const worker = join(output, 'worker.mjs')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  const require = createRequire(import.meta.url),
    platform = process.platform === 'win32' ? 'win' : process.platform
  const executable = join(
    dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  const log = await open(join(output, 'process.log'), 'wx'),
    env = { ...process.env, ORT_DISABLE_TELEMETRY: '1' }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [worker, ...args, '--worker'], {
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', log.fd, log.fd],
  })
  const stop = () => {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, 240000)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const outcome = await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => accept({ code, signal }))
  }).finally(async () => {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await log.close()
  })
  await json(join(output, 'worker-evidence.json'), {
    ...outcome,
    timedOut,
    executable,
    pid: child.pid,
    scope: 'Owned bounded research child; no retry.',
  })
  if (timedOut || outcome.code !== 0) process.exitCode = 1
  console.log(JSON.stringify({ ...outcome, timedOut, output }))
}
await main()
