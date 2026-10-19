import type { AdjustmentParameters } from '../../../shared/adjustments'
import type { DisplayTarget } from '../../../shared/hdr'
import type { Size, View } from './geometry'

export const HDR_PRESENTATION_CACHE_BUDGET = 96 * 1024 ** 2
const identityVersion = 'hdr-exact-presentation-v1'

export interface HdrPresentationIdentityInput {
  /** The caller has matched these parameters to the authoritative edit revision. */
  confirmed: boolean
  sourceIdentity: string
  sourceSha256: string
  renderingPolicy: string
  settingsRevision: number
  adjustments: AdjustmentParameters
  target: DisplayTarget
  comparison: 'before' | 'after' | 'split'
  split: number
  hdrRanges: boolean
  image: Size
  viewport: Size
  view: View
  dpr: number
}

export interface HdrPresentationIdentity {
  readonly key: string
  readonly width: number
  readonly height: number
  /** Exact native backing dimensions, with eight bytes per rgba16float texel. */
  readonly byteLength: number
}

/** No unconfirmed edits, approximate matching, scaling, or SDR transport enters this cache. */
export function hdrPresentationIdentity(
  input: HdrPresentationIdentityInput,
): HdrPresentationIdentity | null {
  const { adjustments, target, image, viewport, view, dpr } = input
  const whiteBalance = adjustments.whiteBalance ?? { mode: 'as-shot' }
  const white =
    whiteBalance.mode === 'as-shot'
      ? ['as-shot']
      : ['custom', whiteBalance.kelvin, whiteBalance.tint]
  const finite = [
    adjustments.exposureEv,
    adjustments.contrast,
    adjustments.highlights,
    adjustments.shadows,
    adjustments.whites,
    adjustments.blacks,
    target.peak,
    ...(target.headroom === null ? [] : [target.headroom]),
    ...(whiteBalance.mode === 'custom' ? [whiteBalance.kelvin, whiteBalance.tint] : []),
    viewport.width,
    viewport.height,
    view.scale,
    view.x,
    view.y,
    dpr,
    input.split,
  ]
  if (
    input.confirmed !== true ||
    !input.sourceIdentity ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
    !input.renderingPolicy ||
    !Number.isSafeInteger(input.settingsRevision) ||
    input.settingsRevision < 0 ||
    !Number.isSafeInteger(target.generation) ||
    target.generation < 0 ||
    !['sdr', 'hdr'].includes(target.mode) ||
    !['srgb', 'display-p3'].includes(target.colorSpace) ||
    !target.outputVersion ||
    !['as-shot', 'custom'].includes(whiteBalance.mode) ||
    !['before', 'after', 'split'].includes(input.comparison) ||
    !finite.every(Number.isFinite) ||
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    view.scale <= 0 ||
    dpr <= 0 ||
    typeof view.fit !== 'boolean' ||
    typeof input.hdrRanges !== 'boolean'
  )
    return null
  const width = Math.max(1, Math.round(viewport.width * dpr))
  const height = Math.max(1, Math.round(viewport.height * dpr))
  const byteLength = width * height * 8
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return null
  return Object.freeze({
    key: JSON.stringify([
      identityVersion,
      input.sourceIdentity,
      input.sourceSha256,
      input.renderingPolicy,
      input.settingsRevision,
      white,
      adjustments.exposureEv,
      adjustments.contrast,
      adjustments.highlights,
      adjustments.shadows,
      adjustments.whites,
      adjustments.blacks,
      target.outputVersion,
      target.generation,
      target.requested,
      target.mode,
      target.colorSpace,
      target.peak,
      target.headroom,
      input.comparison,
      input.split,
      input.hdrRanges,
      image.width,
      image.height,
      viewport.width,
      viewport.height,
      view.fit,
      view.scale,
      view.x,
      view.y,
      dpr,
      width,
      height,
    ]),
    width,
    height,
    byteLength,
  })
}

interface DisposableSurface {
  destroy: () => void
}
export interface CompletedHdrPresentation<Surface extends DisposableSurface> {
  surface: Surface
  width: number
  height: number
  /** Set only after the final rendering fence completed and its identity stayed current. */
  completed: boolean
  quality: 'normal' | 'draft'
  transient: boolean
  serial: number
}
interface Entry<Surface extends DisposableSurface> {
  device: object
  identity: HdrPresentationIdentity
  surface: Surface
  serial: number
  pins: number
  retired: boolean
}
export interface HdrPresentationLease<Surface extends DisposableSurface> {
  readonly surface: Surface
  readonly identity: HdrPresentationIdentity
  readonly serial: number
  /** Release only after every GPU submission using this surface has completed. */
  release: () => void
}

