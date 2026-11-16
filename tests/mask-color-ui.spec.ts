import { expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'
import { foregroundTest } from './foreground'
import { focusPreviewWindow } from './preview-pan.helpers'
import { captureWindow } from './window-capture.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'

async function openColor(page: import('@playwright/test').Page) {
  await maskDetailTab(page, 'Adjustments')
  const panel = page.getByTestId('masks-panel')
  const light = panel.getByRole('button', { name: 'Light', exact: true })
  if ((await light.getAttribute('aria-expanded')) === 'true') await activateButton(light)
  const color = panel.getByRole('button', { name: 'Color', exact: true })
  if ((await color.getAttribute('aria-expanded')) !== 'true') await activateButton(color)
}

test('relative masked color gestures, group reset and shared Undo persist independently of global color', async ({
  irodori,
}) => {
  test.setTimeout(90000)
  let { page } = irodori
  await importPhotos(
    irodori.app,
    page,
    ['tests/fixtures/photos/forest-light.jpg'],
    true,
    'keyboard',
  )
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await canvas.focus()
  await canvas.press('Space')
  await canvas.press('ArrowRight')
  await canvas.press('Space')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const before = (await history()).settings
  await maskDetailTab(page, 'Adjustments')
  const color = page.getByTestId('masks-panel').getByRole('button', { name: 'Color', exact: true })
  await expect(color).toHaveAttribute('aria-expanded', 'false')
  const temperature = page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true })
  const tint = page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })
  const saturation = page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true })
  await expect(temperature).toBeHidden()
  await openColor(page)
  for (const input of [temperature, tint, saturation]) {
    await expect(input).toHaveValue('0')
    await expect(input).toHaveAttribute('min', '-100')
    await expect(input).toHaveAttribute('max', '100')
    await expect(input).toHaveAttribute('step', '1')
  }
  await temperature.fill('17')
  expect((await history()).revision).toBe(2)
  await temperature.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await expect(temperature).toHaveValue('17')
  await expect(temperature).toBeFocused()
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '3')
  await tint.fill('-7')
  await tint.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 4 })
  await saturation.fill('-18')
  await saturation.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 5 })
  await temperature.fill('101')
  await temperature.press('Tab')
  await expect(temperature).toHaveValue('17')
  await temperature.fill('-6')
  await temperature.press('Escape')
  await expect(temperature).toHaveValue('17')
  expect((await history()).revision).toBe(5)
  const slider = page.getByRole('slider', { name: 'Local Temperature', exact: true })
  await slider.focus()
  for (let index = 0; index < 3; index++) await page.keyboard.down('ArrowRight')
  expect((await history()).revision).toBe(5)
  await page.keyboard.up('ArrowRight')
  await expect.poll(history).toMatchObject({ revision: 6 })
  const edited = (await history()).settings.maskStack[0]
  expect(edited.color).toEqual({ temperature: 20, tint: -7, saturation: -18 })
  expect(edited.head).toBe(before.maskStack[0].head)
  expect(edited.light).toEqual(before.maskStack[0].light)
  await activateButton(page.getByRole('button', { name: 'Reset mask Color', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 7 })
  expect((await history()).settings.maskStack[0].color).toEqual({
    temperature: 0,
    tint: 0,
    saturation: 0,
  })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 8 })
  expect((await history()).settings.maskStack[0]).toEqual(edited)
  await activateButton(page.getByRole('button', { name: 'Redo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 9 })
  await expect(temperature).toHaveValue('0')
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 10 })
  const saved = (await history()).settings
  expect(saved.whiteBalance).toEqual(before.whiteBalance)
  expect(saved.saturation).toBe(before.saturation)
  ;({ page } = await irodori.restart())
  await expect.poll(async () => (await history()).settings).toEqual(saved)
  await expect(
    page.getByTestId('masks-panel').getByRole('button', { name: 'Color', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  await openColor(page)
  await expect(
    page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true }),
  ).toHaveValue('20')
  await expect(page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })).toHaveValue(
    '-7',
  )
  await expect(
    page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true }),
  ).toHaveValue('-18')
})

