export const HDR_SOURCE_CACHE_ENTRIES = 2
/** Bump when hdrMipShader changes its source arithmetic, edge rule, or mip geometry. */
export const HDR_SOURCE_MIP_POLICY = 'rgba32float-alpha-weighted-2x2-v1'

interface SourceStrip {
  readonly byteLength: number
  readonly sha256: string
}
export interface HdrSourceDescriptor {
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly strips: readonly SourceStrip[]
}
export interface HdrSourceIdentity extends HdrSourceDescriptor {
  readonly key: string
  readonly format: 'rgba32float'
  readonly mipLevels: number
  readonly textureBytes: number
  readonly mipPolicy: string
}
export interface HdrSourceSamples {
  readonly sourceSha256: string
  /** Ownership transfers with admission. Never mutate or transfer these buffers afterward. */
  readonly sample: Float32Array<ArrayBuffer>
  readonly draft: Float32Array<ArrayBuffer>
}
export interface HdrSourceUploadVerification {
  readonly sourceSha256: string
  readonly verifiedBytes: number
  /** Actual hashes collected after successful strip validation, in source order. */
  readonly verifiedStripHashes: readonly string[]
  readonly eof: boolean
}
export interface HdrSourceResource {
  destroy: () => void
}
export interface HdrSourceCandidate<Resource extends HdrSourceResource> {
  readonly identity: HdrSourceIdentity
  readonly resource: Resource
  readonly samples: HdrSourceSamples
  readonly verification: HdrSourceUploadVerification
  /** The real queue fence submitted after all mip writes, not a completed flag. */
  readonly mipCompletion: Promise<void>
  /** Optional admission hint only; never participates in source identity or pixel authorization. */
  readonly photoId?: string
}
export interface HdrSourceAdmission {
  readonly signal: AbortSignal
  readonly isCurrent: () => boolean
}
export interface HdrSourceLease<Resource extends HdrSourceResource> {
  readonly identity: HdrSourceIdentity
  readonly resource: Resource
  readonly samples: HdrSourceSamples
  /** Stops use immediately; ownership remains pinned until this fence settles, even on failure. */
  releaseAfter: (completion: Promise<unknown>) => Promise<void>
}
export interface HdrSourceMemory {
  readonly ramBytes: number
  readonly vramBytes: number
  /** Includes invalidated or evicted entries still pinned by submitted work. */
  readonly entries: number
}

const hash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function hdrSourceIdentity(
  source: HdrSourceDescriptor,
  mipPolicy = HDR_SOURCE_MIP_POLICY,
): HdrSourceIdentity {
  const { width, height, byteLength } = source
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768 ||
    !Number.isSafeInteger(width * height * 16) ||
    byteLength !== width * height * 16 ||
    byteLength > 512 * 1024 ** 2 ||
    !hash(source.sha256) ||
    !Array.isArray(source.strips) ||
    source.strips.length !== Math.ceil(height / 64) ||
    typeof mipPolicy !== 'string' ||
    !mipPolicy.trim()
  )
    throw new Error('Invalid HDR source cache descriptor.')
  const strips = source.strips.map((strip, index) => {
    if (
      !strip ||
      !hash(strip.sha256) ||
      strip.byteLength !== width * Math.min(64, height - index * 64) * 16
    )
      throw new Error('Invalid HDR source cache strip manifest.')
    return Object.freeze({ sha256: strip.sha256, byteLength: strip.byteLength })
  })
  let textureBytes = 0,
    mipLevels = 0
  for (
    let w = width, h = height;
    ;
    w = Math.max(1, Math.floor(w / 2)), h = Math.max(1, Math.floor(h / 2))
  ) {
    textureBytes += w * h * 16
    mipLevels++
    if (w === 1 && h === 1) break
  }
  return Object.freeze({
    sha256: source.sha256,
    width,
    height,
    byteLength,
    strips: Object.freeze(strips),
    format: 'rgba32float',
    mipLevels,
    textureBytes,
    mipPolicy,
    key: JSON.stringify([
      'hdr-source-cache-v1',
      source.sha256,
      width,
      height,
      byteLength,
      strips,
      'rgba32float',
      mipLevels,
      mipPolicy,
    ]),
  })
}

