import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { Page } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import type { EditState } from '../src/shared/edits'

async function photograph() {
  const source = test.info().outputPath('source', 'detail.png'),
    pixels = Buffer.alloc(19 * 17 * 4)
  for (let y = 0; y < 17; y++)
    for (let x = 0; x < 19; x++)
      pixels.set(
        [
          65 + ((x * 13 + y * 7) % 9) * 5,
          100 + ((x * 3 + y * 11) % 7) * 4,
          140 + ((x * 7 + y * 5) % 11) * 3,
          255,
        ],
        (y * 19 + x) * 4,
      )
  const original = await sharp(pixels, { raw: { width: 19, height: 17, channels: 4 } })
    .png()
    .toBuffer()
  await mkdir(test.info().outputPath('source'))
  await sharp(original).toFile(source)
  return { source, original }
}
async function image(page: Page) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toHaveCSS('visibility', 'visible')
  return canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement,
      dpr = devicePixelRatio || 1,
      width = Math.round(19 * dpr),
      height = Math.round(17 * dpr),
      x = Math.floor((canvas.width - width) / 2),
      y = Math.floor((canvas.height - height) / 2),
      gl = canvas.getContext('webgl2')
    let pixels: Uint8Array | Uint8ClampedArray
    if (gl) {
      pixels = new Uint8Array(width * height * 4)
      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    } else pixels = canvas.getContext('2d')!.getImageData(x, y, width, height).data
    return {
      pixels: [...pixels],
      width,
      height,
      x,
      boundary: canvas.width / 2,
      backend: gl ? 'webgl2' : 'canvas2d',
    }
  })
}

test('the hidden application shares detail UI/MCP history, shows original Before/Split pixels, cancels loading and restores edits', async ({
  irodori,
}) => {
  test.setTimeout(60000)
  const { source, original } = await photograph()
  let { page } = irodori
  await importPhotos(irodori.app, page, [source], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  await activateButton(page.getByRole('button', { name: 'Detail', exact: true }))
  const detail = page.locator('#detail-controls'),
    luminance = detail.getByRole('spinbutton', { name: 'Luminance noise value', exact: true }),
    radius = detail.getByRole('spinbutton', { name: 'Radius value', exact: true })
  await expect(luminance).toBeEnabled()
  const baseline = await image(page),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    }),
    client = new Client({ name: 'irodori-detail-test', version: '1' })
  const gate = await irodori.app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers,
      original = handlers.get('preview:comparison')!
    let armed = false,
      held = false,
      release: (() => void) | undefined
    const wrapper: Handler = async (...args) => {
      const result = await original(...args)
      if (armed) {
        armed = false
        held = true
        await new Promise<void>((done) => {
          release = done
        })
        held = false
      }
      return result
    }
    ipcMain.removeHandler('preview:comparison')
    ipcMain.handle('preview:comparison', wrapper)
    return {
      arm() {
        armed = true
      },
      held() {
        return held
      },
      release() {
        release?.()
      },
      close() {
        release?.()
        if (handlers.get('preview:comparison') === wrapper) {
          ipcMain.removeHandler('preview:comparison')
          ipcMain.handle('preview:comparison', original)
        }
      },
    }
  })
  try {
    await client.connect(transport)
    const call = async (name: string, args = {}) => {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError).not.toBe(true)
        return result.structuredContent as unknown as EditState
      },
      revision = (value: number) =>
        expect
          .poll(async () => (await call('irodori_get_edits', { photoId: id })).revision)
          .toBe(value)
    const schemas = (await client.listTools()).tools.find(
      (tool) => tool.name === 'irodori_update_edits',
    )!.inputSchema
    expect(JSON.stringify(schemas)).toContain('noiseReduction')
    expect(JSON.stringify(schemas)).toContain('detailSharpening')
    const capabilities = await page.evaluate(() => window.irodori.getEditCapabilities())
    expect(capabilities).toMatchObject({
      settingsVersion: 11,
      noiseReduction: { supported: true },
      detailSharpening: { supported: true },
    })
    await luminance.fill('65')
    await luminance.press('Enter')
    await revision(1)
    await expect(radius).toBeEnabled()
    await radius.fill('2.3')
    const edited = await call('irodori_update_edits', {
      photoId: id,
      expectedRevision: 1,
      patch: {
        noiseReduction: { chroma: 60 },
        detailSharpening: { amount: 45, radius: 1.7, threshold: 35 },
      },
    })
    expect(edited.settings).toMatchObject({
      noiseReduction: { luminance: 65, chroma: 60 },
      detailSharpening: { amount: 45, radius: 1.7, threshold: 35 },
    })
    await expect(radius).toHaveValue('1.7')
    await radius.press('Enter')
    await revision(2)
    await expect(luminance).toBeEnabled()
    const filtered = await image(page)
    expect(filtered.pixels).not.toEqual(baseline.pixels)
    const invalid = await client.callTool({
      name: 'irodori_update_edits',
      arguments: { photoId: id, expectedRevision: 2, patch: { detailSharpening: { radius: 3.1 } } },
    })
    expect(invalid.isError).toBe(true)
    await revision(2)
    await gate.evaluate((control) => control.arm())
    const before = page.getByRole('button', { name: 'Before', exact: true })
    await activateButton(before)
    await expect.poll(() => gate.evaluate((control) => control.held())).toBe(true)
    await expect(page.getByTestId('main-preview')).toHaveCSS('visibility', 'hidden')
    await expect(page.getByTestId('preview-resolution')).toContainText('Preparing comparison')
    await activateButton(page.getByRole('button', { name: 'Show After', exact: true }))
    await gate.evaluate((control) => control.release())
    expect((await image(page)).pixels).toEqual(filtered.pixels)
    await activateButton(before)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-comparison', 'before')
    const unfiltered = await image(page)
    expect(unfiltered.pixels).toEqual(baseline.pixels)
    const binding = JSON.parse(
      (await page.getByTestId('main-preview').getAttribute('data-spatial-comparison-binding'))!,
    )
    expect(binding[0]).not.toBe(binding[1])
    await activateButton(
      page.getByRole('button', { name: 'Compare before and after', exact: true }),
    )
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-comparison', 'split')
    const split = await image(page),
      expected = filtered.pixels.map((value, index) =>
        split.x + (Math.floor(index / 4) % split.width) + 0.5 < split.boundary
          ? baseline.pixels[index]
          : value,
      )
    expect(split.pixels).toEqual(expected)
    await activateButton(page.getByRole('button', { name: 'Undo', exact: true }))
    await revision(3)
    expect(
      (await call('irodori_redo_edit', { photoId: id, expectedRevision: 3 })).settings,
    ).toEqual(edited.settings)
    await revision(4)
    await expect
      .poll(() => page.evaluate(() => window.irodori.getWorkspaceState()))
      .toMatchObject({ state: { inspector: { detail: true } } })
    const history = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
    expect(history.snapshots).toHaveLength(3)
    await gate.evaluate((control) => control.close())
    ;({ page } = await irodori.restart())
    await expect(page.getByRole('button', { name: 'Detail', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(
      page
        .locator('#detail-controls')
        .getByRole('spinbutton', { name: 'Luminance noise value', exact: true }),
    ).toHaveValue('65')
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(history)
    expect((await image(page)).pixels).toEqual(filtered.pixels)
    expect(
      await readFile(join(irodori.userDataDir, 'library', 'originals', id, 'original.png')),
    ).toEqual(original)
  } finally {
    await gate.evaluate((control) => control.close()).catch(() => undefined)
    await client.close()
    await transport.close()
  }
})

