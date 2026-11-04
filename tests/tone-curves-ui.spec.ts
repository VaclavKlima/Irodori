import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { identityToneCurves } from '../src/shared/tone-curves'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { identityCrop } from '../src/shared/crop'

test('curve graph, numeric fields, keyboard gestures, MCP and restart share one photo history', async ({
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
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
    graph = () => page.getByTestId('curve-graph')
  await expect(graph()).toHaveAttribute('aria-disabled', 'false')
  await activateButton(page.getByRole('button', { name: 'Light', exact: true }))
  await graph().evaluate((node) => node.scrollIntoView({ block: 'center' }))
  const box = (await graph().boundingBox())!
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.4)
  expect((await history()).revision).toBe(0)
  await page.mouse.up()
  await expect.poll(history).toMatchObject({ revision: 1 })
  expect((await history()).settings.curves.master).toHaveLength(3)
  await expect(graph()).toHaveAttribute('aria-disabled', 'false')
  await graph().focus()
  await page.keyboard.down('ArrowUp')
  await page.keyboard.down('ArrowUp')
  await page.keyboard.down('ArrowUp')
  expect((await history()).revision).toBe(1)
  await page.keyboard.up('ArrowUp')
  await expect.poll(history).toMatchObject({ revision: 2 })
  const saved = await history()
  await expect(graph()).toHaveAttribute('aria-disabled', 'false')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  expect(await history()).toEqual(saved)
  const output = () => page.getByRole('spinbutton', { name: 'Curve Output value', exact: true })
  await output().fill('27.5')
  await output().press('Enter')
  await expect.poll(history).toMatchObject({ revision: 3 })
  const numeric = await history()
  expect(numeric.settings.curves.master.some((p) => p.output === 0.275)).toBe(true)
  await output().fill('6500')
  await output().press('Tab')
  expect(await history()).toEqual(numeric)
  await output().fill('12')
  await output().press('Escape')
  expect(await history()).toEqual(numeric)
  await output().focus()
  await output().press('ControlOrMeta+A')
  await output().pressSequentially('-12.25')
  await expect(output()).toHaveValue('-12.25')
  await output().press('Escape')
  expect(await history()).toEqual(numeric)
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    }),
    client = new Client({ name: 'irodori-curves-test', version: '1' })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    expect(
      JSON.stringify(tools.find((t) => t.name === 'irodori_update_edits')!.inputSchema),
    ).toContain('curves')
    expect(tools.find((t) => t.name === 'irodori_sample_curve_tone')).toBeDefined()
    const sample = await client.callTool({
      name: 'irodori_sample_curve_tone',
      arguments: {
        photoId: id,
        expectedRevision: 3,
        curveSample: { channel: 'red', x: 0.5, y: 0.5 },
      },
    })
    expect(sample.isError).not.toBe(true)
    expect(sample.structuredContent).toMatchObject({
      photoId: id,
      revision: 3,
      channel: 'red',
      visibleSamples: 25,
    })
    await output().fill('40')
    const green = [
      { input: 0, output: 0 },
      { input: 1, output: 1.1 },
    ]
    const external = await client.callTool({
      name: 'irodori_update_edits',
      arguments: {
        photoId: id,
        expectedRevision: 3,
        patch: { curves: { master: identityToneCurves.master, green } },
      },
    })
    expect(external.isError).not.toBe(true)
    await expect.poll(history).toMatchObject({ revision: 4 })
    await expect(output()).toHaveValue('100.0000')
    await output().press('Enter')
    expect((await history()).revision).toBe(4)
    await activateButton(page.getByRole('button', { name: 'Reset Light', exact: true }))
    await expect
      .poll(history)
      .toMatchObject({ revision: 5, settings: { curves: identityToneCurves } })
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await expect.poll(history).toMatchObject({ revision: 6, settings: { curves: { green } } })
    const blue = Array.from({ length: 16 }, (_, i) => ({
      input: -16 + (i * 80) / 15,
      output: -16 + (i * 80) / 15,
    }))
    await page.evaluate(({ id, blue }) => window.irodori.updateEdits(id, { curves: { blue } }, 6), {
      id,
      blue,
    })
    await expect.poll(history).toMatchObject({ revision: 7 })
    await activateButton(
      page
        .getByRole('group', { name: 'Curve channel' })
        .getByRole('button', { name: 'Blue', exact: true }),
    )
    await activateButton(page.getByRole('button', { name: 'Point list (16/16)', exact: true }))
    await expect(page.getByRole('button', { name: /Off plot/ })).toHaveCount(15)
    await activateButton(page.getByRole('button', { name: /^16 ·/ }))
    await expect(
      page.getByRole('spinbutton', { name: 'Curve Input value', exact: true }),
    ).toHaveValue('6400.0000')
    await graph().evaluate((node) => node.scrollIntoView({ block: 'center' }))
    const limits = (await graph().boundingBox())!
    await page.mouse.click(limits.x + limits.width * 0.5, limits.y + limits.height * 0.5)
    await expect(page.getByRole('alert').filter({ hasText: '16 points' })).toBeVisible()
    expect((await history()).revision).toBe(7)
    const final = await history()
    ;({ page } = await irodori.restart())
    await expect.poll(history).toEqual(final)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
  } finally {
    await client.close()
    await transport.close()
  }
})

