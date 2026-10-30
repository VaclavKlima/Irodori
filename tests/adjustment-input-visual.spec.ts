import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { expectAdjustmentBounds, minimumAdjustmentWindow } from './adjustment-input.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { captureWindow } from './window-capture.helpers'

test(
  'numeric controls retain native visibility and captures at 1600% and compact Console-open layouts',
  foregroundTest(
    'Compositor visibility, IntersectionObserver containment and real native captures after an OS resize require a foreground surface on Wayland.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(120000)
    await minimumAdjustmentWindow(app, page)
    await focusPreviewWindow(app, page)
    await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], false, 'keyboard')
    const canvas = page.getByTestId('main-preview'),
      viewport = page.getByTestId('preview-viewport'),
      zoom = page.getByRole('combobox', { name: 'Preview zoom', exact: true }),
      undo = page.getByRole('button', { name: 'Undo', exact: true }),
      exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true }),
      native = await app.browserWindow(page),
      id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
    await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 20000 })
    await expect(viewport).toHaveAttribute('data-resolution', 'full')
    async function number(label: string, key: string, value: number) {
      const field = page.getByRole('spinbutton', { name: `${label} value`, exact: true })
      await expect(field).toBeEditable()
      await field.fill(String(value))
      await field.press('Enter')
      await expect
        .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
        .toMatchObject({
          settings: { [key]: value },
        })
      await expect(field).toBeEditable()
      await expect(canvas).toHaveAttribute(
        `data-${key === 'exposureEv' ? 'exposure' : key}`,
        String(value),
      )
    }
    const captures: { path: string; label: string; zoom: string; bounds: unknown }[] = []
    async function capture(label: string, filename: string, scale: string) {
      const slider = page.getByRole('slider', { name: label, exact: true }),
        bounds = await expectAdjustmentBounds(page, slider)
      await expect(slider).toBeInViewport()
      await expect(undo).toBeInViewport()
      await expect(undo).toBeEnabled()
      await expect(canvas).toBeVisible()
      await expect(canvas).toHaveCSS('visibility', 'visible')
      await expect(page.getByTestId('console-panel')).toBeVisible()
      await expect(zoom).toHaveValue(scale)
      if (scale === '16') await expect(viewport).toHaveAttribute('data-scale', '16')
      else await expect(viewport).toHaveAttribute('data-mode', 'fit')
      await expect(page.getByTestId('preview-resolution')).toContainText('Full resolution')
      expect(
        await native.evaluate((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          contents: window.webContents.isFocused(),
        })),
      ).toEqual({ visible: true, focused: true, contents: true })
      expect(
        await page.evaluate(() => ({
          focused: document.hasFocus(),
          visibility: document.visibilityState,
        })),
      ).toEqual({ focused: true, visibility: 'visible' })
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      const path = info.outputPath(filename)
      await captureWindow(app, page, path)
      await info.attach(`${label} native compact view`, { path, contentType: 'image/png' })
      captures.push({ path, label, zoom: scale, bounds })
    }

    // Retain the original exposure capture's exact 1600% and neutral-current-edit state,
    // while keeping Undo available from its genuine persisted history.
    await number('Exposure', 'exposureEv', 1.25)
    await number('Exposure', 'exposureEv', 0)
    await zoom.selectOption('16')
    await capture('Exposure', 'exposure-1600-console.png', '16')
    await zoom.selectOption('fit')
    await number('Exposure', 'exposureEv', 0.5)
    for (const [label, key] of [
      ['Highlights', 'highlights'],
      ['Shadows', 'shadows'],
      ['Whites', 'whites'],
      ['Blacks', 'blacks'],
    ] as const) {
      await number(label, key, -40)
      await capture(label, `${key}-console-1100x700.png`, 'fit')
      await number(label, key, 0)
    }
    await expect(exposure).toHaveValue('0.50')
    await writeFile(
      info.outputPath('adjustment-input-visual.json'),
      JSON.stringify(
        {
          contentSize: [1100, 700],
          consoleOpen: true,
          captures,
          limitations:
            'Native composition evidence only; no physical HDR, manual-device input or presentation-performance acceptance.',
        },
        null,
        2,
      ),
    )
  },
)
