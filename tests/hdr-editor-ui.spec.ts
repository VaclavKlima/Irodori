import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
test.use({ hdrDisplay: true, hdrImports: true })

test('Wayland refresh updates native screen metadata without disturbing the editor', async ({
  luma,
}, info) => {
  test.setTimeout(120000)
  const { app, page } = luma
  test.skip(
    !(await app.evaluate(
      () =>
        process.platform === 'linux' &&
        Boolean(process.env.WAYLAND_DISPLAY) &&
        process.versions.electron === '44.3.0',
    )),
    'The native workaround is specific to Electron 44.3.0 on Wayland.',
  )
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 90000 })
  await expect(preview).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  const nativeWindow = await app.browserWindow(page)
  const nativeFocus = () =>
    nativeWindow.evaluate((window) => ({
      window: window.isFocused(),
      contents: window.webContents.isFocused(),
    }))
  const pressNativeKey = (
    keyCode: string,
    modifiers: Electron.KeyboardInputEvent['modifiers'] = [],
  ) =>
    nativeWindow.evaluate(
      (window, { keyCode, modifiers }) => {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      },
      { keyCode, modifiers },
    )
  await nativeWindow.evaluate((window) => {
    window.focus()
    window.webContents.focus()
  })
  await expect.poll(nativeFocus).toEqual({ window: true, contents: true })
  await preview.focus()
  await page.keyboard.press('1')
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', '1')
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value' })
  await exposure.focus()
  const retained = await preview.evaluateHandle((canvas) => canvas)
  const before = await page.evaluate(() => window.luma.getPreviewDiagnostics())
  const currentScreen = () =>
    page.evaluate(async () => {
      const screen = (await window.getScreenDetails!()).currentScreen
      return { label: screen.label, headroomStops: screen.hdrHeadroom }
    })
  const initial = await currentScreen()
  const calls = await app.evaluateHandle(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents as Electron.WebContents & {
      setEmbedder: (embedder: Electron.WebContents) => void
    }
    const original = contents.setEmbedder.bind(contents)
    const observations = { count: 0 }
    contents.setEmbedder = (embedder) => {
      observations.count++
      original(embedder)
    }
    return observations
  })
  await expect.poll(() => calls.evaluate((value) => value.count)).toBeGreaterThanOrEqual(3)
  expect(await nativeFocus()).toEqual({ window: true, contents: true })
  await expect(exposure).toBeFocused()
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', '1')
  expect(await retained.evaluate((canvas) => canvas.isConnected)).toBe(true)
  await expect(preview).toHaveAttribute('data-backend', 'webgpu-hdr')
  const after = await page.evaluate(() => window.luma.getPreviewDiagnostics())
  expect(after.presentation).toEqual(before.presentation)
  expect(await currentScreen()).toEqual(initial)
  // CDP keyboard input can bypass missing native focus. Exercise Electron's
  // native input route after refresh, including field and console exclusions.
  await exposure.fill('12')
  await pressNativeKey('Home')
  await pressNativeKey('Delete')
  await expect(exposure).toHaveValue('2')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await pressNativeKey('Escape')
  await expect(exposure).toHaveValue('0.00')
  await pressNativeKey('Tab')
  await expect(exposure).not.toBeFocused()
  await pressNativeKey('Tab', ['shift'])
  await expect(exposure).toBeFocused()
  await preview.focus()
  const beforeDelete = await calls.evaluate((value) => value.count)
  await expect
    .poll(() => calls.evaluate((value) => value.count))
    .toBeGreaterThanOrEqual(beforeDelete + 5)
  expect(await nativeFocus()).toEqual({ window: true, contents: true })
  await expect(preview).toBeFocused()
  await pressNativeKey('Delete')
  await expect(page.getByRole('dialog')).toContainText('Delete photo?')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await pressNativeKey('Escape')
  await expect(preview).toBeFocused()
  await pressNativeKey('Tab')
  await expect(preview).not.toBeFocused()
  await page.getByTestId('console-toggle').click()
  const consoleInput = page.getByRole('textbox', {
    name: 'Agent console output, disconnected and read only',
  })
  await consoleInput.focus()
  const beforeConsole = await calls.evaluate((value) => value.count)
  await expect
    .poll(() => calls.evaluate((value) => value.count))
    .toBeGreaterThanOrEqual(beforeConsole + 2)
  expect(await nativeFocus()).toEqual({ window: true, contents: true })
  await expect(consoleInput).toBeFocused()
  await pressNativeKey('Delete')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  await page.getByTestId('console-toggle').click()
  const viewport = page.getByTestId('preview-viewport')
  const box = (await viewport.boundingBox())!
  const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(pointer.x, pointer.y)
  await page.mouse.down()
  await expect.poll(() => viewport.evaluate((el) => document.pointerLockElement === el)).toBe(true)
  const beforeDrag = await calls.evaluate((value) => value.count)
  await page.waitForTimeout(2200)
  expect(await calls.evaluate((value) => value.count)).toBe(beforeDrag)
  await expect(viewport).toHaveCSS('cursor', 'none')
  await page.mouse.move(pointer.x + 40, pointer.y + 20)
  await expect(viewport).toHaveAttribute('data-pan-x', '40')
  await page.mouse.up()
  await expect(viewport).not.toHaveCSS('cursor', 'none')
  await expect
    .poll(() => calls.evaluate((value) => value.count))
    .toBeGreaterThanOrEqual(beforeDrag + 2)
  // A new renderer takes a fresh native ScreenInfos snapshot. It must agree with
  // the running renderer; no particular monitor name or HDR capability is assumed.
  await page.reload()
  expect(await currentScreen()).toEqual(initial)
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ capabilities: { monitor: { label: initial.label } } })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await expect.poll(currentScreen).toEqual(initial)
  const otherWindow = await app.evaluateHandle(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({ width: 320, height: 200, show: false })
    await window.loadURL('data:text/html,<title>Focus witness</title>Another window')
    window.show()
    return window
  })
  try {
    await expect.poll(() => otherWindow.evaluate((window) => window.isFocused())).toBe(true)
    await expect.poll(nativeFocus).toMatchObject({ window: false })
    const beforeBackground = await calls.evaluate((value) => value.count)
    await expect
      .poll(() => calls.evaluate((value) => value.count))
      .toBeGreaterThanOrEqual(beforeBackground + 3)
    expect(await nativeFocus()).toEqual({ window: false, contents: false })
    expect(await otherWindow.evaluate((window) => window.isFocused())).toBe(true)
    expect(await currentScreen()).toEqual(initial)
  } finally {
    await otherWindow.evaluate((window) => window.destroy())
    await otherWindow.dispose()
  }
  await info.attach('native-current-screen', {
    body: JSON.stringify(initial),
    contentType: 'application/json',
  })
  await retained.dispose()
  await calls.dispose()
})

