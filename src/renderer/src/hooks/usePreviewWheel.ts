import { useEffect, useEffectEvent, type RefObject } from 'react'
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
  const handleWheel = useEffectEvent(
    (event: WheelEvent, element: HTMLElement, physicalControl: boolean) => {
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
          physicalControl,
        )
        return view === model.view ? model : { ...model, view }
      }, false)
    },
  )
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const document = element.ownerDocument
    const window = document.defaultView
    // Chromium encodes touchpad pinch as Ctrl-wheel. Only independent keyboard
    // or pointer events can establish whether Control is physically held.
    // Keep that evidence through loading and same-photo updates while Control stays down.
    let physicalControl: boolean | undefined
    const modifiers = (event: KeyboardEvent | PointerEvent) => {
      physicalControl = event.ctrlKey
    }
    const clearModifiers = () => {
      physicalControl = undefined
    }
    const wheel = (event: WheelEvent) => {
      handleWheel(event, element, physicalControl === true)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    document.addEventListener('keydown', modifiers, true)
    document.addEventListener('keyup', modifiers, true)
    document.addEventListener('pointerdown', modifiers, true)
    document.addEventListener('pointermove', modifiers, true)
    document.addEventListener('pointerup', modifiers, true)
    document.addEventListener('visibilitychange', clearModifiers)
    window?.addEventListener('blur', clearModifiers)
    return () => {
      element.removeEventListener('wheel', wheel)
      document.removeEventListener('keydown', modifiers, true)
      document.removeEventListener('keyup', modifiers, true)
      document.removeEventListener('pointerdown', modifiers, true)
      document.removeEventListener('pointermove', modifiers, true)
      document.removeEventListener('pointerup', modifiers, true)
      document.removeEventListener('visibilitychange', clearModifiers)
      window?.removeEventListener('blur', clearModifiers)
    }
  }, [viewport])
}
