// Test-only native GPU/official-weight comparison. Never imported by the application.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { endianness } from 'node:os'
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const worker = args.includes('--worker')
const root = worker
  ? resolve(args[args.indexOf('--root') + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const [operation, referenceArgument, outputArgument] = args
const referenceDirectory = referenceArgument && resolve(referenceArgument)
const outputDirectory =
  operation === 'prepare' ? referenceDirectory : outputArgument && resolve(outputArgument)
const generator = 'scripts/research/sky-selection/model-reference-child.mjs'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const photos = [
  {
    id: 'treesky',
    photo: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Treesky.jpg',
  },
  {
    id: 'sunset',
    photo:
      'assets/tests/images/raster/wikimedia/sky-selection/originals/Sunset_through_branches_0528.jpg',
  },
  {
    id: 'storm',
    photo:
      'assets/tests/images/raster/wikimedia/sky-selection/originals/Storm_clouds_over_a_field.jpg',
  },
  {
    id: 'robin',
    photo:
      'assets/tests/images/raster/wikimedia/object-selection/originals/European_Robin_(Erithacus_rubecula)_with_mealworm.jpeg',
  },
]
const cases = photos.flatMap((photo) =>
  (photo.id === 'robin' ? [false] : [false, true]).map((monochrome) => ({
    id:
      photo.id === 'robin'
        ? 'background-robin'
        : `sky-${photo.id}-${monochrome ? 'luminance' : 'color'}`,
    selection: photo.id === 'robin' ? 'background' : 'sky',
    monochrome,
    photo: photo.photo,
  })),
)
const officialPins = {
  sky: {
    revision: 'c8cf1b5e823aee214d937d0d001c1850ba44ef6a',
    checkpointSha256: '97bb47771b1f679d0d8b2de75f2d48ce8ad53a60ab56d489c792d48ccb044500',
  },
  background: {
    revision: '7838f1c3472f827cd8ce13ab5ccc2ce48077360f',
    checkpointSha256: '4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815',
  },
}

function boundedFile(directory, file) {
  if (typeof file !== 'string' || !/^[a-z0-9-]+\.(input|reference)\.f32$/.test(file))
    throw new Error('Reference tensor filenames must be bounded local Float32 files.')
  return join(directory, file)
}
async function readTensor(directory, descriptor, shape) {
  if (!descriptor || descriptor.shape?.join(',') !== shape.join(','))
    throw new Error('The reference tensor shape is unsupported.')
  const path = boundedFile(directory, descriptor.file)
  const expectedBytes = shape.reduce((total, value) => total * value, 4)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedBytes)
    throw new Error('Reference tensors must be regular bounded files with the expected length.')
  const bytes = await readFile(path)
  if (hash(bytes) !== descriptor.sha256) throw new Error('Reference tensor hash changed.')
  const values = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  )
  if (!values.every(Number.isFinite))
    throw new Error('Reference tensors must contain finite values.')
  return values
}

async function prepare() {
  const sharp = (await import('sharp')).default
  const { createObjectSelectionGpu } = await import('../../../src/main/object-selection/gpu.ts')
  const { automaticSelectionGraphs } =
    await import('../../../src/main/object-selection/automatic-model.ts')
  const manifest = {
    version: 1,
    format: 'float32-le',
    preparation: {
      generator,
      generatorSha256: hash(await readFile(join(root, generator))),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      scope: 'Exact common GPU-normalized Float32 inputs; no model inference or quality claim.',
    },
    models: automaticSelectionGraphs,
    cases: [],
  }
  for (const fixture of cases) {
    const original = await readFile(join(root, fixture.photo))
    const { data, info } = await sharp(original)
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const edge = fixture.selection === 'sky' ? 512 : 1024
    const gpu = await createObjectSelectionGpu(edge, true, fixture.monochrome)
    try {
      const input = await gpu.preprocess(data, info.width, info.height)
      const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      const file = `${fixture.id}.input.f32`
      await writeFile(join(referenceDirectory, file), bytes, { flag: 'wx' })
      manifest.cases.push({
        ...fixture,
        photoSha256: hash(original),
        input: { file, shape: [1, 3, edge, edge], sha256: hash(bytes) },
      })
    } finally {
      gpu.close()
    }
  }
  await json(join(referenceDirectory, 'manifest.json'), manifest)
}