test('local color drafts flush to their selected mask and external revisions replace stale fields', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const first = (await history()).settings.maskStack[0].id
  await openColor(page)
  const temperature = page.getByRole('spinbutton', { name: 'Local Temperature value', exact: true })
  const tint = page.getByRole('spinbutton', { name: 'Local Tint value', exact: true })
  await temperature.fill('15')
  await createMask(page)
  await expect.poll(history).toMatchObject({ revision: 3 })
  const stack = (await history()).settings.maskStack
  const second = stack[0].id
  expect(stack.find((mask) => mask.id === first)?.color.temperature).toBe(15)
  expect(stack.find((mask) => mask.id === second)?.color.temperature).toBe(0)
  await activateButton(page.locator(`[data-mask-id="${first}"] [data-mask-select]`))
  await openColor(page)
  await tint.fill('5')
  await page.evaluate(
    async ({ photoId, first }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.mutateMasks(photoId, state.revision, {
        operations: [{ kind: 'update', id: first, color: { saturation: -4 } }],
      })
    },
    { photoId, first },
  )
  await expect.poll(history).toMatchObject({ revision: 4 })
  await expect(tint).toHaveValue('0')
  await expect(
    page.getByRole('spinbutton', { name: 'Local Saturation value', exact: true }),
  ).toHaveValue('-4')
  await tint.press('Tab')
  expect((await history()).revision).toBe(4)
  await temperature.fill('21')
  await maskDetailTab(page, 'Coverage')
  await expect.poll(history).toMatchObject({ revision: 5 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.color).toEqual({
    temperature: 21,
    tint: 0,
    saturation: -4,
  })
  await openColor(page)
  await temperature.fill('22')
  await navigateInspector(page, 'Light')
  await expect.poll(history).toMatchObject({ revision: 6 })
  expect(
    (await history()).settings.maskStack.find((mask) => mask.id === first)?.color.temperature,
  ).toBe(22)
  await navigateInspector(page, 'Masks')
  await openColor(page)
  await expect(temperature).toHaveValue('22')
  await activateButton(page.getByRole('button', { name: 'Reset mask Light', exact: true }))
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)?.color).toEqual({
    temperature: 22,
    tint: 0,
    saturation: -4,
  })
})