test('targeted tone clicks are no-ops; a captured drag freezes input, commits once and Escape restores it', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id)
  const toggle = page.getByRole('button', { name: 'Target tones on photo', exact: true })
  await expect(toggle).toBeEnabled()
  await activateButton(toggle)
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const viewport = page.getByTestId('preview-viewport'),
    box = (await viewport.boundingBox())!,
    x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.5
  const original = await history()
  await page.mouse.click(x, y)
  await expect(page.getByRole('status').filter({ hasText: 'Sample ' })).toBeVisible()
  expect(await history()).toEqual(original)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 30, { steps: 4 })
  await expect(page.getByTestId('curve-graph')).toHaveAttribute('data-point-count', '3')
  expect((await history()).revision).toBe(0)
  await page.mouse.up()
  await expect.poll(history).toMatchObject({ revision: 1 })
  const saved = await history(),
    point = saved.settings.curves.master[1]
  expect(point.output).toBeGreaterThan(point.input)
  await expect(toggle).toBeEnabled()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 30, { steps: 3 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await history()).toEqual(saved)
  expect(await viewport.evaluate((node) => node.hasPointerCapture(1))).toBe(false)
})

test('targeted RGB sampling reaches the uncropped source after crop, rotation, straighten, zoom and pan', async ({
  irodori: { app, page },
}) => {
  await importPhotos(app, page, ['tests/fixtures/photos/forest-light.jpg'], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await page.evaluate(
    ({ id, crop }) =>
      window.irodori.updateEdits(
        id,
        {
          crop,
          curves: {
            master: [
              { input: 0, output: 0 },
              { input: 0.2, output: 0.3 },
              { input: 1, output: 1 },
            ],
          },
        },
        0,
      ),
    { id, crop: { ...identityCrop, quarterTurns: 1 as const, angle: 12, width: 0.6, height: 0.6 } },
  )
  const viewport = page.getByTestId('preview-viewport'),
    canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  const context = await page.evaluate((id) => window.irodori.getCropContext(id, 1), id)
  await expect(viewport).toHaveAttribute('data-image-width', String(context.geometry.width))
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await page.getByRole('combobox', { name: 'Preview zoom', exact: true }).selectOption('2')
  await canvas.focus()
  await canvas.press('ArrowRight')
  await canvas.press('ArrowDown')
  await expect(viewport).not.toHaveAttribute('data-pan-x', '0')
  await expect(viewport).not.toHaveAttribute('data-pan-y', '0')
  await activateButton(
    page
      .getByRole('group', { name: 'Curve channel' })
      .getByRole('button', { name: 'Red', exact: true }),
  )
  await activateButton(page.getByRole('button', { name: 'Target tones on photo', exact: true }))
  const view = await viewport.evaluate((node) => ({
      scale: Number(node.getAttribute('data-scale')),
      x: Number(node.getAttribute('data-pan-x')),
      y: Number(node.getAttribute('data-pan-y')),
    })),
    box = (await viewport.boundingBox())!,
    geometry = context.geometry,
    u = 0.53,
    v = 0.46,
    x = box.x + box.width / 2 + view.x + (u - 0.5) * geometry.width * view.scale,
    y = box.y + box.height / 2 + view.y + (v - 0.5) * geometry.height * view.scale,
    matrix = geometry.outputToSource,
    source = {
      x:
        (matrix[0] * u * geometry.width + matrix[1] * v * geometry.height + matrix[4]) /
        geometry.source.width,
      y:
        (matrix[2] * u * geometry.width + matrix[3] * v * geometry.height + matrix[5]) /
        geometry.source.height,
    },
    expected = await page.evaluate(
      ({ id, source }) => window.irodori.sampleCurveTone(id, 1, { channel: 'red', ...source }),
      { id, source },
    )
  expect(x).toBeGreaterThan(box.x)
  expect(x).toBeLessThan(box.x + box.width)
  expect(y).toBeGreaterThan(box.y)
  expect(y).toBeLessThan(box.y + box.height)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y - 25, { steps: 3 })
  await expect(page.getByTestId('curve-graph')).toHaveAttribute('data-point-count', '3')
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate((id) => window.irodori.getEdits(id), id))
    .toMatchObject({ revision: 2 })
  const saved = await page.evaluate((id) => window.irodori.getEditHistory(id), id),
    point = saved.settings.curves.red.find((point) => point.input !== 0 && point.input !== 1)!
  expect(point.input).toBeCloseTo(expected.input, 12)
  expect(point.output).toBeGreaterThan(expected.output)
  expect(saved.snapshots).toHaveLength(3)
  expect(saved.settings.crop).toEqual(context.settings)
})
