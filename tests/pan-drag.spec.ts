import { test, expect } from '@playwright/test'
import { PanDrag } from '../src/renderer/src/preview/pan-drag'

const down = (overrides = {}) =>
  ({
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 100,
    clientY: 80,
    ...overrides,
  }) as PointerEvent

function setup(legacy = false) {
  let time = 0,
    frameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const motion = Object.assign(new EventTarget(), { matches: false })
  const window = Object.assign(new EventTarget(), {
    performance: { now: () => time },
    matchMedia: () => motion,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const document = Object.assign(new EventTarget(), {
    defaultView: window,
    hidden: false,
    pointerLockElement: null as unknown,
    exitPointerLock: () => {
      document.pointerLockElement = null
      document.dispatchEvent(new Event('pointerlockchange'))
    },
  })
  const captured = new Set<number>(),
    deltas: number[][] = [],
    states: boolean[][] = [],
    position = { x: 0, y: 0 },
    limits = { x: Infinity, y: Infinity }
  let grant!: (notify: boolean) => void, reject!: () => void
  const element = {
    ownerDocument: document,
    dataset: { pointerLocked: 'false', gliding: 'false' },
    setPointerCapture: (id: number) => {
      if (document.pointerLockElement)
        throw new DOMException('Pointer is locked', 'InvalidStateError')
      captured.add(id)
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
    requestPointerLock: () => {
      const request = new Promise<void>((resolve, fail) => {
        grant = (notify) => {
          document.pointerLockElement = element
          if (notify) document.dispatchEvent(new Event('pointerlockchange'))
          resolve()
        }
        reject = () => {
          document.dispatchEvent(new Event('pointerlockerror'))
          if (!legacy) fail(new Error('Denied'))
        }
      })
      return legacy ? undefined : request
    },
  }
  const drag = new PanDrag(
    element as unknown as HTMLElement,
    (x, y) => {
      const nextX = Math.max(-limits.x, Math.min(limits.x, position.x + x)),
        nextY = Math.max(-limits.y, Math.min(limits.y, position.y + y))
      const applied = { x: nextX - position.x, y: nextY - position.y }
      deltas.push([applied.x, applied.y])
      position.x = nextX
      position.y = nextY
      return applied
    },
    (dragging, moved) => states.push([dragging, moved]),
  )
  const move = (x: number, y: number, buttons = 1) =>
    document.dispatchEvent(
      Object.assign(new Event('mousemove'), { movementX: x, movementY: y, buttons }),
    )
  return {
    drag,
    document,
    window,
    element,
    captured,
    deltas,
    states,
    position,
    limits,
    motion,
    frames,
    advance: (ms: number) => {
      time += ms
    },
    frame: (ms: number) => {
      time += ms
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(time)
    },
    grant: (notify = true) => grant(notify),
    reject: () => reject(),
    move,
  }
}

test('locked dragging uses relative motion once, beyond cursor boundaries, and releases on mouse up or Escape', async () => {
  const h = setup()
  h.drag.start(down())
  h.drag.move(down({ clientX: 103, clientY: 85 }))
  h.grant()
  await Promise.resolve()
  h.drag.lostCapture()
  h.drag.move(down({ clientX: 5000, clientY: -900 }))
  h.move(800, -500)
  expect(h.deltas).toEqual([
    [3, 5],
    [800, -500],
  ])
  h.document.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }))
  expect(h.document.pointerLockElement).toBeNull()
  expect(h.captured.size).toBe(0)
  expect(h.states.at(-1)).toEqual([false, true])
  h.move(10, 10)
  expect(h.deltas).toHaveLength(2)
  h.drag.start(down())
  h.grant()
  const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })
  h.document.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  expect(h.document.pointerLockElement).toBeNull()
  h.drag.dispose()
})

