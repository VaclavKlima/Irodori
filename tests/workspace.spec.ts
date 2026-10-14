import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { readFile, realpath } from 'node:fs/promises'
import type { LumaApi, Photo } from '../src/shared/contracts'
import type { PreviewPresentation } from '../src/shared/preview-diagnostics'
import { expect, test } from './electron.fixture'
import { holdFullPreview } from './full-preview.helpers'
import { choose, expectImportComplete, importPhotos } from './import.helpers'

async function resizeWindow(app: ElectronApplication, page: Page, width: number, height: number) {
  const window = await app.browserWindow(page)
  await window.evaluate(
    (browserWindow, size) => {
      browserWindow.unmaximize()
      // macOS otherwise constrains large test windows to the physical work area.
      const [, outerHeight] = browserWindow.getSize()
      const [, contentHeight] = browserWindow.getContentSize()
      browserWindow.setMinimumSize(size.width, size.height + outerHeight - contentHeight)
      browserWindow.setContentSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

async function expectInsideWindow(locator: Locator, width: number, height: number) {
  await expect(locator).toBeVisible()
  // xterm fits in a ResizeObserver after the native window has resized.
  await expect(async () => {
    const bounds = await locator.boundingBox()
    expect(bounds).not.toBeNull()
    if (!bounds) throw new Error('The visible element must have layout bounds.')
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height + 1)
  }).toPass({ timeout: 7500 })
}

async function expectCompactFooter(page: Page, width: number, height: number) {
  const footer = page.getByTestId('preview-footer')
  for (const id of ['preview-footer', 'preview-view-controls', 'zoom-controls'])
    await expectInsideWindow(page.getByTestId(id), width, height)
  await expect(async () => {
    const layout = await footer.evaluate((element) => ({
      bounds: element.getBoundingClientRect().toJSON(),
      children: Array.from(element.children)
        .map((child) => child.getBoundingClientRect().toJSON())
        .filter((bounds) => bounds.width && bounds.height),
      overflow: element.scrollWidth > element.clientWidth,
    }))
    expect(layout.overflow).toBe(false)
    for (const [index, bounds] of layout.children.entries()) {
      expect(bounds.x).toBeGreaterThanOrEqual(layout.bounds.x)
      expect(bounds.y).toBeGreaterThanOrEqual(layout.bounds.y)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(layout.bounds.x + layout.bounds.width + 1)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        layout.bounds.y + layout.bounds.height + 1,
      )
      if (index) expect(layout.children[index - 1].right).toBeLessThanOrEqual(bounds.x + 1)
    }
  }).toPass({ timeout: 7500 })
}

async function expectViewportSize(page: Page, width: number, height: number) {
  await expect(async () => {
    const bounds = await page.getByTestId('preview-viewport').boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(width - 1)
    expect(bounds!.height).toBeGreaterThanOrEqual(height - 1)
  }).toPass({ timeout: 7500 })
}

test('starts the built desktop application with its isolated preload bridge', async ({ luma }) => {
  const { app, page } = luma
  const packageInfo = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  await expect(page).toHaveTitle('Luma')
  const navigation = page.getByRole('navigation', { name: 'Workspaces' })
  await expect(navigation.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  )
  for (const name of ['Editor', 'Library'])
    await expect(navigation.getByRole('button', { name, exact: true }).locator('svg')).toHaveCount(
      1,
    )
  expect(page.url()).toMatch(/^file:\/\//)
  expect(app.windows()).toHaveLength(1)

  const nativeInfo = await app.evaluate(({ app }) => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
      debugPort: app.commandLine.getSwitchValue('remote-debugging-port'),
    }
  })
  expect(nativeInfo).toMatchObject({
    version: packageInfo.version,
    userData: await realpath(luma.userDataDir),
    noSandbox: false,
  })
  // Playwright owns an ephemeral debugging endpoint; the fixed MCP port is development-only.
  expect(nativeInfo.debugPort).not.toBe('9222')
  const bridge = await page.evaluate(async () => {
    const luma = (window as unknown as { luma: LumaApi }).luma
    return {
      info: await luma.getAppInfo(),
      keys: Object.keys(luma),
      hasRequire: 'require' in window,
      hasProcess: 'process' in window,
    }
  })
  expect(bridge).toEqual({
    info: { version: nativeInfo.version, platform: nativeInfo.platform },
    keys: [
      'getBrowseSummary',
      'getBrowseChunk',
      'locateBrowsePhoto',
      'getBrowseRange',
      'getBrowseSection',
      'reportForegroundActivity',
      'getPhotoActionsContext',
      'listStacks',
      'getPhotoStack',
      'getStackMembers',
      'getStackSnapshot',
      'groupPhotos',
      'ungroupStack',
      'removeFromStack',
      'setStackCover',
      'setStackExpanded',
      'listGallery',
      'locateGalleryPhoto',
      'getGalleryRange',
      'groupCaptureSequences',
      'getActiveMergeReview',
      'getMergeDiagnostics',
      'createMergeReview',
      'updateMergeReview',
      'requestMergePreview',
      'startMerge',
      'disposeMergeReview',
      'getMergeProvenance',
      'getPreviewDiagnostics',
      'reportPreviewPresentation',
      'getDisplayState',
      'setPreviewPreference',
      'reportDisplayCapabilities',
      'onDisplayState',
      'onDisplayRefresh',
      'onFlushEdits',
      'getPhotoStatistics',
      'getEdits',
      'getPhotoPixel',
      'updateEdits',
      'getEditHistory',
      'undoEdit',
      'redoEdit',
      'getLensSettings',
      'updateLensSettings',
      'getAppInfo',
      'listPhotos',
      'locatePhoto',
      'getPhotoRange',
      'requestHdrPreview',
      'requestEditingPreview',
      'requestFullPreview',
      'releaseFullPreview',
      'requestCachedFullPreview',
      'deletePhotos',
      'listTasks',
      'cancelTask',
      'dismissTask',
      'getTaskErrors',
      'listImportDevices',
      'chooseDevice',
      'requestReviewThumbnails',
      'chooseSource',
      'getReview',
      'selectCandidates',
      'setImportOnlyMissing',
      'setImportVerificationMode',
      'importSelected',
      'cancelImport',
      'disposeImport',
      'onLibraryEvent',
    ],
    hasRequire: false,
    hasProcess: false,
  })
  await expect(page.getByTestId('app-version')).toContainText(nativeInfo.version)
  await expect(page.getByTestId('empty-library')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import photos', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.luma.listPhotos())).toEqual({ photos: [], total: 0 })
  await resizeWindow(app, page, 1100, 700)
  await page.getByTestId('console-toggle').click()
  await expectInsideWindow(page.getByTestId('empty-library'), 1100, 700)
  await expectCompactFooter(page, 1100, 700)
  await expect(page.getByTestId('preview-metadata')).toHaveCount(0)
  await expect(page.getByTestId('preview-resolution')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Preview zoom' })).toBeDisabled()
})

test('compact metadata handles missing fields, long names and merged photos while panels scroll independently', async ({
  luma,
}, info) => {
  const { app, page } = luma
  const longCamera = 'Long camera name '.repeat(18),
    longLens = 'Long lens name '.repeat(22)
  const longFilename = `${'A photograph with a long descriptive filename '.repeat(4)}.jpg`
  const cases: {
    filename: string
    displayFilename?: string
    metadata: Partial<Photo>
    equipment: string[]
    exposure: string[]
  }[] = [
    {
      filename: 'alpine-lake.jpg',
      metadata: {
        camera: 'Camera body',
        lens: 'Zoom lens',
        shutter: '1/250 s',
        aperture: 'f/2.8',
        iso: '100',
      },
      equipment: ['Camera body', 'Zoom lens'],
      exposure: ['1/250 s', 'f/2.8', 'ISO 100'],
    },
    {
      filename: 'mountain-ridge.jpg',
      metadata: { lens: 'Prime lens', aperture: 'f/8' },
      equipment: ['Prime lens'],
      exposure: ['f/8'],
    },
    { filename: 'forest-light.jpg', metadata: {}, equipment: [], exposure: [] },
    {
      filename: 'coastal-dunes.jpg',
      displayFilename: longFilename,
      metadata: {
        camera: longCamera,
        lens: longLens,
        shutter: '1/8000 s',
        aperture: 'f/22',
        iso: '12800',
      },
      equipment: [longCamera, longLens],
      exposure: ['1/8000 s', 'f/22', 'ISO 12800'],
    },
    {
      filename: 'quiet-valley.jpg',
      metadata: {
        assetKind: 'derived',
        camera: 'Merge camera',
        shutter: '1/60 s',
        aperture: 'f/4',
        iso: '400',
      },
      equipment: ['Merge camera'],
      exposure: ['Merged photo'],
    },
  ]
  // Inject presentation metadata only; the real imports, edit service and preview remain in this isolated profile.
  await app.evaluate(({ ipcMain }, cases) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const photoMetadata = (photo: Photo) => {
      const entry = cases.find((c) => c.filename === photo.filename)
      return {
        ...photo,
        filename: entry?.displayFilename ?? photo.filename,
        camera: undefined,
        lens: undefined,
        shutter: undefined,
        aperture: undefined,
        iso: undefined,
        ...entry?.metadata,
      }
    }
    for (const channel of ['gallery:list', 'gallery:locate']) {
      const original = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result = (await original(...args)) as {
          photo?: Photo
          entries: { photo: Photo }[]
        } | null
        if (!result) return result
        return {
          ...result,
          total: result.entries.length ? 1234567 : 0,
          ...(result.photo ? { photo: photoMetadata(result.photo) } : {}),
          entries: result.entries.map((entry) => ({ ...entry, photo: photoMetadata(entry.photo) })),
        }
      })
    }
  }, cases)
  await importPhotos(
    app,
    page,
    cases.map((c) => `tests/fixtures/photos/${c.filename}`),
  )
  await resizeWindow(app, page, 1100, 700)
  await page.getByTestId('console-toggle').click()
  const metadata = page.getByTestId('preview-metadata')
  const lens = page.getByRole('button', { name: 'Lens corrections', exact: true })
  await expect(lens).toHaveAttribute('aria-expanded', 'false')
  await lens.press('Enter')
  for (const c of cases) {
    const filename = c.displayFilename ?? c.filename
    await page.getByRole('button', { name: `Select ${filename}`, exact: true }).click()
    await expect(page.getByTestId('preview-filename')).toHaveText(filename)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    await expect(lens).toHaveAttribute('aria-expanded', 'true')
    await expectInsideWindow(metadata, 1100, 700)
    await expect(metadata.getByTestId('preview-equipment').locator('span')).toHaveText(c.equipment)
    await expect(metadata.getByTestId('preview-exposure').locator('span')).toHaveText(c.exposure)
    if (!c.equipment.length && !c.exposure.length)
      await expect(metadata).toHaveText('Metadata unavailable')
    if (c.filename === 'coastal-dunes.jpg') {
      await expect(page.getByTestId('preview-filename')).toHaveAttribute('title', longFilename)
      expect(
        await page.getByTestId('preview-filename').evaluate((e) => e.scrollWidth > e.clientWidth),
      ).toBe(true)
      for (const name of c.equipment) {
        const field = metadata.getByText(name, { exact: true })
        await expect(field).toHaveAttribute('title', name)
        expect(await field.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
      }
      await page.screenshot({ path: info.outputPath('compact-metadata-1100-console.png') })
    }
    expect(await metadata.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    await expect(page.getByTestId('preview-view-controls')).toContainText('/ 1234567')
    await expectCompactFooter(page, 1100, 700)
  }
  const order = await page
    .getByTestId('adjustments-panel')
    .locator('section > :first-child')
    .allTextContents()
  expect(order.map((s) => s.trim())).toEqual([
    'Histogram · After',
    'Light',
    'Color',
    'Lens corrections',
    'Metadata',
  ])
  const scrolling = await page.evaluate(() => {
    const inspector = document.querySelector<HTMLElement>('[data-testid="adjustments-panel"]')!
      .lastElementChild as HTMLElement
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="photo-library"] *'),
    )
    const libraryScroll = candidates.find((e) => getComputedStyle(e).overflowY === 'auto')!
    const preview = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
    const before = preview.getBoundingClientRect().toJSON()
    const libraryTop = libraryScroll.scrollTop
    inspector.scrollTop = inspector.scrollHeight
    const inspectorTop = inspector.scrollTop
    libraryScroll.scrollTop = libraryScroll.scrollHeight
    return {
      libraryTop,
      inspectorTop,
      inspectorAfter: inspector.scrollTop,
      libraryAfter: libraryScroll.scrollTop,
      before,
      after: preview.getBoundingClientRect().toJSON(),
    }
  })
  expect(scrolling.inspectorTop).toBeGreaterThan(0)
  expect(scrolling.inspectorAfter).toBe(scrolling.inspectorTop)
  expect(scrolling.libraryAfter).toBeGreaterThan(scrolling.libraryTop)
  expect(scrolling.after).toEqual(scrolling.before)
  await page.getByTestId('console-toggle').click()
  await expectInsideWindow(metadata, 1100, 700)
  await page.getByTestId('console-toggle').click()
  await expectInsideWindow(metadata, 1100, 700)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Lens corrections', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(page.getByTestId('lens-corrections')).toBeHidden()
})

