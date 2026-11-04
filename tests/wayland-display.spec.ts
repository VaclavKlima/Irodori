import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, Input, MouseInputEvent } from 'electron'
import { refreshWaylandDisplay, WaylandDisplayRefresh } from '../src/main/wayland-display'

interface DisplayState {
  windowFocused: boolean
  contentsFocused: boolean
  windowDestroyed: boolean
  contentsDestroyed: boolean
  visible: boolean
  minimized: boolean
  loading: boolean
  pickerOpen: boolean
}

function displayWindow(
  onRefresh: (state: DisplayState) => void = (state) => {
    state.contentsFocused = false
  },
) {
  const state: DisplayState = {
    windowFocused: true,
    contentsFocused: true,
    windowDestroyed: false,
    contentsDestroyed: false,
    visible: true,
    minimized: false,
    loading: false,
    pickerOpen: false,
  }
  const calls = { refresh: 0, focus: 0 }
  let probes = 0
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.contentsDestroyed,
    isLoadingMainFrame: () => state.loading,
    isFocused: () => state.contentsFocused,
    executeJavaScript: async (code: string): Promise<boolean> => {
      expect(code).toBe('Boolean(document.querySelector("select:open, input:open"))')
      probes++
      return state.pickerOpen
    },
    focus: () => {
      expect(state.windowDestroyed || state.contentsDestroyed).toBe(false)
      calls.focus++
      state.contentsFocused = true
    },
    setEmbedder: (embedder: unknown) => {
      expect(embedder).toBe(contents)
      calls.refresh++
      onRefresh(state)
    },
  })
  const events = new EventEmitter()
  const window = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    get webContents() {
      expect(state.windowDestroyed).toBe(false)
      return contents
    },
    isDestroyed: () => state.windowDestroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.windowFocused,
  } as unknown as BrowserWindow
  return { state, calls, contents, window, events, probes: () => probes }
}

test('restores native content focus lost during each display refresh', () => {
  const { state, calls, window } = displayWindow()
  for (let cycle = 0; cycle < 5; cycle++) {
    refreshWaylandDisplay(window)
    expect(state.contentsFocused).toBe(true)
  }
  expect(calls).toEqual({ refresh: 5, focus: 5 })
})

