import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { nativeEditorInput, captureNativeEditor } from './professional-editor-native.helpers'
import { verifyLockedPan, focusPreviewWindow } from './preview-pan.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

async function minimumNativeProofWindow(app: ElectronApplication, page: Page) {
  const native = await app.browserWindow(page)
  await expect
    .poll(() => native.evaluate((window) => window.isVisible()), {
      timeout: 15000,
      intervals: [100],
    })
    .toBe(true)
  let stableSince = 0
  await expect
    .poll(
      async () => {
        // Wayland can deliver the initial configure after the first resize.
        // Finish geometry recovery before establishing the native input owner.
        const state = await native.evaluate((window) => {
          const size = window.getContentSize(),
            visible = window.isVisible(),
            minimized = window.isMinimized(),
            maximized = window.isMaximized()
          let recovery = false
          if (minimized) {
            window.restore()
            recovery = true
          } else if (maximized) {
            window.unmaximize()
            recovery = true
          } else if (visible && (size[0] !== 1100 || size[1] !== 700)) {
            window.setContentSize(1100, 700)
            recovery = true
          }
          return { size, visible, minimized, maximized, recovery }
        })
        const viewport = await page.evaluate(() => [innerWidth, innerHeight])
        if (
          state.recovery ||
          !state.visible ||
          state.minimized ||
          state.maximized ||
          state.size[0] !== 1100 ||
          state.size[1] !== 700 ||
          viewport[0] !== 1100 ||
          viewport[1] !== 700
        ) {
          stableSince = 0
          return false
        }
        stableSince ||= performance.now()
        return performance.now() - stableSince >= 1000
      },
      { timeout: 15000, intervals: [100] },
    )
    .toBe(true)
  return native
}

