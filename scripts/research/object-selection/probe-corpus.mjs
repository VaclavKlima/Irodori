import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { platform, arch, cpus, endianness } from 'node:os'
import { performance } from 'node:perf_hooks'

const [
  runtimeArgument,
  modelArgument,
  outputArgument,
  casesArgument,
  protocolArgument,
  idsArgument,
  split = 'development',
] = process.argv.slice(2)
if (
  !runtimeArgument ||
  !modelArgument ||
  !outputArgument ||
  !casesArgument ||
  !protocolArgument ||
  !idsArgument ||
  !['development', 'holdout'].includes(split)
)
  throw new Error(
    'Usage: probe-corpus.mjs <runtime-root> <model-manifest> <output> <cases.json> <protocol.json> <explicit-comma-separated-case-ids> [development|holdout]',
  )
if (endianness() !== 'LE') throw new Error('Research fixtures require little-endian hardware.')
process.env.ORT_DISABLE_TELEMETRY = '1'
const runtime = resolve(runtimeArgument),
  modelPath = resolve(modelArgument),
  output = resolve(outputArgument),
  casesPath = resolve(casesArgument),
  protocolPath = resolve(protocolArgument)
const hash = (data) => createHash('sha256').update(data).digest('hex')
const modelBytes = await readFile(modelPath),
  caseBytes = await readFile(casesPath),
  protocolBytes = await readFile(protocolPath)
const model = JSON.parse(modelBytes),
  corpus = JSON.parse(caseBytes)
const ids = idsArgument.split(',')
if (ids.length !== new Set(ids).size) throw new Error('Repeated research case IDs.')
const cases = ids.map((id) => {
  const candidate = corpus.cases.find((entry) => entry.id === id)
  if (!candidate || candidate.split !== split)
    throw new Error(`Case ${id} is missing or outside explicit ${split} split.`)
  return candidate
})
if (model.model !== corpus.model) throw new Error('Model and corpus input contract differ.')
await mkdir(output, { recursive: true })
const report = {
  status: 'running',
  date: new Date().toISOString(),
  model: model.model,
  scope:
    'Explicit local photographic development/held-out research, not production or cross-platform acceptance.',
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  protocol: { path: protocolPath, sha256: hash(protocolBytes) },
  modelManifest: { path: modelPath, sha256: hash(modelBytes) },
  inputManifest: { path: casesPath, sha256: hash(caseBytes) },
  requestedCaseIds: ids,
  split,
  requestedProvider: 'webgpu',
  cpuFallbackDisabled: true,
  memory: { beforeImport: process.memoryUsage() },
  sessions: [],
  cases: [],
  modelStorageBytes: model.components.reduce((total, component) => total + component.bytes, 0),
  embeddingRetention:
    'One image encoder output set retained as CPU tensors between prompts, including decoder upload; no zero-copy GPU cache claim.',
}
const started = performance.now(),
  sessions = [],
  owned = new Set()
