import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { sameAdjustments, type AdjustmentParameters } from '../shared/adjustments'
import { REC2020_TO_ACES } from '../shared/display-rendering'
import { validateProcessingPatch } from '../shared/edits'
import { preparedToneCurves } from '../shared/tone-curves'
import { hasLocalMasks } from '../shared/masks-gpu'
import {
  hdrAdjustmentMatrix,
  REC2020_TO_P3,
  REC2020_TO_SRGB,
  validateHdrSource,
  validateTarget,
  type HdrWorkingAsset,
} from '../shared/hdr'
import {
  NATIVE_MASK_COLOR_OFFSET,
  NATIVE_MASK_REQUEST_BYTES,
  nativeColorValues,
} from '../shared/native-color-protocol'
import {
  NATIVE_HDR_MASK_VERSION,
  type NativeHdrMaskDeclined,
  type NativeHdrMaskRequest,
  type NativeHdrMaskResult,
} from '../shared/native-hdr-mask'
import { nativeHdrMaskMemory } from '../shared/native-hdr-mask-memory'
import { validatePreparedHdrSourceRef, type PreparedHdrSourceRef } from '../shared/prepared-source'
import { validateManagedImageBytes, type ResourcePolicySnapshot } from '../shared/resource-policy'
import { attestAndFeedCpuMaskSource } from './native-cpu-input'
import { writeNativeCpuMask } from './native-cpu-mask-sink'

export interface HdrMaskSourceLease extends PreparedHdrSourceLease {
  /** Actual main-selected confirmed Before/After parameters. */
  readonly parameters: AdjustmentParameters
  readonly policy: Readonly<ResourcePolicySnapshot>
  /** True only after the prior JS full scan's actual strip/hash drain. */
  readonly replacesDrainedJsScan?: boolean
}

export interface PreparedHdrSourceLease {
  readonly source: PreparedHdrSourceRef
  readonly asset: HdrWorkingAsset
  readonly file: FileHandle
  /** Recheck current revision, lens/correction source key and source existence. */
  check(expectedSettingsRevision: number, signal: AbortSignal): Promise<void>
  /** Idempotent: close fd before releasing its exact cache-entry pin. */
  release(): Promise<void>
}
export interface NativeMaskControllerOptions {
  readonly root: string
  readonly executable: () => Promise<string>
  readonly foreground: <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T>
  readonly mask?: {
    readonly arithmeticSha256: string
    readonly acquireSource: (
      request: NativeHdrMaskRequest,
      signal: AbortSignal,
    ) => Promise<HdrMaskSourceLease>
    readonly checkTarget: (
      request: Pick<NativeHdrMaskRequest, 'domain' | 'target' | 'source' | 'comparisonOf'>,
    ) => void
  }
}
/** Only controller-owned lifecycle transitions are expected cancellation. */
export class NativeMaskCancelled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeMaskCancelled'
  }
}
interface TicketBase {
  abort: AbortController
  admitted: boolean
  reject: (error: unknown) => void
  drained: Promise<void>
  finishDrain: () => void
}
interface MaskTicket extends TicketBase {
  request: NativeHdrMaskRequest
  resolve: (result: NativeHdrMaskResult | NativeHdrMaskDeclined) => void
}
type Ticket = MaskTicket
interface MaskOutput {
  result: NativeHdrMaskResult
  directory: string
  retained: boolean
  pins: number
  drained: Promise<void>
  finishDrain: () => void
  failDrain: (error: unknown) => void
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const sha = /^[a-f0-9]{64}$/
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const sameSource = (a: PreparedHdrSourceRef, b: PreparedHdrSourceRef) =>
  a.photoId === b.photoId &&
  a.cacheId === b.cacheId &&
  a.renderingIdentity === b.renderingIdentity &&
  a.workingSha256 === b.workingSha256
function validateMask(value: NativeHdrMaskRequest) {
  const keys = [
    'version',
    'requestId',
    'sessionId',
    'source',
    'comparisonOf',
    'generation',
    'expectedSettingsRevision',
    'comparison',
    'domain',
    'parameters',
    'target',
    'existingOwners',
  ]
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![keys.length - 1, keys.length].includes(Object.keys(value).length) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== NATIVE_HDR_MASK_VERSION ||
    !uuid.test(value.requestId) ||
    !uuid.test(value.sessionId) ||
    !value.source ||
    typeof value.source !== 'object' ||
    Object.keys(value.source).sort().join(',') !==
      'cacheId,photoId,renderingIdentity,workingSha256' ||
    !sha.test(value.source.photoId) ||
    !uuid.test(value.source.cacheId) ||
    !sha.test(value.source.workingSha256) ||
    typeof value.source.renderingIdentity !== 'string' ||
    !value.source.renderingIdentity ||
    value.source.renderingIdentity.length > 512 ||
    ![value.generation, value.expectedSettingsRevision].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !['before', 'after'].includes(value.comparison) ||
    !['working-hdr', 'content-hdr', 'output'].includes(value.domain)
  )
    throw new Error('Invalid native HDR mask request.')
  if (value.comparisonOf !== undefined) {
    validatePreparedHdrSourceRef(value.comparisonOf)
    if (value.comparison !== 'before' || value.comparisonOf.photoId !== value.source.photoId)
      throw new Error('Invalid native Before mask lineage.')
  }
  if (
    !value.parameters ||
    [
      'exposureEv',
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'saturation',
      'vibrance',
    ].some((key) => typeof value.parameters[key as keyof typeof value.parameters] !== 'number')
  )
    throw new Error('Native mask requires complete confirmed Light parameters.')
  validateProcessingPatch(value.parameters)
  if (hasLocalMasks(value.parameters))
    throw new Error('Clipping overlays with local masks require a qualified GPU analysis path.')
  if (!preparedToneCurves(value.parameters.curves).identity)
    throw new Error(
      'Clipping overlays with active curves require a qualified GPU mask path. The photograph and histogram remain available.',
    )
  validateTarget(value.target)
  if (
    value.target.headroom !== null &&
    (!Number.isFinite(value.target.headroom) ||
      value.target.headroom < 1 ||
      value.target.headroom > 100)
  )
    throw new Error('Invalid native mask target headroom.')
  validateManagedImageBytes(value.existingOwners)
}

