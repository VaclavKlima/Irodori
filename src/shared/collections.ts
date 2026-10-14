/** Transport bounds are independent of viewport size and cache capacity. */
export const COLLECTION_CHUNK_SIZE = 60
export interface CollectionPolicy {
  tier: 'conservative' | 'standard' | 'capable'
  records: number
  decodedBytes: number
  concurrency: number
  lookahead: number
}
export function collectionPolicy(memoryBytes?: number, cpus?: number): CollectionPolicy {
  const gib = 1024 ** 3
  const tier =
    !memoryBytes || !cpus || memoryBytes < 8 * gib || cpus < 4
      ? 'conservative'
      : memoryBytes >= 16 * gib && cpus >= 8
        ? 'capable'
        : 'standard'
  const [records, mib, concurrency, lookahead] =
    tier === 'conservative'
      ? [300, 32, 2, 1]
      : tier === 'standard'
        ? [600, 64, 3, 2]
        : [1200, 128, 4, 3]
  return { tier, records, decodedBytes: mib * 1024 ** 2, concurrency, lookahead }
}
export class CollectionChangedError extends Error {
  constructor() {
    super('The collection changed. Reload the results.')
    this.name = 'CollectionChangedError'
  }
}
export function isCollectionChanged(error: unknown): boolean {
  return error instanceof Error && error.message === 'The collection changed. Reload the results.'
}
export interface CollectionAnchor {
  id: string
  inset: number
  index: number
  coverId?: string
  beforeId?: string
  afterId?: string
}
