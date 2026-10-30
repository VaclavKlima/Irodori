import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { captureWindow } from './window-capture.helpers'
import { foregroundTest } from './foreground'

const nativeCapture =
  process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? foregroundTest(
        'Wayland leaves hidden capturePage pending even with stayHidden/stayAwake. Native menu and chooser composition requires a compositor-presented window; functional coverage remains hidden.',
      )
    : {}

test(
  'photo menu and paste chooser retain native composition at 1100 × 700 with Console open',
  nativeCapture,
  async ({ irodori }, info) => {
    const { app, page } = irodori,
      filename = `${'Long photographic filename '.repeat(7)}.png`,
      path = info.outputPath(filename)
    await sharp({ create: { width: 8, height: 6, channels: 3, background: '#607080' } })
      .png()
      .toFile(path)
    await importPhotos(app, page, [path], true, 'keyboard')
    await activateButton(page.getByRole('button', { name: 'Actions', exact: true }))
    await activateButton(page.getByRole('menuitem', { name: 'Copy edits', exact: true }))
    await expect(page.getByRole('menu')).toHaveCount(0)
    await activateButton(page.getByTestId('console-toggle'))
    await (
      await app.browserWindow(page)
    ).evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await activateButton(page.getByRole('button', { name: 'Actions', exact: true }))
    await expect(
      page.getByRole('menu').getByRole('group', { name: `Photo · ${filename}`, exact: true }),
    ).toBeVisible()
    await captureWindow(app, page, info.outputPath('photo-menu-minimum-console.png'))
    await activateButton(page.getByRole('menuitem', { name: 'Paste edits…', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Paste edits', exact: true })
    await expect(dialog).toContainText('1 ready · 0 unavailable')
    await captureWindow(app, page, info.outputPath('paste-edits-minimum-console.png'))
    await activateButton(dialog.getByRole('button', { name: 'Cancel', exact: true }))
    await expect(dialog).toHaveCount(0)
  },
)
