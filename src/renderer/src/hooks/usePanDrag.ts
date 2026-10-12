import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { PanDrag, type AppliedPan } from '../preview/pan-drag'

export function usePanDrag(
  viewport: RefObject<HTMLDivElement | null>,
  pan: (x: number, y: number) => AppliedPan,
) {
  const [dragging, setDragging] = useState(false)
  const dragged = useRef(false)
  const instance = useRef<PanDrag | null>(null)
  useEffect(() => {
    const drag = new PanDrag(viewport.current!, pan, (dragging, moved) => {
      dragged.current = moved
      setDragging(dragging)
    })
    instance.current = drag
    return () => {
      drag.dispose()
      instance.current = null
    }
  }, [viewport, pan])
  return {
    dragging,
    dragged,
    reset: useCallback(() => {
      dragged.current = false
    }, []),
    start: useCallback((event: PointerEvent) => instance.current?.start(event), []),
    move: useCallback((event: PointerEvent) => instance.current?.move(event), []),
    release: useCallback((event: PointerEvent) => instance.current?.release(event), []),
    cancel: useCallback((event: PointerEvent) => instance.current?.cancel(event), []),
    stop: useCallback(() => instance.current?.stop(), []),
    lostCapture: useCallback(() => instance.current?.lostCapture(), []),
  }
}
