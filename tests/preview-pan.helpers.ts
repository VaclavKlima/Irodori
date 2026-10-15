import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { testUiMode } from '../scripts/test-ui-mode.mjs'

export async function focusPreviewWindow(app: ElectronApplication, page: Page) {
  if (testUiMode() !== 'foreground')
    throw new Error('Native preview focus requires an explicit foreground test run.')
  const window = await app.browserWindow(page)
  // CDP input alone does not establish the native focus required by pointer lock.
  if (!(await window.evaluate((window) => window.isFocused()))) {
    // Let the hide finish before remapping the isolated Wayland test window.
    await window.evaluate((window) => window.hide())
    await page.waitForTimeout(500)
    await window.evaluate((window) => window.show())
  }
  await window.evaluate((window) => {
    window.focus()
    window.webContents.focus()
  })
  await expect
    .poll(() =>
      window.evaluate((window) => ({
        window: window.isFocused(),
        contents: window.webContents.isFocused(),
      })),
    )
    .toEqual({ window: true, contents: true })
}

export async function verifyLockedPan(
  app: ElectronApplication,
  page: Page,
  viewport: Locator,
  zoom: Locator,
) {
  await zoom.selectOption('8')
  await focusPreviewWindow(app, page)
  const refresh = await app.evaluateHandle(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const contents = window.webContents as Electron.WebContents & {
      setEmbedder: (embedder: Electron.WebContents) => void
    }
    const enabled =
      process.platform === 'linux' &&
      Boolean(process.env.WAYLAND_DISPLAY) &&
      process.versions.electron === '44.3.0'
    let count = 0
    const events: string[] = []
    const focusState = () => `${window.isFocused()}:${contents.isFocused()}`
    const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (input.type !== 'mouseMove') events.push(`${input.type}:${input.button}:${focusState()}`)
    }
    const blur = () => events.push(`contents:blur:${focusState()}`)
    const windowBlur = () => events.push(`window:blur:${focusState()}`)
    const original = contents.setEmbedder
    if (enabled) {
      contents.on('before-mouse-event', mouse)
      contents.on('blur', blur)
      window.on('blur', windowBlur)
      contents.setEmbedder = (embedder) => {
        count++
        events.push(`refresh:${focusState()}`)
        original.call(contents, embedder)
      }
    }
    return {
      enabled,
      read: () => ({ count, events, focus: focusState() }),
      restore: () => {
        if (!enabled) return
        contents.setEmbedder = original
        contents.off('before-mouse-event', mouse)
        contents.off('blur', blur)
        window.off('blur', windowBlur)
      },
    }
  })
  const nativeRefresh = await refresh.evaluate((control) => control.enabled)
  const refreshCount = () => refresh.evaluate((control) => control.read().count)
  const geometry = () =>
    viewport.evaluate((el) => ({ x: Number(el.dataset.panX), y: Number(el.dataset.panY) }))
  const locked = () => viewport.evaluate((el) => document.pointerLockElement === el)
  const box = (await viewport.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  async function begin() {
    // Native select popups and later display refreshes can change desktop
    // activation after the initial focus check. Each gesture needs real focus.
    await focusPreviewWindow(app, page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await expect.poll(locked).toBe(true)
    await expect(viewport).toHaveCSS('cursor', 'none')
  }
  async function holdAcrossRefresh() {
    const before = await refreshCount()
    // Keep the button held across at least two real timer ticks.
    await page.waitForTimeout(2200)
    expect(
      await locked(),
      JSON.stringify(await refresh.evaluate((control) => control.read())),
    ).toBe(true)
    await expect(viewport).toHaveAttribute('data-dragging', 'true')
    if (nativeRefresh) expect(await refreshCount()).toBe(before)
  }
  if (nativeRefresh) await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(0)
  await begin()
  await holdAcrossRefresh()
  const before = await geometry()
  await viewport.evaluate((el) => {
    for (let i = 0; i < 4; i++) {
      // Locked client coordinates stay fixed; movement continues beyond viewport/window bounds.
      el.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          buttons: 1,
          clientX: 8000,
          clientY: -8000,
        }),
      )
      el.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          buttons: 1,
          clientX: 8000,
          clientY: -8000,
          movementX: 150,
          movementY: -90,
        }),
      )
    }
  })
  await expect.poll(async () => (await geometry()).x).toBe(before.x + 600)
  await expect.poll(async () => (await geometry()).y).toBe(before.y - 360)
  await expect.poll(locked).toBe(true)
  // Actual Chromium input also produces relative motion while the pointer is locked.
  await page.mouse.move(point.x - 20, point.y - 10)
  await expect.poll(async () => (await geometry()).x).not.toBe(before.x + 600)
  await page.mouse.up()
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await expect(viewport).not.toHaveCSS('cursor', 'none')
  expect(await viewport.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
  await expect(viewport).toHaveAttribute('data-gliding', 'false')
  const released = await geometry()
  await page.mouse.move(point.x + 40, point.y + 20)
  expect(await geometry()).toEqual(released)

  if (nativeRefresh) {
    const before = await refreshCount()
    await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(before)
    // Start a second drag just before the next scheduled refresh.
    await page.waitForTimeout(800)
  }
  await begin()
  await holdAcrossRefresh()
  await page.keyboard.press('Escape')
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()
  if (nativeRefresh) {
    const before = await refreshCount()
    await expect.poll(refreshCount, { intervals: [50] }).toBeGreaterThan(before)
  }
  await refresh.evaluate((control) => control.restore())
  await refresh.dispose()

  await begin()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect.poll(locked).toBe(false)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()

  await zoom.selectOption('fit')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 10, point.y + 5)
  expect(await locked()).toBe(false)
  await page.mouse.up()
}

