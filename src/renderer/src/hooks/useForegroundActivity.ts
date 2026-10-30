import { useCallback, useEffect, useRef } from 'react'
import { ForegroundActivityClient } from '../preview/foreground-activity'

export function useForegroundActivity(photoId?: string, reviewId?: string, enabled = true) {
  const client = useRef<ForegroundActivityClient | null>(null)
  useEffect(() => {
    if (!enabled || (!photoId && !reviewId)) return
    const instance = new ForegroundActivityClient({ photoId, reviewId }, (value) =>
      window.irodori.reportForegroundActivity(value),
    )
    client.current = instance
    const clear = () => instance.clear()
    const visibility = () => {
      if (document.hidden) clear()
    }
    window.addEventListener('blur', clear)
    window.addEventListener('pagehide', clear)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      instance.clear()
      if (client.current === instance) client.current = null
      window.removeEventListener('blur', clear)
      window.removeEventListener('pagehide', clear)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [photoId, reviewId, enabled])
  const begin = useCallback(() => client.current?.begin() ?? (() => {}), [])
  const pulse = useCallback(() => client.current?.pulse(), [])
  return { begin, pulse }
}
