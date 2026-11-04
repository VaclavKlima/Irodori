import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import {
  completedTask,
  acceptedExport,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'
import { defaultExportOptions } from '../src/shared/export'
import { identityCrop } from '../src/shared/crop'
import type { AgentPhotoPreview } from '../src/shared/agent'
import type { Photo } from '../src/shared/contracts'
import type { ManagedImageBytes } from '../src/shared/resource-policy'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
// Match the existing managed Codex/HTTP tool deadline; functional checks impose no speed gate.
const previewRequestOptions = { timeout: 120000 }

for (const source of ['raster', 'raw', 'authored-hdr'] as const) {
  test(`${source} preview is a bounded metadata-free edited SDR rendition with cache reuse and unchanged originals`, async ({
    irodori,
  }, info) => {
    test.setTimeout(240000)
    const { page, app } = irodori
    let path: string
    if (source === 'authored-hdr') {
      const directory = info.outputPath('authored-input')
      await mkdir(directory, { recursive: true })
      path = (await hdrJpegFixture(directory)).path
    } else
      path = resolve(
        source === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : 'tests/fixtures/photos/alpine-lake.jpg',
      )
    const original = hash(await readFile(path))
    await importPhotos(app, page, [path], false, 'keyboard')
    await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
    const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0] as Photo
    expect((await managedOriginalHashes(irodori.userDataDir, [photo]))[0].sha256).toBe(original)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/main/editor-mcp.js')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
    const client = new Client({ name: 'compact-preview-acceptance', version: '1' })
    try {
      await client.connect(transport)
      const preview = async (revision: number) => {
        const result = await client.callTool(
          {
            name: 'irodori_get_photo_preview',
            arguments: { photoId: photo.id, expectedRevision: revision },
          },
          undefined,
          previewRequestOptions,
        )
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        const blocks = result.content as {
          type: string
          mimeType?: string
          data?: string
          text?: string
        }[]
        const image = blocks.find((block) => block.type === 'image')!
        const metadata = result.structuredContent as unknown as Omit<AgentPhotoPreview, 'data'>
        expect(metadata).toMatchObject({
          photoId: photo.id,
          revision,
          colorSpace: 'srgb',
          rendition: 'sRGB SDR rendition',
          quality: 80,
          mimeType: 'image/jpeg',
        })
        const bytes = Buffer.from(image.data!, 'base64')
        expect(image.mimeType).toBe('image/jpeg')
        expect(bytes.length).toBe(metadata.byteLength)
        expect(bytes.length).toBeLessThanOrEqual(1024 * 1024)
        const tags = await sharp(bytes).metadata()
        expect(tags).toMatchObject({
          format: 'jpeg',
          width: metadata.width,
          height: metadata.height,
        })
        expect(Math.max(tags.width!, tags.height!)).toBeLessThanOrEqual(1024)
        expect(tags.exif).toBeUndefined()
        expect(tags.xmp).toBeUndefined()
        expect(tags.iptc).toBeUndefined()
        expect(tags.icc).toBeDefined()
        return { bytes, metadata }
      }
      const neutral = await preview(0)
      const cached = await preview(0)
      expect(cached.bytes).toEqual(neutral.bytes)
      expect(cached.metadata.renderingIdentity).toBe(neutral.metadata.renderingIdentity)
      const crop = { ...identityCrop, quarterTurns: 1 as const, width: 0.75, height: 0.5 }
      await page.evaluate(
        ({ id, crop }) =>
          window.irodori.updateEdits(id, { exposureEv: 0.5, saturation: 8, crop }, 0),
        { id: photo.id, crop },
      )
      const stale = await client.callTool({
        name: 'irodori_get_photo_preview',
        arguments: { photoId: photo.id, expectedRevision: 0 },
      })
      expect(stale.isError).toBe(true)
      const edited = await preview(1)
      expect(edited.metadata.renderingIdentity).not.toBe(neutral.metadata.renderingIdentity)
      expect(hash(edited.bytes)).not.toBe(hash(neutral.bytes))
      if (source === 'authored-hdr') expect(edited.metadata.width).toBeLessThanOrEqual(65)
      const destination = join(irodori.userDataDir, 'preview-reference')
      await mkdir(destination)
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, destination)
      const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
      const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), photo.id)
      const taskId = await page.evaluate(
        ({ preparationId, destinationId, options }) =>
          window.irodori.startExport({ preparationId, destinationId, action: 'custom', options }),
        {
          preparationId: preparation.id,
          destinationId: grant!.id,
          options: {
            ...defaultExportOptions,
            output: 'sdr' as const,
            quality: 80,
            metadata: 'none' as const,
            size: {
              mode: 'longest' as const,
              edge: 1024,
              allowEnlargement: false,
              method: 'lanczos3' as const,
            },
          },
        },
      )
      expect(await completedTask(page, taskId)).toMatchObject({
        status: 'completed',
        errorCount: 0,
      })
      const files = await readdir(destination)
      expect(files).toHaveLength(1)
      expect(await readFile(join(destination, files[0]))).toEqual(edited.bytes)
      const evidence = acceptedExport(irodori.userDataDir, taskId)
      if (source !== 'authored-hdr')
        expect(evidence.files[0].diagnostics?.sourcePreparation).toBe('preview-cache')
      expect((await managedOriginalHashes(irodori.userDataDir, [photo]))[0].sha256).toBe(original)
      expect(hash(await readFile(path))).toBe(original)
    } finally {
      await client.close()
      await transport.close()
    }
  })
}

