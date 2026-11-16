import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { navigateInspector } from './inspector.helpers'
import { createMask, maskDetailTab } from './mask-panel.helpers'
import { identityCrop } from '../src/shared/crop'
import { openPreviewOptions } from './preview-options.helpers'
import { foregroundTest } from './foreground'
import { expectAdjustmentBounds, minimumAdjustmentWindow } from './adjustment-input.helpers'

const photo =
  'assets/tests/images/raster/wikimedia/flamingo-reflection/originals/Flamant_rose_Salines_de_Thyna.jpg'
async function ready(page: Page, revision: number) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', String(revision), {
    timeout: 60000,
  })
}
async function cachedProofHash(page: Page) {
  return page.getByTestId('main-preview').evaluate(async (canvas) => {
    const url = (canvas as HTMLElement).dataset.src
    if (!url) throw new Error('Missing completed managed preview')
    const response = await fetch(url)
    if (!response.ok) throw new Error('Completed managed preview is unavailable')
    const bytes = await response.arrayBuffer()
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  })
}
async function displayedHash(page: Page) {
  return page.getByTestId('main-preview').evaluate(async (element) => {
    const blob = await new Promise<Blob>((resolve, reject) =>
      (element as HTMLCanvasElement).toBlob((blob) =>
        blob ? resolve(blob) : reject(new Error('Missing displayed canvas bitmap')),
      ),
    )
    return Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('')
  })
}
async function prepareRasterTextureMask(app: ElectronApplication, page: Page) {
  await importPhotos(app, page, [photo], true, 'keyboard')
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const id = (await page.evaluate((id) => window.irodori.getEdits(id), photoId)).settings
    .maskStack[0].id
  await page.evaluate(
    async ({ photoId, id }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.mutateMasks(photoId, state.revision, {
        operations: [
          {
            kind: 'update',
            id,
            gradient: {
              kind: 'radial',
              center: { x: 0.56, y: 0.34 },
              radiusX: 0.22,
              radiusY: 0.2,
              rotation: 0,
              feather: 45,
            },
            light: { contrast: 10 },
            color: { saturation: 9 },
          },
        ],
      })
    },
    { photoId, id },
  )
  await ready(page, 2)
  return { photoId, id }
}

test('Texture is usable at 1100 by 700 with Console open and preserves shared history, source coverage and committed GPU output', async ({
  irodori,
}) => {
  test.setTimeout(180000)
  const { app } = irodori
  let { page } = irodori
  const { photoId } = await prepareRasterTextureMask(app, page)
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const neutral = (await history()).settings,
    beforeHash = await cachedProofHash(page)
  // Resize the actual hidden window; foreground presentation is qualified separately.
  await minimumAdjustmentWindow(app, page)
  await maskDetailTab(page, 'Adjustments')
  const texture = page.getByRole('spinbutton', { name: 'Local Texture value', exact: true })
  await expect(texture).toHaveValue('0')
  await expect(texture).toHaveAttribute('min', '-100')
  await expect(texture).toHaveAttribute('max', '100')
  await expect(texture).toHaveAttribute('step', '1')
  await texture.scrollIntoViewIfNeeded()
  const box = await texture.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(1100)
  expect(box!.y + box!.height).toBeLessThanOrEqual(700)
  await texture.fill('25')
  expect((await history()).revision).toBe(2)
  await texture.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  await ready(page, 3)
  await expect(page.getByTestId('main-preview')).toHaveAttribute(
    'data-masked-texture-key',
    /^[a-f0-9]{64}$/,
  )
  const enhanced = (await history()).settings
  expect(enhanced.maskStack[0]).toEqual({ ...neutral.maskStack[0], texture: 25 })
  expect(await cachedProofHash(page)).not.toBe(beforeHash)
  await texture.fill('101')
  await texture.press('Tab')
  await expect(texture).toHaveValue('25')
  expect((await history()).revision).toBe(3)
  await texture.fill('-25')
  await texture.press('Escape')
  await expect(texture).toHaveValue('25')
  expect((await history()).revision).toBe(3)
  await activateButton(page.getByRole('button', { name: 'Reset mask Texture', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 4 })
  await ready(page, 4)
  await expect
    .poll(() => page.getByTestId('main-preview').getAttribute('data-masked-texture-key'))
    .toBeNull()
  expect((await history()).settings).toEqual(neutral)
  expect(await cachedProofHash(page)).toBe(beforeHash)
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 5 })
  await ready(page, 5)
  expect((await history()).settings).toEqual(enhanced)
  ;({ page } = await irodori.restart())
  await expect.poll(history).toMatchObject({ revision: 5, settings: enhanced })
  await ready(page, 5)
  await navigateInspector(page, 'Masks')
  await maskDetailTab(page, 'Adjustments')
  await expect(
    page.getByRole('spinbutton', { name: 'Local Texture value', exact: true }),
  ).toHaveValue('25')
  const canvas = page.getByTestId('main-preview'),
    afterDisplay = await displayedHash(page)
  await openPreviewOptions(page)
  await activateButton(page.getByRole('button', { name: 'Before', exact: true }))
  await expect(canvas).toHaveAttribute('data-comparison', 'before')
  await expect(canvas).toHaveAttribute('data-comparison-loading', 'false')
  const beforeDisplay = await displayedHash(page)
  expect(beforeDisplay).not.toBe(afterDisplay)
  await openPreviewOptions(page)
  await activateButton(page.getByRole('button', { name: 'Compare before and after', exact: true }))
  await expect(canvas).toHaveAttribute('data-comparison', 'split')
  await expect(canvas).toHaveAttribute('data-comparison-loading', 'false')
  const splitDisplay = await displayedHash(page)
  expect(splitDisplay).not.toBe(afterDisplay)
  expect(splitDisplay).not.toBe(beforeDisplay)
  await openPreviewOptions(page)
  await activateButton(page.getByRole('button', { name: 'Compare before and after', exact: true }))
  await expect(canvas).toHaveAttribute('data-comparison', 'after')
  expect(await displayedHash(page)).toBe(afterDisplay)
  expect((await history()).revision).toBe(5)
  const source = await page.evaluate((id) => window.irodori.getEdits(id), photoId)
  expect(source.settings.maskStack[0].gradient).toEqual(neutral.maskStack[0].gradient)
})

