// Research adapter: use production preprocessing, SAM reconstruction, edge and guided kernels.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { createObjectSelectionGpu } from '../../../src/main/object-selection/gpu.ts'
import { ObjectSelectionProcess } from '../../../src/main/object-selection/process.ts'
import { refineAutomaticSelection } from '../../../src/main/object-selection/automatic-gpu.ts'
import { RawGpuRenderer } from '../../../src/main/gpu/raw-renderer.ts'
import { prepareMaskEdgeCoverage } from '../../../src/main/mask-edges/gpu.ts'
import { neutralMaskColor, neutralMaskLight } from '../../../src/shared/masks.ts'
import { objectSelectionMemoryPlan } from '../../../src/shared/object-selection-resources.ts'
import {
  DEFAULT_RESOURCE_SETTINGS,
  resolveResourcePolicy,
} from '../../../src/shared/resource-policy.ts'
import {
  observeResourceHardware,
  matchResourceAdapter,
} from '../../../src/main/resource-settings.ts'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1]) throw new Error(`Missing ${name}.`)
  return args[index + 1]
}
const root = resolve(option('--root', '.'))
const study = resolve(option('--study'))
const stage = option('--stage')
const output = join(study, stage)
const preparedPath = resolve(option('--prepared', join(study, 'prepared/prepared-inputs.json')))
const preparedBytes = await readFile(preparedPath)
const prepared = JSON.parse(preparedBytes)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const signal = new AbortController().signal
const freezePath = resolve(option('--freeze-receipt', join(study, 'freeze-receipt.json')))
const freezeBytes = await readFile(freezePath)
const freeze = JSON.parse(freezeBytes)
const protocolPath = join(root, 'assets/tests/references/refine-edge/protocol.json')
const protocolSha256 = hash(await readFile(protocolPath))
const cropsPath = join(root, freeze.cropsPath)
const cropsSha256 = hash(await readFile(cropsPath))
if (protocolSha256 !== freeze.protocolSha256 || cropsSha256 !== freeze.cropsSha256)
  throw new Error('Refine Edge protocol or native crop selection changed after freeze.')
const frozenAt = Date.parse(freeze.frozenAt)
if (!Number.isFinite(frozenAt) || frozenAt > Date.now())
  throw new Error('Invalid study freeze time.')
const sentinels = ['d01-fog-dog', 'd06-wig', 'd08-flamingo']
const requested = option('--ids', null)?.split(',')
let cases = prepared.images.filter((entry) =>
  requested ? requested.includes(entry.id) : entry.split === 'development',
)
if (
  requested &&
  (new Set(requested).size !== requested.length || requested.length !== cases.length)
)
  throw new Error('Unknown or repeated research IDs.')
if (cases.some((entry) => entry.split !== 'development') && !args.includes('--allow-confirmation'))
  throw new Error('Confirmation execution requires explicit release.')
let confirmationRelease
if (cases.some((entry) => entry.split !== 'development')) {
  const releasePath = join(study, 'confirmation-release.json')
  const releaseBytes = await readFile(releasePath)
  const release = JSON.parse(releaseBytes)
  const decisionSha256 = hash(await readFile(join(study, 'development-decision.json')))
  if (
    release.protocolSha256 !== protocolSha256 ||
    release.cropsSha256 !== cropsSha256 ||
    release.developmentDecisionSha256 !== decisionSha256 ||
    release.tuningAllowed !== false ||
    !cases
      .filter((entry) => entry.split !== 'development')
      .every((entry) => release.ids.includes(entry.id))
  )
    throw new Error('Confirmation release or development decision changed.')
  confirmationRelease = {
    path: releasePath,
    sha256: hash(releaseBytes),
    developmentDecisionSha256: decisionSha256,
  }
}
cases = [
  ...cases.filter((entry) => sentinels.includes(entry.id)),
  ...cases.filter((entry) => !sentinels.includes(entry.id)),
]
await mkdir(output, { recursive: true })
const manifestPath = join(output, 'cases.json')
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )
const manifest = (await exists(manifestPath))
  ? JSON.parse(await readFile(manifestPath, 'utf8'))
  : {
      version: 1,
      stage,
      status: 'running',
      sourceManifest: preparedPath,
      sourceManifestSha256: hash(preparedBytes),
      pathPolicy: 'absolute',
      host: { platform: process.platform, arch: process.arch, node: process.version },
      sourcePolicy:
        'full-native once-oriented neutral SDR, As Shot, no crop/lens/local edits; sensor RAW',
      cases: [],
    }