test.describe('RAW preview memory inventory', () => {
  test.use({ hdrDisplay: true })
  test('two browsed RAW sources remain available to the agent within the unchanged 2 GiB GPU budget', async ({
    irodori,
  }, info) => {
    test.setTimeout(120000)
    const { page, app } = irodori
    await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
    await page.evaluate(async () => {
      await window.irodori.setResourceSettings({ version: 1, ramMiB: 4096, vramMiB: 2048 })
      await window.irodori.setPreviewPreference('sdr')
    })
    const paths = ['DSC03243.ARW', 'DSC03244.ARW'].map((filename) =>
      resolve('tests/fixtures/research-sony/originals', filename),
    )
    await importPhotos(app, page, paths, false, 'keyboard')
    const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
    const first = photos.find((photo) => photo.filename === 'DSC03243.ARW')!
    const second = photos.find((photo) => photo.filename === 'DSC03244.ARW')!
    const originals = await managedOriginalHashes(irodori.userDataDir, photos)
    const ready = async (filename: string) => {
      const canvas = page.getByTestId('main-preview')
      await expect(canvas).toHaveAttribute('aria-label', filename)
      await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr')
      await expect
        .poll(() =>
          canvas.evaluate(
            (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
          ),
        )
        .toBe(true)
    }
    await activateButton(page.getByTestId(`browse-photo-${first.id}`))
    await page.getByTestId('browse-grid').press('Enter')
    await ready(first.filename)
    await activateButton(
      page.getByRole('button', { name: 'Expand stack for DSC03243.ARW, 2 photos', exact: true }),
    )
    await activateButton(page.getByRole('button', { name: 'Select DSC03244.ARW', exact: true }))
    await ready(second.filename)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-source-cache-entries', '2')
    const history = await page.evaluate((id) => window.irodori.getEditHistory(id), second.id)
    const observer = await app.evaluateHandle(({ ipcMain }) => {
      let captured: ManagedImageBytes | undefined
      const reply = (_event: unknown, _token: string, bytes: ManagedImageBytes) => {
        captured = bytes
      }
      ipcMain.on('resources:image-reply', reply)
      return {
        read: () => captured,
        close: () => ipcMain.removeListener('resources:image-reply', reply),
      }
    })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/main/editor-mcp.js')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
    const client = new Client({ name: 'compact-preview-memory-regression', version: '1' })
    try {
      await client.connect(transport)
      const result = await client.callTool(
        {
          name: 'irodori_get_photo_preview',
          arguments: { photoId: second.id, expectedRevision: 0 },
        },
        undefined,
        previewRequestOptions,
      )
      const blocks = result.content as { type: string; data?: string; text?: string }[]
      expect(result.isError, blocks.find((block) => block.type === 'text')?.text).not.toBe(true)
      const bytes = Buffer.from(blocks.find((block) => block.type === 'image')!.data!, 'base64')
      const metadata = await sharp(bytes).metadata()
      expect(Math.max(metadata.width!, metadata.height!)).toBe(1024)
      expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024)
      const inventory = await observer.evaluate((value) => value.read())
      expect(inventory?.vramBytes).toBeGreaterThanOrEqual(
        Number(await page.getByTestId('main-preview').getAttribute('data-source-cache-gpu-bytes')),
      )
      expect(inventory?.vramBytes).toBeLessThanOrEqual(2 * 1024 ** 3)
      expect(await page.evaluate((id) => window.irodori.getEditHistory(id), second.id)).toEqual(
        history,
      )
      expect(await managedOriginalHashes(irodori.userDataDir, photos)).toEqual(originals)
      expect((await page.evaluate(() => window.irodori.getResourceSettings())).settings).toEqual({
        version: 1,
        ramMiB: 4096,
        vramMiB: 2048,
      })
      await writeFile(
        info.outputPath('preview-memory-regression.json'),
        JSON.stringify(
          {
            photoId: second.id,
            inventory,
            width: metadata.width,
            height: metadata.height,
            bytes: bytes.byteLength,
            originals,
          },
          null,
          2,
        ),
      )
    } finally {
      await observer.evaluate((value) => value.close())
      await observer.dispose()
      await client.close()
      await transport.close()
    }
  })
})