test('mouse release glides for 120 ms with cubic easing and a 24 CSS pixel vector cap', () => {
  const h = setup()
  h.drag.start(down())
  h.advance(10)
  h.drag.move(down({ clientX: 130, clientY: 120 }))
  h.drag.release(down())
  expect(h.element.dataset.gliding).toBe('true')
  expect(h.states.at(-1)).toEqual([false, true])
  expect(h.captured.size).toBe(0)
  h.frame(60)
  expect(h.position.x).toBeCloseTo(30 + 24 * 0.6 * 0.875, 12)
  expect(h.position.y).toBeCloseTo(40 + 24 * 0.8 * 0.875, 12)
  h.frame(60)
  expect(Math.hypot(h.position.x - 30, h.position.y - 40)).toBeCloseTo(24, 12)
  expect(h.element.dataset.gliding).toBe('false')
  expect(h.frames.size).toBe(0)
  h.drag.dispose()
})

test('glide uses only applied movement in the last 60 ms and stops at bounds', () => {
  const h = setup()
  h.limits.x = 0
  h.limits.y = 22
  h.drag.start(down())
  h.advance(10)
  h.drag.move(down({ clientX: 1000, clientY: 90 }))
  h.drag.release(down())
  h.frame(16)
  expect(h.position.x).toBe(0)
  expect(h.position.y).toBeCloseTo(10 + 24 * (1 - (1 - 16 / 120) ** 3), 10)
  h.frame(16)
  expect(h.position).toEqual({ x: 0, y: 22 })
  expect(h.frames.size).toBe(0)
  h.drag.dispose()

  const recent = setup()
  recent.drag.start(down())
  recent.advance(10)
  recent.drag.move(down({ clientX: 300 }))
  recent.advance(90)
  recent.drag.move(down({ clientX: 300.5 }))
  recent.drag.release(down())
  expect(recent.frames.size).toBe(0)
  recent.drag.dispose()
})

test('stationary and slow releases, touch, pen and reduced motion receive no glide', () => {
  for (const kind of ['stationary', 'slow', 'touch', 'pen', 'reduced']) {
    const h = setup()
    h.motion.matches = kind === 'reduced'
    const pointerType = kind === 'touch' || kind === 'pen' ? kind : 'mouse'
    h.drag.start(down({ pointerType }))
    h.advance(kind === 'slow' ? 60 : 10)
    h.drag.move(down({ pointerType, clientX: kind === 'slow' ? 102.1 : 120 }))
    if (kind === 'stationary') h.advance(60)
    h.drag.release(down({ pointerType }))
    expect(h.element.dataset.gliding, kind).toBe('false')
    expect(h.frames.size, kind).toBe(0)
    h.drag.dispose()
  }
})

test('duplicate release and native unlock cleanup preserve the glide; cancellation cannot restart it', async () => {
  const h = setup()
  h.drag.start(down())
  h.grant()
  await Promise.resolve()
  h.advance(20)
  h.move(4, 0)
  h.drag.release(down())
  h.document.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }))
  h.drag.release(down())
  h.drag.cancel(down())
  h.drag.lostCapture()
  h.document.dispatchEvent(new Event('pointerlockchange'))
  expect(h.document.pointerLockElement).toBeNull()
  expect(h.element.dataset.pointerLocked).toBe('false')
  h.frame(120)
  expect(h.position.x).toBeCloseTo(12, 12)
  expect(h.states.filter(([dragging]) => !dragging)).toHaveLength(1)
  h.drag.start(down({ pointerId: 2 }))
  h.advance(20)
  h.drag.move(down({ pointerId: 2, clientX: 120 }))
  h.drag.cancel(down({ pointerId: 2 }))
  h.drag.release(down({ pointerId: 2 }))
  expect(h.element.dataset.gliding).toBe('false')
  h.drag.dispose()
})

