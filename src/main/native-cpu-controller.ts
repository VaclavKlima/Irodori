import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
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
import { join } from 'node:path'
import { validateProcessingPatch } from '../shared/edits'
import {
  nativeColorValues,
  NATIVE_CPU_REQUEST_BYTES,
  NATIVE_MASK_REQUEST_BYTES,
  NATIVE_CPU_COLOR_OFFSET,
  NATIVE_MASK_COLOR_OFFSET,
} from '../shared/native-color-protocol'
import { sameAdjustments, neutralAdjustments } from '../shared/adjustments'
import {
  hdrAdjustmentMatrix,
  REC2020_TO_SRGB,
  REC2020_TO_P3,
  validateTarget,
  validateHdrSource,
  type HdrWorkingAsset,
} from '../shared/hdr'
import { REC2020_TO_ACES } from '../shared/display-rendering'
import type { ResourcePolicySnapshot } from '../shared/resource-policy'
import type {
  CpuPreviewRequest,
  CpuPreviewPair,
  CpuPreviewSourceRef,
} from '../shared/native-cpu-preview'
import {
  NATIVE_CPU_PREVIEW_VERSION,
  validateCpuPreviewSourceRef,
} from '../shared/native-cpu-preview'
import type { PreparedPreviewSourceRef } from '../shared/prepared-comparison'
import { NativeCpuBeforeCache, type CpuSampleStamp } from './native-cpu-before-cache'
import { nativeCpuMemory, type CpuManagedBytes } from '../shared/native-cpu-memory'
import { attestAndFeedCpuSource, attestAndFeedCpuMaskSource } from './native-cpu-input'
import { writeNativeCpuPair } from './native-cpu-pair-sink'
import { writeNativeCpuMask } from './native-cpu-mask-sink'
import {
  NATIVE_HDR_MASK_VERSION,
  type NativeHdrMaskRequest,
  type NativeHdrMaskResult,
  type NativeHdrMaskDeclined,
} from '../shared/native-hdr-mask'
import { nativeHdrMaskMemory } from '../shared/native-hdr-mask-memory'
import { validateManagedImageBytes } from '../shared/resource-policy'
import type { AdjustmentParameters } from '../shared/adjustments'

export interface CpuMaskSourceLease extends CpuWorkingLease {
  /** Actual main-selected confirmed Before/After parameters. */
  readonly parameters: AdjustmentParameters
  readonly policy: Readonly<ResourcePolicySnapshot>
  /** True only after the prior JS full scan's actual strip/hash drain. */
  readonly replacesDrainedJsScan?: boolean
}

export interface CpuWorkingLease {
  readonly source: CpuPreviewSourceRef
  readonly asset: HdrWorkingAsset
  readonly file: FileHandle
  /** Recheck current revision, lens/correction source key and source existence. */
  check(expectedSettingsRevision: number, signal: AbortSignal): Promise<void>
  /** Idempotent: close fd before releasing its exact cache-entry pin. */
  release(): Promise<void>
}
export interface CpuControllerOptions {
  readonly root: string
  readonly executable: () => Promise<string>
  readonly policy: () => Promise<ResourcePolicySnapshot>
  readonly acquireSource: (
    request: CpuPreviewRequest,
    signal: AbortSignal,
    comparisonOf?: PreparedPreviewSourceRef,
  ) => Promise<CpuWorkingLease>
  readonly foreground: <T>(work: () => Promise<T>, signal: AbortSignal) => Promise<T>
  /** Complete renderer analysis/overlay/cache allowances after old GPU retirement. */
  readonly existingOwners: (asset: HdrWorkingAsset, request: CpuPreviewRequest) => CpuManagedBytes
  readonly mask?: {
    /** Trusted bundle capability's actual arithmetic/source manifest hash. */
    readonly arithmeticSha256: string
    readonly acquireSource: (
      request: NativeHdrMaskRequest,
      signal: AbortSignal,
    ) => Promise<CpuMaskSourceLease>
    /** Existing main display-state snapshot; check complete pixel target before/after. */
    readonly checkTarget: (
      request: Pick<NativeHdrMaskRequest, 'domain' | 'target' | 'source' | 'comparisonOf'>,
    ) => void
  }
}
export class NativeCpuMemoryLimit extends Error {
  constructor(readonly policy: Readonly<ResourcePolicySnapshot>) {
    super('CPU preview exceeds its managed image resource budget.')
    this.name = 'NativeCpuMemoryLimit'
  }
}
/** Only controller-owned lifecycle transitions are expected cancellation. */
export class NativeCpuCancelled extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeCpuCancelled'
  }
}
interface TicketBase {
  abort: AbortController
  admitted: boolean
  reject: (error: unknown) => void
  drained: Promise<void>
  finishDrain: () => void
}
interface PresentationTicket extends TicketBase {
  kind: 'presentation'
  request: CpuPreviewRequest
  resolve: (pair: CpuPreviewPair) => void
}
interface MaskTicket extends TicketBase {
  kind: 'mask'
  request: NativeHdrMaskRequest
  resolve: (result: NativeHdrMaskResult | NativeHdrMaskDeclined) => void
}
type Ticket = PresentationTicket | MaskTicket
interface MaskOutput {
  result: NativeHdrMaskResult
  directory: string
  retained: boolean
  pins: number
  drained: Promise<void>
  finishDrain: () => void
  failDrain: (error: unknown) => void
}

