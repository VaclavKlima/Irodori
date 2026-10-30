import { expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NativeCpuController,
  type CpuControllerOptions,
  type CpuWorkingLease,
} from '../src/main/native-cpu-controller'
import type { CpuPreviewRequest, CpuPreviewSourceRef } from '../src/shared/native-cpu-preview'
import { NATIVE_CPU_PREVIEW_VERSION } from '../src/shared/native-cpu-preview'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { NATIVE_HDR_MASK_VERSION, type NativeHdrMaskRequest } from '../src/shared/native-hdr-mask'
import {
  adjustHdr,
  contentHdr,
  encodeHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  SDR_TARGET,
  HDR_SOURCE_VERSION,
  hdrSourceVersion,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { hdrRangeColor } from '../src/renderer/src/preview/hdr-ranges'
import { nativeCpuExistingOwners } from '../src/shared/native-cpu-memory'
import { resolveResourcePolicy, type ResourcePolicySnapshot } from '../src/shared/resource-policy'

export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export const observed = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
export async function valueOf<T>(promise: ReturnType<typeof observed<T>>) {
  const result = await promise
  if (!result.ok) throw result.error
  return result.value
}
export async function rejected<T>(promise: ReturnType<typeof observed<T>>, message: RegExp) {
  const result = await promise
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('Expected a rejected controller request.')
  expect(String(result.error)).toMatch(message)
}
export function resourcePolicy(revision = 1, ramMiB = 2048, vramMiB = 2048) {
  return resolveResourcePolicy(
    { version: 1, ramMiB, vramMiB },
    {
      ram: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
      gpu: { status: 'unknown', reason: 'adapter-unverified' },
    },
    revision,
  )
}
export async function realNativeExecutable() {
  const executable = process.env.IRODORI_NATIVE_CPU_RENDER_TEST_EXECUTABLE
  if (!executable || !isAbsolute(executable))
    throw new Error(
      'Set IRODORI_NATIVE_CPU_RENDER_TEST_EXECUTABLE to the absolute verified stdin-capable Rust helper; native coverage is not optional.',
    )
  await access(executable, constants.X_OK)
  return executable
}
export interface SourceRecord {
  readonly ref: CpuPreviewSourceRef
  readonly asset: HdrWorkingAsset
  readonly pixels: Float32Array<ArrayBuffer>
  readonly bytes: Buffer
  readonly path: string
  acquisitions: number
  releases: number
  valid: boolean
  revision: number
  readonly handles: Set<FileHandle>
}
export interface ChildEvent {
  event: string
  generation: number
  pid: number
  code?: number
  phase?: 'before' | 'after'
}
interface FixtureOptions {
  nativeExecutable?: string
  synthetic?: {
    holdGenerations?: number[]
    holdBeforeGenerations?: number[]
    nonzeroGenerations?: number[]
    maskHoldOutput?: number[]
    maskHoldExit?: number[]
    maskFaults?: Record<number, string>
  }
  mask?: {
    arithmeticSha256: string
    parameters?: (record: SourceRecord, request: NativeHdrMaskRequest) => AdjustmentParameters
    checkTarget?: (request: Pick<NativeHdrMaskRequest, 'domain' | 'target' | 'source'>) => void
    policy?: () => ResourcePolicySnapshot
  }
  foreground?: CpuControllerOptions['foreground']
  policy?: () => Promise<ResourcePolicySnapshot>
  check?: (record: SourceRecord, signal: AbortSignal, directory: string) => Promise<void>
  release?: (record: SourceRecord) => Promise<void>
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}
export async function controllerFixture(options: FixtureOptions = {}) {
  // Missing native coverage must fail without leaving a temporary profile behind.
  const nativeExecutable = options.synthetic
    ? undefined
    : (options.nativeExecutable ?? (await realNativeExecutable()))
  const root = await mkdtemp(join(tmpdir(), 'irodori-native-cpu-controller-'))
  const directory = join(root, 'cpu-presentations'),
    control = join(root, 'protocol-control')
  await mkdir(control)
  const records: SourceRecord[] = []
  let policyCalls = 0,
    executableCalls = 0
  let policy = options.policy ?? (async () => resourcePolicy(policyCalls))
  let executable: string
  if (options.synthetic) {
    const config = join(control, 'config.json'),
      wrapper = join(control, 'protocol-child')
    await writeFile(
      config,
      JSON.stringify({
        directory: control,
        holdGenerations: options.synthetic.holdGenerations ?? [],
        holdBeforeGenerations: options.synthetic.holdBeforeGenerations ?? [],
        nonzeroGenerations: options.synthetic.nonzeroGenerations ?? [],
        maskHoldOutput: options.synthetic.maskHoldOutput ?? [],
        maskHoldExit: options.synthetic.maskHoldExit ?? [],
        maskFaults: options.synthetic.maskFaults ?? {},
      }),
      { mode: 0o600 },
    )
    // An actual child process, deliberately distinguishable from the Rust helper.
    // exec preserves the spawned group leader PID for cancellation observations.
    const script = fileURLToPath(new URL('./native-cpu-protocol-child.mjs', import.meta.url)),
      maskScript = fileURLToPath(new URL('./native-hdr-mask-protocol-child.mjs', import.meta.url))
    await writeFile(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "--mask-v1" ]; then\n  exec ${shellQuote(process.execPath)} ${shellQuote(maskScript)} ${shellQuote(config)} "$@"\nfi\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(config)} "$@"\n`,
      { mode: 0o700 },
    )
    executable = wrapper
  } else executable = nativeExecutable!
  const source = async (
    label: string,
    width = 7,
    height = 129,
    supplied?: Float32Array<ArrayBuffer>,
  ): Promise<SourceRecord> => {
    const pixels = supplied ? new Float32Array(supplied) : new Float32Array(width * height * 4)
    if (pixels.length !== width * height * 4)
      throw new Error('Invalid isolated source fixture geometry.')
    for (let index = 0; !supplied && index < width * height; index++) {
      const level = [0, 0.004, 0.02, 0.18, 0.4, 0.9, 1.5, 3][index % 8]
      pixels.set([level, level * 0.9, level * 0.7, [0, 0.25, 0.5, 1][index % 4]], index * 4)
    }
    const bytes = Buffer.from(pixels.buffer),
      hash = sha(bytes),
      path = join(root, `${label}.f32`)
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    const asset: HdrWorkingAsset = {
      kind: 'hdr-working-v1',
      width,
      height,
      byteLength: bytes.length,
      sha256: hash,
      strips: Array.from({ length: Math.ceil(height / 64) }, (_, index) => {
        const part = bytes.subarray(
          index * width * 64 * 16,
          Math.min(height, (index + 1) * 64) * width * 16,
        )
        return { byteLength: part.length, sha256: sha(part) }
      }),
      source: {
        version: HDR_SOURCE_VERSION,
        processing: 'hdr-v1',
        colorSpace: 'rec2020',
        whitePoint: 'D65',
        transfer: 'linear',
        alpha: 'straight',
        decoder: 'synthetic-controller-contract-fixture',
        orientation: 'applied-once',
        cameraProfile: 'synthetic-controller-contract-fixture',
        normalization: {
          black: [0, 0, 0, 0],
          maximum: 65535,
          gains: [1, 1, 1, 1],
          restoreGain: 1,
          referenceWhite: 1,
          sourceSaturation: null,
        },
      },
    }
    const record: SourceRecord = {
      ref: {
        photoId: sha(label),
        cacheId: randomUUID(),
        workingSha256: hash,
        renderingIdentity: `${hdrSourceVersion(asset.source)}-${hash}`,
      },
      asset,
      pixels,
      bytes,
      path,
      acquisitions: 0,
      releases: 0,
      valid: true,
      revision: 1,
      handles: new Set(),
    }
    records.push(record)
    return record
  }
  const acquireSource = async (request: Pick<CpuPreviewRequest, 'source'>, signal: AbortSignal) => {
    const record = records.find((entry) => entry.ref.cacheId === request.source.cacheId)
    if (!record || JSON.stringify(record.ref) !== JSON.stringify(request.source))
      throw new Error('Unknown test-domain source reference.')
    signal.throwIfAborted()
    const file = await open(record.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    record.acquisitions++
    record.handles.add(file)
    let released = false
    const lease: CpuWorkingLease = {
      source: structuredClone(record.ref),
      asset: structuredClone(record.asset),
      file,
      check: async (revision, activeSignal) => {
        activeSignal.throwIfAborted()
        if (!record.valid || revision !== record.revision)
          throw new Error('Test source revision became invalid.')
        await file.stat() // Reusing a released owner is observable as a closed descriptor.
        await options.check?.(record, activeSignal, directory)
        activeSignal.throwIfAborted()
      },
      release: async () => {
        if (released) return
        released = true
        try {
          await options.release?.(record)
        } finally {
          try {
            await file.close()
          } finally {
            record.handles.delete(file)
            record.releases++
          }
        }
      },
    }
    return lease
  }
  const controller = new NativeCpuController({
    root: directory,
    executable: async () => {
      executableCalls++
      return executable
    },
    policy: async () => {
      policyCalls++
      return policy()
    },
    acquireSource,
    foreground:
      options.foreground ??
      (async (work, signal) => {
        signal.throwIfAborted()
        return work()
      }),
    mask: options.mask
      ? {
          arithmeticSha256: options.mask.arithmeticSha256,
          checkTarget: options.mask.checkTarget ?? (() => undefined),
          acquireSource: async (request, signal) => {
            const lease = await acquireSource(request, signal),
              record = records.find((entry) => entry.ref.cacheId === request.source.cacheId)!
            return {
              ...lease,
              parameters: options.mask!.parameters?.(record, request) ?? { ...neutralAdjustments },
              policy: options.mask!.policy?.() ?? resourcePolicy(1),
            }
          },
        }
      : undefined,
    existingOwners: (asset, request) =>
      nativeCpuExistingOwners(
        asset.width,
        asset.height,
        Math.round(request.viewport.width * request.viewport.dpr),
        Math.round(request.viewport.height * request.viewport.dpr),
      ),
  })
  await controller.open()
  const sessionId = randomUUID()
  let generation = 0
  const request = (
    record: SourceRecord,
    patch: Partial<CpuPreviewRequest> = {},
  ): CpuPreviewRequest => ({
    version: NATIVE_CPU_PREVIEW_VERSION,
    requestId: randomUUID(),
    sessionId,
    source: structuredClone(record.ref),
    generation: ++generation,
    expectedSettingsRevision: record.revision,
    parameters: { ...neutralAdjustments },
    quality: 'normal',
    hdrRanges: false,
    headroom: null,
    viewport: { width: 64, height: 32, dpr: 1 },
    ...patch,
  })
  const maskRequest = (
    record: SourceRecord,
    patch: Partial<NativeHdrMaskRequest> = {},
  ): NativeHdrMaskRequest => ({
    version: NATIVE_HDR_MASK_VERSION,
    requestId: randomUUID(),
    sessionId,
    source: structuredClone(record.ref),
    generation: ++generation,
    expectedSettingsRevision: record.revision,
    comparison: 'after',
    domain: 'output',
    parameters: { ...neutralAdjustments },
    target: { ...SDR_TARGET },
    existingOwners: { ramBytes: 0, vramBytes: 0 },
    ...patch,
  })
  const events = async (): Promise<ChildEvent[]> => {
    let text = ''
    try {
      text = await readFile(join(control, 'events.jsonl'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return text
      .split('\n')
      .slice(0, -1)
      .map((line: string) => JSON.parse(line) as ChildEvent)
  }
  const event = async (name: string, forGeneration: number) => {
    await expect
      .poll(
        async () =>
          (await events()).some(
            (entry) => entry.event === name && entry.generation === forGeneration,
          ),
        { timeout: 5000, intervals: [1, 5, 10, 25] },
      )
      .toBe(true)
    return (await events()).find(
      (entry) => entry.event === name && entry.generation === forGeneration,
    )!
  }
  return {
    root,
    directory,
    control,
    controller,
    source,
    request,
    maskRequest,
    events,
    event,
    records,
    executable,
    executableCalls: () => executableCalls,
    policyCalls: () => policyCalls,
    setPolicy: (next: () => Promise<ResourcePolicySnapshot>) => {
      policy = next
    },
    allow: (name: 'output' | 'exit', forGeneration: number) =>
      writeFile(join(control, `allow-${name}-${forGeneration}`), ''),
    close: async () => {
      // Every synthetic hold gets a release even if an assertion failed. Await
      // controller close BEFORE deleting its evidence or manually closing leaks.
      for (const at of new Set([
        ...(options.synthetic?.holdGenerations ?? []),
        ...(options.synthetic?.holdBeforeGenerations ?? []),
        ...(options.synthetic?.maskHoldOutput ?? []),
        ...(options.synthetic?.maskHoldExit ?? []),
      ])) {
        await writeFile(join(control, `allow-output-${at}`), '').catch(() => undefined)
        await writeFile(join(control, `allow-exit-${at}`), '').catch(() => undefined)
      }
      try {
        await controller.close()
      } finally {
        await Promise.allSettled(
          records.flatMap((record) => [...record.handles].map((file) => file.close())),
        )
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

export async function readPlane(controller: NativeCpuController, url: string) {
  const owner = controller.acquire(new URL(url))
  if (!owner) throw new Error('Expected an available owned CPU plane.')
  try {
    const bytes = await readFile(owner.path)
    expect(bytes.length).toBe(owner.byteLength)
    return bytes
  } finally {
    owner.release()
  }
}
/** Independent unchanged application CPU functions, not native generated math or
 * its request encoder. This deliberately covers tiny full-resolution fixtures. */
export function cpuOracle(
  record: Pick<SourceRecord, 'pixels' | 'asset'>,
  request: CpuPreviewRequest,
) {
  const after = new Uint8ClampedArray(record.asset.width * record.asset.height * 4)
  const before = new Uint8ClampedArray(after.length),
    wb = hdrAdjustmentMatrix(request.parameters, record.asset.whiteBalance) ?? undefined
  for (let index = 0; index < after.length / 4; index++) {
    const at = index * 4,
      rgb: [number, number, number] = [
        record.pixels[at],
        record.pixels[at + 1],
        record.pixels[at + 2],
      ]
    const adjusted = adjustHdr(rgb, request.parameters, wb),
      target = { ...SDR_TARGET, headroom: request.headroom }
    const ranges = (value: [number, number, number]) =>
      request.hdrRanges
        ? hdrRangeColor(
            contentHdr(value, record.asset.source).rgb,
            target,
            index % record.asset.width,
            Math.floor(index / record.asset.width),
          )
        : null
    for (const [output, value] of [
      [after, adjusted],
      [before, rgb],
    ] as const) {
      const converted = outputHdr(value, SDR_TARGET, record.asset.source).rgb,
        range = ranges(value)
      for (let channel = 0; channel < 3; channel++)
        output[at + channel] = Math.round((range?.[channel] ?? encodeHdr(converted[channel])) * 255)
      output[at + 3] = Math.round(record.pixels[at + 3] * 255)
    }
  }
  return { after: Buffer.from(after), before: Buffer.from(before) }
}
export async function scratchNames(directory: string) {
  return (await readdir(directory)).filter((name) => name.startsWith('cpu-'))
}
export function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