for (const [width, height, canvasWidth, canvasHeight, consoleCanvasHeight] of [
  [1100, 700, 628, 518, 338],
  [1280, 800, 754, 618, 402],
  [1440, 900, 914, 718, 502],
  [1920, 1080, 1346, 898, 682],
]) {
  test(`keeps the workspace and console usable at ${width} × ${height}`, async ({
    luma,
  }, testInfo) => {
    const { app, page } = luma
    await importPhotos(app, page)
    await resizeWindow(app, page, width, height)
    for (const id of ['photo-library', 'workspace', 'adjustments-panel', 'console-toggle']) {
      await expectInsideWindow(page.getByTestId(id), width, height)
    }
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId('console-panel')).toHaveCount(0)
    await expectViewportSize(page, canvasWidth, canvasHeight)
    await expectCompactFooter(page, width, height)
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}x${height}.png`) })

    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expectInsideWindow(page.getByTestId('console-panel'), width, height)
    await expect(page.getByTestId('console-panel')).toContainText(/disconnected/i)
    await expect(page.getByTestId('console-panel').locator('.xterm')).toBeVisible()
    await expect(page.getByTestId('main-preview')).toBeVisible()
    await expectViewportSize(page, canvasWidth, consoleCanvasHeight)
    await expectCompactFooter(page, width, height)

    await resizeWindow(app, page, 1100, 700)
    for (const id of ['photo-library', 'workspace', 'adjustments-panel', 'console-panel']) {
      await expectInsideWindow(page.getByTestId(id), 1100, 700)
    }
    await expectInsideWindow(page.getByTestId('console-panel').locator('.xterm-screen'), 1100, 700)
    await expectViewportSize(page, 628, 338)
    await resizeWindow(app, page, width, height)
    await expectInsideWindow(
      page.getByTestId('console-panel').locator('.xterm-screen'),
      width,
      height,
    )
    await page.screenshot({ path: testInfo.outputPath(`console-${width}x${height}.png`) })

    await page.getByTestId('console-toggle').click()
    await expect(page.getByTestId('console-panel')).toHaveCount(0)
    await expect(page.getByTestId('console-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expectViewportSize(page, canvasWidth, canvasHeight)
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    }))
    expect(overflow).toEqual({ horizontal: false, vertical: false })
  })
}

test('keeps loading, errors and keyboard retry inside the compact footer', async ({ luma }) => {
  const { app, page } = luma
  await resizeWindow(app, page, 1100, 700)
  await page.getByTestId('console-toggle').click()
  const gate = await holdFullPreview(app)
  try {
    await gate.evaluate((control) => control.fail())
    await page.getByRole('button', { name: 'Import photos', exact: true }).click()
    await choose(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
    await expect(page.getByTestId('import-status')).toContainText('Ready to import')
    await page.getByRole('button', { name: 'Import 1 photos', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const status = page.getByTestId('preview-resolution')
    await expect(status).toContainText('Loading full resolution…')
    await expect(status).toHaveAttribute('title', 'Loading the full-resolution image.')
    await expectViewportSize(page, 628, 338)
    await expectCompactFooter(page, 1100, 700)
    // Release before waiting for import completion: the held preview owns foreground admission.
    await gate.evaluate((control) => control.release())
    await expectImportComplete(page)
    await expect(status).toContainText('Full resolution unavailable')
    await expect(status).toHaveAttribute('aria-description', 'Preview generation timed out.')
    await expectCompactFooter(page, 1100, 700)
    await expectViewportSize(page, 628, 338)
    await gate.evaluate((control) => control.succeed())
    const retry = status.getByRole('button', { name: 'Retry', exact: true })
    await retry.focus()
    await expect(retry).toBeFocused()
    await retry.press('Enter')
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(status).toHaveAttribute('title', /1920 × 1280 · sRGB · Original preserved/)
    await expectCompactFooter(page, 1100, 700)
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})

test('display details describe only a matching presented frame and fit at minimum size', async ({
  luma,
}) => {
  const { app, page } = luma
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await resizeWindow(app, page, 1100, 700)
  await page.getByTestId('console-toggle').click()
  const { photos } = await page.evaluate(() => window.luma.listPhotos())
  const target = await page.evaluate(() => window.luma.getDisplayState())
  const summary = page.getByLabel('Display details')
  await summary.click()
  const popover = summary.locator('..').locator(':scope > div')
  const cases: {
    label: string
    frame: string
    presentation: Partial<PreviewPresentation>
  }[] = [
    { label: 'SDR', frame: 'sRGB · 8-bit', presentation: { backend: 'legacy' } },
    {
      label: 'HDR',
      frame: 'display-p3 · Float32',
      presentation: { backend: 'webgpu-hdr', mode: 'hdr' },
    },
    {
      label: 'SDR fallback',
      frame: 'sRGB · 8-bit',
      presentation: { backend: 'canvas2d-hdr-sdr' },
    },
    {
      label: 'Loading',
      frame: 'Preparing',
      presentation: { backend: 'webgpu-hdr', stage: 'loading' },
    },
    {
      label: 'Unavailable',
      frame: 'Unavailable',
      presentation: { backend: 'webgpu-hdr', stage: 'failed' },
    },
    { label: 'Loading', frame: 'Preparing', presentation: { photoId: 'another-photo' } },
    { label: 'Loading', frame: 'Preparing', presentation: { targetGeneration: -1 } },
  ]
  for (const [index, c] of cases.entries()) {
    const generation = target.generation + 1000 + index
    // Presentation contract fixtures test labels without processing HDR or claiming hardware support.
    // Their generation is separate from main's real target, so normal frame reports cannot replace them.
    await app.evaluate(
      ({ BrowserWindow }, state) =>
        BrowserWindow.getAllWindows()[0].webContents.send('display:state', state),
      {
        ...target,
        generation,
        requested: 'hdr' as const,
        mode: 'hdr' as const,
        colorSpace: 'display-p3' as const,
        peak: 8,
        presentation: {
          photoId: photos[0].id,
          revision: 0,
          targetGeneration: generation,
          backend: 'legacy' as const,
          mode: 'sdr' as const,
          stage: 'presented' as const,
          reason: 'Presentation fixture.',
          timings: {},
          ...c.presentation,
        },
      },
    )
    await expect(summary).toHaveText(c.label)
    await expect(summary).toHaveAccessibleDescription(c.label)
    await expect(popover.getByText(`Frame: ${c.frame}`, { exact: true })).toBeVisible()
    await expectInsideWindow(popover, 1100, 700)
    await expectInsideWindow(page.getByTestId('preview-filename'), 1100, 700)
    await expectCompactFooter(page, 1100, 700)
  }
  await summary.press('Enter')
  await expect(popover).toBeHidden()
})

test('supports visible keyboard focus, photo selection, and adjustment groups', async ({
  luma,
}) => {
  const { page } = luma
  await importPhotos(luma.app, page)
  // Parallel preparation can publish either fixture first; keyboard order follows the gallery.
  const photos = page.locator('[data-testid^="photo-card-"]')
  await expect(photos).toHaveCount(2)
  const firstPhoto = photos.nth(0)
  const secondPhoto = photos.nth(1)
  await firstPhoto.focus()
  await page.keyboard.press('Tab')
  await expect(secondPhoto).toBeFocused()
  const focusStyle = await secondPhoto.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    }
  })
  expect(focusStyle.focusVisible).toBe(true)
  expect(focusStyle.outlineStyle).not.toBe('none')
  expect(focusStyle.outlineWidth).toBeGreaterThan(0)
  await page.keyboard.press('Enter')
  await expect(secondPhoto).toHaveAttribute('aria-pressed', 'true')

  const lightGroup = page.getByRole('button', { name: 'Light', exact: true })
  await lightGroup.click()
  await expect(lightGroup).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeHidden()
  await lightGroup.press('Enter')
  await expect(lightGroup).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible()
})

test('histogram shows compact preparation failures inside the section', async ({ luma }) => {
  const held = await luma.app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('preview:editing')!
    ipcMain.removeHandler('preview:editing')
    ipcMain.handle('preview:editing', () => ({ error: 'Preparation failed for test.' }))
    return {
      restore: () => {
        ipcMain.removeHandler('preview:editing')
        ipcMain.handle('preview:editing', original)
      },
    }
  })
  await expect(luma.page.locator('#histogram').getByRole('status')).toHaveText(
    'Preparing histogram…',
  )
  await importPhotos(luma.app, luma.page)
  await expect(luma.page.locator('#histogram').getByRole('status')).toHaveText(
    'Histogram unavailable',
  )
  await expect(luma.page.locator('#histogram').getByRole('status')).toHaveAttribute(
    'title',
    'Live adjustments could not be prepared.',
  )
  await expect(luma.page.getByRole('slider', { name: 'Histogram tonal value' })).toBeVisible()
  await expect(luma.page.getByRole('button', { name: 'Inspect center pixel' })).toHaveCount(0)
  await expect(luma.page.locator('#histogram details')).toHaveCount(0)
  await held.evaluate((gate) => gate.restore())
  await held.dispose()
  await luma.page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (String(url).includes('analysis-worker'))
          this.addEventListener('message', (event) => {
            if (!event.data.statistics) return
            event.stopImmediatePropagation()
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  generation: event.data.generation,
                  identity: event.data.identity,
                  error: 'Analysis failed for test.',
                  done: true,
                },
              }),
            )
          })
      }
    }
  })
  await luma.page.reload()
  await expect(luma.page.locator('#histogram').getByRole('status')).toHaveText(
    'Histogram unavailable',
  )
  await expect(luma.page.locator('#histogram').getByRole('status')).toHaveAttribute(
    'title',
    'Analysis failed for test.',
  )
})