test.describe('foreground masked Color', () => {
  test.use({ hdrDisplay: true })
  test(
    'authored HDR Color controls fit with Console and share primary Undo, reset and restart',
    foregroundTest(
      'Actual monitor HDR headroom, native Color controls and primary-key routing require a presented hardware window.',
    ),
    async ({ irodori }, info) => {
      test.setTimeout(120000)
      let { app, page } = irodori
      await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
      await focusPreviewWindow(app, page)
      await page.evaluate(() => window.irodori.setPreviewPreference('hdr'))
      let target = await page.evaluate(() => window.irodori.getDisplayState())
      try {
        await expect
          .poll(
            async () => {
              target = await page.evaluate(() => window.irodori.getDisplayState())
              return (
                target.mode === 'hdr' &&
                target.capabilities?.hardware === true &&
                target.capabilities.extended === true &&
                (target.headroom ?? 0) > 1
              )
            },
            { timeout: 15000 },
          )
          .toBe(true)
      } catch (error) {
        await info.attach('masked-color-hdr-unavailable', {
          contentType: 'application/json',
          body: JSON.stringify(target),
        })
        test.skip(
          target.mode !== 'hdr' ||
            target.capabilities?.hardware !== true ||
            target.capabilities.extended !== true ||
            (target.headroom ?? 0) <= 1,
          `Actual HDR masked Color presentation is unavailable: ${target.reason} Selected coverage is incomplete.`,
        )
        throw error
      }
      const directory = info.outputPath('authored-hdr')
      await mkdir(directory)
      const input = await hdrJpegFixture(directory)
      await importPhotos(app, page, [input.path], false, 'keyboard')
      const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
      const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
      const canvas = () => page.getByTestId('main-preview')
      const revealControl = async (control: import('@playwright/test').Locator) => {
        const inspector = page.getByTestId('inspector-scroll'),
          before = await inspector.evaluate((element) => element.scrollTop)
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport({ ratio: 1 })
        await expect(page.getByRole('button', { name: 'Create mask', exact: true })).toBeInViewport(
          { ratio: 1 },
        )
        await expect(page.getByRole('tab', { name: 'Adjustments', exact: true })).toBeInViewport({
          ratio: 1,
        })
        expect(await inspector.evaluate((element) => element.scrollTop)).toBe(before)
      }
      const presented = async (revision: number) => {
        await expect(canvas()).toHaveAttribute('data-editing', 'ready')
        await expect(canvas()).toHaveAttribute('data-backend', 'webgpu-hdr')
        await expect(canvas()).toHaveAttribute('data-quality', 'normal')
        await expect(canvas()).toHaveAttribute('data-presented-settings-revision', String(revision))
        await expect
          .poll(() =>
            canvas().evaluate(async (element, expectedRevision) => {
              const current = await window.irodori.getDisplayState(),
                state = element.dataset
              return (
                Number(state.requestedSerial) > 0 &&
                state.completedEditSerial === state.requestedSerial &&
                state.presentedSourceIdentity === state.requestedSourceIdentity &&
                state.presentedSettingsRevision === String(expectedRevision) &&
                Number(state.targetGeneration) === current.generation
              )
            }, revision),
          )
          .toBe(true)
        await expect
          .poll(() =>
            page.evaluate(
              ({ photoId, expectedRevision }) =>
                window.irodori.getPhotoPresentationContext({ photoId, expectedRevision }),
              { photoId, expectedRevision: revision },
            ),
          )
          .toMatchObject({
            photoId,
            revision,
            workspaceTarget: { mode: 'hdr', requestedPreference: 'hdr' },
            frame: { status: 'presented', mode: 'hdr', backend: 'webgpu-hdr' },
          })
      }
      await presented(0)
      const source = await page.evaluate((id) => window.irodori.getPreviewContext(id, 0), photoId)
      expect(source.sourceDynamicRange).toBe('hdr')
      expect(source.sourceMetadata?.authoredHeadroom).toBeGreaterThan(1)
      await activateButton(page.getByTestId('console-toggle'))
      await navigateInspector(page, 'Masks')
      await createMask(page)
      await presented(1)
      await canvas().focus()
      await canvas().press('Space')
      await canvas().press('ArrowRight')
      await canvas().press('Space')
      await expect.poll(history).toMatchObject({ revision: 2 })
      await presented(2)
      const neutral = (await history()).settings
      expect(neutral.maskStack[0].head ?? neutral.maskStack[0].resultHead).toMatch(/^[a-f0-9]{64}$/)
      expect(neutral.maskStack[0].color).toEqual({ temperature: 0, tint: 0, saturation: 0 })
      await page.getByRole('checkbox', { name: 'Show overlay', exact: true }).uncheck()
      await openColor(page)
      for (const [label, value, revision] of [
        ['Temperature', 17, 3],
        ['Tint', -7, 4],
        ['Saturation', -18, 5],
      ] as const) {
        const input = page.getByRole('spinbutton', { name: `Local ${label} value`, exact: true })
        await revealControl(input)
        await input.fill(String(value))
        expect((await history()).revision).toBe(revision - 1)
        await input.press('Enter')
        await expect.poll(history).toMatchObject({ revision })
        await presented(revision)
      }
      const edited = (await history()).settings
      expect(edited.maskStack[0]).toMatchObject({
        head: neutral.maskStack[0].head,
        resultHead: neutral.maskStack[0].resultHead,
        light: neutral.maskStack[0].light,
        color: { temperature: 17, tint: -7, saturation: -18 },
      })
      expect(edited.whiteBalance).toEqual(neutral.whiteBalance)
      expect(edited.saturation).toBe(neutral.saturation)
      const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
      await canvas().focus()
      await canvas().press(`${primary}+z`)
      await expect.poll(history).toMatchObject({ revision: 6 })
      expect((await history()).settings.maskStack[0].color).toEqual({
        temperature: 17,
        tint: -7,
        saturation: 0,
      })
      await presented(6)
      await canvas().press(`${primary}+Shift+z`)
      await expect.poll(history).toMatchObject({ revision: 7 })
      expect((await history()).settings).toEqual(edited)
      await presented(7)
      await activateButton(page.getByRole('button', { name: 'Reset mask Color', exact: true }))
      await expect.poll(history).toMatchObject({ revision: 8 })
      expect((await history()).settings).toEqual(neutral)
      await presented(8)
      await canvas().focus()
      await canvas().press(`${primary}+z`)
      await expect.poll(history).toMatchObject({ revision: 9 })
      expect((await history()).settings).toEqual(edited)
      ;({ app, page } = await irodori.restart())
      await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1100, 700))
      await focusPreviewWindow(app, page)
      await presented(9)
      expect((await history()).settings).toEqual(edited)
      await navigateInspector(page, 'Masks')
      await openColor(page)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
      await expect(page.getByTestId('console-panel')).toBeVisible()
      for (const [label, value] of [
        ['Temperature', '17'],
        ['Tint', '-7'],
        ['Saturation', '-18'],
      ]) {
        const input = page.getByRole('spinbutton', { name: `Local ${label} value`, exact: true })
        await expect(input).toHaveValue(value)
        await revealControl(input)
      }
      await revealControl(page.getByRole('button', { name: 'Reset mask Color', exact: true }))
      const browser = await canvas().evaluate(async (element) => {
        const configuration = (element as HTMLCanvasElement)
          .getContext('webgpu')!
          .getConfiguration()!
        await configuration.device.queue.onSubmittedWorkDone()
        const adapter = configuration.device.adapterInfo,
          state = element.dataset
        return {
          adapter: {
            vendor: adapter.vendor,
            architecture: adapter.architecture,
            device: adapter.device,
            description: adapter.description,
            isFallbackAdapter: adapter.isFallbackAdapter,
          },
          format: configuration.format,
          colorSpace: configuration.colorSpace,
          toneMapping: configuration.toneMapping,
          backend: state.backend,
          revision: state.presentedSettingsRevision,
          requestedSerial: state.requestedSerial,
          completedSerial: state.completedEditSerial,
          sourceIdentity: state.presentedSourceIdentity,
          requestedSourceIdentity: state.requestedSourceIdentity,
          targetGeneration: state.targetGeneration,
        }
      })
      expect(browser.adapter.isFallbackAdapter).toBe(false)
      expect(browser.format).toBe('rgba16float')
      expect(browser.toneMapping?.mode).toBe('extended')
      target = await page.evaluate(() => window.irodori.getDisplayState())
      expect(target).toMatchObject({
        mode: 'hdr',
        capabilities: { hardware: true, extended: true },
      })
      expect(target.headroom).toBeGreaterThan(1)
      const presentation = await page.evaluate(
        (photoId) => window.irodori.getPhotoPresentationContext({ photoId, expectedRevision: 9 }),
        photoId,
      )
      await info.attach('masked-color-hdr-presentation', {
        contentType: 'application/json',
        body: JSON.stringify({
          target,
          browser,
          source,
          presentation,
          photoId,
          revision: 9,
          color: edited.maskStack[0].color,
          fixture:
            'Original synthetic ISO gain-map chart; no photographic quality or combined-scene acceptance claim.',
          physicalOutputVerified: false,
        }),
      })
      await captureWindow(app, page, info.outputPath('1100-console-authored-hdr-color.png'))
    },
  )
})
