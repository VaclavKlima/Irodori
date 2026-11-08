import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import type { InspectionResult, PreviewContext } from '../src/shared/inspection'

type Block = { type: string; text?: string; data?: string; mimeType?: string }
for (const source of ['raster', 'raw', 'authored-hdr'] as const) {
  test(`${source}: native PNG regions and matched neutral pairs preserve full-frame filtering and geometry`, async ({
    irodori,
  }, info) => {
    test.setTimeout(300000)
    const { app, page } = irodori
    let path: string
    if (source === 'authored-hdr') {
      const directory = info.outputPath('authored')
      await mkdir(directory, { recursive: true })
      path = (await hdrJpegFixture(directory)).path
    } else
      path = resolve(
        source === 'raw' ? 'tests/fixtures/sony-zv1.ARW' : 'tests/fixtures/photos/alpine-lake.jpg',
      )
    await importPhotos(app, page, [path], false, 'keyboard')
    const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
    await page.evaluate(async (id) => {
      await window.irodori.updateEdits(
        id,
        {
          exposureEv: 0.5,
          curves: {
            master: [
              { input: 0, output: 0 },
              { input: 0.3, output: 0.4 },
              { input: 1, output: 1 },
            ],
          },
          crop: {
            ...{
              version: 1 as const,
              quarterTurns: 2 as const,
              angle: 0,
              centerX: 0.5,
              centerY: 0.5,
              width: 0.25,
              height: 0.25,
              aspectRatio: null,
            },
          },
          detailSharpening: { version: 1, amount: 20, radius: 1, threshold: 30 },
        },
        0,
      )
    }, photo.id)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/main/editor-mcp.js')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
    const client = new Client({ name: 'native-inspection-gpu-test', version: '1' })
    try {
      await client.connect(transport)
      const ctx = await client.callTool(
        {
          name: 'irodori_get_preview_context',
          arguments: { photoId: photo.id, expectedRevision: 1 },
        },
        undefined,
        { timeout: 240000 },
      )
      expect(ctx.isError, JSON.stringify(ctx.content)).not.toBe(true)
      const context = ctx.structuredContent as unknown as PreviewContext
      const request = async (inspection: Record<string, unknown>) => {
        const response = await client.callTool(
          {
            name: 'irodori_get_photo_preview',
            arguments: { photoId: photo.id, expectedRevision: 1, inspection },
          },
          undefined,
          { timeout: 240000 },
        )
        expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
        return {
          result: response.structuredContent as unknown as InspectionResult,
          blocks: response.content as Block[],
        }
      }
      const all = await request({ resolutionPercent: 100, encoding: { format: 'png' } })
      const full = all.blocks.find((b) => b.type === 'image')!
      expect(await sharp(Buffer.from(full.data!, 'base64')).metadata()).toMatchObject({
        format: 'png',
        width: context.width,
        height: context.height,
      })
      const region = {
        units: 'pixels',
        gridIdentity: context.gridIdentity,
        x: 3,
        y: 2,
        width: Math.min(128, context.width - 3),
        height: Math.min(96, context.height - 2),
      }
      const pair = await request({
        region,
        resolutionPercent: 100,
        encoding: { format: 'png' },
        comparison: 'pair',
      })
      expect(pair.result.members.map((m) => m.label)).toEqual(['before', 'after'])
      expect(
        pair.result.members.every(
          (m) => m.effectiveRendition === 'sdr' && m.native === 'photo-native',
        ),
      ).toBe(true)
      const blocks = pair.blocks.filter((b) => b.type === 'image')
      expect(blocks).toHaveLength(2)
      const expected = await sharp(Buffer.from(full.data!, 'base64'))
        .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
        .removeAlpha()
        .raw()
        .toBuffer()
      const after = await sharp(Buffer.from(blocks[1].data!, 'base64'))
        .removeAlpha()
        .raw()
        .toBuffer()
      expect(after.equals(expected)).toBe(true)
      expect(blocks[0].data).not.toBe(blocks[1].data)
      const compressed = await request({
        region,
        resolutionPercent: 50,
        encoding: { format: 'jpeg', quality: 13 },
      })
      expect(compressed.result.members[0]).toMatchObject({
        width: Math.round(region.width / 2),
        height: Math.round(region.height / 2),
        encoding: { quality: 13, lossless: false },
      })
      const hdr = await client.callTool({
        name: 'irodori_get_photo_preview',
        arguments: { photoId: photo.id, expectedRevision: 1, inspection: { hdr: true } },
      })
      expect(hdr.isError).toBe(true)
      // A 180-degree rotation preserves dimensions but invalidates all prior coordinates.
      await page.evaluate(
        (id) =>
          window.irodori.updateEdits(
            id,
            {
              crop: {
                version: 1,
                quarterTurns: 0,
                angle: 0,
                centerX: 0.5,
                centerY: 0.5,
                width: 0.25,
                height: 0.25,
                aspectRatio: null,
              },
            },
            1,
          ),
        photo.id,
      )
      const stale = await client.callTool(
        {
          name: 'irodori_get_photo_preview',
          arguments: { photoId: photo.id, expectedRevision: 2, inspection: { region } },
        },
        undefined,
        { timeout: 240000 },
      )
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toContain('grid changed')
    } finally {
      await client.close()
      await transport.close()
    }
  })
}