if (manifest.sourceManifestSha256 !== hash(preparedBytes))
  throw new Error('Prepared source manifest changed.')
manifest.status = 'running'
const implementation = {}
for (const file of [
  'src/main/object-selection/gpu.ts',
  'src/main/object-selection/automatic-gpu.ts',
  'src/main/object-selection/model.ts',
  'src/main/object-selection/worker.ts',
  'src/main/mask-edges/gpu.ts',
  'scripts/research/refine-edge/guided-worker.mjs',
])
  implementation[file] = hash(await readFile(join(root, file)))
const invocation = {
  id: option('--invocation-id', `worker-${Date.now()}`),
  startedAt: new Date().toISOString(),
  requestedIds: cases.map((entry) => entry.id),
  evaluatedIds: [],
  implementation,
  protocolSha256,
  cropsSha256,
  freezePath,
  freezeSha256: hash(freezeBytes),
  freezeCheckedBeforeExecution: true,
  confirmationRelease,
  status: 'running',
}
manifest.invocations ??= []
manifest.invocations.push(invocation)
manifest.protocolSha256 = protocolSha256
manifest.cropsSha256 = cropsSha256
await json(manifestPath, manifest)
let identity
const identify = new RawGpuRenderer()
try {
  const { device, adapter } = await identify.mergeDevice()
  const info = device.adapterInfo
  identity = info
    ? {
        vendor: info.vendor ?? '',
        architecture: info.architecture ?? '',
        device: info.device ?? '',
        description: info.description ?? '',
      }
    : null
  manifest.dawnAdapter = { description: adapter, identity }
} catch (error) {
  manifest.status = 'failed'
  invocation.status = 'failed'
  invocation.error = String(error.stack ?? error)
  invocation.finishedAt = new Date().toISOString()
  await json(manifestPath, manifest)
  throw error
} finally {
  identify.close()
}
async function admission(width, height, guided = false) {
  const hardware = await observeResourceHardware()
  const policy = resolveResourcePolicy(
    DEFAULT_RESOURCE_SETTINGS,
    matchResourceAdapter(hardware, identity),
    0,
  )
  const memory = guided
    ? {
        ramBytes: width * height * 16 + 1024 ** 3,
        vramBytes: width * height * 6 + 1024 * 1024 * 256,
      }
    : objectSelectionMemoryPlan(width, height, {
        policy,
        reservation: { ramBytes: 0, vramBytes: 0 },
      })
  const accepted =
    memory.ramBytes <= policy.ram.effectiveBytes && memory.vramBytes <= policy.vram.effectiveBytes
  const result = {
    settings: DEFAULT_RESOURCE_SETTINGS,
    hardware,
    policy,
    memory,
    accepted,
    scope: 'Managed image estimate, not a physical GPU residency or process memory cap.',
  }
  if (!accepted) {
    await json(join(output, 'resource-refusal.json'), result)
    throw new Error(
      'Automatic resource policy refused this research job; no override or CPU fallback.',
    )
  }
  return result
}
async function sourceRecord(entry) {
  const imagePath = resolve(root, entry.path)
  if (hash(await readFile(imagePath)) !== entry.preparedSha256)
    throw new Error(`Prepared PNG changed: ${entry.id}`)
  const rgbaPath = join(dirname(imagePath), 'full.rgba')
  const rgba = await readFile(rgbaPath)
  if (rgba.byteLength !== entry.width * entry.height * 4)
    throw new Error('Prepared RGBA size changed.')
  return {
    id: entry.id,
    split: entry.split,
    width: entry.width,
    height: entry.height,
    sourcePath: resolve(root, entry.source),
    sourceSha256: entry.sha256,
    preparedPath: imagePath,
    preparedSha256: entry.preparedSha256,
    rgbaPath,
    rgbaSha256: hash(rgba),
  }
}
async function validateCachedCase(cached, entry) {
  if (
    cached.width !== entry.width ||
    cached.height !== entry.height ||
    cached.sourceSha256 !== entry.sha256 ||
    cached.preparedSha256 !== entry.preparedSha256
  )
    throw new Error(`Cached research source identity changed: ${entry.id}`)
  const pixels = cached.width * cached.height
  const records = [
    ['rgbaPath', 'rgbaSha256', pixels * 4],
    ['maskPath', 'maskSha256', pixels],
    ['encodedMaskPath', 'encodedMaskSha256', null],
    ...(stage === 'guided'
      ? [
          ['guidedPath', 'guidedSha256', pixels],
          ['featherPath', 'featherSha256', pixels],
        ]
      : []),
  ]
  for (const [pathField, hashField, expectedBytes] of records) {
    if (typeof cached[pathField] !== 'string' || !/^[a-f0-9]{64}$/.test(cached[hashField] ?? ''))
      throw new Error(`Cached research evidence descriptor is incomplete: ${entry.id}/${pathField}`)
    const bytes = await readFile(cached[pathField])
    if (
      (expectedBytes !== null && bytes.byteLength !== expectedBytes) ||
      hash(bytes) !== cached[hashField]
    )
      throw new Error(`Cached research evidence changed: ${entry.id}/${pathField}`)
  }
}
try {
  if (stage === 'baseline') {
    manifest.baselinePolicy =
      'Frozen original box + original positive/negative points; zero prior mask; pinned production SAM 2.1 Tiny; best predicted-IoU candidate, first on ties; bilinear native reconstruction threshold > 0.'
    if (!manifest.runtimeDevice) {
      const require = createRequire(import.meta.url)
      const platform = process.platform === 'win32' ? 'win' : process.platform
      const executable = join(
        dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
        'bin',
        process.platform === 'win32' ? 'node.exe' : 'node',
      )
      const runtimeOutput = join(output, 'runtime-device')
      await promisify(execFile)(
        executable,
        [
          join(root, 'tests/object-selection-runtime-child.mjs'),
          join(root, 'assets/app/object-selection'),
          runtimeOutput,
        ],
        {
          env: { ...process.env, ORT_DISABLE_TELEMETRY: '1' },
          timeout: 120000,
          maxBuffer: 1024 * 1024,
        },
      )
      manifest.runtimeDevice = JSON.parse(
        await readFile(join(runtimeOutput, 'runtime-device.json'), 'utf8'),
      )
      if (
        manifest.runtimeDevice.status !== 'passed' ||
        !manifest.runtimeDevice.profiles.every(
          (profile) =>
            profile.nodes > 0 &&
            profile.providers.length === 1 &&
            profile.providers[0] === 'WebGpuExecutionProvider',
        )
      )
        throw new Error('SAM native provider receipt failed.')
      if (process.platform === 'linux' && !manifest.runtimeDevice.activeDevices.length)
        throw new Error('SAM physical adapter was not observed.')
    }
    const runtime = new ObjectSelectionProcess({
      workerPath: join(output, 'object-selection-worker.mjs'),
      modelDirectory: join(root, 'assets/app/object-selection'),
    })
    try {
      for (const entry of cases) {
        const cached = manifest.cases.find((item) => item.id === entry.id)
        if (cached) {
          await validateCachedCase(cached, entry)
          continue
        }
        const source = await sourceRecord(entry)
        const resource = await admission(entry.width, entry.height)
        const key = hash(
          Buffer.from(
            JSON.stringify({
              version: 1,
              rgba: source.rgbaSha256,
              width: entry.width,
              height: entry.height,
            }),
          ),
        )
        const prompt = {
          key,
          box: entry.prompt.box,
          positivePoints: entry.prompt.positivePoints,
          negativePoints: entry.prompt.negativePoints,
        }
        const pngPath = join(output, `${entry.id}.png`)
        const started = performance.now()
        const result = await runtime.run(
          { key, path: source.rgbaPath, width: entry.width, height: entry.height, format: 'rgba8' },
          prompt,
          pngPath,
          signal,
        )
        const elapsedMs = performance.now() - started
        const mask = await sharp(pngPath).toColourspace('b-w').raw().toBuffer()
        if (
          mask.byteLength !== entry.width * entry.height ||
          !mask.every((pixel) => pixel === 0 || pixel === 255)
        )
          throw new Error('SAM baseline is not native binary R8.')
        const maskPath = join(output, `${entry.id}.r8`)
        await writeFile(maskPath, mask, { flag: 'wx' })
        const record = {
          ...source,
          invocationId: invocation.id,
          maskPath,
          maskSha256: hash(mask),
          encodedMaskPath: pngPath,
          encodedMaskSha256: result.sha256,
          selectedCandidate: result.selectedCandidate,
          predictedIou: result.predictedIou,
          modelIdentity: result.modelIdentity,
          frozenPrompts: entry.prompt,
          elapsedMs,
          resource,
        }
        manifest.cases.push(record)
        invocation.evaluatedIds.push(entry.id)
        await json(manifestPath, manifest)
        console.log(
          JSON.stringify({
            stage,
            id: entry.id,
            width: entry.width,
            height: entry.height,
            elapsedMs,
          }),
        )
      }
      if (!manifest.safety) {
        await runtime.close()
        const source = manifest.cases[0]
        const cancellation = new AbortController()
        const destination = join(output, 'cancelled-must-not-exist.png')
        const pending = runtime.run(
          {
            key: 'cancel-refine-study',
            path: source.rgbaPath,
            width: source.width,
            height: source.height,
            format: 'rgba8',
          },
          { key: 'cancel-refine-study', positivePoints: [[0.5, 0.5]] },
          destination,
          cancellation.signal,
        )
        const timer = setTimeout(() => cancellation.abort(), 10)
        let cancelled = false
        try {
          await pending
        } catch (error) {
          cancelled = /cancelled/.test(String(error))
        } finally {
          clearTimeout(timer)
          await runtime.close()
        }
        if (!cancelled || (await exists(destination)) || (await exists(`${destination}.tmp`)))
          throw new Error('Owned baseline cancellation did not refuse publication.')
        let refused = false
        try {
          objectSelectionMemoryPlan(8192, 8192, {
            policy: manifest.cases[0].resource.policy,
            reservation: { ramBytes: 0, vramBytes: 0 },
          })
        } catch {
          refused = true
        }
        if (!refused) throw new Error('Out-of-range resource dimensions were accepted.')
        manifest.safety = {
          cancelled,
          outputPublished: false,
          temporaryPublished: false,
          closedOwnedChild: true,
          oversizedDimensionsRefusedBeforeAllocation: true,
        }
      }
    } finally {
      await runtime.close()
    }
  } else if (stage === 'guided') {
    const baselinePath = resolve(option('--baseline-manifest', join(study, 'baseline/cases.json')))
    const baselineBytes = await readFile(baselinePath)
    const baseline = JSON.parse(baselineBytes)
    invocation.baselineManifest = { path: baselinePath, sha256: hash(baselineBytes) }
    const gpu = await createObjectSelectionGpu(1024)
    try {
      manifest.guidedPolicy = {
        edge: 1024,
        radius: 8,
        epsilon: 0.001,
        inputMask:
          'Same native binary SAM baseline, antialiased triangle resize on the same independent X/Y 1024 grid as the RGB guide.',
        output: 'Native fractional R8 from production guided reconstruction; no threshold.',
        feather: { featherPx: 4, shiftPx: 0, implementation: 'prepareMaskEdgeCoverage' },
      }
      for (const entry of cases) {
        const cached = manifest.cases.find((item) => item.id === entry.id)
        if (cached) {
          await validateCachedCase(cached, entry)
          continue
        }
        const base = baseline.cases.find((item) => item.id === entry.id)
        if (!base) throw new Error(`Missing baseline: ${entry.id}`)
        const rgba = await readFile(base.rgbaPath)
        const mask = await readFile(base.maskPath)
        if (hash(rgba) !== base.rgbaSha256 || hash(mask) !== base.maskSha256)
          throw new Error('Frozen source/baseline changed.')
        const resource = await admission(entry.width, entry.height, true)
        const started = performance.now()
        const guide = await gpu.preprocess(rgba, entry.width, entry.height)
        const maskRgba = await sharp(mask, {
          raw: { width: entry.width, height: entry.height, channels: 1 },
        })
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer()
        const maskInput = (await gpu.preprocess(maskRgba, entry.width, entry.height)).slice(
          0,
          1024 * 1024,
        )
        const preprocessingMs = performance.now() - started
        const run = () =>
          refineAutomaticSelection(
            gpu.device,
            rgba,
            guide,
            maskInput,
            entry.width,
            entry.height,
            1024,
          )
        const coldStarted = performance.now()
        const guided = await run()
        const coldMs = performance.now() - coldStarted
        const warmMs = []
        if (entry.id === 'd01-fog-dog')
          for (let repeat = 0; repeat < 3; repeat++) {
            const warmStarted = performance.now()
            const again = await run()
            warmMs.push(performance.now() - warmStarted)
            if (hash(again) !== hash(guided))
              throw new Error('Guided repeat changed native R8 bytes.')
          }
        const guidedPath = join(output, `${entry.id}.r8`)
        await writeFile(guidedPath, guided, { flag: 'wx' })
        const basePng = await readFile(base.encodedMaskPath)
        if (hash(basePng) !== base.encodedMaskSha256)
          throw new Error('Encoded frozen baseline changed.')
        const local = {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Research baseline feather',
          enabled: true,
          inverted: false,
          head: null,
          light: { ...neutralMaskLight },
          color: { ...neutralMaskColor },
          edge: { featherPx: 4, shiftPx: 0 },
          strokes: [],
          base: {
            version: 1,
            width: entry.width,
            height: entry.height,
            hash: hash(basePng),
            pngBase64: basePng.toString('base64'),
          },
        }
        const featherStarted = performance.now()
        const feather = await prepareMaskEdgeCoverage(
          gpu.device,
          local,
          entry.width,
          entry.height,
          signal,
        )
        const featherMs = performance.now() - featherStarted
        const featherPath = join(output, `${entry.id}-feather4.r8`)
        await writeFile(featherPath, feather, { flag: 'wx' })
        if (gpu.failure) throw new Error(gpu.failure)
        const record = {
          ...base,
          baselineInvocationId: base.invocationId,
          invocationId: invocation.id,
          guidedPath,
          guidedSha256: hash(guided),
          featherPath,
          featherSha256: hash(feather),
          resource,
          timing: {
            preprocessingMs,
            guidedColdMs: coldMs,
            guidedWarmMs: warmMs,
            featherMs,
            scope:
              'Readback-complete kernel invocation; warm calls still create production pipelines; source decoding, baseline SAM and proof generation excluded.',
          },
        }
        manifest.cases.push(record)
        invocation.evaluatedIds.push(entry.id)
        await json(manifestPath, manifest)
        console.log(JSON.stringify({ stage, id: entry.id, coldMs, warmMs, featherMs }))
      }
    } finally {
      gpu.close()
    }
  } else throw new Error('Unknown study stage.')
  manifest.status = 'passed'
  invocation.status = 'passed'
} catch (error) {
  manifest.status = 'failed'
  manifest.error = String(error.stack ?? error)
  invocation.status = 'failed'
  invocation.error = manifest.error
  throw error
} finally {
  invocation.finishedAt = new Date().toISOString()
  await json(manifestPath, manifest)
}
