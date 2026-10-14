import { useEffect, useLayoutEffect, useRef } from 'react'
import { thumbnailCache, type ThumbnailDemand } from '../collections/thumbnails'
import type { CollectionWindow } from '../collections/controller'

export function useCollectionThumbnails<T>(
  records: ReadonlyMap<number, T>,
  window: CollectionWindow,
  url: (record: T) => string | undefined,
) {
  const owner = useRef({})
  const identity = useRef(url)
  useLayoutEffect(() => {
    identity.current = url
  }, [url])
  useEffect(() => {
    const demands: ThumbnailDemand[] = []
    if (window.active)
      for (const [indices, priority, pinned] of [
        [window.visible, 0, true],
        [window.overscan, 1, true],
        [window.pinned ?? [], 0, true],
        [window.lookahead, 2, false],
      ] as const) {
        for (const index of indices) {
          const record = records.get(index),
            source = record && identity.current(record)
          if (source) demands.push({ url: source, priority, pinned })
        }
      }
    const key = owner.current
    thumbnailCache.update(key, demands)
    return () => thumbnailCache.remove(key)
  }, [records, window])
}