test('new Sony imports edit in HDR with SDR comparison and domain-aware analysis', async ({
  luma,
}, info) => {
  test.setTimeout(180000)
  const { page } = luma
  await importPhotos(luma.app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const id = (await page.evaluate(() => window.luma.listPhotos())).photos[0].id
  expect((await page.evaluate((id) => window.luma.getEdits(id), id)).settings.processing).toBe(
    'hdr-v1',
  )
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr', {
    timeout: 120000,
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(page.getByRole('slider', { name: 'Histogram tonal value' })).toBeVisible({
    timeout: 45000,
  })
  await expect(page.getByLabel('Analysis domain')).toHaveCount(0)
  await info.attach('available-screens', {
    body: JSON.stringify(
      await page.evaluate(async () => {
        const details = await window.getScreenDetails?.()
        return details?.screens.map((screen) => ({
          label: screen.label,
          headroomStops: screen.hdrHeadroom,
          current: screen === details.currentScreen,
        }))
      }),
    ),
    contentType: 'application/json',
  })
  await page.getByLabel('Preview display mode').selectOption('sdr')
  expect((await page.evaluate(() => window.luma.getDisplayState())).mode).toBe('sdr')
  await expect(page.getByText(/(?:srgb|display-p3) · SDR/)).toBeVisible()
  const state = await page.evaluate((id) => window.luma.getEdits(id), id)
  await page.getByRole('spinbutton', { name: 'Exposure value' }).fill('1')
  await page.getByRole('spinbutton', { name: 'Exposure value' }).press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.luma.getEdits(id), id))
    .toMatchObject({
      revision: state.revision + 1,
      settings: { exposureEv: 1, processing: 'hdr-v1' },
    })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: 'Exposure value' })).toHaveValue('0.00')
  const statistics = await page.evaluate(async (id) => {
    const state = await window.luma.getEdits(id)
    return window.luma.getPhotoStatistics(id, state.revision, { domain: 'working-hdr' })
  }, id)
  expect(statistics.exact).toBe(true)
  expect(statistics.aboveWhite).toBeGreaterThan(0)
  await page.getByLabel('Preview display mode').selectOption('hdr')
  const display = await page.evaluate(() => window.luma.getDisplayState())
  expect(display.physicalOutputVerified).toBe(false)
  const client = new Client({ name: 'hdr-parity', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('scripts/editor-mcp.mjs')],
        env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
      }),
    )
    const state = await client.callTool({ name: 'luma_get_display_state', arguments: {} })
    expect(state.structuredContent).toMatchObject({
      requested: 'hdr',
      physicalOutputVerified: false,
    })
    const diagnostics = await client.callTool({
      name: 'luma_get_preview_diagnostics',
      arguments: {},
    })
    const bridgeDiagnostics = await page.evaluate(() => window.luma.getPreviewDiagnostics())
    expect(diagnostics.structuredContent).toEqual(bridgeDiagnostics)
    expect(bridgeDiagnostics).toMatchObject({
      photoId: id,
      loadingStage: 'prepared',
      presentation: { photoId: id, stage: 'presented', backend: 'webgpu-hdr' },
    })
    const revision = (await page.evaluate((id) => window.luma.getEdits(id), id)).revision
    const pixelArguments = {
      photoId: id,
      expectedRevision: revision,
      x: 100,
      y: 100,
      domain: 'working-hdr',
    }
    const pixel = await client.callTool({ name: 'luma_get_photo_pixel', arguments: pixelArguments })
    expect(pixel.isError).not.toBe(true)
    const bridgePixel = await page.evaluate(
      ({ id, revision }) =>
        window.luma.getPhotoPixel(id, revision, 100, 100, { domain: 'working-hdr' }),
      { id, revision },
    )
    expect(pixel.structuredContent).toEqual(bridgePixel)
    expect(bridgePixel).toMatchObject({
      photoId: id,
      revision,
      x: 100,
      y: 100,
      width: 5422,
      height: 3622,
      domain: 'working-hdr',
      colorSpace: 'rec2020',
      alpha: 1,
    })
    expect(bridgePixel.rgb.every(Number.isFinite)).toBe(true)
    expect(bridgePixel.relativeLuminance).toBeGreaterThan(0)
    expect(bridgePixel.stopsAboveReferenceWhite).toBeCloseTo(
      Math.log2(bridgePixel.relativeLuminance),
      10,
    )
    const outputPixel = await client.callTool({
      name: 'luma_get_photo_pixel',
      arguments: { ...pixelArguments, domain: 'output', target: 'sdr' },
    })
    expect(outputPixel.isError).not.toBe(true)
    expect(outputPixel.structuredContent).toMatchObject({
      domain: 'output',
      colorSpace: 'srgb',
      target: { peak: 1 },
    })
    for (const patch of [
      { expectedRevision: revision - 1 },
      { x: 5422 },
      { x: 0.5 },
      { domain: 'output', target: 'current', targetGeneration: 0 },
    ])
      expect(
        (
          await client.callTool({
            name: 'luma_get_photo_pixel',
            arguments: { ...pixelArguments, ...patch },
          })
        ).isError,
      ).toBe(true)
    const exact = await client.callTool({
      name: 'luma_get_photo_statistics',
      arguments: { photoId: id, expectedRevision: revision, domain: 'working-hdr' },
    })
    expect(exact.isError).not.toBe(true)
    expect(exact.structuredContent).toMatchObject({
      exact: true,
      aboveWhite: statistics.aboveWhite,
      domain: 'working-hdr',
    })
    const legacy = await client.callTool({
      name: 'luma_get_photo_statistics',
      arguments: { photoId: id, expectedRevision: revision },
    })
    expect(legacy.structuredContent).toMatchObject({ dynamicRange: 'sdr', colorSpace: 'srgb' })
    const output = await client.callTool({
      name: 'luma_get_photo_statistics',
      arguments: { photoId: id, expectedRevision: revision, domain: 'output', target: 'sdr' },
    })
    expect(output.isError).not.toBe(true)
    expect(output.structuredContent).toMatchObject({
      domain: 'output',
      colorSpace: 'srgb',
      exact: true,
      target: { peak: 1, outputVersion: 'hdr-output-v1' },
    })
    const stale = await client.callTool({
      name: 'luma_get_photo_statistics',
      arguments: {
        photoId: id,
        expectedRevision: revision,
        domain: 'output',
        target: 'current',
        targetGeneration: 0,
      },
    })
    expect(stale.isError).toBe(true)
    await client.callTool({ name: 'luma_set_preview_preference', arguments: { preference: 'sdr' } })
    await expect(page.getByLabel('Preview display mode')).toHaveValue('sdr')
    expect((await page.evaluate((id) => window.luma.getEdits(id), id)).revision).toBe(revision)
  } finally {
    await client.close()
  }
  await expect(page.getByRole('button', { name: 'Inspect center pixel' })).toHaveCount(0)
  await expect(page.getByText('Analysis details · sampled')).toHaveCount(0)
  const outputClipping = page.getByRole('button', { name: 'Output clipping', exact: true })
  await outputClipping.click()
  await expect(outputClipping).toHaveAttribute('aria-pressed', 'true')
  await outputClipping.click()
  await info.attach('display-state', {
    body: JSON.stringify(display),
    contentType: 'application/json',
  })
  await luma.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
  )
  await page.getByTestId('console-toggle').click()
  await expect(page.getByLabel('Preview display mode')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('hdr-editor-layout-sdr-capture.png') })
  await luma.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(3440, 1080),
  )
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(
          document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.dataset
            .allocatedBytes ?? 0,
        ),
      ),
    )
    .toBeGreaterThan(0)
  await page.screenshot({ path: info.outputPath('hdr-ultrawide.png') })
  // Force backing allocations independently of compositor window-size limits.
  const viewport = page.getByTestId('preview-viewport')
  await viewport.evaluate((element) => {
    Object.assign(element.style, { minWidth: '2900px', minHeight: '1000px' })
  })
  await expect
    .poll(() =>
      page
        .getByTestId('main-preview')
        .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]),
    )
    .toEqual([2900, 1000])
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  // A genuinely over-budget surface falls back; shrinking it must recover without a monitor change.
  await viewport.evaluate((element) => {
    element.style.minWidth = '4400px'
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'canvas2d-hdr-sdr')
  await viewport.evaluate((element) => {
    element.style.minWidth = ''
    element.style.minHeight = ''
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr', {
    timeout: 15000,
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  // Simulated monitor events exercise stale probes without claiming a physical HDR transition.
  await page.evaluate(() => {
    const monitor = Object.assign(new EventTarget(), {
      label: 'Zero-headroom test monitor',
      hdrHeadroom: 0,
      width: 3440,
      height: 1440,
      left: 0,
      top: 0,
    })
    const details = Object.assign(new EventTarget(), { currentScreen: monitor, screens: [monitor] })
    let old: ((value: unknown) => void) | undefined
    let calls = 0
    Object.defineProperty(window, 'getScreenDetails', {
      configurable: true,
      value: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              old = resolve
            })
          : Promise.resolve(details),
    })
    Object.assign(window, {
      testDisplay: {
        details,
        resolveOld: () =>
          old?.(
            Object.assign(new EventTarget(), {
              currentScreen: Object.assign(new EventTarget(), {
                ...monitor,
                label: 'Stale monitor',
                hdrHeadroom: 4,
              }),
              screens: [],
            }),
          ),
      },
    })
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
  })
  await page.getByLabel('Preview display mode').selectOption('hdr')
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({
      mode: 'sdr',
      requested: 'hdr',
      capabilities: { monitor: { label: 'Zero-headroom test monitor' }, failure: 'no-headroom' },
    })
  await page.evaluate(() =>
    (window as unknown as { testDisplay: { resolveOld: () => void } }).testDisplay.resolveOld(),
  )
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({
      mode: 'sdr',
      capabilities: { monitor: { label: 'Zero-headroom test monitor' } },
    })
  await page.getByLabel('Display details').click()
  await expect(page.getByText('Reported headroom: 0.000 stops (1.00×)')).toBeVisible()
  await page.getByLabel('Display details').click()
  await page.evaluate(() => {
    const details = (
      window as unknown as {
        testDisplay: { details: { currentScreen: EventTarget & { hdrHeadroom: number } } }
      }
    ).testDisplay.details
    details.currentScreen.hdrHeadroom = 3
    details.currentScreen.dispatchEvent(new Event('hdrheadroomchange'))
  })
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ mode: 'hdr', peak: 8 })
  await expect(page.locator('#histogram').getByText('HDR', { exact: true })).toBeVisible()
  await expect(page.locator('#histogram').getByText('+4', { exact: true })).toBeVisible()
  await page.getByRole('slider', { name: 'Histogram tonal value' }).focus()
  await page.getByRole('slider', { name: 'Histogram tonal value' }).press('End')
  await expect(page.getByRole('slider', { name: 'Histogram tonal value' })).toHaveAttribute(
    'aria-valuenow',
    '511',
  )
  await page.screenshot({ path: info.outputPath('hdr-histogram-stops.png') })
  await page.getByLabel('Preview display mode').selectOption('sdr')
  await luma.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1100, 700),
  )
  const beforeLoss = await page.evaluate((id) => window.luma.getEdits(id), id)
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const device = canvas.getContext('webgpu')!.getConfiguration()!.device
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: async () => null },
      configurable: true,
    })
    device.destroy()
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-backend',
    'canvas2d-hdr-sdr',
    { timeout: 10000 },
  )
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  expect(await page.evaluate((id) => window.luma.getEdits(id), id)).toEqual(beforeLoss)
  expect((await page.evaluate(() => window.luma.getDisplayState())).mode).toBe('sdr')
  const { page: reopened } = await luma.restart()
  await expect(reopened.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  await expect(reopened.getByTestId('main-preview')).toHaveAttribute('data-backend', 'webgpu-hdr')
  expect(await reopened.evaluate((id) => window.luma.getEdits(id), id)).toEqual(beforeLoss)
  await expect(reopened.getByLabel('Preview display mode')).toHaveValue('sdr')
})

