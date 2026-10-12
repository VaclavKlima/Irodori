interface Pointer {
  id: number
  x: number
  y: number
  distance: number
  moved: boolean
  type: string
  samples: { time: number; x: number; y: number }[]
}
export interface AppliedPan {
  x: number
  y: number
}

const GLIDE_MS = 120
const GLIDE_LIMIT = 24
const VELOCITY_WINDOW_MS = 60

// Pointer capture handles touch/pen and denied locks. Mouse locking provides
// relative motion beyond window/screen edges and hides the cursor until release.
export class PanDrag {
  private pointer: Pointer | null = null
  private pending: Pointer | null = null
  private locked = false
  private disposed = false
  private document: Document
  private motion?: MediaQueryList
  private glideFrame = 0
  private glideState?: { x: number; y: number; started: number; progress: number }
  constructor(
    private element: HTMLElement,
    private pan: (x: number, y: number) => AppliedPan,
    private changed: (dragging: boolean, moved: boolean) => void,
  ) {
    this.document = element.ownerDocument
    element.dataset.pointerLocked = 'false'
    element.dataset.gliding = 'false'
    this.motion = this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)')
    this.motion?.addEventListener('change', this.stopGlide)
    this.document.addEventListener('mousemove', this.mouseMove)
    this.document.addEventListener('mouseup', this.mouseUp, true)
    this.document.addEventListener('pointerlockchange', this.lockChange)
    this.document.addEventListener('pointerlockerror', this.finishRequest)
    this.document.addEventListener('keydown', this.keyDown, true)
    this.document.addEventListener('pointerdown', this.stopGlide, true)
    this.document.addEventListener('wheel', this.stopGlide, true)
    this.document.addEventListener('visibilitychange', this.visibilityChange)
    this.document.defaultView?.addEventListener('blur', this.stop)
  }
  start(event: PointerEvent) {
    this.stopGlide()
    if (this.disposed || this.pointer || event.button !== 0 || !event.isPrimary) return
    const pointer: Pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      distance: 0,
      moved: false,
      type: event.pointerType,
      samples: [{ time: this.now(), x: 0, y: 0 }],
    }
    // Chromium can still forbid capture during native unlock, even after
    // pointerLockElement becomes null. A mouse drag can acquire a new lock.
    try {
      if (!this.document.pointerLockElement) this.element.setPointerCapture(pointer.id)
    } catch (error) {
      if (
        event.pointerType !== 'mouse' ||
        !(error instanceof DOMException) ||
        error.name !== 'InvalidStateError'
      )
        return
    }
    this.pointer = pointer
    this.locked = this.ownsLock()
    this.element.dataset.pointerLocked = String(this.locked)
    this.changed(true, false)
    if (event.pointerType !== 'mouse' || this.pending) return
    this.pending = pointer
    try {
      const request = this.element.requestPointerLock() as Promise<void> | undefined
      void request?.then(
        () => {
          // A release, resize, photo/revision change or unmount can beat the async grant.
          // Native change/error events also cover runtimes returning void.
          if (this.pending !== pointer) return
          this.lockChange()
          this.finishRequest()
        },
        () => {
          if (this.pending === pointer) this.finishRequest()
        },
      )
    } catch {
      this.finishRequest()
    }
  }
  move(event: PointerEvent) {
    const pointer = this.pointer
    if (!pointer || event.pointerId !== pointer.id || this.ownsLock()) return
    if (!(event.buttons & 1)) {
      this.stop()
      return
    }
    const x = event.clientX - pointer.x,
      y = event.clientY - pointer.y
    pointer.x = event.clientX
    pointer.y = event.clientY
    this.moveBy(x, y)
  }
  private moveBy(x: number, y: number) {
    if (!this.pointer || (!x && !y)) return
    this.pointer.distance += Math.abs(x) + Math.abs(y)
    this.pointer.moved ||= this.pointer.distance > 2
    const applied = this.pan(x, y)
    const samples = this.pointer.samples,
      previous = samples.at(-1)!,
      time = this.now()
    samples.push({ time, x: previous.x + applied.x, y: previous.y + applied.y })
    while (samples.length > 2 && samples[1].time < time - VELOCITY_WINDOW_MS) samples.shift()
  }
  private now() {
    return this.document.defaultView!.performance.now()
  }
  private beginGlide(pointer: Pointer) {
    if (pointer.type !== 'mouse' || !pointer.moved || this.motion?.matches || this.document.hidden)
      return
    const started = this.now(),
      samples = pointer.samples,
      last = samples.at(-1)!,
      cutoff = Math.max(samples[0].time, started - VELOCITY_WINDOW_MS)
    if (started - last.time >= VELOCITY_WINDOW_MS || started <= cutoff) return
    let before = samples[0],
      after = before
    for (const sample of samples) {
      if (sample.time <= cutoff) before = sample
      else {
        after = sample
        break
      }
    }
    const fraction =
      after.time > before.time ? (cutoff - before.time) / (after.time - before.time) : 0
    const vx = (last.x - before.x - (after.x - before.x) * fraction) / (started - cutoff),
      vy = (last.y - before.y - (after.y - before.y) * fraction) / (started - cutoff)
    const speed = Math.hypot(vx, vy)
    if (speed < 0.05) return
    // Cubic ease-out starts at the measured velocity before the distance cap.
    const distance = Math.min(GLIDE_LIMIT, (speed * GLIDE_MS) / 3)
    this.glideState = {
      x: (vx * distance) / speed,
      y: (vy * distance) / speed,
      started,
      progress: 0,
    }
    this.element.dataset.gliding = 'true'
    this.glideFrame = this.document.defaultView!.requestAnimationFrame(this.animateGlide)
  }
  private animateGlide = (time: number) => {
    this.glideFrame = 0
    const glide = this.glideState
    if (!glide) return
    const elapsed = Math.max(0, Math.min(1, (time - glide.started) / GLIDE_MS)),
      progress = 1 - (1 - elapsed) ** 3,
      dx = glide.x * (progress - glide.progress),
      dy = glide.y * (progress - glide.progress)
    const applied = this.pan(dx, dy)
    if (Math.abs(applied.x - dx) > 0.000001) glide.x = 0
    if (Math.abs(applied.y - dy) > 0.000001) glide.y = 0
    glide.progress = progress
    if (elapsed >= 1 || (!glide.x && !glide.y)) this.stopGlide()
    else this.glideFrame = this.document.defaultView!.requestAnimationFrame(this.animateGlide)
  }
  private stopGlide = () => {
    if (!this.glideFrame && !this.glideState) return
    if (this.glideFrame) this.document.defaultView!.cancelAnimationFrame(this.glideFrame)
    this.glideFrame = 0
    this.glideState = undefined
    this.element.dataset.gliding = 'false'
  }
  private visibilityChange = () => {
    if (this.document.hidden) this.stop()
  }
  private ownsLock() {
    return this.document.pointerLockElement === this.element
  }
  private unlock() {
    if (this.ownsLock()) this.document.exitPointerLock()
  }
  private mouseMove = (event: MouseEvent) => {
    if (!this.ownsLock() || !this.pointer) return
    if (!(event.buttons & 1)) {
      this.stop()
      return
    }
    this.moveBy(event.movementX, event.movementY)
  }
  private mouseUp = (event: MouseEvent) => {
    if (event.button === 0 && this.pointer?.type === 'mouse') this.finish(true)
  }
  private keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (this.pointer || this.glideState)) {
      event.preventDefault()
      event.stopPropagation()
      this.stop()
    } else this.stopGlide()
  }
  private lockChange = () => {
    const locked = this.ownsLock()
    const pending = this.pending
    if (locked) this.finishRequest()
    if (locked && (!this.pointer || this.disposed || (pending && pending !== this.pointer))) {
      this.unlock()
      return
    }
    this.element.dataset.pointerLocked = String(locked)
    if (!locked && this.locked) this.stop()
    this.locked = locked
  }
  private finishRequest = () => {
    this.pending = null
    if (this.disposed) {
      this.document.removeEventListener('pointerlockchange', this.lockChange)
      this.document.removeEventListener('pointerlockerror', this.finishRequest)
    }
  }
  lostCapture = () => {
    if (this.pointer && !this.ownsLock()) this.stop()
  }
  release = (event: PointerEvent) => {
    if (event.button === 0 && event.pointerId === this.pointer?.id) this.finish(true)
  }
  cancel = (event: PointerEvent) => {
    if (event.pointerId === this.pointer?.id) this.stop()
  }
  private finish(released: boolean) {
    const pointer = this.pointer
    if (!pointer && !this.ownsLock() && !this.locked) return
    // The lock can be granted before its change event is delivered.
    if (this.ownsLock()) this.finishRequest()
    this.pointer = null
    this.locked = false
    this.element.dataset.pointerLocked = 'false'
    if (pointer) {
      if (this.element.hasPointerCapture(pointer.id)) this.element.releasePointerCapture(pointer.id)
      this.changed(false, pointer.moved)
    }
    this.unlock()
    if (released && pointer) this.beginGlide(pointer)
  }
  stop = () => {
    this.stopGlide()
    this.finish(false)
  }
  dispose() {
    this.disposed = true
    this.stop()
    this.document.removeEventListener('mousemove', this.mouseMove)
    this.document.removeEventListener('mouseup', this.mouseUp, true)
    if (!this.pending) this.finishRequest()
    this.document.removeEventListener('keydown', this.keyDown, true)
    this.document.removeEventListener('pointerdown', this.stopGlide, true)
    this.document.removeEventListener('wheel', this.stopGlide, true)
    this.document.removeEventListener('visibilitychange', this.visibilityChange)
    this.motion?.removeEventListener('change', this.stopGlide)
    this.document.defaultView?.removeEventListener('blur', this.stop)
  }
}
