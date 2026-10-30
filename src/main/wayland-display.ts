import type { BrowserWindow, Event, Input, MouseInputEvent, WebContents } from 'electron'

type DisplayRefreshContents = WebContents & {
  setEmbedder?: (embedder: WebContents) => void
}

export function refreshWaylandDisplay(window: BrowserWindow): void {
  if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) return
  const contents = window.webContents as DisplayRefreshContents
  if (
    contents.isDestroyed() ||
    contents.isLoadingMainFrame() ||
    typeof contents.setEmbedder !== 'function'
  )
    return

  const wasFocused = window.isFocused() && contents.isFocused()
  contents.setEmbedder(contents)
  // WasHidden/WasShown can clear native view focus while leaving the window active.
  // Restore only that view's previous focus, preserving the focused DOM control.
  if (
    wasFocused &&
    !window.isDestroyed() &&
    !contents.isDestroyed() &&
    window.isFocused() &&
    !contents.isFocused()
  )
    contents.focus()
}

export class WaylandDisplayRefresh {
  private contents: WebContents
  private buttons = new Set<NonNullable<MouseInputEvent['button']>>()
  private control = false
  private pointerControl = false

  constructor(private window: BrowserWindow) {
    this.contents = window.webContents
    // Observe presses before the renderer can request pointer lock. WasHidden
    // releases that lock even when native focus is immediately restored.
    this.contents.on('before-mouse-event', this.mouse)
    // WasHidden also clears the renderer's physical-Control evidence, making
    // mouse-wheel zoom switch to touchpad sensitivity while the key stays down.
    this.contents.on('before-input-event', this.keyboard)
    this.contents.on('blur', this.blur)
    this.contents.on('did-start-navigation', this.navigation)
    this.contents.on('render-process-gone', this.reset)
    window.on('blur', this.reset)
    window.on('hide', this.reset)
    window.on('minimize', this.reset)
  }

  private mouse = (_event: Event, mouse: MouseInputEvent) => {
    // Recover a modifier already held when entering this view. Wheel events can
    // encode touchpad pinch, so they cannot establish physical Control.
    if (mouse.type !== 'mouseWheel' && mouse.modifiers)
      this.pointerControl = mouse.modifiers.some(
        (modifier) => modifier === 'control' || modifier === 'ctrl',
      )
    if (!mouse.button) return
    if (mouse.type === 'mouseDown') this.buttons.add(mouse.button)
    if (mouse.type === 'mouseUp') this.buttons.delete(mouse.button)
  }

  private keyboard = (_event: Event, input: Input) => {
    this.control = input.control
    this.pointerControl = false
  }

  private reset = () => {
    this.buttons.clear()
    this.control = false
    this.pointerControl = false
  }

  private blur = () => {
    // View blur alone does not establish that the owner was deactivated.
    // Keep held presses and Control until release or actual window focus loss.
    if (this.window.isDestroyed() || !this.window.isFocused()) this.reset()
  }

  private navigation = (_event: Event, _url: string, inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !inPlace) this.reset()
  }

  refresh(): void {
    if (!this.buttons.size && !this.control && !this.pointerControl)
      refreshWaylandDisplay(this.window)
  }

  dispose(): void {
    this.reset()
    this.contents.off('before-mouse-event', this.mouse)
    this.contents.off('before-input-event', this.keyboard)
    this.contents.off('blur', this.blur)
    this.contents.off('did-start-navigation', this.navigation)
    this.contents.off('render-process-gone', this.reset)
    this.window.off('blur', this.reset)
    this.window.off('hide', this.reset)
    this.window.off('minimize', this.reset)
  }
}

/** Work around stale ScreenInfos in Electron 44.3.0 on Wayland. */
export function installWaylandDisplayRefresh(window: BrowserWindow): void {
  if (
    process.platform !== 'linux' ||
    !process.env.WAYLAND_DISPLAY ||
    process.versions.electron !== '44.3.0'
  )
    return

  // This internal method is deliberately confined to the verified, pinned runtime.
  // With the same contents as embedder it retains the existing owner window and
  // synchronously calls WasHidden/WasShown, refreshing native ScreenInfos without
  // reloading, remapping the Wayland surface, or emulating a different display.
  // Recheck this workaround when upgrading Electron; see docs/hdr-processing.md.
  const contents = window.webContents as DisplayRefreshContents
  if (typeof contents.setEmbedder !== 'function') return
  const display = new WaylandDisplayRefresh(window)
  const dispose = () => {
    clearInterval(timer)
    display.dispose()
  }
  const refresh = () => {
    try {
      display.refresh()
    } catch (error) {
      dispose()
      console.warn('Could not refresh the Wayland display:', error)
    }
  }
  // Wayland does not supply global window coordinates or reliable move events.
  // Refresh native metadata while mapped; Blink emits events only when it changes.
  const timer = setInterval(refresh, 1000)
  timer.unref()
  window.once('closed', dispose)
}