export async function verifyPanGlide(
  app: ElectronApplication,
  page: Page,
  viewport: Locator,
  zoom: Locator,
) {
  await focusPreviewWindow(app, page)
  const initialSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await zoom.selectOption('8')
  for (const interruption of ['none', 'escape', 'wheel', 'blur', 'resize', 'reduced']) {
    await page.emulateMedia({
      reducedMotion: interruption === 'reduced' ? 'reduce' : 'no-preference',
    })
    const box = (await viewport.boundingBox())!
    const cursor = { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) }
    await page.mouse.move(cursor.x, cursor.y)
    await page.mouse.down()
    await expect
      .poll(() =>
        viewport.evaluate((el) => document.pointerLockElement === el || el.hasPointerCapture(1)),
      )
      .toBe(true)
    const released = await viewport.evaluate(async (el, cursor) => {
      const frame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
      for (let i = 0; i < 3; i++) {
        await frame()
        if (document.pointerLockElement === el)
          el.dispatchEvent(
            new MouseEvent('mousemove', { bubbles: true, buttons: 1, movementX: 6, movementY: 3 }),
          )
        else
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              buttons: 1,
              pointerType: 'mouse',
              isPrimary: true,
              pointerId: 1,
              clientX: cursor.x + (i + 1) * 6,
              clientY: cursor.y + (i + 1) * 3,
            }),
          )
      }
      await frame()
      const view = { x: Number(el.dataset.panX), y: Number(el.dataset.panY) }
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      )
      // Chromium's subsequent mouseup and unlock notification must preserve the tail.
      document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
      el.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }))
      return { ...view, gliding: el.dataset.gliding, locked: document.pointerLockElement === el }
    }, cursor)
    expect(released.locked).toBe(false)
    expect(released.gliding, interruption).toBe(interruption === 'reduced' ? 'false' : 'true')
    await page.mouse.up()
    await expect(viewport).toHaveAttribute('data-dragging', 'false')
    await expect(viewport).not.toHaveCSS('cursor', 'none')
    if (interruption === 'escape') await page.keyboard.press('Escape')
    else if (interruption === 'wheel')
      await viewport.dispatchEvent('wheel', { deltaX: 0, deltaY: 0 })
    else if (interruption === 'blur')
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else if (interruption === 'resize')
      await (
        await app.browserWindow(page)
      ).evaluate((window, size) => window.setContentSize(size.width + 20, size.height), initialSize)
    await expect(viewport).toHaveAttribute('data-gliding', 'false')
    await viewport.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    const settled = await viewport.evaluate((el) => ({
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
    }))
    const distance = Math.hypot(settled.x - released.x, settled.y - released.y)
    expect(distance, interruption).toBeLessThanOrEqual(24.001)
    if (interruption === 'none') expect(distance).toBeGreaterThan(0)
    if (interruption === 'reduced') expect(distance).toBe(0)
    await viewport.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    expect(
      await viewport.evaluate((el) => ({ x: Number(el.dataset.panX), y: Number(el.dataset.panY) })),
    ).toEqual(settled)
  }
  await (
    await app.browserWindow(page)
  ).evaluate((window, size) => window.setContentSize(size.width, size.height), initialSize)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
}
