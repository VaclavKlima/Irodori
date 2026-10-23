import type { WorkingFrame } from '../../../shared/adjustments'
import type { DisplayTarget } from '../../../shared/hdr'
import type { ManagedImageBytes, ResourcePolicySnapshot } from '../../../shared/resource-policy'
import { validateManagedImageBytes } from '../../../shared/resource-policy'
import { nativeHdrMaskMemory } from '../../../shared/native-hdr-mask-memory'

export interface NativeMaskReservation {
  readonly existingOwners: ManagedImageBytes
  readonly policy: Readonly<ResourcePolicySnapshot>
  readonly additionalReservation: ManagedImageBytes
  release(): void
}

/** Display reports also contain live diagnostics; only these fields select pixels. */
export function maskPixelTarget(target: DisplayTarget | undefined) {
  return target
    ? [
        target.generation,
        target.requested,
        target.mode,
        target.colorSpace,
        target.peak,
        target.headroom,
        target.outputVersion,
      ]
    : null
}

export function sameMaskFrame(a: WorkingFrame | undefined, b: WorkingFrame): boolean {
  const x = a?.cpuSource,
    y = b.cpuSource
  return (
    !!a?.hdr &&
    !!b.hdr &&
    !!x &&
    !!y &&
    a.width === b.width &&
    a.height === b.height &&
    a.identity === b.identity &&
    a.hdr.sha256 === b.hdr.sha256 &&
    x.workingSha256 === a.hdr.sha256 &&
    x.photoId === y.photoId &&
    x.cacheId === y.cacheId &&
    x.renderingIdentity === y.renderingIdentity &&
    x.workingSha256 === y.workingSha256
  )
}

interface Entry {
  scope: NativeMaskReservation
  cancel: () => void
  settled: Promise<void>
  released: boolean
  done: boolean
  cancelling?: Promise<void>
}
const empty = Object.freeze({ ramBytes: 0, vramBytes: 0 })

/** One optional operation per presenter. Its supplied promise owns actual native/browser drain. */
export class NativeMaskReservationOwner {
  private entry?: Entry
  get active(): boolean {
    return !!this.entry
  }
  get bytes(): ManagedImageBytes {
    return this.entry?.scope.additionalReservation ?? empty
  }
  reserve(
    width: number,
    height: number,
    existing: ManagedImageBytes,
    policy: Readonly<ResourcePolicySnapshot>,
    cancel: () => void,
    drained: Promise<void>,
  ): NativeMaskReservation | undefined {
    if (this.entry) return undefined
    validateManagedImageBytes(existing)
    const plan = nativeHdrMaskMemory(width, height, existing, policy)
    if (!plan.accepted) return undefined
    const copy = structuredClone(policy)
    Object.freeze(copy.ram)
    Object.freeze(copy.vram)
    Object.freeze(copy)
    const entry = {} as Entry
    const clear = () => {
      if (entry.done && entry.released && this.entry === entry) this.entry = undefined
    }
    const scope: NativeMaskReservation = Object.freeze({
      existingOwners: Object.freeze({ ...existing }),
      policy: copy,
      additionalReservation: plan.additional,
      // A caller cannot uncharge an unresolved WebCrypto/native owner early.
      release: () => {
        entry.released = true
        clear()
      },
    })
    entry.scope = scope
    entry.cancel = cancel
    entry.released = false
    entry.done = false
    // Register before reserve returns, so render IPC cannot precede accounting.
    entry.settled = Promise.resolve(drained)
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        entry.done = true
        clear()
      })
    this.entry = entry
    return scope
  }
  cancelAndDrain(): Promise<void> {
    const entry = this.entry
    if (!entry) return Promise.resolve()
    if (!entry.cancelling) {
      entry.cancelling = entry.settled.then(() => {
        entry.released = true
        if (this.entry === entry) this.entry = undefined
      })
      // Install the join before calling user code, including synchronous disposal.
      // Notification failure does not prove that the operation's owners drained.
      try {
        entry.cancel()
      } catch {
        /* The supplied lifetime remains authoritative. */
      }
    }
    return entry.cancelling
  }
}
