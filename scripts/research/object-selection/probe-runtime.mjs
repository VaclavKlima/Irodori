import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { platform, arch, cpus } from 'node:os'
import { performance } from 'node:perf_hooks'

// Run only with an isolated installed runtime and synthetic model. This is not a
// production provider selector, model loader or automatic CPU fallback path.
const [runtimeRoot, modelPath, outputDirectory] = process.argv.slice(2).map((path) => resolve(path))
if (!runtimeRoot || !modelPath || !outputDirectory)
  throw new Error(
    'Usage: node probe-runtime.mjs <isolated-runtime-root> <model.onnx> <output-directory>',
  )
await mkdir(outputDirectory, { recursive: true })
process.env.ORT_DISABLE_TELEMETRY = '1'
const started = performance.now()
const report = {
  scope: 'Synthetic native WebGPU feasibility; not segmentation quality or Linux acceptance.',
  status: 'running',
  date: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  requestedProvider: 'webgpu',
  cpuFallbackDisabled: true,
  memory: { beforeImport: process.memoryUsage() },
  runtime: undefined,
  model: {
    path: modelPath,
    sha256: createHash('sha256')
      .update(await readFile(modelPath))
      .digest('hex'),
  },
  stagesMs: {},
}
let session
try {
  const require = createRequire(resolve(runtimeRoot, 'package.json'))
  const ort = require('onnxruntime-node')
  report.runtime = { versions: ort.env.versions, backends: ort.listSupportedBackends() }
  report.stagesMs.import = performance.now() - started
  if (!report.runtime.backends.some((backend) => backend.name === 'webgpu' && backend.bundled))
    throw new Error(
      'The pinned native package has no bundled WebGPU provider. No CPU retry attempted.',
    )
  const specification = JSON.parse(await readFile(modelPath.replace(/\.onnx$/, '.json'), 'utf8'))
  if (specification.sha256 !== report.model.sha256)
    throw new Error('Synthetic model hash mismatch.')
  const sessionStarted = performance.now()
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: [{ name: 'webgpu', validationMode: 'basic' }],
    enableProfiling: true,
    profileFilePrefix: resolve(outputDirectory, 'native-webgpu'),
    logSeverityLevel: 0,
    logVerbosityLevel: 1,
    extra: { session: { disable_cpu_ep_fallback: '1', record_ep_graph_assignment_info: '1' } },
  })
  report.stagesMs.sessionCreation = performance.now() - sessionStarted
  report.memory.afterSession = process.memoryUsage()
  const input = new ort.Tensor(
    'float32',
    Float32Array.from(specification.input.data),
    specification.input.shape,
  )
  const execute = async () => {
    const begin = performance.now()
    const output = await session.run({ [specification.input.name]: input })
    const values = output[specification.expected.name]
    const maxAbsoluteError = Math.max(
      ...values.data.map((number, index) => Math.abs(number - specification.expected.data[index])),
    )
    if (values.dims.join(',') !== specification.expected.shape.join(',') || maxAbsoluteError > 1e-5)
      throw new Error(`Unexpected synthetic output (max absolute error ${maxAbsoluteError}).`)
    const elapsedMs = performance.now() - begin
    Object.values(output).forEach((tensor) => tensor.dispose())
    return { elapsedMs, maxAbsoluteError }
  }
  process.send?.({ phase: 'session-ready', pid: process.pid })
  report.cold = await execute()
  report.warm = []
  for (let iteration = 0; iteration < 10; iteration++) report.warm.push(await execute())
  input.dispose()
  report.memory.afterRuns = process.memoryUsage()
  session.endProfiling()
  await session.release()
  session = undefined
  report.memory.afterRelease = process.memoryUsage()
  const profiles = (await readdir(outputDirectory)).filter(
    (name) => name.startsWith('native-webgpu') && name.endsWith('.json'),
  )
  report.profiles = []
  for (const name of profiles) {
    const events = JSON.parse(await readFile(resolve(outputDirectory, name), 'utf8'))
    const nodes = events.filter((event) => event.cat === 'Node' && event.args?.provider)
    report.profiles.push({
      path: name,
      providers: [...new Set(nodes.map((event) => event.args.provider))],
      nodes: nodes.map((event) => ({
        name: event.name,
        provider: event.args.provider,
        op: event.args.op_name,
      })),
    })
  }
  if (
    !report.profiles.some((profile) =>
      profile.providers.some((provider) => /webgpu/i.test(provider)),
    )
  )
    throw new Error('The native profiler did not identify WebGPU execution.')
  if (
    report.profiles.some((profile) => profile.providers.some((provider) => /cpu/i.test(provider)))
  )
    throw new Error('The profiler includes CPU inference; the strict WebGPU gate failed.')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  await session?.release().catch(() => {})
  report.durationMs = performance.now() - started
  report.memory.peakRssBytes = process.resourceUsage().maxRSS * 1024
  report.gpuMemory = 'Unavailable from this public Node binding; no GPU peak claim.'
  await writeFile(
    resolve(outputDirectory, 'runtime-result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await writeFile(
    resolve(outputDirectory, 'summary.md'),
    `# Native WebGPU runtime probe: ${report.status.toUpperCase()}\n\nProvider: webgpu only; CPU fallback disabled.\n\nRuntime: ${JSON.stringify(report.runtime?.versions ?? null)}. Host: ${report.host.platform}/${report.host.arch}, ${report.host.cpu}.\n\nModel: ${basename(modelPath)}; SHA-256 ${report.model.sha256}.\n\n${report.error ?? `Known MatMul/Add output passed eleven runs. Cold ${report.cold.elapsedMs.toFixed(3)} ms; warm runs ${report.warm.map((run) => run.elapsedMs.toFixed(3)).join(', ')} ms. Peak process RSS ${report.memory.peakRssBytes} bytes.`}\n\nTotal ${report.durationMs.toFixed(2)} ms. GPU peak memory unavailable. Process cleanup is verified by the caller; this process releases its session before exit.\n\nThis is a synthetic runtime gate, not segmentation or cross-platform acceptance. Full evidence: runtime-result.json and native profiler files.\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ status: report.status, summary: resolve(outputDirectory, 'summary.md'), error: report.error?.split('\n')[0] })}\n`,
  )
}