function checkedIdentity(value: HdrSourceIdentity) {
  const identity = hdrSourceIdentity(value, value.mipPolicy)
  if (
    value.key !== identity.key ||
    value.format !== identity.format ||
    value.textureBytes !== identity.textureBytes ||
    value.mipLevels !== identity.mipLevels
  )
    throw new Error('HDR source cache identity does not match its descriptor.')
  return identity
}
function verifyUpload(identity: HdrSourceIdentity, proof: HdrSourceUploadVerification) {
  if (
    !proof ||
    proof.eof !== true ||
    proof.sourceSha256 !== identity.sha256 ||
    proof.verifiedBytes !== identity.byteLength ||
    !Array.isArray(proof.verifiedStripHashes) ||
    proof.verifiedStripHashes.length !== identity.strips.length ||
    proof.verifiedStripHashes.some((value, index) => value !== identity.strips[index].sha256)
  )
    throw new Error('HDR source cache admission requires verified complete source bytes.')
}
function checkedSamples(identity: HdrSourceIdentity, input: HdrSourceSamples): HdrSourceSamples {
  const total = identity.width * identity.height
  if (
    !input ||
    input.sourceSha256 !== identity.sha256 ||
    input.sample?.buffer === input.draft?.buffer
  )
    throw new Error('HDR source cache samples do not belong to this source.')
  for (const [sample, count] of [
    [input.sample, Math.min(65536, total)],
    [input.draft, Math.min(8192, total)],
  ] as const) {
    if (
      !(sample instanceof Float32Array) ||
      !(sample.buffer instanceof ArrayBuffer) ||
      sample.byteOffset !== 0 ||
      sample.byteLength !== sample.buffer.byteLength ||
      sample.length !== count * 4
    )
      throw new Error('HDR source cache requires tightly owned sample planes.')
    for (let index = 0; index < sample.length; index++)
      if (
        !Number.isFinite(sample[index]) ||
        (index % 4 === 3 && (sample[index] < 0 || sample[index] > 1))
      )
        throw new Error('HDR source cache samples contain invalid pixels.')
  }
  return Object.freeze({
    sourceSha256: input.sourceSha256,
    sample: input.sample,
    draft: input.draft,
  })
}

interface Entry<Resource extends HdrSourceResource> {
  device: object
  identity: HdrSourceIdentity
  resource: Resource
  samples: HdrSourceSamples
  pins: number
  retired: boolean
  photoId?: string
}
interface LeaseState<Resource extends HdrSourceResource> {
  entry: Entry<Resource>
  releasing: boolean
}