interface Pair {
  result: CpuPreviewPair
  directory: string
  pins: number
  retained: boolean
  published: boolean
  drained?: Promise<void>
  finishDrain?: () => void
  failDrain?: (error: unknown) => void
}
interface Owner {
  sessionId: string
  source: CpuPreviewSourceRef
  policy: Readonly<ResourcePolicySnapshot>
  lease?: CpuWorkingLease
  beforeSource?: CpuPreviewSourceRef
  beforeLease?: CpuWorkingLease
  beforeCache?: NativeCpuBeforeCache
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const sha = /^[a-f0-9]{64}$/
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const sameSource = (a: CpuPreviewSourceRef, b: CpuPreviewSourceRef) =>
  a.photoId === b.photoId &&
  a.cacheId === b.cacheId &&
  a.renderingIdentity === b.renderingIdentity &&
  a.workingSha256 === b.workingSha256
const sameOptionalSource = (a?: CpuPreviewSourceRef, b?: CpuPreviewSourceRef) =>
  a && b ? sameSource(a, b) : a === b

function validate(value: CpuPreviewRequest) {
  const keys = [
    'version',
    'requestId',
    'sessionId',
    'source',
    'beforeSource',
    'generation',
    'expectedSettingsRevision',
    'parameters',
    'quality',
    'hdrRanges',
    'headroom',
    'viewport',
  ]
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== NATIVE_CPU_PREVIEW_VERSION ||
    typeof value.requestId !== 'string' ||
    !uuid.test(value.requestId) ||
    typeof value.sessionId !== 'string' ||
    !uuid.test(value.sessionId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.expectedSettingsRevision) ||
    value.expectedSettingsRevision < 0 ||
    !['draft', 'normal'].includes(value.quality) ||
    typeof value.hdrRanges !== 'boolean' ||
    (value.headroom !== null &&
      (!Number.isFinite(value.headroom) || value.headroom < 1 || value.headroom > 100)) ||
    !value.viewport ||
    Object.keys(value.viewport).sort().join(',') !== 'dpr,height,width' ||
    Object.values(value.viewport).some((v) => !Number.isFinite(v) || v <= 0) ||
    value.viewport.dpr > 8 ||
    value.viewport.width * value.viewport.dpr > 32768 ||
    value.viewport.height * value.viewport.dpr > 32768
  )
    throw new Error('Invalid native CPU preview request.')
  validateCpuPreviewSourceRef(value.source)
  if (value.beforeSource !== undefined) {
    validateCpuPreviewSourceRef(value.beforeSource)
    if (value.beforeSource.photoId !== value.source.photoId)
      throw new Error('CPU comparison belongs to another photograph.')
  }
  const parameters = value.parameters
  if (
    !parameters ||
    typeof parameters !== 'object' ||
    Object.keys(parameters).some(
      (key) =>
        ![
          'whiteBalance',
          'exposureEv',
          'contrast',
          'highlights',
          'shadows',
          'whites',
          'blacks',
          'saturation',
          'vibrance',
          'colorMixer',
          'colorGrading',
        ].includes(key),
    ) ||
    [
      'exposureEv',
      'contrast',
      'highlights',
      'shadows',
      'whites',
      'blacks',
      'saturation',
      'vibrance',
    ].some((key) => typeof parameters[key as keyof typeof parameters] !== 'number')
  )
    throw new Error('Native CPU preview requires complete Light parameters.')
  validateProcessingPatch(parameters)
}

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
    validateCpuPreviewSourceRef(value.comparisonOf)
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
export class NativeCpuController {
  private owner?: Owner
  private pending?: Ticket
  private current?: Ticket
  private work?: Promise<void>
  private pairs = new Map<string, Pair>()
  private masks = new Map<string, MaskOutput>()
  private closed = false
  private cleanup?: Promise<void>
  constructor(private readonly options: CpuControllerOptions) {}