test(
  'native Texture section and committed photograph fit at 1100 by 700 with Console open',
  foregroundTest(
    'Native minimum-size geometry and Wayland screenshot capture require a compositor-presented foreground window.',
  ),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(180000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { photoId } = await prepareRasterTextureMask(app, page)
    await minimumAdjustmentWindow(app, page)
    await maskDetailTab(page, 'Adjustments')
    const texture = page.getByRole('spinbutton', { name: 'Local Texture value', exact: true }),
      slider = page.getByRole('slider', { name: 'Local Texture', exact: true }),
      canvas = page.getByTestId('main-preview')
    await texture.fill('25')
    await texture.press('Enter')
    await ready(page, 3)
    await expect(canvas).toHaveAttribute('data-masked-texture-key', /^[a-f0-9]{64}$/)
    await expect(canvas).toHaveAttribute('data-prepared-mask-state', 'ready', { timeout: 60000 })
    await expect(canvas).toHaveAttribute(
      'data-prepared-mask-key',
      (await canvas.getAttribute('data-masked-texture-key'))!,
    )
    await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
    await expect(canvas).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate(async (photoId) => {
            const context = await window.irodori.getPhotoPresentationContext({
              photoId,
              expectedRevision: 3,
            })
            return context.frame.status
          }, photoId),
        { timeout: 60000 },
      )
      .toBe('presented')
    expect(
      (await page.evaluate((id) => window.irodori.getEdits(id), photoId)).settings.maskStack[0]
        .texture,
    ).toBe(25)
    await expectAdjustmentBounds(page, slider)
    await expect(texture).toBeVisible()
    await expect(texture).toHaveValue('25')
    await expect(
      page.getByRole('group', { name: 'Mask Texture controls', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Reset mask Texture', exact: true }),
    ).toBeVisible()
    await expect(page.getByTestId('console-panel')).toBeVisible()
    const preview = await canvas.boundingBox()
    expect(preview!.width).toBeGreaterThan(0)
    expect(preview!.height).toBeGreaterThan(0)
    await page.evaluate(async () => {
      await document.fonts.ready
      ;(document.activeElement as HTMLElement)?.blur()
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    await page.screenshot({ path: info.outputPath('1100-texture-console.png'), scale: 'css' })
  },
)

test('Texture numeric drafts flush on mask navigation and external revisions replace stale drafts', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(120000)
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'], true, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const first = (await history()).settings.maskStack[0].id
  await createMask(page)
  const second = (await history()).settings.maskStack[0].id
  await maskDetailTab(page, 'Adjustments')
  const texture = page.getByRole('spinbutton', { name: 'Local Texture value', exact: true })
  await texture.fill('25')
  await activateButton(page.locator(`[data-mask-id="${first}"] [data-mask-select]`))
  await expect.poll(history).toMatchObject({ revision: 3 })
  expect((await history()).settings.maskStack.find((mask) => mask.id === second)!.texture).toBe(25)
  await expect(texture).toHaveValue('0')
  await texture.fill('-25')
  await page.evaluate(
    async ({ photoId, id }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.mutateMasks(photoId, state.revision, {
        operations: [{ kind: 'update', id, texture: 10 }],
      })
    },
    { photoId, id: first },
  )
  await expect(texture).toHaveValue('10')
  await texture.press('Enter')
  expect((await history()).revision).toBe(4)
  expect((await history()).settings.maskStack.find((mask) => mask.id === first)!.texture).toBe(10)
})

test('a genuine Sony RAW consumes Texture in the actual HDR-source presenter under an SDR display target', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(180000)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await ready(page, 0)
  // The committed native crop qualifies the real RAW path without admitting a full 20 MP filter.
  await page.evaluate(
    async ({ photoId, crop }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.updateEdits(photoId, { crop }, state.revision)
    },
    { photoId, crop: { ...identityCrop, width: 0.3, height: 0.3 } },
  )
  await ready(page, 1)
  await navigateInspector(page, 'Masks')
  await createMask(page)
  const id = (await history()).settings.maskStack[0].id
  await page.evaluate(
    async ({ photoId, id }) => {
      const state = await window.irodori.getEdits(photoId)
      await window.irodori.mutateMasks(photoId, state.revision, {
        operations: [
          {
            kind: 'update',
            id,
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.12,
              radiusY: 0.12,
              rotation: 0,
              feather: 45,
            },
            light: { contrast: 5 },
            color: { saturation: 3 },
          },
        ],
      })
    },
    { photoId, id },
  )
  await ready(page, 3)
  await maskDetailTab(page, 'Adjustments')
  const texture = page.getByRole('spinbutton', { name: 'Local Texture value', exact: true })
  await texture.fill('25')
  await texture.press('Enter')
  await expect.poll(history).toMatchObject({ revision: 4 })
  await ready(page, 4)
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(canvas).toHaveAttribute('data-masked-texture-key', /^[a-f0-9]{64}$/)
  try {
    await expect(canvas).toHaveAttribute('data-quality', 'normal')
  } catch (error) {
    const state = await canvas.evaluate((element) =>
      Object.fromEntries(
        [
          'textureDrawStage',
          'texturePending',
          'loadTimings',
          'requestedSerial',
          'presentationSerial',
          'editing',
          'frameGeometryRevision',
          'presentationCacheEligible',
          'presentedEpoch',
          'requestedEpoch',
        ].map((key) => [key, (element as HTMLElement).dataset[key]?.slice(0, 1500) ?? null]),
      ),
    )
    console.info('Texture presenter failure state', JSON.stringify(state))
    await test.info().attach('texture-presenter-state', {
      body: JSON.stringify(state, null, 2),
      contentType: 'application/json',
    })
    throw error
  }
  const key = await canvas.getAttribute('data-masked-texture-key')
  await page.evaluate(async (photoId) => {
    const state = await window.irodori.getEdits(photoId)
    await window.irodori.updateEdits(photoId, { exposureEv: 0.5 }, state.revision)
  }, photoId)
  await expect.poll(history).toMatchObject({ revision: 5 })
  await ready(page, 5)
  await expect.poll(() => canvas.getAttribute('data-masked-texture-key')).not.toBe(key)
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
  expect((await history()).settings.maskStack[0].texture).toBe(25)
  await activateButton(page.getByRole('button', { name: 'Reset mask Texture', exact: true }))
  await expect.poll(history).toMatchObject({ revision: 6 })
  await ready(page, 6)
  await expect.poll(() => canvas.getAttribute('data-masked-texture-key')).toBeNull()
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
  expect((await history()).settings.maskStack[0]).toMatchObject({
    texture: 0,
    light: { contrast: 5 },
    color: { saturation: 3 },
  })
})