const checkedBytes = async (record) => {
  const bytes = await readFile(record.path)
  if (bytes.byteLength !== record.bytes || hash(bytes) !== record.sha256)
    throw new Error(`Research asset changed: ${record.name ?? record.path}`)
  return bytes
}
let ort
const tensor = async (record) => {
  const bytes = await checkedBytes(record),
    array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const ArrayType = { float32: Float32Array, int64: BigInt64Array }[record.dtype]
  if (!ArrayType) throw new Error('Unsupported tensor fixture type.')
  const value = new ort.Tensor(record.dtype, new ArrayType(array), record.shape)
  owned.add(value)
  return value
}
const dispose = (values) => {
  for (const value of Object.values(values)) {
    value.dispose()
    owned.delete(value)
  }
}
const compare = async (actual, referenceRecord) => {
  const bytes = await checkedBytes(referenceRecord),
    reference = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  if (actual.length !== reference.length) throw new Error('Reference output length mismatch.')
  let maxAbsoluteError = 0,
    sum = 0,
    outOfTolerance = 0,
    signMismatches = 0
  for (let index = 0; index < actual.length; index++) {
    if (!Number.isFinite(reference[index]))
      throw new Error('Original upstream reference contains non-finite values.')
    const difference = Math.abs(actual[index] - reference[index])
    maxAbsoluteError = Math.max(maxAbsoluteError, difference)
    sum += difference * difference
    if (difference > 1e-3 + 1e-3 * Math.abs(reference[index])) outOfTolerance++
    if (actual[index] > 0 !== reference[index] > 0) signMismatches++
  }
  return {
    maxAbsoluteError,
    rmse: Math.sqrt(sum / actual.length),
    outOfTolerance,
    samples: actual.length,
    signAgreement: 1 - signMismatches / actual.length,
  }
}
try {
  const importStarted = performance.now()
  ort = createRequire(resolve(runtime, 'package.json'))('onnxruntime-node')
  report.runtimeImportMs = performance.now() - importStarted
  report.runtime = { versions: ort.env.versions, backends: ort.listSupportedBackends() }
  if (!report.runtime.backends.some((backend) => backend.name === 'webgpu' && backend.bundled))
    throw new Error('No native WebGPU provider. No CPU retry.')
  for (const component of model.components) {
    await checkedBytes(component)
    const begin = performance.now(),
      session = await ort.InferenceSession.create(component.path, {
        executionProviders: [{ name: 'webgpu', validationMode: 'basic' }],
        enableProfiling: true,
        profileFilePrefix: resolve(output, `${component.component}-webgpu`),
        logSeverityLevel: 0,
        extra: { session: { disable_cpu_ep_fallback: '1', record_ep_graph_assignment_info: '1' } },
      })
    sessions.push({ component: component.component, session })
    report.sessions.push({ component: component.component, creationMs: performance.now() - begin })
  }
  const encoder = sessions.find((entry) => entry.component === 'encoder').session,
    decoder = sessions.find((entry) => entry.component === 'decoder').session
  for (const specimen of cases) {
    const directory = resolve(output, specimen.id)
    await mkdir(directory)
    if (hash(await readFile(specimen.preparedImage)) !== specimen.preparedSha256)
      throw new Error('Prepared photograph changed.')
    const measured = {
      id: specimen.id,
      split: specimen.split,
      source: specimen.source,
      sourceSha256: specimen.sourceSha256,
      preparedImage: specimen.preparedImage,
      preparedSha256: specimen.preparedSha256,
      width: specimen.width,
      height: specimen.height,
      mapping: specimen.mapping,
      preprocessing: specimen.preprocessPolicy,
      stages: [],
      memoryBefore: process.memoryUsage(),
    }
    report.cases.push(measured)
    const image = await tensor(specimen.image),
      encodeStarted = performance.now(),
      features = await encoder.run({ [encoder.inputNames[0]]: image })
    measured.encoderMs = performance.now() - encodeStarted
    Object.values(features).forEach((value) => owned.add(value))
    measured.embedding = {
      tensors: Object.entries(features).map(([name, value]) => ({
        name,
        dtype: value.type,
        shape: value.dims,
        bytes: value.data.byteLength,
      })),
      bytes: Object.values(features).reduce((total, value) => total + value.data.byteLength, 0),
      location: 'cpu-tensors',
    }
    image.dispose()
    owned.delete(image)
    process.send?.({
      phase: 'session-ready',
      component: 'encoder-completed',
      id: specimen.id,
      pid: process.pid,
    })
    const extras = {}
    for (const descriptor of specimen.decoderExtras ?? [])
      extras[descriptor.name] = await tensor(descriptor)
    for (const stage of specimen.stages) {
      const feeds = { ...features, ...extras },
        prompts = {}
      for (const descriptor of stage.inputs) prompts[descriptor.name] = await tensor(descriptor)
      const labels = prompts.labels
      if (
        labels &&
        (labels.type !== 'float32' ||
          labels.dims.join(',') !== '1,6' ||
          [...labels.data].some((value) => ![-1, 0, 1, 2, 3].includes(Number(value))))
      )
        throw new Error('Research categorical prompt contract is invalid; no truncation performed.')
      Object.assign(feeds, prompts)
      const decodeStarted = performance.now(),
        results = await decoder.run(feeds)
      Object.values(results).forEach((value) => owned.add(value))
      const stageResult = {
        id: stage.id,
        decodeMs: performance.now() - decodeStarted,
        outputs: [],
        warmRunsMs: [],
      }
      measured.stages.push(stageResult)
      if (
        !stage.outputs ||
        stage.outputs
          .map((record) => record.name)
          .sort()
          .join(',') !== Object.keys(results).sort().join(',')
      )
        throw new Error('Every model output requires an original upstream reference.')
      for (const [name, value] of Object.entries(results)) {
        if (value.type !== 'float32' || value.data.some((number) => !Number.isFinite(number)))
          throw new Error('Non-finite or unexpected model output.')
        const bytes = Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength),
          path = resolve(directory, `${stage.id}-${name}.bin`)
        await writeFile(path, bytes)
        const reference = stage.outputs.find((record) => record.name === name)
        if (reference.dtype !== value.type || reference.shape.join(',') !== value.dims.join(','))
          throw new Error('Original upstream output shape/type mismatch.')
        stageResult.outputs.push({
          name,
          path,
          dtype: value.type,
          shape: value.dims,
          bytes: bytes.byteLength,
          sha256: hash(bytes),
          ...(name === 'iou_scores' ? { values: [...value.data] } : {}),
          comparison: await compare(value.data, reference),
        })
      }
      if (stageResult.outputs.some((record) => record.comparison?.outOfTolerance > 0))
        throw new Error(
          `Original upstream numeric parity failed for ${specimen.id}/${stage.id}. No remaining cases or CPU retry were run.`,
        )
      const scores = results.iou_scores?.data
      if (scores)
        stageResult.selectedCandidate = [...scores].reduce(
          (best, score, index) => (score > scores[best] ? index : best),
          0,
        )
      dispose(results)
      if (stage.id === 'refined')
        for (let iteration = 0; iteration < 3; iteration++) {
          const begin = performance.now(),
            repeated = await decoder.run(feeds)
          stageResult.warmRunsMs.push(performance.now() - begin)
          Object.values(repeated).forEach((value) => value.dispose())
        }
      dispose(prompts)
    }
    dispose(extras)
    dispose(features)
    measured.memoryAfter = process.memoryUsage()
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(measured, null, 2) + '\n')
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  for (const value of owned) value.dispose()
  for (const { session } of sessions.reverse()) {
    session.endProfiling()
    await session.release().catch(() => {})
  }
  report.profiles = []
  for (const name of (await readdir(output)).filter(
    (name) => name.endsWith('.json') && name.includes('-webgpu_'),
  )) {
    const events = JSON.parse(await readFile(resolve(output, name), 'utf8')),
      nodes = events.filter((event) => event.cat === 'Node' && event.args?.provider)
    report.profiles.push({
      path: name,
      providers: [...new Set(nodes.map((node) => node.args.provider))],
      operators: [...new Set(nodes.map((node) => node.args.op_name))],
      nodeEvents: nodes.length,
    })
  }
  if (
    report.status === 'passed' &&
    (report.profiles.length !== 2 ||
      report.profiles.some(
        (profile) => profile.providers.length !== 1 || !/webgpu/i.test(profile.providers[0]),
      ))
  ) {
    report.status = 'failed'
    report.error = 'The native profiler did not establish WebGPU-only execution.'
    process.exitCode = 1
  }
  report.memory.afterRelease = process.memoryUsage()
  report.memory.peakRssBytes = process.resourceUsage().maxRSS * 1024
  report.gpuPeakMemory = 'Unavailable from public Node binding; not measured.'
  report.durationMs = performance.now() - started
  await writeFile(resolve(output, 'corpus-result.json'), JSON.stringify(report, null, 2) + '\n')
  await writeFile(
    resolve(output, 'summary.md'),
    `# Native photographic model probe: ${report.status.toUpperCase()}\n\nModel ${model.model}; ${cases.length} explicit ${split} scenes. Native WebGPU only; CPU fallback disabled.\n\n${report.error ?? report.cases.map((record) => `${record.id}: encoder ${record.encoderMs.toFixed(2)} ms; ${record.stages.map((stage) => `${stage.id} ${stage.decodeMs.toFixed(2)} ms`).join(', ')}.`).join('\n\n')}\n\nPeak host RSS ${report.memory.peakRssBytes} bytes; GPU peak unavailable. Total ${report.durationMs.toFixed(2)} ms. Protocol SHA-256 ${report.protocol.sha256}.\n\nOne encoder output set reused between each image's prompts. CPU tensor retention includes decoder upload. Coverage reconstruction, photographic quality and cross-platform acceptance require independent review. Evidence: corpus-result.json and per-case result.json.\n`,
  )
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      model: model.model,
      cases: report.cases.length,
      summary: resolve(output, 'summary.md'),
    }) + '\n',
  )
}