test(
  'native output proof keyboard, pointer lock and picker choice/Escape/outside dismissal at 1100 × 700 with Console open',
  foregroundTest(
    'Actual keyboard focus, pointer lock, native select-popup lifetime and Wayland display refresh require a foreground desktop.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(150000)
    const { app, page } = irodori
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
    const native = await minimumNativeProofWindow(app, page)
    const input = await nativeEditorInput(app, page, irodori.userDataDir)
    const refresh = await native.evaluateHandle((window) => {
      const contents = window.webContents as Electron.WebContents & {
        setEmbedder?: (contents: Electron.WebContents) => void
      }
      const original = contents.setEmbedder
      let count = 0
      if (original)
        contents.setEmbedder = (embedder) => {
          count++
          original.call(contents, embedder)
        }
      return {
        read: () => count,
        restore: () => {
          contents.setEmbedder = original
        },
      }
    })
    const popupKey = (keyCode: string) =>
      native.evaluate((window, keyCode) => {
        if (!window.isVisible() || !window.isFocused())
          throw new Error('The isolated popup owner lost focus.')
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      }, keyCode)
    try {
      await input.activate(page.getByTestId('console-toggle'))
      await input.activate(page.getByRole('button', { name: 'Export photo', exact: true }))
      await input.activate(page.getByRole('button', { name: /Custom…/ }))
      const dialog = page.getByRole('dialog', { name: 'Custom JPEG export' }),
        viewport = page.getByTestId('output-proof-viewport')
      await input.activate(dialog.getByRole('button', { name: 'Preview output', exact: true }))
      await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
      await focusPreviewWindow(app, page)
      await input.focus(viewport)
      await input.key('1')
      await expect(viewport).toHaveAttribute('data-scale', '1')
      await input.key('Right')
      await expect(viewport).toHaveAttribute('data-x', '-30')
      await input.key('F')
      await expect(viewport).toHaveAttribute('data-fit', 'true')
      const zoom = page.getByLabel('Output preview zoom', { exact: true })
      const evidence: unknown[] = []
      for (const picker of [
        {
          id: 'zoom',
          select: zoom,
          choice: '1',
          keys: ['Home', 'Down', 'Down', 'Down', 'Down'],
        },
        {
          id: 'output-sharpening',
          select: dialog.getByRole('combobox', { name: 'Output sharpening', exact: true }),
          choice: 'standard',
          keys: ['Home', 'Down', 'Down'],
        },
      ]) {
        const select = picker.select
        for (const dismissal of ['choice', 'escape', 'outside']) {
          await focusPreviewWindow(app, page)
          await select.scrollIntoViewIfNeeded()
          await input.focus(select)
          const before = await select.inputValue()
          // Open through native keyboard delivery; outside dismissal below also
          // verifies native mouse delivery without replacing the real popup.
          await native.evaluate((window) => {
            for (const event of [
              { type: 'keyDown' as const, keyCode: 'Alt' },
              { type: 'keyDown' as const, keyCode: 'Down', modifiers: ['alt' as const] },
              { type: 'keyUp' as const, keyCode: 'Down', modifiers: ['alt' as const] },
              { type: 'keyUp' as const, keyCode: 'Alt' },
            ])
              window.webContents.sendInputEvent(event)
          })
          await expect.poll(() => select.evaluate((e) => e.matches(':open'))).toBe(true)
          const refreshBefore = await refresh.evaluate((r) => r.read())
          const samples: boolean[] = [],
            started = Date.now()
          while (Date.now() - started < 3200) {
            samples.push(await select.evaluate((e) => e.matches(':open')))
            const state = await native.evaluate((window) => ({
              focused: window.isFocused(),
              contents: window.webContents.isFocused(),
              visible: window.isVisible(),
              size: window.getContentSize(),
            }))
            expect(
              samples.at(-1),
              JSON.stringify({
                dismissal,
                picker: picker.id,
                elapsed: Date.now() - started,
                refreshBefore,
                refreshNow: await refresh.evaluate((r) => r.read()),
                state,
              }),
            ).toBe(true)
            await page.waitForTimeout(50)
          }
          expect(await refresh.evaluate((r) => r.read())).toBe(refreshBefore)
          if (dismissal === 'choice') {
            for (const key of picker.keys) await popupKey(key)
            await popupKey('Enter')
            await expect(select).toHaveValue(picker.choice)
          } else if (dismissal === 'escape') {
            await popupKey('Escape')
            await expect(select).toHaveValue(before)
          } else {
            const header = (await dialog.locator('h2').boundingBox())!
            await native.evaluate((window, header) => {
              const x = Math.round(header.x + 5),
                y = Math.round(header.y + 5)
              window.webContents.sendInputEvent({
                type: 'mouseDown',
                x,
                y,
                button: 'left',
                clickCount: 1,
              })
              window.webContents.sendInputEvent({
                type: 'mouseUp',
                x,
                y,
                button: 'left',
                clickCount: 1,
              })
            }, header)
          }
          await expect.poll(() => select.evaluate((e) => e.matches(':open'))).toBe(false)
          await expect.poll(() => refresh.evaluate((r) => r.read())).toBeGreaterThan(refreshBefore)
          await expect(dialog).toBeVisible()
          evidence.push({
            picker: picker.id,
            dismissal,
            samples,
            refreshBefore,
            refreshAfter: await refresh.evaluate((r) => r.read()),
          })
        }
      }
      await refresh.evaluate((r) => r.restore())
      await expect(dialog.getByRole('status')).toHaveText('Preview out of date')
      await expect(page.getByTestId('output-proof-metadata')).toContainText(
        'Output sharpening: Off',
      )
      await input.activate(dialog.getByRole('button', { name: 'Update preview', exact: true }))
      await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
      await expect(page.getByTestId('output-proof-metadata')).toContainText(
        'Output sharpening: Standard',
      )
      await verifyLockedPan(app, page, viewport, zoom)
      await input.guard('output proof pointer and picker complete')
      await captureNativeEditor(app, page, info, 'output-proof-native-1100-console')
      await input.activate(dialog.getByRole('button', { name: 'Back', exact: true }))
      await expect(page.getByRole('button', { name: /Custom…/ })).toBeFocused()
      await input.key('Escape')
      await expect(dialog).toHaveCount(0)
      await expect
        .poll(() => readdir(join(irodori.userDataDir, 'library', 'cache', 'output-proofs')))
        .toEqual([])
      await writeFile(
        info.outputPath('native-input.json'),
        JSON.stringify({ picker: evidence, input: await input.stop() }, null, 2),
      )
    } finally {
      await refresh.evaluate((r) => r.restore())
      await refresh.dispose()
      await input.stop().catch(() => undefined)
    }
  },
)

