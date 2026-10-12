import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { isolateTrash } from './photo-actions.helpers'
import { brkFixtures } from './brk.helpers'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { exposure, type MergePreview } from '../src/shared/merge'

test('partial BRK group extends without changing selection or view, then reviews and publishes through UI/MCP', async ({
  luma,
}, info) => {
  test.setTimeout(360000)
  const manifest = await brkFixtures()
  test.skip(!manifest, 'Private BRK manifest unavailable; camera UI acceptance is incomplete.')
  const sequence = manifest!.sequences.find((s) => s.files[0] === 'DSC02040.ARW')!,
    files = sequence.files.map((name) => manifest!.files.find((f) => f.name === name)!),
    { app, page } = luma
  await isolateTrash(app)
  await importPhotos(
    app,
    page,
    files.slice(0, 2).map((f) => f.path),
    false,
  )
  const partial = (await page.evaluate(() => window.luma.listStacks())).stacks[0]
  expect(partial).toMatchObject({ count: 2, origin: 'capture' })
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos,
    cover = photos.find((p) => p.id === partial.coverId)!
  await page
    .getByRole('button', { name: `Expand stack for ${cover.filename}, 2 photos`, exact: true })
    .click()
  await page.getByTestId(`photo-card-${cover.id}`).click()
  await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
    timeout: 60000,
  })
  await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('1')
  await page.getByTestId('main-preview').press('ArrowRight')
  await page.getByTestId('main-preview').press('ArrowDown')
  const view = await page.getByTestId('preview-viewport').evaluate((el) => ({
    x: el.getAttribute('data-pan-x'),
    y: el.getAttribute('data-pan-y'),
  }))
  expect(Math.abs(Number(view.x))).toBeGreaterThan(0)
  expect(Math.abs(Number(view.y))).toBeGreaterThan(0)
  const selection = await page.getByTestId('selection-count').innerText(),
    previousTasks = await page.evaluate(async () =>
      (await window.luma.listTasks()).map((task) => task.id),
    )
  await importPhotos(app, page, [files[2].path], false)
  // The previous import's completion message can remain visible while this
  // accepted import starts. Wait for this operation's publication instead.
  await expect
    .poll(async () =>
      page.evaluate(
        async (previous) =>
          (await window.luma.listTasks()).find(
            (task) => task.kind === 'import' && !previous.includes(task.id),
          )?.status,
        previousTasks,
      ),
    )
    .toBe('completed')
  await expect
    .poll(async () => (await page.evaluate(() => window.luma.listStacks())).stacks[0])
    .toMatchObject({
      id: partial.id,
      coverId: partial.coverId,
      count: 3,
      expanded: true,
    })
  await expect(page.getByTestId('preview-filename')).toHaveText(cover.filename)
  await expect(page.getByTestId('selection-count')).toHaveText(selection)
  await expect(page.getByRole('combobox', { name: 'Preview zoom', exact: true })).toHaveValue('1')
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-pan-x', view.x!)
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-pan-y', view.y!)
  await page.getByTestId('console-toggle').click()
  const native = await app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await page.getByTestId(`photo-card-${cover.id}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Merge 3 group originals to HDR…', exact: true }).click()
  const merge = page.getByRole('button', { name: 'Merge', exact: true })
  await expect(page.getByRole('checkbox', { name: 'Auto Align', exact: true })).toBeChecked({
    timeout: 30000,
  })
  try {
    await expect(merge).toBeEnabled({ timeout: 180000 })
  } catch (error) {
    const review = await page.evaluate(() => window.luma.getActiveMergeReview())
    if (review)
      await info.attach('failure', {
        body: JSON.stringify(
          await page.evaluate((r) => window.luma.getMergeDiagnostics(r.id, r.revision), review),
        ),
        contentType: 'application/json',
      })
    throw error
  }
  const review = (await page.evaluate(() => window.luma.getActiveMergeReview()))!
  expect(review.sources).toHaveLength(3)
  const reference = review.sources.find(
    (source) => source.photo.id === review.settings.referenceId,
  )!
  for (const source of review.sources) {
    const relative = Math.log2(exposure(source.capture) / exposure(reference.capture)).toFixed(2)
    await expect(
      page.getByRole('dialog').getByRole('button', { name: new RegExp(source.photo.filename) }),
    ).toContainText(`${relative} EV`)
  }
  expect(review.sources.every((s) => s.captureMetadata?.version === 2)).toBe(true)
  expect(JSON.stringify(review)).not.toContain('/originals/')
  const client = new Client({ name: 'brk-review-test', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), LUMA_PROFILE: luma.userDataDir },
    })
  let preview: MergePreview
  try {
    await client.connect(transport)
    const response = await client.callTool({
      name: 'luma_request_merge_preview',
      arguments: { reviewId: review.id, expectedRevision: review.revision },
    })
    expect(response.isError).not.toBe(true)
    preview = response.structuredContent as unknown as MergePreview
    expect(preview.recipe.version).toBe('sony-merge-v4')
    expect(preview.recipe.settings.autoAlign).toBe(true)
    expect(preview.recipe.resolution).toBe('native')
  } finally {
    await client.close()
    await transport.close()
  }
  const viewport = page.getByTestId('merge-viewport')
  await page.getByRole('combobox', { name: 'Merge preview zoom' }).selectOption('1')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('button', { name: 'Show prepared reference' }).click()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await page.getByRole('button', { name: 'Show merged result' }).click()
  await page.screenshot({ path: info.outputPath('brk-native-review-1100x700.png') })
  await merge.click()
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
  expect(result).toBeDefined()
  expect(
    (await page.evaluate((id) => window.luma.getMergeProvenance(id), result.id)).manifest.recipe
      .maskSha256,
  ).toBe(preview!.recipe.maskSha256)
  await expect(page.getByTestId('preview-filename')).toHaveText(result.filename)
  await expect(page.getByTestId('selection-count')).toHaveText('1 selected')
  const restarted = await luma.restart()
  expect(
    (await restarted.page.evaluate((id) => window.luma.getMergeProvenance(id), result.id)).manifest
      .version,
  ).toBe('sony-merge-v4')
})