test('new input, Escape, blur, visibility loss, reduced motion and disposal interrupt glide', () => {
  for (const kind of [
    'start',
    'pointer',
    'wheel',
    'key',
    'escape',
    'blur',
    'hidden',
    'motion',
    'stop',
    'dispose',
  ]) {
    const h = setup()
    h.drag.start(down())
    h.advance(10)
    h.drag.move(down({ clientX: 120 }))
    h.drag.release(down())
    h.frame(16)
    const position = { ...h.position }
    if (kind === 'start') h.drag.start(down({ pointerId: 2 }))
    else if (kind === 'pointer') h.document.dispatchEvent(new Event('pointerdown'))
    else if (kind === 'wheel') h.document.dispatchEvent(new Event('wheel'))
    else if (kind === 'key' || kind === 'escape')
      h.document.dispatchEvent(
        Object.assign(new Event('keydown', { cancelable: true }), {
          key: kind === 'key' ? 'ArrowRight' : 'Escape',
        }),
      )
    else if (kind === 'blur') h.window.dispatchEvent(new Event('blur'))
    else if (kind === 'hidden') {
      h.document.hidden = true
      h.document.dispatchEvent(new Event('visibilitychange'))
    } else if (kind === 'motion') {
      h.motion.matches = true
      h.motion.dispatchEvent(new Event('change'))
    } else if (kind === 'dispose') h.drag.dispose()
    else h.drag.stop()
    h.document.dispatchEvent(Object.assign(new Event('mouseup'), { button: 0 }))
    h.frame(120)
    expect(h.position, kind).toEqual(position)
    expect(h.frames.size, kind).toBe(0)
    h.drag.dispose()
  }
})

test('late grants after release, replacement drag or disposal cannot lock the cursor, including void-returning runtimes', async () => {
  for (const legacy of [false, true]) {
    for (const cancellation of ['release', 'replace', 'dispose']) {
      const h = setup(legacy)
      h.drag.start(down())
      if (cancellation === 'dispose') h.drag.dispose()
      else h.drag.stop()
      if (cancellation === 'replace') h.drag.start(down({ pointerId: 2 }))
      h.grant()
      await Promise.resolve()
      expect(h.document.pointerLockElement).toBeNull()
      expect(h.element.dataset.pointerLocked).toBe('false')
      if (cancellation === 'replace') {
        h.drag.move(down({ pointerId: 2, clientX: 112 }))
        expect(h.deltas).toEqual([[12, 0]])
      }
      h.drag.dispose()
    }
  }
})

test('denied locks, pen/touch and interruption retain captured dragging without leaving stale listeners', async () => {
  const h = setup()
  h.drag.start(down())
  h.reject()
  await Promise.resolve()
  h.drag.move(down({ clientX: 130 }))
  expect(h.deltas).toEqual([[30, 0]])
  h.window.dispatchEvent(new Event('blur'))
  expect(h.captured.size).toBe(0)
  for (const pointerType of ['touch', 'pen']) {
    h.drag.start(down({ pointerType }))
    h.drag.move(down({ pointerType, clientX: 102 }))
    h.drag.move(down({ pointerType, clientX: 104 }))
    h.drag.lostCapture()
    expect(h.states.at(-1)).toEqual([false, true])
  }
  h.drag.dispose()
  const states = h.states.length
  h.window.dispatchEvent(new Event('blur'))
  h.document.dispatchEvent(new Event('pointerlockchange'))
  expect(h.states).toHaveLength(states)
})

test('rapid clicks during native unlock do not request forbidden capture or leave a drag active', async () => {
  for (const clearedElement of [false, true]) {
    const h = setup()
    h.drag.start(down())
    h.grant()
    await Promise.resolve()
    h.document.exitPointerLock = () => undefined
    h.drag.stop()
    if (clearedElement) {
      h.document.pointerLockElement = null
      h.element.setPointerCapture = () => {
        throw new DOMException('Native unlock pending', 'InvalidStateError')
      }
    }
    h.drag.start(down())
    expect(h.captured.size).toBe(0)
    h.grant()
    await Promise.resolve()
    h.document.pointerLockElement = null
    h.document.dispatchEvent(new Event('pointerlockchange'))
    expect(h.states.at(-1)).toEqual([false, false])
    h.move(100, 100)
    expect(h.deltas).toHaveLength(0)
    h.drag.dispose()
  }
})

test('release before native lock notification does not block subsequent lock requests', async () => {
  for (const legacy of [false, true]) {
    const h = setup(legacy)
    let requests = 0
    const acquire = h.element.requestPointerLock
    h.element.requestPointerLock = () => {
      requests++
      return acquire()
    }
    h.drag.start(down())
    h.grant(false)
    h.drag.stop()
    h.drag.start(down())
    await Promise.resolve()
    expect(requests).toBe(2)
    h.drag.stop()
    h.drag.start(down())
    expect(requests).toBe(2)
    h.grant()
    await Promise.resolve()
    expect(h.document.pointerLockElement).toBeNull()
    h.drag.dispose()
  }
})
