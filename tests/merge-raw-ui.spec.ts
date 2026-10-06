import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test.use({ hdrImports: true })
test('supplied Sony brackets review, publish, open and survive source deletion through the UI', async ({
  luma,
}, info) => {
  test.skip(
    !process.env.LUMA_MERGE_BRACKETS,
    'Supply a read-only Sony bracket sequence explicitly.',
  )
  test.setTimeout(360000)
  const paths = JSON.parse(process.env.LUMA_MERGE_BRACKETS!) as string[]
  await isolateTrash(luma.app)
  await importPhotos(luma.app, luma.page, paths, false)
  const { page } = luma,
    photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  for (const stack of (await page.evaluate(() => window.luma.listStacks())).stacks) {
    if (stack.expanded) continue
    const cover = photos.find((photo) => photo.id === stack.coverId)!
    await page
      .getByRole('button', {
        name: `Expand stack for ${cover.filename}, ${stack.count} photos`,
        exact: true,
      })
      .click()
  }
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page
    .getByTestId(`photo-card-${photos[photos.length - 1].id}`)
    .click({ modifiers: ['Shift'] })
  const native = await luma.app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Merge to HDR…' }).click()
  await expect(page.getByRole('checkbox', { name: 'Auto Align', exact: true })).toBeChecked({
    timeout: 30000,
  })
  const merge = page.getByRole('button', { name: 'Merge', exact: true })
  try {
    await expect
      .poll(async () => (await merge.isEnabled()) || (await page.getByRole('alert').count()) > 0, {
        timeout: 180000,
      })
      .toBe(true)
    await expect(merge).toBeEnabled()
  } catch (error) {
    const review = await page.evaluate(() => window.luma.getActiveMergeReview())
    if (review) {
      const diagnostics = await page.evaluate(
        (r) => window.luma.getMergeDiagnostics(r.id, r.revision),
        review,
      )
      await info.attach('alignment-diagnostics', {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: 'application/json',
      })
    }
    throw error
  }
  const viewport = page.getByTestId('merge-viewport')
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(page.getByRole('button', { name: 'Native detail (100%)' })).toHaveCount(0)
  const readyReview = await page.evaluate(() => window.luma.getActiveMergeReview())
  const client = new Client({ name: 'native-merge-review-test', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
    })
  try {
    await client.connect(transport)
    const response = await client.callTool({
      name: 'luma_request_merge_preview',
      arguments: { reviewId: readyReview!.id, expectedRevision: readyReview!.revision },
    })
    expect(response.isError).not.toBe(true)
    const nativePreview =
      response.structuredContent as unknown as import('../src/shared/merge').MergePreview
    expect(nativePreview.recipe.resolution).toBe('native')
    expect(nativePreview.width).toBe(nativePreview.recipe.crop.width)
    expect(nativePreview.height).toBe(nativePreview.recipe.crop.height)
    expect(nativePreview.resultUrl).toMatch(/\/result$/)
    expect(nativePreview.referenceUrl).toMatch(/\/reference$/)
    expect(nativePreview.overlayUrl).toMatch(/\/overlay$/)
    expect(nativePreview).not.toHaveProperty('nativeResultUrl')
  } finally {
    await client.close()
    await transport.close()
  }
  await info.attach('alignment-diagnostics', {
    body: JSON.stringify(
      await page.evaluate((r) => window.luma.getMergeDiagnostics(r!.id, r!.revision), readyReview),
      null,
      2,
    ),
    contentType: 'application/json',
  })
  const strength = page.getByRole('spinbutton', { name: 'Deghost strength value' })
  await strength.fill('72')
  await strength.press('Escape')
  await expect(strength).toHaveValue('50')
  await page.getByRole('checkbox', { name: 'Show deghost overlay' }).check()
  expect((await page.evaluate(() => window.luma.getActiveMergeReview()))?.revision).toBe(
    readyReview!.revision,
  )
  await expect(merge).toBeEnabled()
  await page.screenshot({ path: info.outputPath('merge-review-1100x700.png') })
  await page.getByRole('combobox', { name: 'Merge preview zoom' }).selectOption('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  const canvas = page.getByTestId('merge-preview')
  await expect(canvas).toHaveAttribute('data-scale', '1')
  const dimensions = await canvas.evaluate((image) => ({
    width: Number(image.dataset.imageWidth),
    height: Number(image.dataset.imageHeight),
  }))
  expect(dimensions.width).toBeGreaterThan(1024)
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-suspended', 'true')
  await page.getByRole('button', { name: 'Show prepared reference' }).click()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await expect(page.getByRole('img', { name: 'Prepared reference', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show merged result' }).click()
  await page.getByRole('button', { name: 'Fit merge preview' }).click()
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await merge.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText(`${paths.length} selected`)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.luma.listTasks())).find((t) => t.kind === 'merge')
          ?.finishedAt,
      { timeout: 120000 },
    )
    .toBeTruthy()
  const result = (await page.evaluate(() => window.luma.listPhotos())).photos.find(
    (p) => p.assetKind === 'derived',
  )!
  expect(result).toBeTruthy()
  await expect(page.getByTestId('preview-filename')).toHaveText(result.filename)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  const resultCard = page.getByTestId(`photo-card-${result.id}`)
  await expect(resultCard).toHaveAttribute('aria-current', 'true')
  await expect(resultCard).toHaveAttribute('aria-pressed', 'true')
  await expect(resultCard).toBeInViewport({ ratio: 1 })
  await cp(
    join(luma.userDataDir, 'library', 'originals', result.id),
    info.outputPath('published-master'),
    { recursive: true },
  )
  expect(await page.evaluate((id) => window.luma.getEdits(id), result.id)).toMatchObject({
    referenceWhiteBalance: true,
    revision: 0,
    settings: { exposureEv: 0, contrast: 0, highlights: 0 },
  })
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 45000,
  })
  const adjusted = await page.evaluate(
    (id) =>
      window.luma.updateEdits(id, { whiteBalance: { mode: 'custom', kelvin: 7000, tint: 10 } }, 0),
    result.id,
  )
  expect(adjusted.settings.whiteBalance).toMatchObject({ mode: 'custom', kelvin: 7000, tint: 10 })
  await page.evaluate((id) => window.luma.undoEdit(id, 1), result.id)
  await page.evaluate(
    (ids) => window.luma.deletePhotos(ids),
    photos.map((p) => p.id),
  )
  await expect.poll(async () => (await page.evaluate(() => window.luma.listPhotos())).total).toBe(1)
  expect(await page.evaluate((id) => window.luma.getMergeProvenance(id), result.id)).toMatchObject({
    reproducible: false,
  })
  const restarted = await luma.restart(true)
  await expect(restarted.page.getByTestId('main-preview')).toHaveAttribute(
    'data-editing',
    'ready',
    { timeout: 45000 },
  )
  expect((await restarted.page.evaluate(() => window.luma.listPhotos())).photos[0].id).toBe(
    result.id,
  )
  const statistics = await restarted.page.evaluate(
    (id) => window.luma.getPhotoStatistics(id, 2, { domain: 'working-hdr' }),
    result.id,
  )
  expect(statistics.exact).toBe(true)
  expect(statistics.visiblePixels).toBe(result.width * result.height)
  expect(statistics.sourceSaturation).toBeNull()
  expect(
    (await restarted.page.evaluate((id) => window.luma.getEdits(id), result.id)).settings
      .whiteBalance.mode,
  ).toBe('as-shot')
})
