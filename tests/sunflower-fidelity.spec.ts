import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { activateButton } from './button.helpers'
import { foregroundTest } from './foreground'

const nativeCapture =
  process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)
    ? foregroundTest('Wayland capturePage requires a window presented by the compositor.')
    : {}

// Sunflower geometry is preserved; photo rows and Console placement follow the selected photo-browser study.
// The reference-only study toolbar is excluded from application content height.
test(
  'matches the approved editor composition at minimum and larger content sizes',
  nativeCapture,
  async ({ irodori }, testInfo) => {
    const { app, page } = irodori
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await importPhotos(app, page, [
      'tests/fixtures/photos/alpine-lake.jpg',
      'tests/fixtures/photos/mountain-ridge.jpg',
      'tests/fixtures/photos/forest-light.jpg',
      'tests/fixtures/photos/coastal-dunes.jpg',
      'tests/fixtures/photos/quiet-valley.jpg',
    ])
    await page.evaluate(async () => {
      const photos = (await window.irodori.listPhotos()).photos
      const ids = ['alpine-lake.jpg', 'mountain-ridge.jpg', 'quiet-valley.jpg'].map(
        (name) => photos.find((photo) => photo.filename === name)!.id,
      )
      const stack = await window.irodori.groupPhotos(
        ids,
        ids[0],
        (await window.irodori.listStacks()).revision,
      )
      await window.irodori.setStackExpanded(stack.id, true, stack.revision)
    })
    await expect(page.getByRole('button', { name: /Collapse stack for alpine-lake/ })).toBeVisible()
    await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await page.getByTestId('editor-photo-scroll').evaluate((element) => {
      element.scrollTop = 0
    })
    await activateButton(page.getByTestId('console-toggle'))
    const nativeWindow = await app.browserWindow(page)
    for (const [width, height, stageWidth, stageHeight, inspectorWidth] of [
      [1100, 700, 500, 429, 344],
      [1440, 1000, 808, 689, 368],
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
      await navigateInspector(page, 'Light')
      const inspector = page.getByTestId('adjustments-panel')
      await expect(page.locator('header').first()).toHaveCSS('height', '48px')
      await expect(page.getByTestId('photo-library')).toHaveCSS('width', '224px')
      await expect(inspector).toHaveCSS('width', `${inspectorWidth}px`)
      const stage = page.locator('[data-hover-controls]')
      await expect(stage).toHaveCSS('width', `${stageWidth}px`)
      await expect(stage).toHaveCSS('height', `${stageHeight}px`)
      await expect(page.getByTestId('preview-viewport')).toHaveCSS('width', `${stageWidth - 26}px`)
      await expect(page.getByTestId('preview-viewport')).toHaveCSS(
        'height',
        `${stageHeight - 26}px`,
      )
      const histogram = page.getByRole('region', { name: 'Histogram · After' })
      await expect(histogram).toHaveCSS('height', '157px')
      await expect(page.getByRole('slider', { name: 'Histogram tonal value' })).toHaveCSS(
        'height',
        '96px',
      )
      await expect(page.getByRole('tablist', { name: 'Editing groups' })).toHaveCSS('width', '52px')
      for (const tab of await page
        .getByRole('tablist', { name: 'Editing groups' })
        .getByRole('tab')
        .all())
        await expect(tab).toHaveCSS('height', '40px')
      const toolbar = page
        .getByRole('button', { name: 'Toggle hover', exact: true })
        .locator('../..')
      await expect(toolbar).toHaveCSS('height', '30px')
      for (const name of ['Undo', 'Redo', 'Photo actions'])
        await expect(toolbar.getByRole('button', { name, exact: true })).toHaveCSS('height', '28px')
      await expect(toolbar.getByRole('button', { name: 'Toggle hover', exact: true })).toHaveCSS(
        'height',
        '24px',
      )
      await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toHaveCSS(
        'field-sizing',
        'content',
      )
      for (const id of ['group-navigation', 'preview-view-controls'])
        await expect(page.getByTestId(id)).toHaveCSS('height', '26px')
      const exposure = await page
        .getByRole('slider', { name: 'Exposure', exact: true })
        .boundingBox()
      expect(exposure!.y).toBe(width === 1100 ? 303 : 305)
      const reset = page.getByRole('button', { name: 'Reset Light', exact: true })
      expect((await reset.boundingBox())!.y).toBeLessThan(
        (await page.getByRole('button', { name: 'Light', exact: true }).boundingBox())!.y,
      )
      await expect(page.getByTestId('console-panel')).toHaveCSS(
        'height',
        height <= 760 ? '180px' : '216px',
      )
      const photos = await page.getByTestId('photo-library').boundingBox()
      const consoleBox = await page.getByTestId('console-panel').boundingBox()
      const stageBox = await stage.boundingBox()
      expect(photos!.y).toBe(stageBox!.y)
      expect(photos!.y + photos!.height).toBe(consoleBox!.y + consoleBox!.height)
      expect(consoleBox!.x).toBe(stageBox!.x)
      expect(consoleBox!.width).toBe(width === 1100 ? 852 : 1186)
      expect(consoleBox!.y).toBeGreaterThan(stageBox!.y + stageBox!.height)
      const rows = page.locator('[data-testid="photo-library"] [data-photo-id]')
      for (const row of await rows.all()) {
        await expect(row).toHaveCSS('height', '56px')
        await expect(row.locator('img')).toHaveCSS('height', '44px')
      }
      const cover = await page
        .getByRole('button', { name: 'Select alpine-lake.jpg', exact: true })
        .boundingBox()
      const member = await page
        .getByRole('button', { name: 'Select mountain-ridge.jpg', exact: true })
        .boundingBox()
      expect(member!.x).toBe(cover!.x)
      expect(member!.y - cover!.y).toBe(58)
      expect(member!.width).toBe(cover!.width)
      await expect(
        page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }),
      ).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')

      await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Before', exact: true })).toBeHidden()
      await page.evaluate(() => document.fonts.ready)
      for (const tool of [
        'Light',
        'Color',
        'Color Mixer',
        'Color Grading',
        'Detail',
        'Crop',
        'Metadata',
      ] as const) {
        await navigateInspector(page, tool)
        await page.getByTestId('inspector-scroll').evaluate((element) => {
          element.scrollTop = 0
        })
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        )
        await page.screenshot({
          path: testInfo.outputPath(`${width}-${tool.toLowerCase().replaceAll(' ', '-')}.png`),
          scale: 'css',
        })
      }
      expect(
        await page.evaluate(() => ({
          x: document.documentElement.scrollWidth > innerWidth,
          y: document.documentElement.scrollHeight > innerHeight,
        })),
      ).toEqual({ x: false, y: false })
    }
  },
)
