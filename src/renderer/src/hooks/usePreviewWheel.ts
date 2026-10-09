import { useEffect, type RefObject } from 'react'
import { wheelView, type Size, type View } from '../preview/geometry'

interface Model {
  image: Size
  viewport: Size
  view: View
}

export function usePreviewWheel<T extends Model>(
  viewport: RefObject<HTMLElement | null>,
  ready: boolean,
  change: (action: (model: T) => T, immediate: boolean) => void,
  stopDrag: () => void,
) {
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!ready || event.defaultPrevented) return
      event.preventDefault()
      if (event.ctrlKey ? !event.deltaY : !event.deltaX && !event.deltaY) return
      stopDrag()
      const box = element.getBoundingClientRect()
      change((model) => {
        const view = wheelView(
          model.view,
          event,
          {
            x: event.clientX - box.left - box.width / 2,
            y: event.clientY - box.top - box.height / 2,
          },
          model.image,
          model.viewport,
        )
        return view === model.view ? model : { ...model, view }
      }, false)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [viewport, ready, change, stopDrag])
}
