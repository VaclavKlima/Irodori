import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { foregroundTest } from './foreground'
import { writeFile } from 'node:fs/promises'

test.use({ hdrDisplay: true })
test(
  'native curve focus and Standard/HDR layouts keep the photograph and histogram usable with Console open',
  foregroundTest(
    'Native keyboard focus, real content sizing and HDR presentation need a visible Wayland window.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(90000)
    await importPhotos(
      app,
      page,
      ['assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW'],
      true,
      'keyboard',
    )
    await focusPreviewWindow(app, page)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await activateButton(page.getByTestId('console-toggle'))
    await activateButton(page.getByRole('button', { name: 'Light', exact: true }))
    const nativeWindow = await app.browserWindow(page),
      id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    const layouts = []
    const pickerEvidence: unknown[] = []
    for (const [width, height] of [
      [1100, 700],
      [1440, 1000],
    ]) {
      await nativeWindow.evaluate(
        (window, size) => {
          window.unmaximize()
          const [, outer] = window.getSize(),
            [, content] = window.getContentSize()
          window.setMinimumSize(size.width, size.height + outer - content)
          window.setContentSize(size.width, size.height)
        },
        { width, height },
      )
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height])
      const stage = page.locator('[data-hover-controls]'),
        stageBefore = await stage.boundingBox(),
        pinned = await page.getByTestId('inspector-pinned').boundingBox(),
        graph = page.getByTestId('curve-graph')
      for (const view of ['standard', 'hdr']) {
        await page.getByLabel('Graph view', { exact: true }).selectOption(view)
        await graph.evaluate((node) => node.scrollIntoView({ block: 'center' }))
        const bounds = (await graph.boundingBox())!
        expect(Math.abs(bounds.width - bounds.height)).toBeLessThan(1)
        expect(bounds.y).toBeGreaterThanOrEqual(pinned!.y + pinned!.height)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(
          (await page.getByTestId('console-panel').boundingBox())!.y,
        )
        await graph.focus()
        await expect(graph).toBeFocused()
        await page.screenshot({
          path: info.outputPath(`${width}-${view}-curves.png`),
          scale: 'css',
        })
        expect(await stage.boundingBox()).toEqual(stageBefore)
        expect(await page.getByTestId('inspector-pinned').boundingBox()).toEqual(pinned)
        layouts.push({ width, height, view, graph: bounds, stage: stageBefore, pinned })
      }
      if (width === 1100) {
        const select = page.getByRole('combobox', { name: 'Graph view', exact: true })
        await select.selectOption('standard')
        const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
        const observer = await nativeWindow.evaluateHandle((window) => {
          const contents = window.webContents as Electron.WebContents & {
            setEmbedder: (embedder: Electron.WebContents) => void
          }
          const original = contents.setEmbedder
          let count = 0
          contents.setEmbedder = function (embedder) {
            count++
            return original.call(this, embedder)
          }
          return {
            read: () => count,
            stop: () => {
              contents.setEmbedder = original
            },
          }
        })
        const refreshCount = () => observer.evaluate((observer) => observer.read())
        const send = (events: (Electron.KeyboardInputEvent | Electron.MouseInputEvent)[]) =>
          nativeWindow.evaluate((window, events) => {
            if (!window.isVisible() || !window.isFocused() || window.isMinimized())
              throw new Error('The isolated owner lost activation before native picker input.')
            for (const event of events) window.webContents.sendInputEvent(event)
          }, events)
        const key = (keyCode: string, modifiers: Electron.KeyboardInputEvent['modifiers'] = []) =>
          send([
            { type: 'keyDown', keyCode, modifiers },
            ...(keyCode === 'Enter' ? [{ type: 'char' as const, keyCode: '\r' }] : []),
            { type: 'keyUp', keyCode, modifiers },
          ])
        const click = async (locator: typeof select) => {
          const box = (await locator.boundingBox())!
          expect(box).not.toBeNull()
          const point = {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          }
          await send([
            { type: 'mouseMove', ...point },
            { type: 'mouseDown', button: 'left', clickCount: 1, ...point },
            { type: 'mouseUp', button: 'left', clickCount: 1, ...point },
          ])
        }
        try {
          await expect.poll(refreshCount, { timeout: 7000 }).toBeGreaterThanOrEqual(2)
          for (const dismissal of ['escape', 'choice', 'outside']) {
            await select.scrollIntoViewIfNeeded()
            await select.focus()
            if (dismissal === 'escape') await key('Down', ['alt'])
            else await click(select)
            await expect.poll(() => select.evaluate((node) => node.matches(':open'))).toBe(true)
            const before = await refreshCount(),
              started = performance.now()
            let samples = 0
            while (performance.now() - started < 3300) {
              expect(
                await select.evaluate((node) => node.isConnected && node.matches(':open')),
              ).toBe(true)
              expect(await refreshCount()).toBe(before)
              expect(await nativeWindow.evaluate((window) => window.isFocused())).toBe(true)
              samples++
              await page.waitForTimeout(50)
            }
            if (dismissal === 'choice') {
              await key('Home')
              await key('Down')
              await key('Enter')
            } else if (dismissal === 'escape') await key('Escape')
            else await click(page.getByTestId('app-version'))
            await expect.poll(() => select.evaluate((node) => node.matches(':open'))).toBe(false)
            await expect(select).toHaveValue(dismissal === 'escape' ? 'standard' : 'hdr')
            await expect.poll(refreshCount, { timeout: 5000 }).toBeGreaterThan(before)
            expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
              history,
            )
            pickerEvidence.push({
              dismissal,
              samples,
              holdMs: performance.now() - started,
              before,
              after: await refreshCount(),
            })
          }
        } finally {
          await observer.evaluate((observer) => observer.stop())
          await observer.dispose()
        }
      }
      const field = page.getByRole('spinbutton', { name: 'Curve Output value', exact: true })
      await field.focus()
      await field.fill('1.25')
      await page.keyboard.press('Enter')
      await expect
        .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
        .toMatchObject({
          settings: {
            curves: {
              master: [
                { input: 0, output: 0.0125 },
                { input: 1, output: 1 },
              ],
            },
          },
        })
      await expect(field).toBeFocused()
      await expect(field).not.toHaveAttribute('readonly', '')
      await field.fill('2')
      await field.press('Escape')
      await expect(field).toHaveValue('1.2500')
    }
    await writeFile(
      info.outputPath('curve-native-layout.json'),
      JSON.stringify(
        {
          layouts,
          pickerEvidence,
          display: await page.evaluate(() => window.irodori.getDisplayState()),
          limits: 'Screenshots and renderer completion do not measure physical display luminance.',
        },
        null,
        2,
      ),
    )
  },
)
