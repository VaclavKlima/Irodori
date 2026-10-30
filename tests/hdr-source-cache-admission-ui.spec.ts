import type { ElectronApplication, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { HdrPreview } from '../src/shared/contracts'
import type { ManagedImageBytes } from '../src/shared/resource-policy'
import { HDR_BITMAP_RESERVATION } from '../src/renderer/src/preview/hdr-memory'
import { expect, test } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'

test.use({ hdrDisplay: true })
test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'Requires native Linux RAW preparation.',
)

const filenames = ['DSC03243.ARW', 'DSC03244.ARW', 'DSC03245.ARW']
const paths = filenames.map((name) => `tests/fixtures/research-sony/originals/${name}`)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

async function observeRequests(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const channel = 'preview:hdr',
      original = handlers.get(channel)!
    const requests: {
      photoId: string
      requestId: string
      reservation: ManagedImageBytes
      reply?: { preview?: HdrPreview | null; error?: string }
    }[] = []
    const wrapped: Handler = async (...args) => {
      const request = {
        photoId: args[1] as string,
        requestId: args[2] as string,
        reservation: structuredClone(args[6] as ManagedImageBytes),
      } as (typeof requests)[number]
      requests.push(request)
      request.reply = (await original(...args)) as NonNullable<typeof request.reply>
      return request.reply
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, wrapped)
    return {
      read: () => requests,
      close: () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, original)
      },
    }
  })
}

async function ready(page: Page, filename: string) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('aria-label', filename)
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
      ),
    )
    .toBe(true)
  await expect(page.getByText('Could not load this preview.', { exact: true })).toHaveCount(0)
  return canvas.evaluate((element) => ({
    requestId: element.dataset.previewRequestId!,
    cache: element.dataset.sourceCache,
    source: element.dataset.presentedSourceIdentity,
    entries: Number(element.dataset.sourceCacheEntries),
    sourceRamBytes: Number(element.dataset.sourceCacheRamBytes),
  }))
}

test('three real RAW sources release an inactive slot before preparation and preserve cached revisits', async ({
  irodori,
}, info) => {
  test.setTimeout(180000)
  const { app, page } = irodori
  const native = await app.browserWindow(page)
  await native.evaluate((window) => window.setContentSize(1100, 700))
  await activateButton(
    page
      .getByRole('navigation', { name: 'Workspaces' })
      .getByRole('button', { name: 'Library', exact: true }),
  )
  await page.evaluate(async () => {
    await window.irodori.setResourceSettings({ version: 1, ramMiB: 4096, vramMiB: 1900 })
    await window.irodori.setPreviewPreference('sdr')
  })
  const manifest = JSON.parse(
    await readFile('tests/fixtures/research-sony/manifest.json', 'utf8'),
  ) as {
    files: { name: string; sha256: string }[]
  }
  const hashes = await Promise.all(paths.map(hash))
  expect(new Set(hashes).size).toBe(3)
  expect(hashes).toEqual(
    filenames.map((name) => manifest.files.find((file) => file.name === name)!.sha256),
  )
  const observer = await observeRequests(app)
  const visits: Awaited<ReturnType<typeof ready>>[] = []
  try {
    await importPhotos(app, page, paths, false, 'keyboard')
    expect(await observer.evaluate((observer) => observer.read())).toEqual([])
    const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
    const first = photos.find((photo) => photo.filename === filenames[0])!
    await activateButton(page.getByTestId(`browse-photo-${first.id}`))
    await page.getByTestId('browse-grid').press('Enter')
    visits.push(await ready(page, filenames[0]))
    await activateButton(
      page.getByRole('button', { name: 'Expand stack for DSC03243.ARW, 3 photos', exact: true }),
    )
    for (const index of [1, 2, 1, 0, 2]) {
      await activateButton(
        page.getByRole('button', { name: `Select ${filenames[index]}`, exact: true }),
      )
      visits.push(await ready(page, filenames[index]))
      const diagnostics = await page.evaluate(() => window.irodori.getPreviewDiagnostics())
      expect(diagnostics.loadingStage).toBe('prepared')
      expect(diagnostics.preparationBackend).toBe('gpu')
      if (visits.length <= 3) expect(diagnostics.timings.workerNativeRawSourceMs).toBeGreaterThan(0)
    }
    const requests = await observer.evaluate((observer) => observer.read())
    const completed = visits.map((visit) =>
      requests.find((request) => request.requestId === visit.requestId)!,
    )
    for (const request of completed) {
      expect(request).toBeDefined()
      expect(request.reply?.error).toBeUndefined()
      expect(request.reply?.preview?.format).toBe('hdr-working')
    }
    expect(visits.map((visit) => visit.entries)).toEqual([1, 2, 2, 2, 2, 2])
    const singleSourceRam = visits[0].sourceRamBytes
    expect(singleSourceRam).toBeGreaterThan(0)
    // RAM counters isolate actual cached sample ownership from varying presentation textures.
    expect(completed[2].reservation.ramBytes).toBe(
      HDR_BITMAP_RESERVATION.ramBytes + singleSourceRam,
    )
    expect(completed[3].reservation.ramBytes).toBe(
      HDR_BITMAP_RESERVATION.ramBytes + visits[2].sourceRamBytes,
    )
    expect(visits[3].cache).toBe('hit')
    expect(visits[3].source).toBe(visits[1].source)
    expect(visits[4].source).toBe(visits[0].source)
    expect(visits[5].source).toBe(visits[2].source)
  } finally {
    await writeFile(
      info.outputPath('raw-source-admission.json'),
      JSON.stringify(
        { hashes, visits, requests: await observer.evaluate((observer) => observer.read()) },
        null,
        2,
      ),
    )
    await observer.evaluate((observer) => observer.close())
    await observer.dispose()
    expect(await Promise.all(paths.map(hash))).toEqual(hashes)
  }
})