test('leaves retained native focus alone', () => {
  const { state, calls, window } = displayWindow(() => undefined)
  refreshWaylandDisplay(window)
  expect(state.contentsFocused).toBe(true)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

test('does not focus content that was initially unfocused', () => {
  const { state, calls, window } = displayWindow()
  state.contentsFocused = false
  refreshWaylandDisplay(window)
  expect(state.contentsFocused).toBe(false)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

test('refreshes a background window without taking focus', () => {
  const { state, calls, window } = displayWindow()
  state.windowFocused = false
  refreshWaylandDisplay(window)
  expect(state.windowFocused).toBe(false)
  expect(state.contentsFocused).toBe(false)
  expect(calls).toEqual({ refresh: 1, focus: 0 })
})

for (const change of ['windowDestroyed', 'contentsDestroyed', 'windowFocused'] as const) {
  test(`does not restore focus when ${change} changes during refresh`, () => {
    const { state, calls, window } = displayWindow((state) => {
      state.contentsFocused = false
      state[change] = change !== 'windowFocused'
    })
    refreshWaylandDisplay(window)
    expect(state.contentsFocused).toBe(false)
    expect(calls).toEqual({ refresh: 1, focus: 0 })
  })
}

function mouse(
  contents: EventEmitter,
  type: MouseInputEvent['type'],
  button?: MouseInputEvent['button'],
  modifiers?: MouseInputEvent['modifiers'],
) {
  contents.emit('before-mouse-event', {}, { type, button, modifiers, x: 100, y: 80 })
}

function keyboard(
  contents: EventEmitter,
  type: 'keyDown' | 'keyUp',
  control: boolean,
  key = 'Control',
) {
  const input: Input = {
    type,
    key,
    code: key === 'Control' ? 'ControlLeft' : key,
    control,
    isAutoRepeat: false,
    isComposing: false,
    shift: key === 'Shift' && type === 'keyDown',
    alt: false,
    meta: false,
    location: 0,
    modifiers: control ? ['control'] : [],
  }
  contents.emit('before-input-event', {}, input)
}

for (const button of ['left', 'middle', 'right'] as const) {
  test(`defers every display refresh throughout a held ${button} press and resumes after release`, async () => {
    const { calls, contents, window } = displayWindow()
    const display = new WaylandDisplayRefresh(window)
    mouse(contents, 'mouseDown', button)
    mouse(contents, 'mouseMove')
    mouse(contents, 'mouseLeave')
    for (let tick = 0; tick < 5; tick++) await display.refresh()
    expect(calls).toEqual({ refresh: 0, focus: 0 })
    mouse(contents, 'mouseUp', button)
    await display.refresh()
    expect(calls).toEqual({ refresh: 1, focus: 1 })
    display.dispose()
  })
}

test('releasing another button does not interrupt a held drag', async () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  mouse(contents, 'mouseDown', 'right')
  mouse(contents, 'mouseUp', 'right')
  await display.refresh()
  expect(calls.refresh).toBe(0)
  mouse(contents, 'mouseUp', 'left')
  await display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

test('a native view blur inside the active window preserves the held-drag guard', async () => {
  const { state, calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  state.contentsFocused = false
  contents.emit('blur')
  for (let tick = 0; tick < 5; tick++) await display.refresh()
  expect(calls).toEqual({ refresh: 0, focus: 0 })
  mouse(contents, 'mouseUp', 'left')
  await display.refresh()
  expect(calls).toEqual({ refresh: 1, focus: 0 })
  display.dispose()
})

test('preserves held Control across active-window view blur and resumes refresh after release', async () => {
  const { state, calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  keyboard(contents, 'keyDown', true)
  for (let tick = 0; tick < 5; tick++) await display.refresh()
  expect(calls).toEqual({ refresh: 0, focus: 0 })
  state.contentsFocused = false
  contents.emit('blur')
  // A view-generated pointer move must not erase an observed keyboard hold.
  mouse(contents, 'mouseMove', undefined, [])
  mouse(contents, 'mouseWheel', undefined, [])
  keyboard(contents, 'keyUp', true, 'Shift')
  for (let tick = 0; tick < 5; tick++) await display.refresh()
  expect(calls).toEqual({ refresh: 0, focus: 0 })
  keyboard(contents, 'keyUp', false)
  await display.refresh()
  expect(calls).toEqual({ refresh: 1, focus: 0 })
  display.dispose()
})

for (const modifier of ['control', 'ctrl'] as const) {
  test(`defers refresh when entering with ${modifier} already held and resumes after pointer release evidence`, async () => {
    const { calls, contents, window } = displayWindow()
    const display = new WaylandDisplayRefresh(window)
    mouse(contents, 'mouseEnter', undefined, [modifier])
    // No keyboard event is available when the modifier was pressed elsewhere.
    mouse(contents, 'mouseWheel')
    contents.emit('blur')
    for (let tick = 0; tick < 5; tick++) await display.refresh()
    expect(calls).toEqual({ refresh: 0, focus: 0 })
    mouse(contents, 'mouseMove', undefined, [])
    await display.refresh()
    expect(calls).toEqual({ refresh: 1, focus: 1 })
    display.dispose()
  })
}

test('touchpad wheel Control does not establish a held keyboard modifier', async () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseWheel', undefined, ['control'])
  await display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

test('refresh waits for both the mouse press and Control to be released', async () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  keyboard(contents, 'keyDown', true)
  mouse(contents, 'mouseDown', 'left', ['control'])
  mouse(contents, 'mouseUp', 'left', ['control'])
  await display.refresh()
  expect(calls.refresh).toBe(0)
  mouse(contents, 'mouseDown', 'left', ['control'])
  keyboard(contents, 'keyUp', false)
  await display.refresh()
  expect(calls.refresh).toBe(0)
  mouse(contents, 'mouseUp', 'left', [])
  await display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

for (const [source, event] of [
  ['window', 'blur'],
  ['window', 'hide'],
  ['window', 'minimize'],
  ['contents', 'blur'],
  ['contents', 'render-process-gone'],
] as const) {
  test(`clears held presses and Control after ${source} ${event}, allowing future refreshes and drags`, async () => {
    const { state, calls, contents, window, events } = displayWindow()
    const display = new WaylandDisplayRefresh(window)
    mouse(contents, 'mouseDown', 'left')
    keyboard(contents, 'keyDown', true)
    mouse(contents, 'mouseMove', undefined, ['control'])
    if (source === 'contents' && event === 'blur') state.windowFocused = false
    const target = source === 'window' ? events : contents
    target.emit(event)
    await display.refresh()
    expect(calls.refresh).toBe(1)
    mouse(contents, 'mouseDown', 'left')
    await display.refresh()
    expect(calls.refresh).toBe(1)
    mouse(contents, 'mouseUp', 'left')
    await display.refresh()
    expect(calls.refresh).toBe(2)
    display.dispose()
  })
}

test('only a new main-frame navigation clears unfinished presses and Control', async () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  keyboard(contents, 'keyDown', true)
  mouse(contents, 'mouseMove', undefined, ['control'])
  for (const [inPlace, main] of [
    [false, false],
    [true, true],
  ]) {
    contents.emit('did-start-navigation', {}, 'irodori://page', inPlace, main)
    await display.refresh()
    expect(calls.refresh).toBe(0)
  }
  contents.emit('did-start-navigation', {}, 'irodori://page', false, true)
  await display.refresh()
  expect(calls.refresh).toBe(1)
  display.dispose()
})

test('disposal removes input and lifecycle observers without removing other listeners', async () => {
  const { calls, contents, window, events } = displayWindow()
  const unrelated = () => undefined
  contents.on('before-mouse-event', unrelated)
  contents.on('before-input-event', unrelated)
  const display = new WaylandDisplayRefresh(window)
  mouse(contents, 'mouseDown', 'left')
  keyboard(contents, 'keyDown', true)
  mouse(contents, 'mouseMove', undefined, ['control'])
  display.dispose()
  display.dispose()
  expect(contents.eventNames()).toEqual(['before-mouse-event', 'before-input-event'])
  expect(contents.listeners('before-mouse-event')).toEqual([unrelated])
  expect(contents.listeners('before-input-event')).toEqual([unrelated])
  expect(events.eventNames()).toEqual([])
  mouse(contents, 'mouseDown', 'left', ['control'])
  keyboard(contents, 'keyDown', true)
  await display.refresh()
  expect(calls).toEqual({ refresh: 0, focus: 0 })
})

function holdPickerProbe(contents: ReturnType<typeof displayWindow>['contents']) {
  const original = contents.executeJavaScript
  let resolve!: (open: boolean) => void,
    reject!: (error: Error) => void,
    calls = 0
  const result = new Promise<boolean>((done, fail) => {
    resolve = done
    reject = fail
  })
  contents.executeJavaScript = () => {
    calls++
    return result
  }
  return {
    resolve,
    reject,
    calls: () => calls,
    restore: () => {
      contents.executeJavaScript = original
    },
  }
}

test('an open native picker defers refresh after release and a closed focused select does not', async () => {
  const { state, calls, contents, window, probes } = displayWindow()
  const display = new WaylandDisplayRefresh(window)
  try {
    mouse(contents, 'mouseDown', 'left')
    state.pickerOpen = true
    mouse(contents, 'mouseUp', 'left')
    for (let tick = 0; tick < 5; tick++) await display.refresh()
    expect(probes()).toBe(5)
    expect(calls).toEqual({ refresh: 0, focus: 0 })
    expect(state.contentsFocused).toBe(true)
    state.pickerOpen = false
    await display.refresh()
    expect(calls).toEqual({ refresh: 1, focus: 1 })
    expect(state.contentsFocused).toBe(true)
  } finally {
    display.dispose()
  }
})

test('a pending picker probe excludes overlapping timer ticks without queuing a burst', async () => {
  const { calls, contents, window } = displayWindow()
  const display = new WaylandDisplayRefresh(window),
    probe = holdPickerProbe(contents)
  try {
    const pending = display.refresh()
    for (let tick = 0; tick < 5; tick++) await display.refresh()
    expect(probe.calls()).toBe(1)
    expect(calls.refresh).toBe(0)
    probe.resolve(false)
    await pending
    expect(calls.refresh).toBe(1)
    probe.restore()
    await display.refresh()
    expect(calls.refresh).toBe(2)
  } finally {
    display.dispose()
  }
})

for (const change of [
  'mouse',
  'keyboard',
  'view-blur',
  'window-blur',
  'window-hide',
  'window-minimize',
  'navigation',
  'same-document-navigation',
  'renderer-loss',
  'disposal',
] as const)
  test(`a picker probe cannot refresh after intervening ${change}`, async () => {
    const { calls, contents, window, events } = displayWindow()
    const display = new WaylandDisplayRefresh(window),
      probe = holdPickerProbe(contents)
    try {
      const pending = display.refresh()
      if (change === 'mouse') {
        mouse(contents, 'mouseDown', 'left')
        mouse(contents, 'mouseUp', 'left')
      } else if (change === 'keyboard') {
        keyboard(contents, 'keyDown', false, 'Enter')
        keyboard(contents, 'keyUp', false, 'Enter')
      } else if (change === 'view-blur') contents.emit('blur')
      else if (change.startsWith('window-')) events.emit(change.slice('window-'.length))
      else if (change === 'navigation' || change === 'same-document-navigation')
        contents.emit(
          'did-start-navigation',
          {},
          'irodori://page',
          change === 'same-document-navigation',
          true,
        )
      else if (change === 'renderer-loss') contents.emit('render-process-gone')
      else display.dispose()
      probe.resolve(false)
      await pending
      expect(calls).toEqual({ refresh: 0, focus: 0 })
      probe.restore()
      await display.refresh()
      expect(calls.refresh).toBe(change === 'disposal' ? 0 : 1)
    } finally {
      display.dispose()
    }
  })

for (const guard of [
  'windowDestroyed',
  'contentsDestroyed',
  'visible',
  'minimized',
  'loading',
] as const)
  test(`a picker probe rechecks ${guard} before native refresh`, async () => {
    const { state, calls, contents, window } = displayWindow()
    const display = new WaylandDisplayRefresh(window),
      probe = holdPickerProbe(contents)
    try {
      const pending = display.refresh()
      state[guard] = guard !== 'visible'
      probe.resolve(false)
      await pending
      expect(calls).toEqual({ refresh: 0, focus: 0 })
    } finally {
      display.dispose()
    }
  })

test('a current picker-probe failure propagates while obsolete navigation/disposal failures drain', async () => {
  for (const change of ['none', 'navigation', 'disposal'] as const) {
    const { calls, contents, window } = displayWindow()
    const display = new WaylandDisplayRefresh(window),
      probe = holdPickerProbe(contents)
    try {
      const pending = display.refresh()
      if (change === 'navigation')
        contents.emit('did-start-navigation', {}, 'irodori://page', false, true)
      if (change === 'disposal') display.dispose()
      probe.reject(new Error('The renderer context is gone.'))
      if (change === 'none') await expect(pending).rejects.toThrow('renderer context')
      else await pending
      expect(calls.refresh).toBe(0)
      probe.restore()
      await display.refresh()
      expect(calls.refresh).toBe(change === 'disposal' ? 0 : 1)
    } finally {
      display.dispose()
    }
  }
})

for (const guard of [
  'windowDestroyed',
  'contentsDestroyed',
  'visible',
  'minimized',
  'loading',
] as const) {
  test(`skips refresh when ${guard} prevents a mapped, ready view`, () => {
    const { state, calls, window } = displayWindow()
    state[guard] = guard !== 'visible'
    refreshWaylandDisplay(window)
    expect(calls).toEqual({ refresh: 0, focus: 0 })
  })
}