test.describe('native authored HDR output proof', () => {
  test.use({ hdrDisplay: true })
  test(
    'actual capable-display presentation retains HDR content, switches to the independent SDR primary and writes no display preference',
    foregroundTest(
      'Authored HDR canvas routing requires actual foreground monitor headroom; hidden Wayland windows can select SDR.',
    ),
    async ({ irodori }, info) => {
      test.setTimeout(120000)
      const { app, page } = irodori
      await focusPreviewWindow(app, page)
      await expect
        .poll(async () => (await page.evaluate(() => window.irodori.getDisplayState())).mode, {
          timeout: 15000,
        })
        .toBe('hdr')
      const directory = info.outputPath('authored')
      await mkdir(directory, { recursive: true })
      const source = await hdrJpegFixture(directory)
      await importPhotos(app, page, [source.path], false, 'keyboard')
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr', {
        timeout: 60000,
      })
      await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
        timeout: 60000,
      })
      await minimumNativeProofWindow(app, page)
      const input = await nativeEditorInput(app, page, irodori.userDataDir)
      try {
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.irodori.getDisplayState())).capabilities
                ?.headroomStops ?? 0,
            { timeout: 15000 },
          )
          .toBeGreaterThan(0)
        const display = await page.evaluate(() => window.irodori.getDisplayState())
        expect(display.capabilities?.hardware).toBe(true)
        expect(display.capabilities?.extended).toBe(true)
        const preferencePath = join(irodori.userDataDir, 'preview-preference.json')
        const saved = await readFile(preferencePath).catch(() => null)
        await input.activate(page.getByTestId('console-toggle'))
        await input.activate(page.getByRole('button', { name: 'Export photo', exact: true }))
        await input.activate(page.getByRole('button', { name: /Custom…/ }))
        await page
          .getByRole('combobox', { name: 'Output sharpening', exact: true })
          .selectOption('standard')
        await input.activate(page.getByRole('button', { name: 'Preview output', exact: true }))
        const viewport = page.getByTestId('output-proof-viewport'),
          pixels = viewport.locator('canvas')
        await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
        await expect(pixels).toHaveAttribute('data-backend', 'webgpu-hdr')
        await expect(pixels).toHaveAttribute('data-source-cache', 'miss-unretained')
        await expect(page.getByRole('dialog')).toContainText('Showing authored HDR output.')
        await expect(page.getByTestId('output-proof-metadata')).toContainText(
          'Output sharpening: Standard',
        )
        const proofId = await viewport.getAttribute('data-proof-id')
        await captureNativeEditor(app, page, info, 'authored-hdr-proof')
        await page.getByLabel('Output preview display', { exact: true }).selectOption('sdr')
        await expect(viewport).toHaveAttribute('data-ready', 'true')
        await expect(pixels).not.toHaveAttribute('data-backend', 'webgpu-hdr')
        await expect(page.getByRole('dialog')).toContainText('Showing the embedded SDR primary.')
        expect(await viewport.getAttribute('data-proof-id')).toBe(proofId)
        expect(await readFile(preferencePath).catch(() => null)).toEqual(saved)
        await captureNativeEditor(app, page, info, 'authored-sdr-primary-proof')
        await focusPreviewWindow(app, page)
        await input.activate(page.getByRole('button', { name: 'Cancel', exact: true }))
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
          timeout: 60000,
        })
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-source-cache', 'hit')
        // Exercise an actual proof-device loss after proving healthy source reuse.
        await input.activate(page.getByRole('button', { name: 'Export photo', exact: true }))
        await input.activate(page.getByRole('button', { name: /Custom…/ }))
        await page
          .getByRole('combobox', { name: 'Output sharpening', exact: true })
          .selectOption('standard')
        await input.activate(page.getByRole('button', { name: 'Preview output', exact: true }))
        await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
        await expect(pixels).toHaveAttribute('data-backend', 'webgpu-hdr')
        const recoveryProofId = await viewport.getAttribute('data-proof-id')
        const fault = await page.evaluateHandle(async () => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '[data-testid="output-proof-viewport"] canvas',
          )!
          const configuration = canvas.getContext('webgpu')!.getConfiguration()!
          const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu')
          Object.defineProperty(navigator, 'gpu', {
            configurable: true,
            value: { requestAdapter: async () => null },
          })
          const display = await window.irodori.getDisplayState()
          await window.irodori.reportDisplayCapabilities({
            ...display.capabilities!,
            hardware: false,
            extended: false,
            failure: 'device-lost',
            reason: 'Injected output proof device loss.',
          })
          configuration.device.destroy()
          return {
            restore: () => {
              if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor)
              else Reflect.deleteProperty(navigator, 'gpu')
            },
          }
        })
        try {
          const retry = page.getByRole('button', { name: 'Retry GPU', exact: true })
          await expect(retry).toBeVisible()
          await expect(viewport).toHaveAttribute('data-ready', 'false')
          await expect(pixels).toHaveAttribute('data-backend', 'webgpu-hdr')
          expect(await viewport.getAttribute('data-proof-id')).toBe(recoveryProofId)
          await fault.evaluate((f) => f.restore())
          await focusPreviewWindow(app, page)
          await input.activate(retry)
          await expect(viewport).toHaveAttribute('data-ready', 'true', { timeout: 60000 })
          await expect(pixels).toHaveAttribute('data-backend', 'webgpu-hdr')
          expect(await viewport.getAttribute('data-proof-id')).toBe(recoveryProofId)
          await captureNativeEditor(app, page, info, 'authored-hdr-proof-recovered')
        } finally {
          await fault.evaluate((f) => f.restore())
          await fault.dispose()
        }
        await focusPreviewWindow(app, page)
        await input.activate(page.getByRole('button', { name: 'Cancel', exact: true }))
        await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
          timeout: 60000,
        })
        expect(await readFile(preferencePath).catch(() => null)).toEqual(saved)
        await writeFile(
          info.outputPath('hdr-display.json'),
          JSON.stringify(
            { display, input: await input.stop(), proofId, physicalLuminanceVerified: false },
            null,
            2,
          ),
        )
      } finally {
        await input.stop().catch(() => undefined)
      }
    },
  )
})
