import { useSyncExternalStore } from 'react'
import { thumbnailCache } from '../collections/thumbnails'

export function CollectionThumbnail({ url }: { url: string }) {
  useSyncExternalStore(thumbnailCache.subscribe, thumbnailCache.version)
  if (thumbnailCache.failed(url))
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label="Retry thumbnail"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          thumbnailCache.retry(url)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            thumbnailCache.retry(url)
          }
        }}
      >
        Retry thumbnail
      </span>
    )
  return thumbnailCache.get(url) ? (
    <img src={url} alt="" draggable={false} />
  ) : (
    <span role="status" aria-label="Loading thumbnail" />
  )
}