/** Two complete device-owned sources. Pending candidates remain owned by their callers. */
export class HdrSourceCache<Resource extends HdrSourceResource> {
  private entries: Entry<Resource>[] = []
  private owned = new Set<Entry<Resource>>()
  private leases = new WeakMap<HdrSourceLease<Resource>, LeaseState<Resource>>()
  private lost = new WeakSet<object>()
  private waiters = new Set<{ device?: object; resolve: () => void }>()
  private epoch = 0
  private closed = false
  private clearing?: Promise<void>
  get size() {
    return this.entries.length
  }
  /** A passive hint: this neither acquires a lease nor changes LRU order or reservations. */
  hasCompletedPhoto(photoId: string): boolean {
    return (
      hash(photoId) &&
      !this.closed &&
      !this.clearing &&
      this.entries.some(
        (entry) => entry.photoId === photoId && !entry.retired && !this.lost.has(entry.device),
      )
    )
  }
  /** Free the next source's slot before native preparation freezes existing ownership. */
  preparePhoto(photoId: string): void {
    if (!hash(photoId)) throw new Error('Invalid source cache photo hint.')
    if (this.hasCompletedPhoto(photoId)) return
    // Admission would evict this idle LRU source after upload anyway. Releasing it
    // now avoids charging two cached pyramids alongside a third RAW preparation.
    // Retired or submitted owners stay charged until their real fences settle.
    while (this.owned.size >= HDR_SOURCE_CACHE_ENTRIES) {
      if (!this.evictOldestUnpinned()) break
    }
  }
  /** Source-changing edits forget the hint without evicting or releasing any owner. */
  forgetPhoto(photoId: string): void {
    for (const entry of this.entries) if (entry.photoId === photoId) entry.photoId = undefined
  }
  memory(excluding?: HdrSourceLease<Resource>): HdrSourceMemory {
    const state = excluding ? this.leases.get(excluding) : undefined
    if (excluding && (!state || state.releasing || !this.owned.has(state.entry)))
      throw new Error('Only an active source lease can be excluded from cache reservations.')
    let ramBytes = 0,
      vramBytes = 0,
      entries = 0
    for (const entry of this.owned) {
      if (entry === state?.entry) continue
      entries++
      ramBytes += entry.samples.sample.byteLength + entry.samples.draft.byteLength
      vramBytes += entry.identity.textureBytes
    }
    return Object.freeze({ ramBytes, vramBytes, entries })
  }
  /** Retiring entries still own immutable samples until their final submission settles. */
  ownsSampleBuffer(buffer: ArrayBufferLike): boolean {
    for (const entry of this.owned)
      if (entry.samples.sample.buffer === buffer || entry.samples.draft.buffer === buffer)
        return true
    return false
  }
  acquire(
    device: object,
    requested: HdrSourceIdentity,
    photoId?: string,
  ): HdrSourceLease<Resource> | null {
    const identity = checkedIdentity(requested)
    if (photoId !== undefined && !hash(photoId)) throw new Error('Invalid source cache photo hint.')
    if (this.closed || this.lost.has(device)) return null
    const entry = this.entries.find(
      (item) => item.device === device && item.identity.key === identity.key,
    )
    if (!entry) return null
    if (photoId !== undefined) entry.photoId = photoId
    this.entries = [...this.entries.filter((item) => item !== entry), entry]
    return this.lease(entry)
  }
  async admit(
    device: object,
    candidate: HdrSourceCandidate<Resource>,
    admission: HdrSourceAdmission,
  ): Promise<HdrSourceLease<Resource> | null> {
    if (
      this.closed ||
      this.clearing ||
      this.lost.has(device) ||
      admission.signal.aborted ||
      !admission.isCurrent()
    )
      return null
    const identity = checkedIdentity(candidate.identity)
    const photoId = candidate.photoId
    if (photoId !== undefined && !hash(photoId)) throw new Error('Invalid source cache photo hint.')
    verifyUpload(identity, candidate.verification)
    const resource = candidate.resource,
      sample = candidate.samples.sample,
      draft = candidate.samples.draft
    const sourceSha256 = candidate.samples.sourceSha256,
      completion = candidate.mipCompletion,
      epoch = this.epoch
    if (
      !resource ||
      typeof resource.destroy !== 'function' ||
      !completion ||
      typeof completion.then !== 'function'
    )
      throw new Error(
        'HDR source cache admission requires an owned resource and a mip completion promise.',
      )
    await completion
    if (
      this.closed ||
      this.clearing ||
      this.lost.has(device) ||
      this.epoch !== epoch ||
      admission.signal.aborted ||
      !admission.isCurrent()
    )
      return null
    const samples = checkedSamples(identity, { sourceSha256, sample, draft })
    if (
      [...this.owned].some((entry) => entry.resource === resource) ||
      this.entries.some((entry) => entry.device === device && entry.identity.key === identity.key)
    )
      return null
    while (this.owned.size >= HDR_SOURCE_CACHE_ENTRIES) if (!this.evictOldestUnpinned()) return null
    const entry: Entry<Resource> = {
      device,
      identity,
      resource,
      samples,
      pins: 0,
      retired: false,
      photoId,
    }
    this.entries.push(entry)
    this.owned.add(entry)
    return this.lease(entry)
  }
  /** Optional cache pressure can evict an idle source without touching a submitted lease. */
  evictOldestUnpinned() {
    const entry = this.entries.find((item) => item.pins === 0)
    if (!entry) return false
    this.retire(entry)
    return true
  }
  /** A lost device can never reacquire or admit a late completion. Other devices remain independent. */
  invalidate(device: object): Promise<void> {
    this.lost.add(device)
    return this.retireAndDrain(device)
  }
  /** Do not await this while holding a lease whose final submission has not been released. */
  clearAndDrain(): Promise<void> {
    if (this.clearing) return this.clearing
    this.epoch++
    const pending = this.retireAndDrain().finally(() => {
      if (this.clearing === pending) this.clearing = undefined
    })
    this.clearing = pending
    return pending
  }
  dispose(): Promise<void> {
    this.closed = true
    return this.clearAndDrain()
  }
  private lease(entry: Entry<Resource>): HdrSourceLease<Resource> {
    entry.pins++
    const state: LeaseState<Resource> = { entry, releasing: false }
    let release: Promise<void> | undefined
    const lease: HdrSourceLease<Resource> = Object.freeze({
      identity: entry.identity,
      resource: entry.resource,
      samples: entry.samples,
      releaseAfter: (completion: Promise<unknown>) => {
        if (release) return release
        if (!completion || typeof completion.then !== 'function')
          throw new Error('Source lease release requires the final submission promise.')
        state.releasing = true
        const settled = () => {
          entry.pins--
          if (entry.retired && entry.pins === 0) this.destroy(entry)
        }
        return (release = Promise.resolve(completion).then(settled, settled))
      },
    })
    this.leases.set(lease, state)
    return lease
  }
  private retireAndDrain(device?: object): Promise<void> {
    for (const entry of [...this.entries])
      if (!device || entry.device === device) this.retire(entry)
    if (![...this.owned].some((entry) => !device || entry.device === device))
      return Promise.resolve()
    return new Promise((resolve) => this.waiters.add({ device, resolve }))
  }
  private retire(entry: Entry<Resource>) {
    entry.retired = true
    this.entries = this.entries.filter((item) => item !== entry)
    if (entry.pins === 0) this.destroy(entry)
  }
  private destroy(entry: Entry<Resource>) {
    if (!this.owned.delete(entry)) return
    try {
      entry.resource.destroy()
    } finally {
      for (const waiter of this.waiters)
        if (![...this.owned].some((item) => !waiter.device || item.device === waiter.device)) {
          this.waiters.delete(waiter)
          waiter.resolve()
        }
    }
  }
}