test('merge source regions retain mask coordinates, curves and denoise/sharpening context across ROI edges', async () => {
  const { mkdtemp, lstat, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { AgentPhotoPreviews } = await import('../src/main/agent/photo-previews')
  const { syntheticExportSource } = await import('./export.helpers')
  const { identity } = await import('../src/main/export/files')
  const { cropAdmission } = await import('./crop-frame.helpers')
  const { WorkScheduler } = await import('../src/main/work-scheduler')
  const { ExportProcess } = await import('../src/main/export/process')
  const { neutralMaskEdge, neutralMaskLight } = await import('../src/shared/masks')
  const { identityMaskGeometry } = await import('../src/shared/mask-geometry')
  const root = await mkdtemp(join(tmpdir(), 'irodori-inspection-merge-'))
  const source = await syntheticExportSource(root, 128, 96, (x, y) => [
    0.2 + (Math.sin(x * y) + 1) * 0.1,
    x < 64 ? 0.2 : 0.8,
    0.1 + y / 96,
  ])
  source.identity = identity(await lstat(source.path))
  source.processing.metadata.mergeMaster = {
    asset: source.processing.workingAsset!.hdr!,
    recipe: {} as import('../src/shared/merge').MergeRecipe,
  }
  // Exercise a terminal IPC payload above the pipe buffer size, as real RAW lens grids do.
  const mapping = {
    ...identityMaskGeometry(128, 96),
    correction: {
      width: 128,
      height: 96,
      left: 0,
      top: 0,
      distortion: Array.from({ length: 4096 }, (_, i) => 1 + Math.sin(i) * 1e-5),
    },
  }
  source.processing.workingAsset!.maskGeometry = mapping
  source.processing.workingAsset!.hdr!.maskGeometry = mapping
  expect(Buffer.byteLength(JSON.stringify(mapping))).toBeGreaterThan(65536)
  source.processing.crop = {
    version: 1,
    quarterTurns: 2,
    angle: 0,
    centerX: 0.5,
    centerY: 0.5,
    width: 0.75,
    height: 0.75,
    aspectRatio: null,
  }
  source.processing.adjustments = {
    ...source.processing.adjustments!,
    curves: {
      version: 1,
      master: [
        { input: 0, output: 0 },
        { input: 0.3, output: 0.45 },
        { input: 1, output: 1 },
      ],
      red: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
      green: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
      blue: [
        { input: 0, output: 0 },
        { input: 1, output: 1 },
      ],
    },
    localMasks: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Region light',
        enabled: true,
        inverted: false,
        head: null,
        edge: { ...neutralMaskEdge },
        light: { ...neutralMaskLight, exposureEv: 1 },
        strokes: [{ mode: 'add', radius: 0.25, feather: 0.5, points: [{ x: 0.4, y: 0.6 }] }],
      },
    ],
  }
  source.processing.noiseReduction = { version: 1, luminance: 10, chroma: 10 }
  source.processing.detailSharpening = { version: 1, amount: 30, radius: 1, threshold: 20 }
  const previews = new AgentPhotoPreviews(
    root,
    async () => source,
    async () => 4,
    async () => undefined,
    async () => cropAdmission(),
    new WorkScheduler(),
    new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js')),
  )
  try {
    const context = await previews.context(source.photo.id, 4)
    const full = await previews.inspect(source.photo.id, 4, {
      resolutionPercent: 100,
      encoding: { format: 'png' },
    })
    const region = {
      units: 'pixels' as const,
      gridIdentity: context.gridIdentity,
      x: 20,
      y: 19,
      width: 40,
      height: 31,
    }
    const pair = await previews.inspect(source.photo.id, 4, {
      region,
      resolutionPercent: 100,
      encoding: { format: 'png' },
      comparison: 'pair',
    })
    const expected = await sharp(Buffer.from(full.members[0].data, 'base64'))
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .removeAlpha()
      .raw()
      .toBuffer()
    const actual = await sharp(Buffer.from(pair.members[1].data, 'base64'))
      .removeAlpha()
      .raw()
      .toBuffer()
    expect(actual.equals(expected)).toBe(true)
    expect(pair.members[0].data).not.toEqual(pair.members[1].data)
    expect(pair.members[0].comparison).toBe('neutral rendition derived from current revision')
  } finally {
    await previews.close()
    await rm(root, { recursive: true, force: true })
  }
})
