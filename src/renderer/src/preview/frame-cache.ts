import type { FullPreview } from '../../../shared/contracts'
import { frameByteLength } from '../../../shared/preview-frame'

interface Entry {
  bitmap: ImageBitmap
  bytes: number
  pins: number
}
export interface FrameLease {
  bitmap: ImageBitmap
  release: () => void
}
function validate(preview: FullPreview) {
  if (
    preview.format !== 'rgba8-srgb' ||
    frameByteLength(preview.width, preview.height) !== preview.byteLength
  )
    throw new Error('The cached preview has incorrect dimensions.')
}
function key(preview: FullPreview) {
  return `${preview.url}:${preview.renderId}:${preview.sha256}`
}
export class BitmapCache {
  private reserved = 0
  private entries = new Map<string, Entry>()
  constructor(private budget = 256 * 1024 * 1024) {}
  get bytes(): number {
    return this.reserved + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  }
  private prune() {
    let bytes =
      this.reserved + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [key, entry] of this.entries) {
      if (bytes <= this.budget) break
      if (entry.pins) continue
      this.entries.delete(key)
      bytes -= entry.bytes
      entry.bitmap.close()
    }
  }
  retain(bitmap: ImageBitmap): (() => void) | undefined {
    const entry = [...this.entries.values()].find((entry) => entry.bitmap === bitmap)
    return entry ? this.lease(entry).release : undefined
  }
  reserve(bytes: number): () => void {
    this.reserved += bytes
    this.prune()
    let released = false
    return () => {
      if (!released) {
        released = true
        this.reserved -= bytes
        this.prune()
      }
    }
  }
  private lease(entry: Entry): FrameLease {
    entry.pins++
    let released = false
    return {
      bitmap: entry.bitmap,
      release: () => {
        if (!released) {
          released = true
          entry.pins--
          this.prune()
        }
      },
    }
  }
  acquire(preview: FullPreview): FrameLease | null {
    validate(preview)
    const id = key(preview),
      entry = this.entries.get(id)
    if (!entry) return null
    this.entries.delete(id)
    this.entries.set(id, entry)
    return this.lease(entry)
  }
  insert(preview: FullPreview, bitmap: ImageBitmap): FrameLease {
    const existing = this.acquire(preview)
    if (existing) {
      bitmap.close()
      return existing
    }
    const entry: Entry = { bitmap, bytes: preview.byteLength, pins: 0 }
    this.entries.set(key(preview), entry)
    const result = this.lease(entry)
    this.prune()
    return result
  }
}
const frames = new BitmapCache()
export const presentationBitmapBytes = () => frames.bytes
export const retainPresentationBitmap = (bitmap: ImageBitmap) => frames.retain(bitmap)
export const reservePresentationBitmaps = (bytes: number) => frames.reserve(bytes)
export function cachedFrame(preview: FullPreview): FrameLease | null {
  return frames.acquire(preview)
}
export async function loadFrame(preview: FullPreview, signal: AbortSignal): Promise<FrameLease> {
  validate(preview)
  const release = frames.reserve(preview.byteLength * 2)
  try {
    const response = await fetch(preview.url, { signal, cache: 'no-store' })
    if (!response.ok || Number(response.headers.get('content-length')) !== preview.byteLength)
      throw new Error('The cached preview is incomplete.')
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength !== preview.byteLength)
      throw new Error('The cached preview is incomplete.')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')
    if (hash !== preview.sha256) throw new Error('The cached preview is damaged.')
    signal.throwIfAborted()
    const bitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(bytes), preview.width, preview.height, {
        colorSpace: 'srgb',
      }),
    )
    if (signal.aborted) {
      bitmap.close()
      signal.throwIfAborted()
    }
    return frames.insert(preview, bitmap)
  } finally {
    release()
  }
}
