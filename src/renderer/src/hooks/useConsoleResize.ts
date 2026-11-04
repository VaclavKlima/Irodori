import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { CONSOLE_HEIGHT_MIN, CONSOLE_HEIGHT_MAX } from '../../../shared/workspace'

/** Local drag feedback; only accepted height changes enter the workspace checkpoint owner. */
export function useConsoleResize(
  host: HTMLElement | null,
  open: boolean,
  preferred: number | null,
  commit: (height: number | null) => void,
) {
  const [bounds, setBounds] = useState({
    maximum: CONSOLE_HEIGHT_MAX,
    normal: window.innerHeight <= 760 ? 180 : 216,
  })
  const [draft, setDraft] = useState<number | null>(null)
  const gesture = useRef<{ id: number; y: number; height: number; owner: HTMLElement } | null>(null)
  const frame = useRef(0)
  const clamp = useCallback(
    (height: number) => Math.round(Math.max(CONSOLE_HEIGHT_MIN, Math.min(bounds.maximum, height))),
    [bounds.maximum],
  )
  const height = clamp(draft ?? preferred ?? bounds.normal)
  const retire = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const active = gesture.current
    gesture.current = null
    if (active?.owner.hasPointerCapture(active.id)) active.owner.releasePointerCapture(active.id)
  }, [])
  const cancel = useCallback(() => {
    retire()
    setDraft(null)
  }, [retire])
  useLayoutEffect(() => {
    const parent = host?.parentElement
    if (!parent) return
    const measure = () => {
      if (!parent.clientHeight) return
      const style = getComputedStyle(parent)
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const gap = parseFloat(style.rowGap) || 0
      const maximum = Math.max(
        CONSOLE_HEIGHT_MIN,
        Math.min(CONSOLE_HEIGHT_MAX, Math.floor(parent.clientHeight - padding - gap - 240)),
      )
      const normal = window.innerHeight <= 760 ? 180 : 216
      setBounds((previous) =>
        previous.maximum === maximum && previous.normal === normal ? previous : { maximum, normal },
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    measure()
    return () => {
      observer.disconnect()
      cancel()
    }
  }, [host, cancel])
  useEffect(() => {
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      cancel()
    }
  }, [open, cancel])
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { id: event.pointerId, y: event.clientY, height, owner: event.currentTarget }
    setDraft(height)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const next = clamp(active.height + active.y - event.clientY)
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setDraft(next))
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) return
    const next = clamp(active.height + active.y - event.clientY)
    retire()
    commit(next)
    setDraft(null)
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && gesture.current) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 30 : 10
    commit(
      event.key === 'Home'
        ? CONSOLE_HEIGHT_MIN
        : event.key === 'End'
          ? bounds.maximum
          : clamp(height + (event.key === 'ArrowUp' ? step : -step)),
    )
  }
  return { height, maximum: bounds.maximum, start, move, finish, cancel, keydown }
}
