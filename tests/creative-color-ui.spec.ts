import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { neutralColorMixer } from '../src/shared/color-mixer'
import type { EditState } from '../src/shared/edits'

test('hidden mixer and grading controls share MCP history and restore saved groups and workspace selection', async ({
  irodori,
}) => {
  test.setTimeout(60000)
  const source = test.info().outputPath('source', 'color.png')
  await mkdir(test.info().outputPath('source'))
  const original = await sharp({
    create: { width: 32, height: 24, channels: 4, background: { r: 62, g: 108, b: 179, alpha: 1 } },
  })
    .png()
    .toBuffer()
  await sharp(original).toFile(source)
  let { page } = irodori
  await importPhotos(irodori.app, page, [source], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    }),
    client = new Client({ name: 'irodori-creative-color-test', version: '1' })
  try {
    await client.connect(transport)
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).not.toBe(true)
      return result.structuredContent as unknown as EditState
    }
    const tools = (await client.listTools()).tools,
      update = tools.find((tool) => tool.name === 'irodori_update_edits')!
    expect(update.inputSchema.required).toEqual(['photoId', 'expectedRevision', 'patch'])
    expect(JSON.stringify(update.inputSchema)).toContain('colorMixer')
    expect(JSON.stringify(update.inputSchema)).toContain('colorGrading')
    expect(await call('irodori_get_edit_capabilities')).toEqual(
      await page.evaluate(() => window.irodori.getEditCapabilities()),
    )
    await activateButton(page.getByRole('button', { name: 'Color Mixer', exact: true }))
    await activateButton(
      page
        .getByRole('group', { name: 'Color mixer range' })
        .getByRole('button', { name: 'Blue', exact: true }),
    )
    const mixer = page.locator('#color-mixer-controls'),
      grade = page.locator('#color-grading-controls')
    const revision = async (value: number) =>
      expect
        .poll(async () => (await call('irodori_get_edits', { photoId: id })).revision)
        .toBe(value)
    await expect(mixer.getByRole('spinbutton', { name: 'Hue value', exact: true })).toBeEnabled()
    await mixer.getByRole('spinbutton', { name: 'Hue value', exact: true }).fill('-30')
    await mixer.getByRole('spinbutton', { name: 'Hue value', exact: true }).press('Enter')
    await revision(1)
    await activateButton(page.getByRole('button', { name: 'Color Grading', exact: true }))
    for (const [label, value, next] of [
      ['Hue', '32.5', 2],
      ['Saturation', '20', 3],
      ['Blending', '70', 4],
    ] as const) {
      const field = grade.getByRole('spinbutton', { name: `${label} value`, exact: true })
      await expect(field).toBeEnabled()
      await field.fill(value)
      await field.press('Enter')
      await revision(next)
    }
    const balance = grade.getByRole('spinbutton', { name: 'Balance value', exact: true })
    await balance.fill('-20')
    const committed = await call('irodori_update_edits', {
      photoId: id,
      expectedRevision: 4,
      patch: {
        colorMixer: { ranges: { blue: { luminance: 10 } } },
        colorGrading: { tones: { highlights: { hue: 30, saturation: 10 } }, balance: 12 },
      },
    })
    expect(committed).toMatchObject({
      revision: 5,
      settings: {
        colorMixer: { ranges: { blue: { hue: -30, saturation: 0, luminance: 10 } } },
        colorGrading: {
          tones: {
            midtones: { hue: 32.5, saturation: 20 },
            highlights: { hue: 30, saturation: 10 },
          },
          blending: 70,
          balance: 12,
        },
      },
    })
    await expect(balance).toHaveValue('12')
    await balance.press('Enter')
    await revision(5)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute(
      'data-color-mixer',
      JSON.stringify(committed.settings.colorMixer),
    )
    await expect(canvas).toHaveAttribute(
      'data-color-grading',
      JSON.stringify(committed.settings.colorGrading),
    )
    const invalid = await client.callTool({
      name: 'irodori_update_edits',
      arguments: {
        photoId: id,
        expectedRevision: 5,
        patch: { colorGrading: { tones: { midtones: { hue: 360 } } } },
      },
    })
    expect(invalid.isError).toBe(true)
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await revision(6)
    expect(
      (await call('irodori_redo_edit', { photoId: id, expectedRevision: 6 })).settings,
    ).toEqual(committed.settings)
    await revision(7)
    await expect(mixer.getByRole('button', { name: 'Reset color mixer' })).toBeEnabled()
    await activateButton(mixer.getByRole('button', { name: 'Reset color mixer' }))
    await revision(8)
    expect((await call('irodori_get_edits', { photoId: id })).settings).toMatchObject({
      colorMixer: neutralColorMixer,
      colorGrading: committed.settings.colorGrading,
    })
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await revision(9)
    await activateButton(
      page
        .getByRole('group', { name: 'Color grading tone' })
        .getByRole('button', { name: 'Highlights', exact: true }),
    )
    await expect(grade.getByRole('spinbutton', { name: 'Hue value', exact: true })).toHaveValue(
      '30.0',
    )
    await expect
      .poll(() => page.evaluate(() => window.irodori.getWorkspaceState()))
      .toMatchObject({ state: { creativeColor: { range: 'blue', tone: 'highlights' } } })
    const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
    ;({ page } = await irodori.restart())
    await expect(page.getByRole('button', { name: 'Color Mixer', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(page.getByRole('button', { name: 'Color Grading', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(
      page
        .getByRole('group', { name: 'Color mixer range' })
        .getByRole('button', { name: 'Blue', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page
        .locator('#color-grading-controls')
        .getByRole('spinbutton', { name: 'Hue value', exact: true }),
    ).toHaveValue('30.0')
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(history)
    expect(
      await readFile(join(irodori.userDataDir, 'library', 'originals', id, 'original.png')),
    ).toEqual(original)
  } finally {
    await client.close()
    await transport.close()
  }
})

test('grading wheel groups repeated keys and pointer moves, cancels capture and stays inside the compact inspector', async ({
  irodori: { app, page },
}) => {
  const source = test.info().outputPath('wheel.png')
  await sharp({
    create: { width: 24, height: 16, channels: 4, background: { r: 120, g: 100, b: 80, alpha: 1 } },
  })
    .png()
    .toFile(source)
  await importPhotos(app, page, [source], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
    grade = page.locator('#color-grading-controls'),
    wheel = grade.getByRole('slider', { name: 'Midtones color wheel' })
  await activateButton(page.getByRole('button', { name: 'Color Grading', exact: true }))
  await expect(wheel).toHaveAttribute('aria-disabled', 'false')
  await wheel.focus()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await expect(wheel).toHaveAttribute('aria-valuenow', '3')
  expect((await history()).revision).toBe(0)
  await page.keyboard.up('ArrowRight')
  await expect.poll(history).toMatchObject({
    revision: 1,
    settings: { colorGrading: { tones: { midtones: { hue: 3, saturation: 0 } } } },
  })
  await expect(wheel).toHaveAttribute('aria-disabled', 'false')
  await page.keyboard.down('ArrowUp')
  await expect(wheel).toHaveAttribute('aria-valuetext', '3.0 degrees, saturation 1')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowUp')
  await expect(wheel).toHaveAttribute('aria-valuetext', '3.0 degrees, saturation 0')
  expect((await history()).revision).toBe(1)
  await wheel.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const box = (await wheel.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7)
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
  expect((await history()).revision).toBe(1)
  await page.mouse.up()
  await expect.poll(history).toMatchObject({
    revision: 2,
    settings: { colorGrading: { tones: { midtones: { hue: 180, saturation: 42 } } } },
  })
  const saved = await history()
  expect(saved.snapshots).toHaveLength(3)
  await expect(wheel).toHaveAttribute('aria-disabled', 'false')
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await history()).toEqual(saved)
  await expect(wheel).toHaveAttribute('aria-valuenow', '180')
  await expect(grade.getByRole('spinbutton', { name: 'Hue value', exact: true })).toHaveValue(
    '180.0',
  )
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(page.getByTestId('console-toggle'))
  // Hidden Wayland windows do not provide Playwright's post-resize animation stability.
  // Scroll the real inspector directly and assert its native content-size bounds below.
  await wheel.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const pinned = await page.getByTestId('inspector-pinned').boundingBox(),
    bounds = (await wheel.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1100)
  expect(bounds.y).toBeGreaterThanOrEqual(pinned!.y + pinned!.height)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700)
  await activateButton(page.getByRole('button', { name: 'Color Grading', exact: true }))
  await activateButton(page.getByRole('button', { name: 'Color Grading', exact: true }))
  expect(await history()).toEqual(saved)
})
