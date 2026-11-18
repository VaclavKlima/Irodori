import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import type { PhotoDiagnosticsResult } from '../src/shared/photo-diagnostics'
import type { PreviewContext } from '../src/shared/inspection'
import type { AgentPresentationContext } from '../src/shared/agent-presentation'

test.use({ hdrDisplay: true })

test('real RAW and authored HDR provide regional diagnostics under their selected targets', async ({
  irodori: { app, page, userDataDir },
}, info) => {
  test.setTimeout(150000)
  const directory = info.outputPath('authored')
  await mkdir(directory, { recursive: true })
  const fixture = await hdrJpegFixture(directory)
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW', fixture.path], false, 'keyboard')
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
  const raw = photos.find(({ filename }) => filename === 'sony-zv1.ARW')!
  const authored = photos.find(({ filename }) => filename === 'authored-hdr.jpg')!
  const client = new Client({ name: 'native-photo-diagnostics', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('out/main/editor-mcp.js')],
    env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: userDataDir },
  })
  try {
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }),
      )
    const inspect = async (args: Record<string, unknown>) => {
      const reply = await call('irodori_get_photo_diagnostics', args)
      expect(reply.isError, JSON.stringify(reply.content).slice(0, 1200)).not.toBe(true)
      const result = reply.structuredContent as unknown as PhotoDiagnosticsResult
      expect(result.imagesUnavailable).toBeUndefined()
      expect(reply.content.filter((entry) => entry.type === 'image')).toHaveLength(
        result.images.length,
      )
      for (const image of reply.content) {
        if (image.type !== 'image') continue
        expect(image.mimeType).toBe('image/png')
        expect(await sharp(Buffer.from(image.data, 'base64')).metadata()).toMatchObject({
          width: result.bounds.width,
          height: result.bounds.height,
        })
      }
      return result
    }
    const photoContext = async (photoId: string) => {
      const context = await call('irodori_get_preview_context', { photoId, expectedRevision: 0 })
      expect(context.isError).not.toBe(true)
      return context.structuredContent as unknown as PreviewContext
    }

    // The flat bright neutral patch of the authored HDR fixture is 4× white.
    // Its preserved sRGB primary is gray code 240, so this patch has zero SDR clipping.
    const authoredContext = await photoContext(authored.id)
    const authoredArgs = { photoId: authored.id, expectedRevision: 0 }
    const patch = { x: 210, y: 5, width: 32, height: 60 }
    const fixed = await inspect({
      ...authoredArgs,
      target: 'sdr',
      region: { units: 'pixels', gridIdentity: authoredContext.gridIdentity, ...patch },
    })
    expect(fixed).toMatchObject({
      ...{ photoId: authored.id, revision: 0, bounds: patch, sourceDynamicRange: 'hdr' },
      target: { selection: 'sdr', mode: 'sdr' },
      clipping: { status: 'available', value: { counts: { highlights: 0, shadows: 0 } } },
      aboveWhite: { status: 'available', value: { count: 1920 } },
      histogram: { status: 'available', value: { statistics: { visiblePixels: 1920 } } },
    })
    expect(fixed.images.map(({ label }) => label)).toEqual(['clipping', 'above-white'])
    if (
      fixed.histogram.status !== 'available' ||
      fixed.histogram.value.statistics.dynamicRange !== 'sdr'
    )
      throw new Error('Expected the exact authored SDR primary histogram.')
    expect(fixed.histogram.value.statistics.rgb[0][240]).toBe(1920)

    const rawArgs = { photoId: raw.id, expectedRevision: 0 }
    const rawContext = await photoContext(raw.id)
    await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
    await page.evaluate(() => window.irodori.setPreviewPreference('hdr'))
    await expect
      .poll(
        async () => {
          const reply = await call('irodori_get_photo_presentation_context', rawArgs)
          const context = reply.structuredContent as unknown as AgentPresentationContext
          return context?.frame.status === 'presented' && context.frame.mode === 'hdr'
        },
        { timeout: 60000 },
      )
      .toBe(true)
    const context = (await call('irodori_get_photo_presentation_context', rawArgs))
      .structuredContent as unknown as AgentPresentationContext
    const generation = context.workspaceTarget.targetGeneration
    const bounds = { x: 3, y: 62, width: 130, height: 67 }
    const region = { units: 'pixels', gridIdentity: rawContext.gridIdentity, ...bounds }
    const current = await inspect({ ...rawArgs, region, targetGeneration: generation })
    expect(current).toMatchObject({
      photoId: raw.id,
      revision: 0,
      bounds,
      target: { selection: 'current', mode: 'hdr', generation },
      clipping: { status: 'available', value: { exact: true } },
      aboveWhite: { status: 'available', value: { exact: true } },
      histogram: { status: 'available', value: { statistics: { visiblePixels: 8710 } } },
    })
    expect(current.images.map(({ label }) => label)).toEqual(['clipping', 'above-white'])
    expect(
      (
        await call('irodori_get_photo_diagnostics', {
          ...rawArgs,
          region: { ...region, gridIdentity: 'stale' },
          targetGeneration: generation,
        })
      ).isError,
    ).toBe(true)
    expect(
      (
        await call('irodori_get_photo_diagnostics', {
          ...rawArgs,
          region,
          targetGeneration: generation + 1,
        })
      ).isError,
    ).toBe(true)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), raw.id)).toMatchObject({
      revision: 0,
    })
  } finally {
    await client.close()
    await transport.close()
  }
})