/** Cache ownership transfers only on successful retain; leases protect submitted GPU work. */
export class HdrPresentationCache<Surface extends DisposableSurface> {
  private entries = new Map<string, Entry<Surface>>()
  private owned = new Set<Surface>()
  private allocated = 0
  private closed = false
  private admissionPauses = 0
  private drainWaiters = new Set<() => void>()
  constructor(readonly budget = HDR_PRESENTATION_CACHE_BUDGET) {
    if (!Number.isSafeInteger(budget) || budget < 0)
      throw new Error('Invalid HDR presentation cache budget.')
  }
  /** Includes invalidated surfaces still leased by an in-flight GPU submission. */
  get bytes() {
    return this.allocated
  }
  get size() {
    return this.entries.size
  }
  /** Non-mutating preflight; an oversized or pinned-out candidate remains caller-owned. */
  canRetain(identity: HdrPresentationIdentity) {
    if (
      this.closed ||
      this.admissionPauses > 0 ||
      !this.valid(identity) ||
      identity.byteLength > this.budget
    )
      return false
    let unavailable = this.allocated
    for (const entry of this.entries.values())
      if (!entry.pins) unavailable -= entry.identity.byteLength
    return unavailable + identity.byteLength <= this.budget
  }
  retain(
    device: object,
    identity: HdrPresentationIdentity,
    completed: CompletedHdrPresentation<Surface>,
  ): boolean {
    if (
      completed.completed !== true ||
      completed.quality !== 'normal' ||
      completed.transient !== false ||
      !Number.isSafeInteger(completed.serial) ||
      completed.serial < 1 ||
      completed.width !== identity.width ||
      completed.height !== identity.height ||
      this.owned.has(completed.surface) ||
      !this.canRetain(identity)
    )
      return false
    const existing = this.entries.get(identity.key)
    if (existing) this.retire(existing)
    for (const entry of this.entries.values()) {
      if (this.allocated + identity.byteLength <= this.budget) break
      if (!entry.pins) this.retire(entry)
    }
    const entry: Entry<Surface> = {
      device,
      identity: Object.freeze({ ...identity }),
      surface: completed.surface,
      serial: completed.serial,
      pins: 0,
      retired: false,
    }
    this.entries.set(identity.key, entry)
    this.owned.add(entry.surface)
    this.allocated += identity.byteLength
    return true
  }
  acquire(device: object, identity: HdrPresentationIdentity): HdrPresentationLease<Surface> | null {
    const entry = this.entries.get(identity.key)
    if (
      this.closed ||
      !entry ||
      entry.device !== device ||
      !this.valid(identity) ||
      entry.identity.width !== identity.width ||
      entry.identity.height !== identity.height ||
      entry.identity.byteLength !== identity.byteLength
    )
      return null
    this.entries.delete(identity.key)
    this.entries.set(identity.key, entry)
    entry.pins++
    let released = false
    return {
      surface: entry.surface,
      identity: entry.identity,
      serial: entry.serial,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        if (entry.retired && !entry.pins) this.destroy(entry)
      },
    }
  }
  invalidate(device: object) {
    for (const entry of this.entries.values()) if (entry.device === device) this.retire(entry)
  }
  clear() {
    for (const entry of this.entries.values()) this.retire(entry)
  }
  /** A presenter using the ordinary memory budget must prevent later cache admission. */
  pauseRetaining() {
    this.admissionPauses++
    let released = false
    return () => {
      if (released) return
      released = true
      this.admissionPauses--
    }
  }
  /** Retired leases remain charged until their final submitted GPU read has completed. */
  clearAndDrain(): Promise<void> {
    this.clear()
    if (!this.allocated) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }
  dispose() {
    this.closed = true
    this.clear()
  }
  private valid(identity: HdrPresentationIdentity) {
    return (
      !!identity.key &&
      Number.isSafeInteger(identity.width) &&
      Number.isSafeInteger(identity.height) &&
      identity.width > 0 &&
      identity.height > 0 &&
      Number.isSafeInteger(identity.byteLength) &&
      identity.byteLength === identity.width * identity.height * 8
    )
  }
  private retire(entry: Entry<Surface>) {
    if (this.entries.get(entry.identity.key) === entry) this.entries.delete(entry.identity.key)
    entry.retired = true
    if (!entry.pins) this.destroy(entry)
  }
  private destroy(entry: Entry<Surface>) {
    if (!this.owned.delete(entry.surface)) return
    this.allocated -= entry.identity.byteLength
    try {
      entry.surface.destroy()
    } finally {
      if (!this.allocated) {
        for (const resolve of this.drainWaiters) resolve()
        this.drainWaiters.clear()
      }
    }
  }
}
