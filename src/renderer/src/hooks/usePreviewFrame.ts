import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

/** Keep gesture state synchronous while coalescing presentation into the next frame. */
export function usePreviewFrame(present: () => void) {
  const callback = useRef(present)
  const frame = useRef(0)
  useLayoutEffect(() => {
    callback.current = present
  }, [present])
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])
  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      callback.current()
    })
  }, [])
  const flush = useCallback(() => {
    cancel()
    callback.current()
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { schedule, cancel, flush }
}
