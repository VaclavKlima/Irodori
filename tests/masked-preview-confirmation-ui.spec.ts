import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { requireEditorPreviewFeature } from './hdr-test-policy.helpers'

/** Exercise the ordinary platform policy and real GPU; no fabricated confirmation or pixels. */
test('saved RAW compound masks publish a confirmed frame on activation, global edit, navigation and restart', async ({
  irodori,
}) => {
  test.setTimeout(120000)
  let { page } = irodori
  await requireEditorPreviewFeature(page, 'presentation-cache')
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(
    irodori.app,
    page,
    ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/sony-zv1.ARW'],
    false,
    'renderer',
  )
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos,
    raw = photos.find((photo) => photo.filename === 'sony-zv1.ARW')!,
    raster = photos.find((photo) => photo.filename === 'alpine-lake.jpg')!,
    maskId = crypto.randomUUID(),
    componentId = crypto.randomUUID()
  await activateButton(page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }))
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  // Author while another photo is active, so the masked RAW must load from saved edits.
  await page.evaluate(
    ({ id, maskId, componentId }) =>
      window.irodori.mutateMasks(id, 0, {
        operations: [
          {
            kind: 'create',
            id: maskId,
            name: 'Saved protected gradient',
            gradient: {
              kind: 'linear',
              start: { x: 0.15, y: 0.2 },
              end: { x: 0.85, y: 0.8 },
            },
          },
          {
            kind: 'component-add',
            id: maskId,
            componentId,
            name: 'Editable protection',
            operator: 'subtract',
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.2,
              radiusY: 0.25,
              rotation: 20,
              feather: 45,
            },
          },
          { kind: 'component-update', id: maskId, componentId, edge: { featherPx: 3 } },
          {
            kind: 'update',
            id: maskId,
            light: { exposureEv: 0.65 },
            color: { temperature: 10, saturation: 7 },
          },
        ],
      }),
    { id: raw.id, maskId, componentId },
  )
  const settled = async (revision: number, sourceUploads = 1) => {
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('aria-label', raw.filename)
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(canvas).toHaveAttribute('data-source-uploads', String(sourceUploads), {
      timeout: 60000,
    })
    await expect(canvas).toHaveAttribute('data-frame-geometry-revision', String(revision), {
      timeout: 30000,
    })
    await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 15000 })
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 15000 })
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) =>
              Boolean(element.dataset.requestedSerial) &&
              element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        { timeout: 15000 },
      )
      .toBe(true)
    await expect(canvas).toBeVisible()
    await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
    await expect(page.getByTestId('mask-edge-pending')).toHaveCount(0)
  }
  await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
  await settled(1)
  const exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
  await exposure.fill('0.5')
  await exposure.press('Enter')
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), raw.id))
    .toMatchObject({ revision: 2 })
  await settled(2)
  const saved = await page.evaluate((id) => window.irodori.getEdits(id), raw.id)
  expect(saved.settings.maskStack).toHaveLength(1)
  expect(saved.settings.maskStack[0].operands?.[0].id).toBe(componentId)
  await activateButton(page.getByRole('button', { name: `Select ${raster.filename}`, exact: true }))
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  await activateButton(page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }))
  await settled(2, 0)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-source-cache', 'hit')
  const restarted = await irodori.restart()
  page = restarted.page
  await settled(2)
  expect((await page.evaluate((id) => window.irodori.getEdits(id), raw.id)).settings).toEqual(
    saved.settings,
  )
})