async function validateManifest() {
  const manifestPath = join(referenceDirectory, 'manifest.json')
  if ((await stat(manifestPath)).size > 1024 * 1024)
    throw new Error('Reference manifest is too large.')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const { automaticSelectionGraphs } =
    await import('../../../src/main/object-selection/automatic-model.ts')
  if (
    manifest.version !== 1 ||
    manifest.format !== 'float32-le' ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== cases.length ||
    JSON.stringify(manifest.models) !== JSON.stringify(automaticSelectionGraphs)
  )
    throw new Error('The automatic model reference manifest is unsupported.')
  if (
    manifest.preparation?.generator !== generator ||
    manifest.preparation.generatorSha256 !== hash(await readFile(join(root, generator)))
  )
    throw new Error(
      'The prepared-input generator identity changed; regenerate the reference inputs.',
    )
  const oracle = manifest.officialReference
  const oracleGenerator = 'scripts/research/sky-selection/generate-model-reference.py'
  if (
    oracle?.generator !== oracleGenerator ||
    oracle.generatorSha256 !== hash(await readFile(join(root, oracleGenerator)))
  )
    throw new Error('The independent official reference generator is missing or changed.')
  for (const selection of ['sky', 'background']) {
    const actual = oracle.models?.[selection]
    if (
      actual?.revision !== officialPins[selection].revision ||
      actual.checkpointSha256 !== officialPins[selection].checkpointSha256
    )
      throw new Error('The independent official checkpoint identity changed.')
  }
  for (let index = 0; index < cases.length; index++) {
    const expected = cases[index],
      actual = manifest.cases[index]
    for (const field of ['id', 'selection', 'monochrome', 'photo'])
      if (actual[field] !== expected[field])
        throw new Error('The reference photographic cohort changed.')
    if (hash(await readFile(join(root, actual.photo))) !== actual.photoSha256)
      throw new Error('The reference original photograph changed.')
  }
  return manifest
}

function compareValues(actual, expected, selection) {
  if (actual.length !== expected.length || !actual.every(Number.isFinite))
    throw new Error('Native output dimensions or finite-value contract failed.')
  let maxAbsoluteError = 0,
    maxGateRatio = 0,
    violations = 0,
    flips = 0
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs(actual[index] - expected[index])
    maxAbsoluteError = Math.max(maxAbsoluteError, error)
    maxGateRatio = Math.max(maxGateRatio, error / (1e-3 + 1e-3 * Math.abs(expected[index])))
    if (error > 1e-3 + 1e-3 * Math.abs(expected[index])) violations++
    if (selection === 'background' && actual[index] > 0 !== expected[index] > 0) flips++
  }
  if (selection === 'sky') {
    const pixels = 128 * 128
    for (let pixel = 0; pixel < pixels; pixel++) {
      let actualLabel = 0,
        expectedLabel = 0
      for (let label = 1; label < 150; label++) {
        if (actual[label * pixels + pixel] > actual[actualLabel * pixels + pixel])
          actualLabel = label
        if (expected[label * pixels + pixel] > expected[expectedLabel * pixels + pixel])
          expectedLabel = label
      }
      if ((actualLabel === 2) !== (expectedLabel === 2)) flips++
    }
  }
  return { values: actual.length, maxAbsoluteError, maxGateRatio, violations, flips }
}