  /** Startup only, before IPC installation. Never inspect/remove source bundles. */
  async open() {
    if (this.work || this.owner || this.pairs.size || this.masks.size)
      throw new Error('CPU preview startup cleanup requires an idle controller.')
    await mkdir(this.options.root, { recursive: true })
    for (const entry of await readdir(this.options.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^cpu-(?:mask-)?[A-Za-z0-9]+$/.test(entry.name))
        await rm(join(this.options.root, entry.name), { recursive: true, force: true })
    }
  }

  render(value: CpuPreviewRequest): Promise<CpuPreviewPair> {
    validate(value)
    if (this.closed)
      return Promise.reject(new NativeCpuCancelled('CPU preview controller is closed.'))
    const request = structuredClone(value)
    this.pending?.reject(new NativeCpuCancelled('CPU preview superseded before admission.'))
    this.pending?.finishDrain()
    this.current?.abort.abort(new NativeCpuCancelled('CPU preview superseded.'))
    const result = new Promise<CpuPreviewPair>((resolve, reject) => {
      let finishDrain!: () => void
      const drained = new Promise<void>((done) => {
        finishDrain = done
      })
      this.pending = {
        kind: 'presentation',
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
        if (ticket.kind === 'mask')
          ticket.resolve(
            await this.options.foreground(async () => {
              await admitted()
              return this.performMask(ticket)
            }, ticket.abort.signal),
          )
        else
          ticket.resolve(
            await this.options.foreground(async () => {
              await admitted()
              return this.perform(ticket)
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
  private async perform(ticket: PresentationTicket) {
    const { request, abort } = ticket,
      signal = abort.signal
    signal.throwIfAborted()
    // A completed mask receiver owns its scoped reservation until explicit
    // release after fetch/hash/reduction; no new presentation allocations first.
    await this.waitForMaskReceivers(signal)
    signal.throwIfAborted()
    if (this.owner?.sessionId !== request.sessionId) {
      const previousOwner = this.owner
      this.owner = undefined
      await this.dropPairs().finally(() => this.releaseOwner(previousOwner))
      const policy = structuredClone(await this.options.policy())
      signal.throwIfAborted()
      this.owner = {
        sessionId: request.sessionId,
        source: request.source,
        beforeSource: request.beforeSource,
        policy: Object.freeze(policy),
      }
    }
    const owner = this.owner
    if (
      !sameSource(owner.source, request.source) ||
      !sameOptionalSource(owner.beforeSource, request.beforeSource)
    )
      throw new Error('A changed source requires a new CPU owner session.')
    if ([...this.pairs.values()].some((pair) => !pair.published))
      throw new Error('Previous CPU pair construction has not been acknowledged or released.')
    const lease = (owner.lease ??= await this.options.acquireSource(request, signal))
    const beforeLease = request.beforeSource
      ? (owner.beforeLease ??= await this.options.acquireSource(
          { ...request, source: request.beforeSource, parameters: neutralAdjustments },
          signal,
          {
            photoId: request.source.photoId,
            cacheId: request.source.cacheId,
            workingSha256: request.source.workingSha256,
          },
        ))
      : undefined
    const check = async () => {
      await lease.check(request.expectedSettingsRevision, signal)
      if (beforeLease) await beforeLease.check(request.expectedSettingsRevision, signal)
      signal.throwIfAborted()
    }
    let directory: string | undefined, after: FileHandle | undefined, before: FileHandle | undefined
    let keep = false
    try {
      await check()
      signal.throwIfAborted()
      validateHdrSource(lease.asset.source)
      if (
        !sameSource(lease.source, request.source) ||
        lease.asset.sha256 !== request.source.workingSha256 ||
        lease.asset.byteLength !== lease.asset.width * lease.asset.height * 16 ||
        lease.asset.byteLength > 512 * 1024 ** 2
      )
        throw new Error('The trusted CPU lease does not match the requested source identity.')
      if (beforeLease) {
        validateHdrSource(beforeLease.asset.source)
        if (
          !sameSource(beforeLease.source, request.beforeSource!) ||
          beforeLease.asset.sha256 !== request.beforeSource!.workingSha256 ||
          beforeLease.asset.width !== lease.asset.width ||
          beforeLease.asset.height !== lease.asset.height ||
          beforeLease.asset.byteLength !== lease.asset.byteLength ||
          JSON.stringify(beforeLease.asset.source) !== JSON.stringify(lease.asset.source) ||
          JSON.stringify(beforeLease.asset.whiteBalance) !==
            JSON.stringify(lease.asset.whiteBalance)
        )
          throw new Error('The CPU comparison source does not match its edited frame.')
      }
      const separateBefore = !!beforeLease && beforeLease.asset.sha256 !== lease.asset.sha256
      const scale =
        request.quality === 'draft' && Math.max(lease.asset.width, lease.asset.height) > 1024
          ? 1024 / Math.max(lease.asset.width, lease.asset.height)
          : 1
      const width = Math.max(1, Math.round(lease.asset.width * scale)),
        height = Math.max(1, Math.round(lease.asset.height * scale))
      const available = availableParallelism(),
        threads: 1 | 4 | 8 = available >= 10 ? 8 : available >= 6 ? 4 : 1
      const oldPairBytes = [...this.pairs.values()].reduce(
        (n, pair) => n + pair.result.after.byteLength + pair.result.before.byteLength,
        0,
      )
      const plan = nativeCpuMemory(
        {
          sourceWidth: lease.asset.width,
          sourceHeight: lease.asset.height,
          outputWidth: width,
          outputHeight: height,
          canvasWidth: Math.max(1, Math.round(request.viewport.width * request.viewport.dpr)),
          canvasHeight: Math.max(1, Math.round(request.viewport.height * request.viewport.dpr)),
          threads,
          oldPairBytes,
          existingOwners: this.options.existingOwners(lease.asset, request),
          sourceCount: separateBefore ? 2 : 1,
        },
        {
          ramBytes: owner.policy.ram.effectiveBytes,
          gpuBytes: owner.policy.vram.effectiveBytes,
          revision: owner.policy.revision,
        },
      )
      if (!plan.accepted) throw new NativeCpuMemoryLimit(owner.policy)
      const executable = await this.options.executable()
      signal.throwIfAborted()
      await mkdir(this.options.root, { recursive: true })
      directory = await mkdtemp(join(this.options.root, 'cpu-'))
      const encoded = this.encode(request, lease.asset, width, height, owner.policy.revision)
      const requestPath = join(directory, 'request.bin')
      await writeFile(requestPath, encoded, { flag: 'wx', mode: 0o600 })
      after = await open(join(directory, 'after.rgba'), 'wx', 0o600)
      if (!separateBefore) before = await open(join(directory, 'before.rgba'), 'wx', 0o600)
      const timing = performance.now()
      const native = await this.child(
        executable,
        requestPath,
        encoded,
        lease,
        after,
        before,
        threads,
        abort,
      )
      await after.close()
      after = undefined
      await before?.close()
      before = undefined
      signal.throwIfAborted()
      await check()
      let comparison:
          { plane: { byteLength: number; sha256: string }; samples: CpuSampleStamp } | undefined,
        beforeCacheHit = false,
        beforeSourceReadHashSampleMs = 0
      if (separateBefore) {
        const key = JSON.stringify([
            'native-unfiltered-before-v1',
            [
              request.beforeSource!.photoId,
              request.beforeSource!.cacheId,
              request.beforeSource!.renderingIdentity,
              request.beforeSource!.workingSha256,
            ],
            width,
            height,
            request.hdrRanges,
            request.headroom,
          ]),
          planePath = join(directory, 'before.rgba'),
          samplesPath = join(directory, 'before-samples.f32'),
          cache = (owner.beforeCache ??= new NativeCpuBeforeCache(this.options.root))
        comparison = await cache.reuse(request.quality, key, planePath, samplesPath, signal)
        beforeCacheHit = !!comparison
        if (!comparison) {
          const originalRequest: CpuPreviewRequest = {
            ...request,
            source: beforeLease!.source,
            parameters: neutralAdjustments,
          }
          delete (originalRequest as { beforeSource?: CpuPreviewSourceRef }).beforeSource
          const originalEncoded = this.encode(
              originalRequest,
              beforeLease!.asset,
              width,
              height,
              owner.policy.revision,
            ),
            originalPath = join(directory, 'before-request.bin')
          await writeFile(originalPath, originalEncoded, { flag: 'wx', mode: 0o600 })
          before = await open(planePath, 'wx', 0o600)
          const original = await this.child(
            executable,
            originalPath,
            originalEncoded,
            beforeLease!,
            undefined,
            before,
            threads,
            abort,
          )
          await before.close()
          before = undefined
          await check()
          const data = Buffer.concat([
            Buffer.from(original.input.samples.sample.buffer),
            Buffer.from(original.input.samples.draft.buffer),
          ])
          await writeFile(samplesPath, data, { flag: 'wx', mode: 0o600 })
          const samples: CpuSampleStamp = {
            format: 'rgba-f32le-straight',
            sampleCount: original.input.samples.sample.length / 4,
            draftCount: original.input.samples.draft.length / 4,
            byteLength: data.byteLength,
            sha256: hash(data),
          }
          comparison = { plane: original.output.before, samples }
          beforeSourceReadHashSampleMs = original.input.elapsedMs
          await cache.retain(
            request.quality,
            key,
            planePath,
            comparison.plane,
            samplesPath,
            samples,
            signal,
          )
        }
        await check()
      }
      const sampleData = Buffer.concat([
        Buffer.from(native.input.samples.sample.buffer),
        Buffer.from(native.input.samples.draft.buffer),
      ])
      await writeFile(join(directory, 'samples.f32'), sampleData, { flag: 'wx', mode: 0o600 })
      const pairId = randomUUID(),
        base = `irodori-photo://library/${request.source.photoId}/cpu/${pairId}`
      const plane = (name: string, value: { byteLength: number; sha256: string }) => ({
        format: 'rgba8-srgb' as const,
        width,
        height,
        ...value,
        url: `${base}/${name}`,
      })
      const result: CpuPreviewPair = {
        version: NATIVE_CPU_PREVIEW_VERSION,
        pairId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        source: lease.source,
        ...(request.beforeSource ? { beforeSource: beforeLease!.source } : {}),
        generation: request.generation,
        settingsRevision: request.expectedSettingsRevision,
        parameters: request.parameters,
        hdrRanges: request.hdrRanges,
        headroom: request.headroom,
        quality: scale === 1 ? 'normal' : 'draft',
        sourceDimensions: { width: lease.asset.width, height: lease.asset.height },
        policy: owner.policy,
        after: plane('after', native.output.after),
        before: plane('before', comparison?.plane ?? native.output.before),
        samples: {
          format: 'rgba-f32le-straight',
          sampleCount: native.input.samples.sample.length / 4,
          draftCount: native.input.samples.draft.length / 4,
          byteLength: sampleData.length,
          sha256: hash(sampleData),
          url: `${base}/samples`,
        },
        ...(comparison
          ? { beforeSamples: { ...comparison.samples, url: `${base}/before-samples` } }
          : {}),
        diagnostics: {
          implementation: 'float64-ctl-cpu-strip-v1',
          threads,
          sourceAttestedByMain: true,
          outputValidatedAfterChildClose: true,
          sourceReadHashSampleMs: native.input.elapsedMs,
          childAndOutputMs: performance.now() - timing,
          managedRamPeakBytes: plan.peak.ramBytes,
          managedGpuPeakBytes: plan.peak.gpuBytes,
          ...(separateBefore ? { beforeCacheHit, beforeSourceReadHashSampleMs } : {}),
        },
      }
      await writeFile(join(directory, 'manifest.pending'), JSON.stringify(result), {
        flag: 'wx',
        mode: 0o600,
      })
      signal.throwIfAborted()
      await check()
      await rename(join(directory, 'manifest.pending'), join(directory, 'manifest.json'))
      signal.throwIfAborted()
      await check()
      signal.throwIfAborted()
      this.pairs.set(pairId, { result, directory, pins: 0, retained: true, published: false })
      keep = true
      return result
    } finally {
      await after?.close().catch(() => undefined)
      await before?.close().catch(() => undefined)
      // The one CPU owner retains its opened source/cache pin between jobs.
      if (!keep && directory) await rm(directory, { recursive: true, force: true })
    }
  }
  private waitForMaskReceivers(signal: AbortSignal) {
    signal.throwIfAborted()
    const pending = [...this.masks.values()].map((entry) => entry.drained)
    if (!pending.length) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
          signal.removeEventListener('abort', abort)
          if (error !== undefined) reject(error)
          else resolve()
        },
        abort = () => finish(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void Promise.all(pending).then(() => finish(), finish)
      if (signal.aborted) abort()
    })
  }
  renderMask(value: NativeHdrMaskRequest): Promise<NativeHdrMaskResult | NativeHdrMaskDeclined> {
    validateMask(value)
    if (this.closed)
      return Promise.reject(new NativeCpuCancelled('Native mask controller is closed.'))
    const request = structuredClone(value)
    const declined = (reason: NativeHdrMaskDeclined['reason']): NativeHdrMaskDeclined => ({
      kind: 'mask-declined',
      version: NATIVE_HDR_MASK_VERSION,
      requestId: request.requestId,
      sessionId: request.sessionId,
      generation: request.generation,
      reason,
    })
    // Masks never evict admitted/queued presentation, nor a receiver that has
    // genuinely completed native output but still owns fetch/hash/reduction.
    if (this.current?.kind === 'presentation' || this.pending?.kind === 'presentation')
      return Promise.resolve(declined('presentation-priority'))
    if (this.masks.size) return Promise.resolve(declined('previous-receiver'))
    this.pending?.reject(new NativeCpuCancelled('Native mask superseded before admission.'))
    this.pending?.finishDrain()
    this.current?.abort.abort(new NativeCpuCancelled('Native mask superseded.'))
    const result = new Promise<NativeHdrMaskResult | NativeHdrMaskDeclined>((resolve, reject) => {
      let finishDrain!: () => void
      const drained = new Promise<void>((done) => {
        finishDrain = done
      })
      this.pending = {
        kind: 'mask',
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
    lease: CpuWorkingLease,
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

  private encode(
    request: CpuPreviewRequest,
    asset: HdrWorkingAsset,
    width: number,
    height: number,
    revision: number,
  ) {
    const wb = hdrAdjustmentMatrix(request.parameters, asset.whiteBalance),
      data = Buffer.alloc(NATIVE_CPU_REQUEST_BYTES)
    const flags =
      Number(!!wb) |
      (Number(!!asset.source.display) << 1) |
      (Number(request.hdrRanges) << 2) |
      (Number(sameAdjustments(request.parameters, neutralAdjustments)) << 3) |
      (Number(request.headroom !== null) << 4)
    data.write('IRODCPU3')
    data.writeUInt32LE(3, 8)
    data.writeUInt32LE(flags, 12)
    for (const [at, n] of [
      [16, asset.width],
      [20, asset.height],
      [24, width],
      [28, height],
    ])
      data.writeUInt32LE(n, at)
    for (const [at, n] of [
      [32, request.generation],
      [40, request.expectedSettingsRevision],
      [48, revision],
    ])
      data.writeBigUInt64LE(BigInt(n), at)
    Buffer.from(asset.sha256, 'hex').copy(data, 56)
    Buffer.from(hash(JSON.stringify(request)), 'hex').copy(data, 88)
    data.writeBigUInt64LE(BigInt(asset.byteLength), 120)
    REC2020_TO_ACES.flat().forEach((n, i) => data.writeDoubleLE(n, 128 + i * 8))
    REC2020_TO_SRGB.forEach((n, i) => data.writeDoubleLE(n, 200 + i * 8))
    const p = request.parameters
    ;[p.exposureEv, p.contrast, p.highlights, p.shadows, p.whites, p.blacks].forEach((n, i) =>
      data.writeDoubleLE(n, 272 + i * 8),
    )
    ;(wb ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).forEach((n, i) => data.writeDoubleLE(n, 320 + i * 8))
    data.writeDoubleLE(request.headroom ?? 0, 392)
    data.writeDoubleLE(p.saturation, 400)
    data.writeDoubleLE(p.vibrance, 408)
    nativeColorValues(p).forEach((value, index) =>
      data.writeDoubleLE(value, NATIVE_CPU_COLOR_OFFSET + index * 8),
    )
    return data
  }
  private async child(
    executable: string,
    requestPath: string,
    encoded: Buffer,
    lease: CpuWorkingLease,
    after: FileHandle | undefined,
    before: FileHandle | undefined,
    threads: 1 | 4 | 8,
    abort: AbortController,
  ) {
    abort.signal.throwIfAborted()
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(executable, [requestPath, '-', String(threads)], {
      detached: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = '',
      ended = false,
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
    // Keep error observers installed through close, including late EPIPE events.
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-65536)
    })
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', fail)
      child.once('close', (code, signal) => {
        ended = true
        if (force) clearTimeout(force)
        if (code === 0 && !signal) resolve()
        else reject(new Error(`Native CPU renderer stopped (${code}/${signal}): ${stderr}`))
      })
    })
    const timeout = setTimeout(() => fail(new Error('Native CPU renderer timed out.')), 10 * 60_000)
    abort.signal.addEventListener('abort', stop, { once: true })
    const input = attestAndFeedCpuSource(lease.file, lease.asset, child.stdin, abort.signal)
    const output = writeNativeCpuPair({
      stdout: child.stdout,
      expectedRequest: encoded,
      threads,
      closedSuccessfully: closed,
      after,
      before,
      signal: abort.signal,
    })
    const observe = <T>(work: Promise<T>) =>
      work.catch((error: unknown) => {
        fail(error)
        throw error
      })
    try {
      const settled = await Promise.allSettled([observe(input), observe(output), observe(closed)])
      // Preserve the initiating cancellation or I/O failure after all owners drain.
      // Destroyed pipes can otherwise replace it with a secondary premature-close error.
      abort.signal.throwIfAborted()
      for (const result of settled) if (result.status === 'rejected') throw result.reason
      return { input: await input, output: await output }
    } finally {
      clearTimeout(timeout)
      if (force) clearTimeout(force)
      abort.signal.removeEventListener('abort', stop)
    }
  }

  acquire(url: URL) {
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
    const [photoId, kind, pairId, plane, extra] = url.pathname.slice(1).split('/')
    if (
      kind !== 'cpu' ||
      extra !== undefined ||
      !uuid.test(pairId ?? '') ||
      !['after', 'before', 'samples', 'before-samples'].includes(plane)
    )
      return
    const entry = this.pairs.get(pairId)
    if (!entry?.retained || entry.result.source.photoId !== photoId) return
    const metadata =
      plane === 'before-samples'
        ? entry.result.beforeSamples
        : plane === 'samples'
          ? entry.result.samples
          : plane === 'after'
            ? entry.result.after
            : entry.result.before
    if (!metadata) return
    entry.pins++
    let released = false
    return {
      path: join(entry.directory, plane.endsWith('samples') ? `${plane}.f32` : `${plane}.rgba`),
      contentType: 'application/octet-stream',
      byteLength: metadata.byteLength,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        void this.prune(entry)
      },
    }
  }
  /** Actual acknowledged CPU bitmap owner, independent of compositor/report RAFs. */
  hasCpuPresentationSource(
    source: CpuPreviewSourceRef,
    comparisonOf?: CpuPreviewSourceRef,
  ): boolean {
    const matches = (after: CpuPreviewSourceRef, before?: CpuPreviewSourceRef) =>
      comparisonOf
        ? sameSource(after, comparisonOf) && !!before && sameSource(before, source)
        : sameSource(after, source)
    return (
      !!this.owner &&
      matches(this.owner.source, this.owner.beforeSource) &&
      [...this.pairs.values()].some(
        (entry) =>
          entry.published &&
          entry.retained &&
          matches(entry.result.source, entry.result.beforeSource),
      )
    )
  }
  async acknowledge(sessionId: string, pairId: string, replacedPairId: string | null) {
    const entry = this.pairs.get(pairId)
    if (entry?.result.sessionId !== sessionId || !entry.retained || entry.published)
      throw new Error('Unknown CPU output acknowledgement.')
    const previous = [...this.pairs.values()].find((pair) => pair.published)
    if ((previous?.result.pairId ?? null) !== replacedPairId)
      throw new Error('CPU output replacement identity mismatch.')
    entry.published = true
    if (previous) await this.drop(previous)
  }
  async cancelMask(sessionId: string, requestId: string) {
    return this.cancel(sessionId, requestId, 'mask')
  }
  async cancel(sessionId: string, requestId: string, kind: Ticket['kind'] = 'presentation') {
    if (
      this.pending?.kind === kind &&
      this.pending.request.sessionId === sessionId &&
      this.pending.request.requestId === requestId
    ) {
      this.pending.reject(new NativeCpuCancelled('CPU preview cancelled.'))
      this.pending.finishDrain()
      this.pending = undefined
    }
    if (
      this.current?.kind === kind &&
      this.current.request.sessionId === sessionId &&
      this.current.request.requestId === requestId
    ) {
      const ticket = this.current
      ticket.abort.abort(new NativeCpuCancelled('CPU preview cancelled.'))
      await ticket.drained
    }
    for (const entry of this.pairs.values())
      if (
        kind === 'presentation' &&
        !entry.published &&
        entry.result.sessionId === sessionId &&
        entry.result.requestId === requestId
      )
        await this.drop(entry)
  }
  async release(sessionId: string, pairId: string | null) {
    if (pairId !== null) {
      const entry = this.pairs.get(pairId)
      if (entry?.result.sessionId === sessionId) await this.drop(entry)
      return
    }
    await this.retireOwners((owner) => owner.sessionId === sessionId, 'CPU owner closed.')
  }
  private async prune(entry: Pair) {
    if (entry.retained || entry.pins) return
    try {
      await rm(entry.directory, { recursive: true, force: true })
      if (this.pairs.get(entry.result.pairId) === entry) this.pairs.delete(entry.result.pairId)
      entry.finishDrain?.()
    } catch (error) {
      entry.failDrain?.(error)
    }
  }
  private drop(entry: Pair) {
    entry.retained = false
    entry.drained ??= new Promise<void>((resolve, reject) => {
      entry.finishDrain = resolve
      entry.failDrain = reject
    })
    void this.prune(entry)
    return entry.drained
  }
  private async dropPairs() {
    await Promise.all([...this.pairs.values()].map((entry) => this.drop(entry)))
  }
  private async releaseOwner(owner?: Owner) {
    const results = await Promise.allSettled([
        owner?.beforeCache?.close(),
        owner?.beforeLease?.release(),
        owner?.lease?.release(),
      ]),
      errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'CPU source-pair retirement failed.')
  }
  beforeRemoval(photoId: string) {
    return this.retireOwners((owner) => owner.source.photoId === photoId, 'CPU source removed.')
  }
  private retireOwners(
    matches: (owner: Pick<Owner, 'sessionId' | 'source'>) => boolean,
    reason: string,
  ): Promise<void> {
    const previous = this.cleanup
    const owner = this.owner && matches(this.owner) ? this.owner : undefined
    const pending = this.pending && matches(this.pending.request) ? this.pending : undefined
    const current = this.current && matches(this.current.request) ? this.current : undefined
    // Stale release/unrelated removal owns nothing to retire and must not wait
    // or impose a cleanup barrier on an unrelated active native child.
    if (
      !owner &&
      !pending &&
      !current &&
      ![...this.pairs.values()].some((pair) => matches(pair.result)) &&
      ![...this.masks.values()].some((entry) => matches(entry.result))
    )
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
      for (const result of await Promise.allSettled(
        [...this.pairs.values()]
          .filter((pair) => matches(pair.result))
          .map((pair) => this.drop(pair)),
      ))
        if (result.status === 'rejected') errors.push(result.reason)
      try {
        await this.releaseOwner(owner)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1)
        throw new AggregateError(errors, 'CPU owner retirement failed after draining.')
    }
    // Install synchronously before abort can resume the pump. Requests arriving
    // during retirement use the same latest pending slot, without recursive
    // Promise callbacks admitting older requests one by one after the barrier.
    // A previous caller owns its rejection; this retirement still drains itself.
    const cleanup = Promise.resolve(previous).then(retire, retire)
    this.cleanup = cleanup
    if (owner) this.owner = undefined
    if (pending) {
      pending.reject(new NativeCpuCancelled(reason))
      pending.finishDrain()
      if (this.pending === pending) this.pending = undefined
    }
    current?.abort.abort(new NativeCpuCancelled(reason))
    const finished = () => {
      if (this.cleanup !== cleanup) return
      this.cleanup = undefined
      this.start()
    }
    void cleanup.then(finished, finished)
    return cleanup
  }
  reset(): Promise<void> {
    const reset = this.retireOwners(() => true, 'CPU preview closed.')
    // An earlier retirement can already have detached the final owner while
    // its source close is pending. Global reset/shutdown still drains that work.
    return this.cleanup ?? reset
  }
  async close() {
    this.closed = true
    await this.reset()
  }
}