test('monitor tracking survives pending GPU probes and missed compositor events', async ({
  luma,
}) => {
  const { page } = luma
  await page.addInitScript(() => {
    const sdr = Object.assign(new EventTarget(), {
      label: 'SDR monitor',
      width: 1920,
      height: 1080,
      left: 0,
      top: 0,
      hdrHeadroom: 0,
      devicePixelRatio: 1,
    })
    const hdr = Object.assign(new EventTarget(), {
      label: 'HDR monitor',
      width: 3440,
      height: 1440,
      left: 1920,
      top: 0,
      hdrHeadroom: 3,
      devicePixelRatio: 1.25,
    })
    const details = Object.assign(new EventTarget(), { currentScreen: sdr, screens: [sdr, hdr] })
    Object.defineProperty(window, 'getScreenDetails', { value: async () => details })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
    let probing = false
    Object.defineProperty(navigator.gpu, 'requestAdapter', {
      value: async (options?: GPURequestAdapterOptions) => {
        probing = true
        await gate
        return requestAdapter(options)
      },
    })
    Object.assign(window, {
      monitorTest: {
        get probing() {
          return probing
        },
        enterHdr() {
          details.currentScreen = hdr
          details.dispatchEvent(new Event('currentscreenchange'))
          resume()
        },
        enterSdrWithoutEvent() {
          details.currentScreen = sdr
        },
        enterHdrWithoutEvent() {
          details.currentScreen = hdr
        },
        zeroHeadroom() {
          hdr.hdrHeadroom = 0
          hdr.dispatchEvent(new Event('hdrheadroomchange'))
        },
      },
    })
  })
  await page.reload()
  await page.waitForFunction(
    () => (window as unknown as { monitorTest: { probing: boolean } }).monitorTest.probing,
  )
  await page.evaluate(() =>
    (window as unknown as { monitorTest: { enterHdr(): void } }).monitorTest.enterHdr(),
  )
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({
      mode: 'hdr',
      capabilities: { monitor: { label: 'HDR monitor', scale: 1.25 }, headroomStops: 3 },
    })
  await page.evaluate(() =>
    (
      window as unknown as { monitorTest: { enterSdrWithoutEvent(): void } }
    ).monitorTest.enterSdrWithoutEvent(),
  )
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({
      mode: 'sdr',
      capabilities: { monitor: { label: 'SDR monitor' }, headroomStops: 0 },
    })
  await page.evaluate(() =>
    (
      window as unknown as { monitorTest: { enterHdrWithoutEvent(): void } }
    ).monitorTest.enterHdrWithoutEvent(),
  )
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({ mode: 'hdr' })
  await page.evaluate(() =>
    (window as unknown as { monitorTest: { zeroHeadroom(): void } }).monitorTest.zeroHeadroom(),
  )
  await expect
    .poll(() => page.evaluate(() => window.luma.getDisplayState()))
    .toMatchObject({
      mode: 'sdr',
      capabilities: { monitor: { label: 'HDR monitor' }, headroomStops: 0 },
    })
})