/** One child and one latest ticket; no new scheduler/LRU/issued-policy registry. */
export class NativeMaskController {
  private pending?: Ticket
  private current?: Ticket
  private work?: Promise<void>
  private masks = new Map<string, MaskOutput>()
  private closed = false
  private cleanup?: Promise<void>
  constructor(private readonly options: NativeMaskControllerOptions) {}

  /** Startup only, before IPC installation. Never inspect/remove source bundles. */
  async open() {
    if (this.work || this.masks.size)
      throw new Error('Native mask startup cleanup requires an idle controller.')
    await mkdir(this.options.root, { recursive: true })
    for (const entry of await readdir(this.options.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^cpu-(?:mask-)?[A-Za-z0-9]+$/.test(entry.name))
        await rm(join(this.options.root, entry.name), { recursive: true, force: true })
    }
  }

  private start() {
    if (this.work || this.cleanup || this.closed) return
    const work = this.pump()
    this.work = work
    const finished = () => {
      if (this.work === work) this.work = undefined
      if (this.pending) this.start()
    }
    void work.then(finished, finished)
  }
  private async pump() {
    // Cleanup waits this pump's existing work. Return at its barrier rather
    // than awaiting it, which would make retirement wait on itself.
    while (this.pending && !this.cleanup && !this.closed) {
      const ticket = this.pending
      this.pending = undefined
      this.current = ticket
      try {
        const admitted = async () => {
          ticket.abort.signal.throwIfAborted()
          const cleanup = this.cleanup
          if (cleanup) await cleanup
          ticket.abort.signal.throwIfAborted()
          ticket.admitted = true
        }
        ticket.resolve(
          await this.options.foreground(async () => {
            await admitted()
            return this.performMask(ticket)
          }, ticket.abort.signal),
        )
      } catch (error) {
        ticket.reject(error)
      } finally {
        if (this.current === ticket) this.current = undefined
        ticket.finishDrain()
      }
    }
  }
  renderMask(value: NativeHdrMaskRequest): Promise<NativeHdrMaskResult | NativeHdrMaskDeclined> {
    validateMask(value)
    if (this.closed)
      return Promise.reject(new NativeMaskCancelled('Native mask controller is closed.'))
    const request = structuredClone(value)
    const declined = (reason: NativeHdrMaskDeclined['reason']): NativeHdrMaskDeclined => ({
      kind: 'mask-declined',
      version: NATIVE_HDR_MASK_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      generation: request.generation,
      reason,
    })
    // A completed receiver keeps its reservation until actual stream drainage.
    if (this.masks.size) return Promise.resolve(declined('previous-receiver'))
    this.pending?.reject(new NativeMaskCancelled('Native mask superseded before admission.'))
    this.pending?.finishDrain()
    this.current?.abort.abort(new NativeMaskCancelled('Native mask superseded.'))
    const result = new Promise<NativeHdrMaskResult | NativeHdrMaskDeclined>((resolve, reject) => {
      let finishDrain!: () => void
      const drained = new Promise<void>((done) => {
        finishDrain = done
      })
      this.pending = {
        request,
        abort: new AbortController(),
        admitted: false,
        resolve,
        reject,
        drained,
        finishDrain,
      }
    })
    this.start()
    return result
  }
  private async performMask(
    ticket: MaskTicket,
  ): Promise<NativeHdrMaskResult | NativeHdrMaskDeclined> {
    const { request, abort } = ticket,
      signal = abort.signal,
      configuration = this.options.mask
    signal.throwIfAborted()
    if (!configuration) throw new Error('Native HDR mask integration is not installed.')
    const decline = (reason: NativeHdrMaskDeclined['reason']): NativeHdrMaskDeclined => ({
      kind: 'mask-declined',
      version: NATIVE_HDR_MASK_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      generation: request.generation,
      reason,
    })
    if (this.masks.size) return decline('previous-receiver')
    configuration.checkTarget(request)
    const lease = await configuration.acquireSource(request, signal)
    let directory: string | undefined,
      output: FileHandle | undefined,
      keep = false,
      published: MaskOutput | undefined
    const perform = async () => {
      await lease.check(request.expectedSettingsRevision, signal)
      configuration.checkTarget(request)
      const policy = Object.freeze(structuredClone(lease.policy))
      if (
        policy.version !== 'managed-image-memory-v1' ||
        policy.scope !== 'managed-image-resources' ||
        !Number.isSafeInteger(policy.revision) ||
        policy.revision < 0 ||
        ![policy.ram.effectiveBytes, policy.vram.effectiveBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new Error('The native mask frozen source policy changed.')
      validateProcessingPatch(lease.parameters)
      if (!sameAdjustments(lease.parameters, request.parameters))
        throw new Error('Native mask parameters do not match confirmed Before/After history.')
      if (
        !sameSource(lease.source, request.source) ||
        lease.asset.sha256 !== request.source.workingSha256 ||
        lease.asset.byteLength !== lease.asset.width * lease.asset.height * 16
      )
        throw new Error('The native mask lease does not match its exact source.')
      validateHdrSource(lease.asset.source)
      // Always reserve the eight-participant envelope; execution can choose less.
      const plan = nativeHdrMaskMemory(
        lease.asset.width,
        lease.asset.height,
        request.existingOwners,
        policy,
        lease.replacesDrainedJsScan === true,
      )
      if (!plan.accepted) return decline('memory-limit')
      const available = availableParallelism(),
        threads: 1 | 4 | 8 = available >= 10 ? 8 : available >= 6 ? 4 : 1,
        executable = await this.options.executable()
      signal.throwIfAborted()
      await mkdir(this.options.root, { recursive: true })
      signal.throwIfAborted()
      directory = await mkdtemp(join(this.options.root, 'cpu-mask-'))
      if (!sha.test(configuration.arithmeticSha256))
        throw new Error('Invalid trusted mask arithmetic manifest hash.')
      const encoded = this.encodeMask(
          request,
          lease.asset,
          lease.parameters,
          configuration.arithmeticSha256,
        ),
        requestPath = join(directory, 'request.bin')
      await writeFile(requestPath, encoded, { flag: 'wx', mode: 0o600 })
      output = await open(join(directory, 'mask.r8'), 'wx', 0o600)
      const native = await this.maskChild(
        executable,
        requestPath,
        encoded,
        lease,
        output,
        threads,
        abort,
      )
      await output.close()
      output = undefined
      signal.throwIfAborted()
      await lease.check(request.expectedSettingsRevision, signal)
      configuration.checkTarget(request)
      const maskId = randomUUID(),
        result: NativeHdrMaskResult = {
          kind: 'mask',
          version: NATIVE_HDR_MASK_VERSION,
          requestId: request.requestId,
          sessionId: request.sessionId,
          maskId,
          source: lease.source,
          ...(request.comparisonOf ? { comparisonOf: request.comparisonOf } : {}),
          generation: request.generation,
          settingsRevision: request.expectedSettingsRevision,
          comparison: request.comparison,
          domain: request.domain,
          parameters: lease.parameters,
          target: request.target,
          policy,
          width: lease.asset.width,
          height: lease.asset.height,
          format: 'r8-hdr-mask-bits-v1',
          arithmeticSha256: configuration.arithmeticSha256,
          byteLength: native.output.byteLength,
          sha256: native.output.sha256,
          url: `irodori-photo://library/${request.source.photoId}/mask/${maskId}`,
          additionalReservation: plan.additional,
        }
      await writeFile(join(directory, 'manifest.pending'), JSON.stringify(result), {
        flag: 'wx',
        mode: 0o600,
      })
      signal.throwIfAborted()
      await lease.check(request.expectedSettingsRevision, signal)
      configuration.checkTarget(request)
      await rename(join(directory, 'manifest.pending'), join(directory, 'manifest.json'))
      signal.throwIfAborted()
      await lease.check(request.expectedSettingsRevision, signal)
      configuration.checkTarget(request)
      let finishDrain!: () => void, failDrain!: (error: unknown) => void
      const drained = new Promise<void>((resolve, reject) => {
        finishDrain = resolve
        failDrain = reject
      })
      // A rejection is observed until a retirement/release caller awaits it.
      void drained.catch(() => undefined)
      published = { result, directory, pins: 0, retained: true, drained, finishDrain, failDrain }
      this.masks.set(maskId, published)
      keep = true
      return result
    }
    const failures: unknown[] = []
    let result: NativeHdrMaskResult | NativeHdrMaskDeclined | undefined
    try {
      result = await perform()
    } catch (error) {
      failures.push(error)
    }
    try {
      await output?.close()
    } catch (error) {
      failures.push(error)
      keep = false
    }
    // Child/sink/feed settle before maskChild returns or rejects; source FD and
    // its exact cache pin cannot leave earlier, including native cancellation.
    try {
      await lease.release()
    } catch (error) {
      failures.push(error)
      keep = false
    }
    if ((!keep || signal.aborted) && published) {
      keep = false
      try {
        await this.dropMask(published)
      } catch (error) {
        failures.push(error)
      }
    }
    if (!keep && directory) {
      try {
        await rm(directory, { recursive: true, force: true })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1)
      throw new AggregateError(failures, 'Native mask work and cleanup failed.')
    signal.throwIfAborted()
    return result!
  }
  private encodeMask(
    request: NativeHdrMaskRequest,
    asset: HdrWorkingAsset,
    parameters: AdjustmentParameters,
    arithmeticSha256: string,
  ) {
    const data = Buffer.alloc(NATIVE_MASK_REQUEST_BYTES),
      wb = hdrAdjustmentMatrix(parameters, asset.whiteBalance),
      flags =
        Number(Boolean(wb)) |
        (Number(Boolean(asset.source.display)) << 1) |
        (Number(request.target.headroom !== null) << 4)
    data.write('MASKCPU3')
    data.writeUInt32LE(3, 8)
    data.writeUInt32LE(flags, 12)
    data.writeUInt32LE(asset.width, 16)
    data.writeUInt32LE(asset.height, 20)
    data.writeUInt32LE(64, 24)
    data.writeBigUInt64LE(BigInt(asset.byteLength), 32)
    Buffer.from(asset.sha256, 'hex').copy(data, 40)
    Buffer.from(hash(JSON.stringify({ request, parameters, asset, arithmeticSha256 })), 'hex').copy(
      data,
      72,
    )
    ;[
      parameters.exposureEv,
      parameters.contrast,
      parameters.highlights,
      parameters.shadows,
      parameters.whites,
      parameters.blacks,
    ].forEach((value, index) => data.writeDoubleLE(value, 104 + index * 8))
    ;(wb ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).forEach((value, index) =>
      data.writeDoubleLE(value, 152 + index * 8),
    )
    REC2020_TO_ACES.flat().forEach((value, index) => data.writeDoubleLE(value, 224 + index * 8))
    ;(request.target.colorSpace === 'display-p3' ? REC2020_TO_P3 : REC2020_TO_SRGB).forEach(
      (value, index) => data.writeDoubleLE(value, 296 + index * 8),
    )
    data.writeDoubleLE(request.target.peak, 368)
    data.writeDoubleLE(request.target.headroom ?? 0, 376)
    Buffer.from(arithmeticSha256, 'hex').copy(data, 384)
    data.writeDoubleLE(parameters.saturation, 416)
    data.writeDoubleLE(parameters.vibrance, 424)
    nativeColorValues(parameters).forEach((value, index) =>
      data.writeDoubleLE(value, NATIVE_MASK_COLOR_OFFSET + index * 8),
    )
    return data
  }
  private async maskChild(
    executable: string,
    requestPath: string,
    encoded: Buffer,
    lease: PreparedHdrSourceLease,
    file: FileHandle,
    threads: 1 | 4 | 8,
    abort: AbortController,
  ) {
    abort.signal.throwIfAborted()
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(executable, ['--mask-v1', requestPath, String(threads)], {
      detached: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let ended = false,
      stderr = '',
      force: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (ended || !child.pid) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      force ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, 1500)
      child.stdin.destroy()
      child.stdout.destroy()
    }
    const fail = (error: unknown) => {
      if (!abort.signal.aborted) abort.abort(error)
      stop()
    }
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stderr.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-65536)
    })
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', fail)
      child.once('close', (code, signal) => {
        ended = true
        if (force) clearTimeout(force)
        if (code === 0 && !signal) resolve()
        else reject(new Error(`Native mask stopped (${code}/${signal}): ${stderr}`))
      })
    })
    const timeout = setTimeout(() => fail(new Error('Native mask timed out.')), 10 * 60_000)
    abort.signal.addEventListener('abort', stop, { once: true })
    const input = attestAndFeedCpuMaskSource(lease.file, lease.asset, child.stdin, abort.signal),
      output = writeNativeCpuMask({
        stdout: child.stdout,
        expectedRequest: encoded,
        threads,
        closedSuccessfully: closed,
        file,
        signal: abort.signal,
      }),
      observe = <T>(work: Promise<T>) =>
        work.catch((error: unknown) => {
          fail(error)
          throw error
        })
    try {
      const settled = await Promise.allSettled([observe(input), observe(output), observe(closed)])
      abort.signal.throwIfAborted()
      for (const result of settled) if (result.status === 'rejected') throw result.reason
      return { input: await input, output: await output }
    } finally {
      clearTimeout(timeout)
      if (force) clearTimeout(force)
      abort.signal.removeEventListener('abort', stop)
    }
  }
  acquireMask(url: URL) {
    if (
      url.protocol !== 'irodori-photo:' ||
      url.hostname !== 'library' ||
      url.search ||
      url.hash ||
      url.port ||
      url.username ||
      url.password
    )
      return
    const [photoId, kind, maskId, extra] = url.pathname.slice(1).split('/')
    if (kind !== 'mask' || extra !== undefined || !uuid.test(maskId ?? '')) return
    const entry = this.masks.get(maskId)
    if (!entry?.retained || entry.result.source.photoId !== photoId) return
    entry.pins++
    let released = false
    return {
      path: join(entry.directory, 'mask.r8'),
      contentType: 'application/octet-stream',
      byteLength: entry.result.byteLength,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        void this.pruneMask(entry)
      },
    }
  }
  async releaseMask(sessionId: string, maskId: string) {
    const entry = this.masks.get(maskId)
    if (entry?.result.sessionId === sessionId) await this.dropMask(entry)
  }
  private dropMask(entry: MaskOutput) {
    entry.retained = false
    void this.pruneMask(entry)
    return entry.drained
  }
  private async pruneMask(entry: MaskOutput) {
    if (entry.retained || entry.pins) return
    try {
      await rm(entry.directory, { recursive: true, force: true })
      if (this.masks.get(entry.result.maskId) === entry) this.masks.delete(entry.result.maskId)
      entry.finishDrain()
    } catch (error) {
      entry.failDrain(error)
    }
  }

  async cancelMask(sessionId: string, requestId: string) {
    if (
      this.pending &&
      this.pending.request.sessionId === sessionId &&
      this.pending.request.requestId === requestId
    ) {
      this.pending.reject(new NativeMaskCancelled('Native mask cancelled.'))
      this.pending.finishDrain()
      this.pending = undefined
    }
    if (
      this.current &&
      this.current.request.sessionId === sessionId &&
      this.current.request.requestId === requestId
    ) {
      const ticket = this.current
      ticket.abort.abort(new NativeMaskCancelled('Native mask cancelled.'))
      await ticket.drained
    }
  }
  beforeRemoval(photoId: string) {
    return this.retireOwners(
      (owner) => owner.source.photoId === photoId,
      'Native mask source removed.',
    )
  }
  private retireOwners(
    matches: (owner: Pick<NativeHdrMaskRequest, 'sessionId' | 'source'>) => boolean,
    reason: string,
  ): Promise<void> {
    const previous = this.cleanup
    const pending = this.pending && matches(this.pending.request) ? this.pending : undefined
    const current = this.current && matches(this.current.request) ? this.current : undefined
    // Stale release/unrelated removal owns nothing to retire and must not wait
    // or impose a cleanup barrier on an unrelated active native child.
    if (!pending && !current && ![...this.masks.values()].some((entry) => matches(entry.result)))
      return previous ?? Promise.resolve()
    // Matching queued work is aborted below, so its admission wait will drain.
    // Unrelated work still waiting behind a mutation has acquired no new owner;
    // awaiting it here would hold that mutation while waiting for it to finish.
    const work = current !== undefined || this.current?.admitted ? this.work : undefined
    const retire = async () => {
      const errors: unknown[] = []
      // Cleanup failure cannot release the old source while its child/parser or
      // temporary mask source lease is still draining.
      for (const result of await Promise.allSettled(
        [...this.masks.values()]
          .filter((entry) => matches(entry.result))
          .map((entry) => this.dropMask(entry)),
      ))
        if (result.status === 'rejected') errors.push(result.reason)
      try {
        await work
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'Native mask retirement failed after draining.')
    }
    // Install synchronously before abort can resume the pump. Requests arriving
    // during retirement use the same latest pending slot, without recursive
    // Promise callbacks admitting older requests one by one after the barrier.
    // A previous caller owns its rejection; this retirement still drains itself.
    // Revoke capabilities synchronously so deletion/reset cannot admit another
    // receiver while already-issued streams retain their pins through drainage.
    for (const entry of this.masks.values()) if (matches(entry.result)) entry.retained = false
    const cleanup = Promise.resolve(previous).then(retire, retire)
    this.cleanup = cleanup
    if (pending) {
      pending.reject(new NativeMaskCancelled(reason))
      pending.finishDrain()
      if (this.pending === pending) this.pending = undefined
    }
    current?.abort.abort(new NativeMaskCancelled(reason))
    const finished = () => {
      if (this.cleanup !== cleanup) return
      this.cleanup = undefined
      this.start()
    }
    void cleanup.then(finished, finished)
    return cleanup
  }
  reset(): Promise<void> {
    const reset = this.retireOwners(() => true, 'Native mask closed.')
    // An earlier retirement can already have detached the final owner while
    // its source close is pending. Global reset/shutdown still drains that work.
    return this.cleanup ?? reset
  }
  async close() {
    this.closed = true
    await this.reset()
  }
}
