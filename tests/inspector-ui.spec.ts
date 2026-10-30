import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { DEFAULT_INSPECTOR_SECTIONS } from '../src/shared/workspace'

test('every inspector section uses keyboard disclosures without remounting controls or adding photo history', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const before = await page.evaluate((id) => window.irodori.getEdits(id), id)
  for (const [title, content] of [
    ['Histogram · After', 'histogram'],
    ['Light', 'light-controls'],
    ['Color', 'color-controls'],
    ['Crop', 'crop-controls'],
    ['Color Mixer', 'color-mixer-controls'],
    ['Color Grading', 'color-grading-controls'],
    ['Lens corrections', 'lens-controls'],
    ['Metadata', 'photo-metadata'],
  ]) {
    const toggle = page.getByRole('button', { name: title, exact: true })
    const body = page.locator(`#${content}`)
    await expect(toggle).toHaveAttribute('aria-controls', content)
    const initiallyOpen = (await toggle.getAttribute('aria-expanded')) === 'true'
    // The sentinel detects lost DOM ownership even when new controls look identical.
    await body.evaluate((element) => element.setAttribute('data-retained', 'true'))
    await activateButton(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', String(!initiallyOpen))
    await expect(body).toHaveAttribute('data-retained', 'true')
    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('aria-expanded', String(initiallyOpen))
    await expect(toggle).toBeFocused()
    await expect(body).toHaveAttribute('data-retained', 'true')
  }
  expect(await page.evaluate((id) => window.irodori.getEdits(id), id)).toEqual(before)
})

test('histogram remains pinned while only the adjustment body scrolls at native minimum size with Console open', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(page.getByTestId('console-toggle'))
  await activateButton(page.getByRole('button', { name: 'Lens corrections', exact: true }))
  const pinned = page.getByTestId('inspector-pinned')
  const scroll = page.getByTestId('inspector-scroll')
  const before = await pinned.boundingBox()
  const canvasBefore = await page.getByTestId('preview-viewport').boundingBox()
  await scroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await pinned.boundingBox()).toEqual(before)
  expect(await page.getByTestId('preview-viewport').boundingBox()).toEqual(canvasBefore)
  const plot = page.getByRole('slider', { name: 'Histogram tonal value' })
  await expect(plot).toBeVisible()
  await expect(page.locator('#histogram')).toHaveAttribute('data-pending', /^(true|false)$/)
  await expect(page.locator('#histogram')).toHaveAttribute('aria-busy', /^(true|false)$/)
  // IntersectionObserver does not publish for a hidden native Wayland surface.
  // Check the real resized renderer's bounds, including overlap with its scroll body.
  const plotBox = await plot.boundingBox()
  const expandedBodyBox = await scroll.boundingBox()
  expect(plotBox!.x).toBeGreaterThanOrEqual(0)
  expect(plotBox!.y).toBeGreaterThanOrEqual(0)
  expect(plotBox!.x + plotBox!.width).toBeLessThanOrEqual(1100)
  expect(plotBox!.y + plotBox!.height).toBeLessThanOrEqual(expandedBodyBox!.y)
  expect(expandedBodyBox!.y + expandedBodyBox!.height).toBeLessThanOrEqual(700)
  const histogram = page.getByRole('button', { name: 'Histogram · After', exact: true })
  await activateButton(histogram)
  await expect(page.locator('#histogram')).toBeHidden()
  await expect(histogram).toBeVisible()
  await expect(page.getByTestId('console-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const bodyBox = await scroll.boundingBox()
  const headingBox = await histogram.boundingBox()
  expect(headingBox!.y).toBeGreaterThanOrEqual(0)
  expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(700)
  expect(bodyBox!.y).toBeGreaterThanOrEqual(headingBox!.y + headingBox!.height)
})

test('collapsed section retains a pending edit and receives external revisions without stale values on reopen', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/alpine-lake.jpg'])
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const field = page.getByRole('spinbutton', { name: 'Exposure value' })
  await expect(field).toBeEnabled({ timeout: 20000 })
  await field.fill('1.25')
  const light = page.getByRole('button', { name: 'Light', exact: true })
  await activateButton(light)
  await expect(page.locator('#light-controls')).toBeHidden()
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 1, settings: { exposureEv: 1.25 } })
  await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 2, settings: { exposureEv: 0 } })
  await activateButton(light)
  await expect(field).toHaveValue('0.00')
  await expect(field).toBeEnabled()
})

test('disclosure choices survive photo changes, crash recovery and normal restart', async ({
  irodori,
}) => {
  let { page } = irodori
  await importPhotos(irodori.app, page)
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  for (const title of [
    'Histogram · After',
    'Light',
    'Color',
    'Metadata',
    'Lens corrections',
    'Color Mixer',
    'Color Grading',
  ])
    await activateButton(page.getByRole('button', { name: title, exact: true }))
  const expected = {
    ...DEFAULT_INSPECTOR_SECTIONS,
    histogram: false,
    light: false,
    color: false,
    metadata: false,
    lens: true,
    colorMixer: true,
    colorGrading: true,
  }
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.inspector,
    )
    .toEqual(expected)
  await activateButton(
    page.getByRole('button', { name: `Select ${photos[1].filename}`, exact: true }),
  )
  await expect(page.getByTestId('preview-filename')).toHaveText(photos[1].filename)
  await expect(page.getByRole('button', { name: 'Color', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  ;({ page } = await irodori.crashAndRestart())
  for (const title of ['Histogram · After', 'Light', 'Color', 'Metadata'])
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  await expect(page.getByRole('button', { name: 'Lens corrections', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  for (const title of ['Color Mixer', 'Color Grading'])
    await expect(page.getByRole('button', { name: title, exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  await activateButton(page.getByRole('button', { name: 'Color', exact: true }))
  ;({ page } = await irodori.restart())
  await expect(page.getByRole('button', { name: 'Color', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect
    .poll(
      async () => (await page.evaluate(() => window.irodori.getWorkspaceState())).state?.inspector,
    )
    .toEqual({ ...expected, color: true })
})
