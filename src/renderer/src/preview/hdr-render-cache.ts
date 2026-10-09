import type { Size, View } from './geometry'

export const HDR_CACHE_MAX_TILES = 2048
export const HDR_CACHE_TILE_SIZE = 256
export function hdrCacheTileSize(width: number, height: number) {
  return Math.min(64, 2 ** Math.ceil(Math.log2(Math.max(16, width, height))))
}
export interface HdrCacheTile {
  level: number
  x: number
  y: number
  before: boolean
}
export interface HdrCachePlan {
  variant?: string
  level: number
  width: number
  height: number
  columns: number
  rows: number
  tiles: HdrCacheTile[]
}
/** Select source texels, independently of Retina pixel density. Each tile has a one-pixel halo. */
export function hdrCachePlan(
  frame: Size,
  image: Size,
  viewport: Size,
  view: View,
  mode: string,
  split: number,
  tileSize = HDR_CACHE_TILE_SIZE,
  minimumLevel = 0,
): HdrCachePlan {
  const level = Math.max(
    0,
    Math.min(
      Math.floor(Math.log2(Math.max(frame.width, frame.height))),
      Math.max(minimumLevel, Math.floor(Math.log2(1 / view.scale))),
    ),
  )
  const width = Math.max(1, frame.width >> level),
    height = Math.max(1, frame.height >> level)
  const columns = Math.ceil(width / tileSize),
    rows = Math.ceil(height / tileSize)
  const tiles: HdrCacheTile[] = []
  const add = (left: number, right: number, before: boolean) => {
    if (right <= left) return
    const point = (css: number, axis: 'width' | 'height', offset: number) => {
      const source = (css - viewport[axis] / 2 - offset) / view.scale + image[axis] / 2
      return view.scale >= 1 && level === 0
        ? source
        : (source / image[axis]) * (axis === 'width' ? width : height) - 0.5
    }
    const bounds = [
      point(left, 'width', view.x),
      point(right, 'width', view.x),
      point(0, 'height', view.y),
      point(viewport.height, 'height', view.y),
    ]
    if (bounds[1] < -1 || bounds[0] > width || bounds[3] < -1 || bounds[2] > height) return
    const x0 = Math.max(0, Math.floor(Math.max(0, bounds[0] - 1) / tileSize))
    const x1 = Math.min(columns - 1, Math.floor(Math.min(width - 1, bounds[1] + 1) / tileSize))
    const y0 = Math.max(0, Math.floor(Math.max(0, bounds[2] - 1) / tileSize))
    const y1 = Math.min(rows - 1, Math.floor(Math.min(height - 1, bounds[3] + 1) / tileSize))
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) tiles.push({ level, x, y, before })
  }
  if (mode === 'split') {
    const divider = Math.max(0, Math.min(1, split)) * viewport.width
    add(0, divider, true)
    add(divider, viewport.width, false)
  } else add(0, viewport.width, mode === 'before')
  return { level, width, height, columns, rows, tiles }
}

interface CachedTile {
  slot: number
  neutral: boolean
}
export interface HdrCacheBatch {
  lookup: Int32Array<ArrayBuffer>
  jobs: Uint32Array<ArrayBuffer>
  renderedTiles: number
}
/** Content and SDR variants share one bounded LRU; monitor state never enters content keys. */
export class HdrRenderCache {
  private entries = new Map<string, CachedTile>()
  private free: number[]
  private edits = ''
  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > HDR_CACHE_MAX_TILES)
      throw new Error('Invalid HDR render cache capacity.')
    this.free = Array.from({ length: capacity }, (_, i) => capacity - i - 1)
  }
  get size() {
    return this.entries.size
  }
  setEdits(key: string) {
    if (key === this.edits) return
    this.edits = key
    for (const [key, entry] of this.entries)
      if (!entry.neutral) {
        this.entries.delete(key)
        this.free.push(entry.slot)
      }
  }
  reset() {
    this.entries.clear()
    this.free = Array.from({ length: this.capacity }, (_, i) => this.capacity - i - 1)
  }
  discardSlots(slots: ReadonlySet<number>) {
    for (const [key, entry] of this.entries)
      if (slots.has(entry.slot)) {
        this.entries.delete(key)
        this.free.push(entry.slot)
      }
  }
  *batches(
    plan: HdrCachePlan,
    neutral: boolean,
    batchCapacity = this.capacity,
  ): Generator<HdrCacheBatch> {
    const groups = new Map<string, HdrCacheTile[]>()
    for (const tile of plan.tiles) {
      const key = `${plan.variant ?? 'legacy'}:${tile.level}:${tile.x}:${tile.y}:${tile.before || neutral ? 'neutral' : 'after'}`
      const group = groups.get(key) ?? []
      group.push(tile)
      groups.set(key, group)
    }
    const all = [...groups.entries()]
    const limit = Math.max(1, Math.min(this.capacity, batchCapacity))
    for (let start = 0; start < all.length; start += limit) {
      const batch = all.slice(start, start + limit),
        pinned = new Set(batch.map(([key]) => key))
      const lookup = new Int32Array(plan.columns * plan.rows * 2).fill(-1)
      const jobs: number[] = []
      for (const [key, tiles] of batch) {
        let entry = this.entries.get(key)
        if (entry) this.entries.delete(key)
        else {
          if (!this.free.length)
            for (const [retired, value] of this.entries)
              if (!pinned.has(retired)) {
                this.entries.delete(retired)
                this.free.push(value.slot)
                break
              }
          const slot = this.free.pop()
          if (slot === undefined) throw new Error('HDR render cache has no unpinned slot.')
          entry = { slot, neutral: tiles[0].before || neutral }
          jobs.push(tiles[0].x, tiles[0].y, slot, Number(entry.neutral))
        }
        this.entries.set(key, entry)
        for (const tile of tiles)
          lookup[(Number(tile.before) * plan.rows + tile.y) * plan.columns + tile.x] = entry.slot
      }
      yield { lookup, jobs: new Uint32Array(jobs), renderedTiles: jobs.length / 4 }
    }
    if (!all.length)
      yield {
        lookup: new Int32Array(plan.columns * plan.rows * 2).fill(-1),
        jobs: new Uint32Array(),
        renderedTiles: 0,
      }
  }
}
