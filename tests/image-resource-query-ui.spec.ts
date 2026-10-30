import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { build } from 'esbuild'
import sharp from 'sharp'

test('the production preload returns a fresh, path-free renderer inventory in an isolated hidden profile', async ({
  irodori,
}) => {
  const source = test.info().outputPath('resource-source.png')
  await sharp({
    create: {
      width: 128,
      height: 96,
      channels: 4,
      background: { r: 73, g: 110, b: 152, alpha: 1 },
    },
  })
    .png()
    .toFile(source)
  await importPhotos(irodori.app, irodori.page, [source])
  await expect(
    irodori.page.getByRole('spinbutton', { name: 'Exposure value', exact: true }),
  ).toBeEnabled()
  const bytes = await irodori.app.evaluate(({ BrowserWindow, ipcMain }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents,
      token = 'isolated-resource-query'
    return new Promise<{ ramBytes: number; vramBytes: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('resources:image-reply', reply)
        reject(new Error('No production image inventory reply.'))
      }, 5000)
      const reply = (
        event: Electron.IpcMainEvent,
        returned: string,
        value: { ramBytes: number; vramBytes: number },
        error?: string,
      ) => {
        if (
          event.sender !== contents ||
          event.senderFrame !== contents.mainFrame ||
          returned !== token
        )
          return
        clearTimeout(timer)
        ipcMain.removeListener('resources:image-reply', reply)
        if (error) reject(new Error(error))
        else resolve(value)
      }
      ipcMain.on('resources:image-reply', reply)
      contents.send('resources:image-query', token)
    })
  })
  expect(Object.keys(bytes).sort()).toEqual(['ramBytes', 'vramBytes'])
  expect(Number.isSafeInteger(bytes.ramBytes)).toBe(true)
  expect(Number.isSafeInteger(bytes.vramBytes)).toBe(true)
  expect(bytes.ramBytes).toBeGreaterThan(128 * 96 * 16)
  expect(bytes.vramBytes).toBeGreaterThan(0)
})

test('a failed raster presenter constructor does not leave a phantom resource owner', async ({
  irodori: { page },
}) => {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
  })
  const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())!
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'ts',
      contents: `
import {PreviewPresenter} from './src/renderer/src/preview/presenter';
import {imageResourceOwners} from './src/renderer/src/preview/image-resource-owners';
const before=imageResourceOwners.snapshot();let failed=false;
try {new PreviewPresenter({getContext:()=>null,dataset:{}},true,()=>{})} catch {failed=true}
window.resourceFixture={before,after:imageResourceOwners.snapshot(),failed};
`,
    },
    bundle: true,
    format: 'iife',
    write: false,
  })
  await frame.evaluate(bundle.outputFiles[0].text)
  expect(
    await frame.evaluate(() => (window as unknown as { resourceFixture: unknown }).resourceFixture),
  ).toEqual({
    before: { ramBytes: 0, vramBytes: 0 },
    after: { ramBytes: 0, vramBytes: 0 },
    failed: true,
  })
})
