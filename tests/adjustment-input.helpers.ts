import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { activateButton } from './button.helpers'

export async function minimumAdjustmentWindow(app: ElectronApplication, page: Page) {
  const native = await app.browserWindow(page)
  await native.evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await expect
    .poll(() =>
      native.evaluate((window) => {
        const bounds = window.getContentBounds()
        return [bounds.width, bounds.height]
      }),
    )
    .toEqual([1100, 700])
  const toggle = page.getByTestId('console-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await activateButton(toggle)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Hidden Wayland surfaces do not publish post-resize stability/IntersectionObserver updates. */
export async function expectAdjustmentBounds(page: Page, slider: Locator) {
  await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const bounds = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (!box) throw new Error('An adjustment layout element has no measured bounds.')
    expect(box.width).toBeGreaterThan(0)
    expect(box.height).toBeGreaterThan(0)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(1100)
    expect(box.y + box.height).toBeLessThanOrEqual(700)
    return box
  }
  const control = await bounds(slider),
    scroll = await bounds(page.getByTestId('inspector-scroll')),
    undo = await bounds(page.getByRole('button', { name: 'Undo', exact: true })),
    console = await bounds(page.getByTestId('console-panel')),
    preview = await bounds(page.getByTestId('preview-viewport'))
  expect(control.x).toBeGreaterThanOrEqual(scroll.x)
  expect(control.x + control.width).toBeLessThanOrEqual(scroll.x + scroll.width)
  expect(control.y).toBeGreaterThanOrEqual(scroll.y)
  expect(control.y + control.height).toBeLessThanOrEqual(scroll.y + scroll.height)
  expect(
    await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      scrollY,
    })),
  ).toEqual({ width: 1100, height: 700, overflow: false, scrollY: 0 })
  return { control, scroll, undo, console, preview }
}

/** Hold the first real edit IPC before publication; no edit owner or history is replaced. */
export function holdAdjustmentCommit(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('edits:update')!
    let calls = 0,
      held = false,
      resume!: () => void
    const wait = new Promise<void>((resolve) => {
      resume = resolve
    })
    const wrapper: Handler = async (...args) => {
      calls++
      if (calls === 1) {
        held = true
        await wait
        held = false
      }
      return original(...args)
    }
    ipcMain.removeHandler('edits:update')
    ipcMain.handle('edits:update', wrapper)
    return {
      read: () => ({ calls, held }),
      release: () => resume(),
      close() {
        resume()
        if (handlers.get('edits:update') === wrapper) {
          ipcMain.removeHandler('edits:update')
          ipcMain.handle('edits:update', original)
        }
      },
    }
  })
}

/** Native read-only does not protect against programmatic input; exercise the owner guard too. */
export function attemptBusyInput(field: Locator, value: string) {
  return field.evaluate((element, value) => {
    const input = element as HTMLInputElement
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}