test('detail keyboard gestures commit once, Escape cancels and controls remain accessible at minimum size with Console open', async ({
  irodori: { app, page },
}) => {
  const { source } = await photograph()
  await importPhotos(app, page, [source], true, 'keyboard')
  const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id)
  await (
    await app.browserWindow(page)
  ).evaluate((window) => {
    window.unmaximize()
    window.setContentSize(1100, 700)
  })
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
  await activateButton(page.getByTestId('console-toggle'))
  await activateButton(page.getByRole('button', { name: 'Detail', exact: true }))
  const detail = page.locator('#detail-controls'),
    slider = detail.getByRole('slider', { name: 'Luminance noise', exact: true })
  await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const box = (await slider.boundingBox())!,
    scroll = (await page.getByTestId('inspector-scroll').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(scroll.y)
  expect(box.y + box.height).toBeLessThanOrEqual(scroll.y + scroll.height)
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight')
  await expect(slider).toHaveValue('3')
  expect((await history()).snapshots).toHaveLength(1)
  await page.keyboard.up('ArrowRight')
  await expect
    .poll(history)
    .toMatchObject({ revision: 1, settings: { noiseReduction: { luminance: 3, chroma: 0 } } })
  await expect(slider).toBeEnabled()
  await slider.focus()
  await page.keyboard.down('ArrowRight')
  await expect(slider).toHaveValue('4')
  await page.keyboard.press('Escape')
  await page.keyboard.up('ArrowRight')
  await expect(slider).toHaveValue('3')
  expect((await history()).snapshots).toHaveLength(2)
  const radius = detail.getByRole('spinbutton', { name: 'Radius value', exact: true })
  await radius.fill('4')
  await radius.press('Enter')
  await expect(radius).toHaveValue('1.0')
  expect((await history()).revision).toBe(1)
  const pinned = await page.getByTestId('inspector-pinned').boundingBox()
  await page.getByTestId('inspector-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  expect(await page.getByTestId('inspector-pinned').boundingBox()).toEqual(pinned)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