async function compare() {
  const ort = await import('onnxruntime-node')
  const { loadAutomaticSelectionGraph } =
    await import('../../../src/main/object-selection/automatic-model.ts')
  const { objectSelectionSessionOptions } =
    await import('../../../src/main/object-selection/model.ts')
  const report = {
    status: 'running',
    runtime: { versions: ort.env.versions, backends: ort.listSupportedBackends() },
    host: { platform: process.platform, arch: process.arch, node: process.version },
    cpuFallbackDisabled: true,
    physicalAdapter: {
      status: 'unobserved',
      reason:
        'This oracle runner verifies native node providers; separate runtime-device evidence owns physical-adapter observation.',
    },
    tolerance: { absolute: 1e-3, relative: 1e-3, allowedFlips: 0 },
    cases: [],
    profiles: [],
  }
  const started = performance.now()
  try {
    const manifest = await validateManifest()
    report.manifestSha256 = hash(await readFile(join(referenceDirectory, 'manifest.json')))
    if (!report.runtime.backends.some((entry) => entry.name === 'webgpu' && entry.bundled))
      throw new Error('Native WebGPU inference is unavailable. CPU inference is disabled.')
    for (const selection of ['sky', 'background']) {
      const session = await ort.InferenceSession.create(
        await loadAutomaticSelectionGraph(join(root, 'assets/app/object-selection'), selection),
        {
          ...objectSelectionSessionOptions(),
          enableProfiling: true,
          profileFilePrefix: join(outputDirectory, `${selection}-webgpu`),
        },
      )
      try {
        for (const fixture of manifest.cases.filter((entry) => entry.selection === selection)) {
          const edge = selection === 'sky' ? 512 : 1024
          const shape = selection === 'sky' ? [1, 150, 128, 128] : [1, 1, 1024, 1024]
          const values = await readTensor(referenceDirectory, fixture.input, [1, 3, edge, edge])
          const expected = await readTensor(referenceDirectory, fixture.reference, shape)
          const input = new ort.Tensor('float32', values, [1, 3, edge, edge])
          let outputs
          try {
            outputs = await session.run({
              [selection === 'sky' ? 'pixel_values' : 'input_image']: input,
            })
            const output = outputs[selection === 'sky' ? 'semantic' : 'output_image']
            if (output?.type !== 'float32' || output.dims.join(',') !== shape.join(','))
              throw new Error('The automatic model output shape changed.')
            const result = { id: fixture.id, ...compareValues(output.data, expected, selection) }
            report.cases.push(result)
            if (result.violations || result.flips)
              throw new Error(
                `${fixture.id}: ${result.violations} numerical violations; ${result.flips} label flips.`,
              )
          } finally {
            input.dispose()
            for (const output of Object.values(outputs ?? {})) output.dispose()
          }
        }
      } finally {
        session.endProfiling()
        await session.release()
      }
    }
    const profiles = (await readdir(outputDirectory)).filter((file) =>
      /^(sky|background)-webgpu.*\.json$/.test(file),
    )
    if (profiles.length !== 2)
      throw new Error('Both automatic native-provider profiles are required.')
    for (const file of profiles) {
      const path = join(outputDirectory, file)
      if ((await stat(path)).size > 32 * 1024 * 1024)
        throw new Error('Native profile exceeded its read bound.')
      const events = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(events) || events.length > 100000)
        throw new Error('Native profile event bound exceeded.')
      const nodes = events.filter((entry) => entry.cat === 'Node' && entry.args?.provider)
      const providers = [...new Set(nodes.map((entry) => entry.args.provider))]
      report.profiles.push({ file, nodes: nodes.length, providers })
      if (!nodes.length || providers.length !== 1 || providers[0] !== 'WebGpuExecutionProvider')
        throw new Error(
          'The official comparison did not execute exclusively on the native WebGPU provider.',
        )
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = (error.stack ?? String(error)).slice(0, 4096)
    process.exitCode = 1
  } finally {
    report.durationMs = performance.now() - started
    await json(join(outputDirectory, 'result.json'), report)
  }
}

async function main() {
  if (!['prepare', 'compare'].includes(operation) || !referenceDirectory || !outputDirectory)
    throw new Error(
      'Usage: model-reference-child.mjs prepare NEW_REFERENCE_DIR | compare REFERENCE_DIR NEW_OUTPUT_DIR',
    )
  if (endianness() !== 'LE' || process.versions.electron)
    throw new Error('Use the isolated little-endian bundled Node runtime.')
  if (worker) {
    process.env.ORT_DISABLE_TELEMETRY = '1'
    return operation === 'prepare' ? prepare() : compare()
  }
  const insideArtifacts = relative(join(root, 'artifacts'), outputDirectory)
  if (!insideArtifacts || insideArtifacts.startsWith('..') || isAbsolute(insideArtifacts))
    throw new Error('Oracle inputs and run outputs belong in a fresh artifacts/ directory.')
  await mkdir(outputDirectory, { recursive: true })
  const bundle = join(outputDirectory, `runner-${randomUUID()}.mjs`)
  const { build } = await import('esbuild')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  })
  const require = createRequire(import.meta.url)
  const platform = process.platform === 'win32' ? 'win' : process.platform
  const executable = join(
    dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const launchId = randomUUID()
  const logPath = join(outputDirectory, `process-${launchId}.log`)
  const log = await open(logPath, 'wx')
  const child = spawn(executable, [bundle, ...args, '--worker', '--root', root], {
    env,
    stdio: ['ignore', log.fd, log.fd],
  })
  const started = performance.now()
  let interrupted,
    timedOut = false,
    launchError
  const closed = new Promise((accept) => {
    child.once('error', (error) => {
      launchError = String(error)
    })
    child.once('close', (code, signal) => accept({ code, signal }))
  })
  const terminate = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const interrupt = (signal) => {
    interrupted ??= signal
    terminate()
  }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, 180000)
  let exit
  try {
    exit = await closed
  } finally {
    terminate()
    exit ??= await closed
    clearTimeout(timer)
    await log.close()
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
    const status = interrupted
      ? 'interrupted'
      : timedOut || launchError || exit.code !== 0
        ? 'failed'
        : 'passed'
    const launch = {
      status,
      operation,
      exit,
      interrupted: interrupted ?? null,
      timedOut,
      error: launchError ?? null,
      durationMs: performance.now() - started,
      log: logPath,
      outputDirectory,
    }
    await json(join(outputDirectory, `launcher-${launchId}.json`), launch)
    process.exitCode =
      interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : status === 'passed' ? 0 : 1
    process.stdout.write(JSON.stringify(launch) + '\n')
  }
}
await main()
