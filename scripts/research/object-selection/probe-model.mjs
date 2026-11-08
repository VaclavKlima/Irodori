import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { platform, arch, cpus, endianness } from 'node:os'
import { performance } from 'node:perf_hooks'

const [runtimeArgument, manifestArgument, outputArgument] = process.argv.slice(2)
if (!runtimeArgument || !manifestArgument || !outputArgument)
  throw new Error(
    'Usage: node probe-model.mjs <isolated-runtime-root> <model-manifest.json> <output-directory>',
  )
const runtime = resolve(runtimeArgument),
  manifestPath = resolve(manifestArgument),
  output = resolve(outputArgument)
await mkdir(output, { recursive: true })
process.env.ORT_DISABLE_TELEMETRY = '1'
if (endianness() !== 'LE')
  throw new Error('Research tensor fixtures require little-endian hardware.')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const started = performance.now(),
  sessions = [],
  ownedTensors = new Set()
const report = {
  status: 'running',
  date: new Date().toISOString(),
  scope:
    'Actual model native GPU/operator and numeric parity probe; not photographic or Linux acceptance.',
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  model: manifest.model,
  sourceRevision: manifest.sourceRevision,
  checkpoint: manifest.checkpoint,
  requestedProvider: 'webgpu',
  cpuFallbackDisabled: true,
  memory: { beforeImport: process.memoryUsage() },
  embeddingRetention:
    'Encoder outputs retained as CPU tensors between decoder prompts; includes host-to-device copies, not zero-copy GPU retention.',
  numericComparison: {
    absoluteTolerance: 1e-3,
    relativeTolerance: 1e-3,
    scope: 'Diagnostic FP32/PyTorch comparison, not photographic acceptance.',
  },
  components: [],
}
const hash = (data) => createHash('sha256').update(data).digest('hex')
const raw = async (descriptor) => {
  const data = await readFile(descriptor.path)
  if (data.byteLength !== descriptor.bytes || hash(data) !== descriptor.sha256)
    throw new Error(`Tensor fixture mismatch: ${descriptor.name}`)
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  const typed = { float32: Float32Array, int64: BigInt64Array }[descriptor.dtype]
  if (!typed) throw new Error(`Unsupported research tensor type: ${descriptor.dtype}`)
  return new typed(bytes)
}
let ort
try {
  ort = createRequire(resolve(runtime, 'package.json'))('onnxruntime-node')
  report.runtime = { versions: ort.env.versions, backends: ort.listSupportedBackends() }
  if (!report.runtime.backends.some((backend) => backend.name === 'webgpu' && backend.bundled))
    throw new Error('No bundled native WebGPU provider; no CPU retry.')
  const retainedEncoder = {}
  for (const component of manifest.components) {
    const measured = {
      component: component.component,
      model: { path: component.path, sha256: component.sha256 },
      stage: 'loading',
      memoryBefore: process.memoryUsage(),
    }
    report.components.push(measured)
    if (hash(await readFile(component.path)) !== component.sha256)
      throw new Error('ONNX export hash mismatch.')
    const sessionStarted = performance.now()
    const session = await ort.InferenceSession.create(component.path, {
      executionProviders: [{ name: 'webgpu', validationMode: 'basic' }],
      enableProfiling: true,
      profileFilePrefix: resolve(output, `${component.component}-webgpu`),
      logSeverityLevel: 0,
      extra: { session: { disable_cpu_ep_fallback: '1', record_ep_graph_assignment_info: '1' } },
    })
    sessions.push(session)
    measured.sessionCreationMs = performance.now() - sessionStarted
    measured.inputs = session.inputMetadata
    measured.outputMetadata = session.outputMetadata
    const feeds = {}
    for (const descriptor of component.inputs) {
      if (component.component === 'decoder' && retainedEncoder[descriptor.name])
        feeds[descriptor.name] = retainedEncoder[descriptor.name]
      else {
        const tensor = new ort.Tensor(descriptor.dtype, await raw(descriptor), descriptor.shape)
        ownedTensors.add(tensor)
        feeds[descriptor.name] = tensor
      }
    }
    measured.stage = 'running'
    const runStarted = performance.now()
    const results = await session.run(feeds)
    measured.coldRunMs = performance.now() - runStarted
    Object.values(results).forEach((tensor) => ownedTensors.add(tensor))
    measured.outputs = []
    for (const descriptor of component.outputs) {
      const tensor = results[descriptor.name],
        reference = await raw(descriptor)
      if (
        !tensor ||
        tensor.type !== descriptor.dtype ||
        tensor.dims.join(',') !== descriptor.shape.join(',')
      )
        throw new Error(`Model output shape/type mismatch: ${descriptor.name}`)
      let maxAbsoluteError = 0,
        squaredError = 0,
        meanAbsoluteError = 0,
        outOfTolerance = 0,
        signMismatches = 0
      const actual = tensor.data
      if (actual.length !== reference.length) throw new Error('Model output length mismatch.')
      for (let index = 0; index < actual.length; index++) {
        if (!Number.isFinite(actual[index])) throw new Error('Model produced non-finite values.')
        if (!Number.isFinite(reference[index]))
          throw new Error('Original upstream reference contains non-finite values.')
        const error = Math.abs(actual[index] - reference[index])
        maxAbsoluteError = Math.max(maxAbsoluteError, error)
        meanAbsoluteError += error
        squaredError += error * error
        if (error > 1e-3 + 1e-3 * Math.abs(reference[index])) outOfTolerance++
        if (actual[index] > 0 !== reference[index] > 0) signMismatches++
      }
      const path = resolve(output, `${component.component}-${descriptor.name}.bin`)
      const encoded = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
      await writeFile(path, encoded)
      measured.outputs.push({
        name: descriptor.name,
        dtype: tensor.type,
        shape: tensor.dims,
        path,
        bytes: encoded.byteLength,
        sha256: hash(encoded),
        comparison: {
          maxAbsoluteError,
          meanAbsoluteError: meanAbsoluteError / actual.length,
          rmse: Math.sqrt(squaredError / actual.length),
          outOfTolerance,
          samples: actual.length,
          signAgreement: 1 - signMismatches / actual.length,
        },
      })
      if (outOfTolerance)
        throw new Error(
          `Model numeric parity failed for ${descriptor.name}: ${outOfTolerance} samples exceed the frozen 1e-3 absolute/relative diagnostic tolerance.`,
        )
      if (component.component === 'encoder') retainedEncoder[descriptor.name] = tensor
    }
    measured.warmRunsMs = []
    if (component.component === 'decoder')
      for (let iteration = 0; iteration < 5; iteration++) {
        const warmStarted = performance.now(),
          warm = await session.run(feeds)
        measured.warmRunsMs.push(performance.now() - warmStarted)
        Object.values(warm).forEach((tensor) => tensor.dispose())
      }
    measured.stage = 'completed'
    measured.memoryAfter = process.memoryUsage()
    if (component.component === 'encoder')
      process.send?.({ phase: 'session-ready', component: 'encoder-completed', pid: process.pid })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  for (const tensor of ownedTensors) tensor.dispose()
  for (const session of sessions.reverse()) {
    session.endProfiling()
    await session.release().catch(() => {})
  }
  report.profiles = []
  for (const name of (await readdir(output)).filter(
    (name) => name.endsWith('.json') && name.includes('-webgpu_'),
  )) {
    const events = JSON.parse(await readFile(resolve(output, name), 'utf8'))
    const nodes = events.filter((event) => event.cat === 'Node' && event.args?.provider)
    report.profiles.push({
      path: name,
      providers: [...new Set(nodes.map((node) => node.args.provider))],
      operators: [...new Set(nodes.map((node) => node.args.op_name))],
      nodeEvents: nodes.length,
    })
  }
  if (
    report.status === 'passed' &&
    (report.profiles.length !== manifest.components.length ||
      report.profiles.some(
        (profile) => profile.providers.length !== 1 || !/webgpu/i.test(profile.providers[0]),
      ))
  ) {
    report.status = 'failed'
    report.error = 'Native profiling did not establish WebGPU-only execution for each component.'
    process.exitCode = 1
  }
  report.memory.afterRelease = process.memoryUsage()
  report.memory.peakRssBytes = process.resourceUsage().maxRSS * 1024
  report.gpuMemory = 'Not exposed by this public Node binding; no GPU peak claim.'
  report.durationMs = performance.now() - started
  await writeFile(resolve(output, 'model-result.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(
    resolve(output, 'summary.md'),
    `# Native segmentation model probe: ${report.status.toUpperCase()}\n\nModel: ${manifest.model}; native WebGPU only, CPU fallback disabled.\n\n${report.error ?? report.components.map((component) => `${component.component}: load ${component.sessionCreationMs.toFixed(2)} ms, first run ${component.coldRunMs.toFixed(2)} ms, warm runs ${component.warmRunsMs.map((time) => time.toFixed(2)).join(', ') || 'not repeated'}.`).join('\n\n')}\n\nPeak process RSS ${report.memory.peakRssBytes} bytes. GPU peak unavailable. Total ${report.durationMs.toFixed(2)} ms.\n\nEmbedding cache retains CPU tensors and reuploads to decoder. Numeric error metrics and native node assignments are in model-result.json. Successful GPU execution does not establish photographic mask quality or cross-platform acceptance.\n`,
  )
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      model: manifest.model,
      summary: resolve(output, 'summary.md'),
      error: report.error?.split('\n')[0],
    }) + '\n',
  )
}
