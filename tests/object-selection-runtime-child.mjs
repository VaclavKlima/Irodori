// Isolated ORT diagnostics only: no separate Dawn owner can contribute DRM engine activity.
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import * as ort from 'onnxruntime-node'
import {
  loadObjectSelectionGraph,
  loadBundledSelectionGraph,
  objectSelectionSessionOptions,
} from '../src/main/object-selection/model.ts'
import { packObjectSelectionPrompts } from '../src/main/object-selection/prompts.ts'

const [modelDirectory, outputDirectory] = process.argv.slice(2, 4).map((path) => resolve(path))
const automatic = process.argv[4] === 'automatic'
if (!modelDirectory || !outputDirectory) throw new Error('Supply model and evidence directories.')
await mkdir(outputDirectory, { recursive: true })
process.env.ORT_DISABLE_TELEMETRY = '1'

async function drmClients() {
  if (process.platform !== 'linux') return []
  const descriptors = await readdir('/proc/self/fdinfo')
  if (descriptors.length > 2048) throw new Error('ORT descriptor sampling exceeded its bound.')
  const clients = new Map()
  for (const descriptor of descriptors) {
    let handle
    try {
      handle = await open(`/proc/self/fdinfo/${descriptor}`, 'r')
      const bytes = Buffer.alloc(65537)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 65536) throw new Error('ORT fdinfo exceeded its bound.')
      const text = bytes.subarray(0, bytesRead).toString('utf8')
      const driver = /^drm-driver:\s*(\S+)$/m.exec(text)?.[1]
      if (!driver) continue
      const device = /^drm-pdev:\s*([\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[\da-f])$/im.exec(text)?.[1]
      const clientId = /^drm-client-id:\s*(\d+)$/m.exec(text)?.[1]
      if (!device || !clientId) throw new Error('ORT DRM client has no physical device identity.')
      const engines = Object.fromEntries(
        [...text.matchAll(/^drm-engine-([^:\s]+):\s*(\d+)\s+ns\s*$/gm)].map(
          ([, engine, nanoseconds]) => [engine, nanoseconds],
        ),
      )
      clients.set(`${device}:${clientId}`, {
        device: device.toLowerCase(),
        clientId,
        driver,
        engines,
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    } finally {
      await handle?.close()
    }
  }
  return [...clients.values()]
}

const sessions = [],
  tensors = []
const report = {
  status: 'running',
  runtime: { versions: ort.env.versions, backends: ort.listSupportedBackends() },
  host: { platform: process.platform, arch: process.arch, node: process.version, pid: process.pid },
  driPrime: process.env.DRI_PRIME ?? null,
  cpuFallbackDisabled: true,
  scope:
    'Pinned ORT encoder/decoder execution and physical-device evidence; no image quality or physical-memory claim.',
}
const recordFailure = (operation, error) => {
  const message = (error.stack ?? String(error)).slice(0, 4096)
  report.status = 'failed'
  report.error ??= message
  ;(report.errors ??= []).push({ operation, message })
  process.exitCode = 1
}
async function collectProfiles() {
  report.profiles = []
  let profiles
  try {
    profiles = (await readdir(outputDirectory)).filter((name) =>
      /^(encoder|decoder|sky|background)-webgpu.*\.json$/.test(name),
    )
    if (profiles.length > 2) throw new Error('ORT emitted more than two component profiles.')
  } catch (error) {
    recordFailure('profile discovery', error)
    profiles = []
  }
  for (const name of profiles) {
    try {
      const path = join(outputDirectory, name)
      if ((await stat(path)).size > 32 * 1024 * 1024)
        throw new Error('ORT profile exceeded its 32 MiB read bound.')
      const events = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(events) || events.length > 100000)
        throw new Error('ORT profile exceeded its event bound.')
      const nodes = events.filter((event) => event.cat === 'Node' && event.args?.provider)
      report.profiles.push({
        file: name,
        nodes: nodes.length,
        providers: [...new Set(nodes.map((node) => node.args.provider))],
      })
    } catch (error) {
      recordFailure('profile ' + name, error)
    }
  }
}
try {
  if (!report.runtime.backends.some((backend) => backend.name === 'webgpu' && backend.bundled))
    throw new Error('The pinned native WebGPU provider is unavailable; CPU inference is disabled.')
  if (automatic) {
    const pins = {
      sky: {
        bytes: 287296604,
        sha256: '2035d1c38fff88ee792d32002b269fe29f5c561009e9256200bdd9e3fbfb515f',
      },
      background: {
        bytes: 199681624,
        sha256: '50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67',
      },
    }
    report.scope =
      'Pinned automatic sky/background native provider and physical device; no photographic or memory-peak claim.'
    for (const kind of ['sky', 'background']) {
      const graph = await loadBundledSelectionGraph(
        join(modelDirectory, 'automatic'),
        kind,
        'mask2former-sky-birefnet-background-fp32-v1',
        pins[kind],
      )
      sessions.push(
        await ort.InferenceSession.create(graph, {
          ...objectSelectionSessionOptions(),
          enableProfiling: true,
          profileFilePrefix: join(outputDirectory, `${kind}-webgpu`),
        }),
      )
    }
    report.before = await drmClients()
    for (let index = 0; index < 2; index++) {
      const edge = index === 0 ? 512 : 1024
      const input = new ort.Tensor('float32', new Float32Array(3 * edge * edge), [1, 3, edge, edge])
      tensors.push(input)
      const result = await sessions[index].run({
        [index === 0 ? 'pixel_values' : 'input_image']: input,
      })
      tensors.push(...Object.values(result))
      if (
        !Object.values(result).every(
          (tensor) => tensor.type === 'float32' && tensor.data.every(Number.isFinite),
        )
      )
        throw new Error('The automatic model returned nonfinite output.')
    }
  } else {
    for (const component of ['encoder', 'decoder']) {
      const options = objectSelectionSessionOptions()
      sessions.push(
        await ort.InferenceSession.create(
          await loadObjectSelectionGraph(modelDirectory, component),
          {
            ...options,
            enableProfiling: true,
            profileFilePrefix: join(outputDirectory, `${component}-webgpu`),
          },
        ),
      )
    }
    report.before = await drmClients()
    const input = new ort.Tensor(
      'float32',
      new Float32Array(3 * 1024 * 1024).fill(0.5),
      [1, 3, 1024, 1024],
    )
    tensors.push(input)
    const encoderStarted = performance.now()
    const retained = await sessions[0].run({ image: input })
    report.encoderMs = performance.now() - encoderStarted
    tensors.push(...Object.values(retained))
    const packed = packObjectSelectionPrompts({
      key: 'native-ort-device-evidence',
      positivePoints: [[0.5, 0.5]],
    })
    const prompts = {
      coordinates: new ort.Tensor('float32', packed.coordinates, [1, 6, 2]),
      labels: new ort.Tensor('float32', packed.labels, [1, 6]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask: new ort.Tensor('float32', new Float32Array(1), [1]),
    }
    tensors.push(...Object.values(prompts))
    const decoderStarted = performance.now()
    const result = await sessions[1].run({ ...retained, ...prompts })
    report.decoderMs = performance.now() - decoderStarted
    tensors.push(...Object.values(result))
    if (
      result.mask_logits?.dims.join(',') !== '1,3,256,256' ||
      result.iou_scores?.dims.join(',') !== '1,3'
    )
      throw new Error('The pinned decoder returned unsupported output.')
    if (
      !Object.values(result).every(
        (tensor) => tensor.type === 'float32' && tensor.data.every(Number.isFinite),
      )
    )
      throw new Error('The pinned decoder returned nonfinite output.')
  }
  report.after = await drmClients()
  report.activeDevices = [
    ...new Set(
      report.after
        .filter((client) => {
          const previous = report.before.find(
            (entry) => entry.device === client.device && entry.clientId === client.clientId,
          )
          return Object.entries(client.engines).some(
            ([engine, nanoseconds]) =>
              BigInt(nanoseconds) > BigInt(previous?.engines[engine] ?? '0'),
          )
        })
        .map((client) => client.device),
    ),
  ]
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  for (const tensor of tensors) {
    try {
      tensor.dispose()
    } catch (error) {
      recordFailure('tensor disposal', error)
    }
  }
  for (const session of sessions.reverse()) {
    try {
      session.endProfiling()
    } catch (error) {
      recordFailure('end profiling', error)
    }
    try {
      await session.release()
    } catch (error) {
      recordFailure('session release', error)
    }
  }
  await collectProfiles()
  try {
    await writeFile(
      join(outputDirectory, 'runtime-device.json'),
      JSON.stringify(report, null, 2) + '\n',
    )
  } catch (error) {
    recordFailure('report publication', error)
    console.error(report.error, report.errors)
  }
}
