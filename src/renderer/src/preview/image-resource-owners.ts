import { validateManagedImageBytes, type ManagedImageBytes } from '../../../shared/resource-policy'

export interface ImageResourceOwner {
  release(): void
  /** Freeze live ownership before clearing fields; keep it charged until the real drain. */
  retire(drained: Promise<unknown>): void
}

/** Logical ownership upper bounds, independent of DOM membership and process RSS. */
export class ImageResourceOwners {
  private readonly owners = new Map<symbol, () => ManagedImageBytes>()
  register(read: () => ManagedImageBytes): ImageResourceOwner {
    const id = Symbol('image owner')
    this.owners.set(id, read)
    let released = false,
      retired = false
    const release = () => {
      if (released) return
      released = true
      this.owners.delete(id)
    }
    return {
      release,
      retire: (drained) => {
        if (released || retired) return
        const bytes = this.copy(read())
        retired = true
        this.owners.set(id, () => bytes)
        void drained.then(release, release)
      },
    }
  }
  snapshot(): ManagedImageBytes {
    let ramBytes = 0,
      vramBytes = 0
    for (const read of this.owners.values()) {
      const bytes = this.copy(read())
      ramBytes += bytes.ramBytes
      vramBytes += bytes.vramBytes
    }
    return this.copy({ ramBytes, vramBytes })
  }
  private copy(bytes: ManagedImageBytes): ManagedImageBytes {
    validateManagedImageBytes(bytes)
    return Object.freeze({ ramBytes: bytes.ramBytes, vramBytes: bytes.vramBytes })
  }
}

export const imageResourceOwners = new ImageResourceOwners()
