import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { processingMetadata } from '../src/main/processing/metadata'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { identityCrop } from '../src/shared/crop'
import { fitCrop } from '../src/shared/crop'
import { noLensSettings, type ProcessingOptions } from '../src/shared/lens'
import { srgbTransform } from '../src/shared/adjustments'
import { FullPreviews } from '../src/main/full-previews'
import { workingAsset } from './export.helpers'

test('main and real stdio MCP read authoritative crop context without editing history or trusting catalog dimensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-context-')),
    bytes = await sharp({
      create: {
        width: 17,
        height: 13,
        channels: 4,
        background: { r: 73, g: 110, b: 152, alpha: 0.5 },
      },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer(),
    id = createHash('sha256').update(bytes).digest('hex'),
    args: ConstructorParameters<typeof PhotoLibrary> = [
      join(root, 'library'),
      {
        async process() {
          throw new Error('Unexpected import preparation.')
        },
        async close() {},
      },
      () => {},
    ]
  args[16] = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const library = new PhotoLibrary(...args),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        IRODORI_PROFILE: root,
        IRODORI_PREVIEW_BACKEND: 'cpu',
      },
    }),
    client = new Client({ name: 'crop-context-service', version: '1' })
  let endpoint: Awaited<ReturnType<typeof startEditorEndpoint>> | undefined
  try {
    await library.open()
    await mkdir(join(root, 'library', 'originals', id), { recursive: true })
    const path = join(root, 'library', 'originals', id, 'original.png')
    await writeFile(path, bytes)
    await library.catalogCommands.command({
      operation: 'original.publish',
      payload: {
        photo: {
          id,
          filename: 'Authored.png',
          format: 'PNG',
          width: 999,
          height: 777,
          bytes: bytes.length,
          importedAt: '2026-10-25T00:00:00.000Z',
          previewSource: 'image',
          thumbnailUrl: '',
          previewUrl: '',
        },
        processingIdentity: 'display-referred-v1',
        createdAt: '2026-10-25T00:00:00.000Z',
        metadata: processingMetadata({}, []),
      },
    })
    const history = await library.getEditHistory(id),
      direct = await library.getCropContext(id, 0)
    expect(direct.source).toEqual({ width: 13, height: 17 })
    expect(direct.settings).toEqual(identityCrop)
    expect(direct.geometry.identity).toBe(true)
    expect(JSON.stringify(direct)).not.toContain(root)
    expect(await library.getEditHistory(id)).toEqual(history)
    endpoint = await startEditorEndpoint(root, library)
    await client.connect(transport)
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === 'irodori_get_crop_context',
    )!
    expect(tool.inputSchema.required).toEqual(['photoId', 'expectedRevision'])
    expect(tool.inputSchema.additionalProperties).toBe(false)
    const result = await client.callTool({
      name: tool.name,
      arguments: { photoId: id, expectedRevision: 0 },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(direct)
    expect(await library.getEditHistory(id)).toEqual(history)
    await library.updateEdits(id, { saturation: 35 }, 0)
    const stale = await client.callTool({
      name: tool.name,
      arguments: { photoId: id, expectedRevision: 0 },
    })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('revision conflict')
    const updated = await client.callTool({
      name: tool.name,
      arguments: { photoId: id, expectedRevision: 1 },
    })
    expect(updated.isError).not.toBe(true)
    expect(updated.structuredContent).toMatchObject({ revision: 1, source: direct.source })
    const crop = fitCrop(direct.source, {
        ...identityCrop,
        quarterTurns: 1,
        angle: 9.87,
        width: 0.8,
        height: 0.8,
      }),
      accepted = await client.callTool({
        name: 'irodori_update_edits',
        arguments: {
          photoId: id,
          expectedRevision: 1,
          patch: { crop, exposureEv: 0.25 },
        },
      })
    expect(accepted.isError).not.toBe(true)
    expect(accepted.structuredContent).toMatchObject({
      revision: 2,
      settings: { crop, exposureEv: 0.25 },
    })
    expect((await library.getEditHistory(id)).snapshots).toHaveLength(3)
    const framed = await client.callTool({
      name: tool.name,
      arguments: { photoId: id, expectedRevision: 2 },
    })
    expect(framed.isError).not.toBe(true)
    expect(framed.structuredContent).toMatchObject({
      revision: 2,
      source: direct.source,
      settings: crop,
    })
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await client.close()
    await endpoint?.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('crop commit preflight validates the prepared proposed-lens dimensions without changing confirmed settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-proposed-crop-')),
    path = join(root, 'source.arw'),
    original = Buffer.from('Synthetic source: this check never invokes a RAW decoder.'),
    id = createHash('sha256').update(original).digest('hex'),
    options: ProcessingOptions = {
      processing: 'hdr-v1',
      metadata: processingMetadata({}, []),
      settings: { ...noLensSettings },
      revision: 0,
      crop: { ...identityCrop, aspectRatio: 1 },
    }
  await writeFile(path, original)
  let preparations = 0
  const previews = new FullPreviews(
    join(root, 'cache'),
    (candidate) => (candidate === id ? path : undefined),
    {
      async renderFull(_source, output, signal, selected) {
        signal.throwIfAborted()
        preparations++
        const width = selected!.settings.distortion ? 80 : 100,
          height = 100,
          data = new Float32Array(width * height * 4).fill(0.18)
        for (let index = 3; index < data.length; index += 4) data[index] = 1
        const bytes = Buffer.from(data.buffer),
          asset = workingAsset(bytes, width, height)
        await writeFile(join(output, 'linear.f32'), bytes)
        return {
          width,
          height,
          byteLength: 0,
          format: 'hdr-working',
          placeholderBytes: 0,
          sha256: asset.sha256,
          renderId: `synthetic-native-${width}`,
          settingsRevision: selected!.revision,
          linear: {
            byteLength: bytes.length,
            sha256: asset.sha256,
            hdr: asset,
            transform: srgbTransform,
          },
        }
      },
      async close() {},
    },
    undefined,
    async () => structuredClone(options),
  )
  try {
    await previews.open()
    const before = structuredClone(options)
    await expect(
      previews.validateCropEdit(id, 0, { ...identityCrop, version: 2 } as never),
    ).rejects.toThrow('Invalid crop settings')
    expect(preparations).toBe(0)
    expect(await previews.validateCropEdit(id, 0, options.crop!)).toMatchObject({
      width: 100,
      height: 100,
      source: { width: 100, height: 100 },
    })
    const proposedLens = { ...noLensSettings, distortion: true }
    await expect(previews.validateCropEdit(id, 0, options.crop!, proposedLens)).rejects.toThrow(
      'locked aspect ratio',
    )
    expect(preparations).toBe(2)
    const fitted = fitCrop({ width: 80, height: 100 }, options.crop!)
    expect(await previews.validateCropEdit(id, 0, fitted, proposedLens)).toMatchObject({
      width: 80,
      height: 80,
      source: { width: 80, height: 100 },
    })
    expect((await previews.getCropContext(id, 0)).source).toEqual({ width: 100, height: 100 })
    expect(preparations).toBe(2)
    expect(options).toEqual(before)
    expect(await readFile(path)).toEqual(original)
  } finally {
    await previews.close()
    await rm(root, { recursive: true, force: true })
  }
})
