import { collectionQueue, currentCollectionPolicy, type CollectionQueue } from './controller'

export interface DecodedThumbnail {
  url: string
  width: number
  height: number
  release: () => void
}
export interface ThumbnailDemand {
  url: string
  priority: number
  pinned: boolean
}
interface Entry {
  image: DecodedThumbnail
  bytes: number
  used: number
}
export const decodeThumbnail = async (
  url: string,
  signal: AbortSignal,
): Promise<DecodedThumbnail> => {
  const image = new Image()
  let rejectCancelled!: (error: unknown) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  const abort = () => {
    image.src = ''
    rejectCancelled(new DOMException('Cancelled', 'AbortError'))
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    image.src = url
    await Promise.race([image.decode(), cancelled])
    signal.throwIfAborted()
    return {
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => {
        image.src = ''
      },
    }
  } catch (error) {
    image.src = ''
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
/** Counts only references owned by this application, never Chromium's total memory. */
export class ThumbnailCache {
  private owners = new Map<object, ThumbnailDemand[]>()
  private images = new Map<string, Entry>()
  private pending = new Map<string, AbortController>()
  private errors = new Set<string>()
  private listeners = new Set<() => void>()
  private clock = 0
  private serial = 0
  constructor(
    private load = decodeThumbnail,
    private queue: CollectionQueue = collectionQueue,
    private budget = () => currentCollectionPolicy().decodedBytes,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  version = () => this.serial
  get(url: string) {
    return this.images.get(url)?.image
  }
  failed(url: string) {
    return this.errors.has(url)
  }
  get decodedBytes() {
    return [...this.images.values()].reduce((sum, e) => sum + e.bytes, 0)
  }
  update(owner: object, demands: ThumbnailDemand[]) {
    this.owners.set(owner, demands)
    this.reconcile()
  }
  remove(owner: object) {
    this.owners.delete(owner)
    this.reconcile()
  }
  private desired() {
    const desired = new Map<string, ThumbnailDemand>()
    for (const demand of [...this.owners.values()].flat()) {
      const previous = desired.get(demand.url)
      desired.set(demand.url, {
        ...demand,
        priority: Math.min(previous?.priority ?? 2, demand.priority),
        pinned: !!previous?.pinned || demand.pinned,
      })
    }
    return desired
  }
  private reconcile() {
    const desired = this.desired()
    for (const url of this.errors) if (!desired.has(url)) this.errors.delete(url)
    for (const [url, abort] of this.pending)
      if (!desired.has(url)) {
        abort.abort()
        this.pending.delete(url)
      }
    for (const [url, demand] of [...desired].sort((a, b) => a[1].priority - b[1].priority)) {
      const cached = this.images.get(url)
      if (cached) {
        if (demand.pinned) cached.used = ++this.clock
        continue
      }
      if (this.errors.has(url)) continue
      const active = this.pending.get(url)
      if (active) {
        this.queue.promote(`thumbnail:${url}`, demand.priority)
        continue
      }
      const abort = new AbortController()
      this.pending.set(url, abort)
      void this.queue
        .request(`thumbnail:${url}`, demand.priority, abort.signal, () =>
          this.load(url, abort.signal),
        )
        .then(
          (image) => {
            if (abort.signal.aborted || !this.desired().has(url)) {
              image.release()
              return
            }
            this.images.set(url, {
              image,
              bytes: image.width * image.height * 4,
              used: ++this.clock,
            })
            this.evict()
            this.emit()
          },
          () => {
            if (!abort.signal.aborted) {
              this.errors.add(url)
              this.emit()
            }
          },
        )
        .finally(() => {
          if (this.pending.get(url) === abort) this.pending.delete(url)
        })
    }
    this.evict()
  }
  private evict() {
    const desired = this.desired()
    const pinnedBytes = [...this.images]
      .filter(([url]) => desired.get(url)?.pinned)
      .reduce((sum, [, e]) => sum + e.bytes, 0)
    const capacity = Math.max(this.budget(), pinnedBytes)
    let bytes = this.decodedBytes
    for (const [url, entry] of [...this.images]
      .filter(([url]) => !desired.get(url)?.pinned)
      .sort((a, b) => a[1].used - b[1].used)) {
      if (bytes <= capacity) break
      bytes -= entry.bytes
      entry.image.release()
      this.images.delete(url)
      this.emit()
    }
  }
  retry(url: string) {
    this.errors.delete(url)
    this.reconcile()
  }
  close() {
    this.owners.clear()
    for (const abort of this.pending.values()) abort.abort()
    this.pending.clear()
    for (const entry of this.images.values()) entry.image.release()
    this.images.clear()
    this.emit()
  }
  private emit() {
    this.serial++
    for (const listener of this.listeners) listener()
  }
}
export const thumbnailCache = new ThumbnailCache()
