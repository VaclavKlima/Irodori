import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { foregroundTest } from './foreground'
import type { PhotoDiagnosticsResult } from '../src/shared/photo-diagnostics'
import type { PreviewContext } from '../src/shared/inspection'
import type { AgentPresentationContext } from '../src/shared/agent-presentation'

test.use({ hdrDisplay: true })

test('authored HDR JPEG exposes exact regional diagnostics for its preserved SDR primary', ({
  irodori,
}, info) => verifyDiagnostics(irodori, info, 'sdr'))
test(
  'real Sony RAW exposes exact regional diagnostics for the current HDR target',
  foregroundTest('The current HDR target requires an entered monitor with native headroom.'),
  ({ irodori }, info) => verifyDiagnostics(irodori, info, 'hdr'),
)

async function verifyDiagnostics(
  { app, page, userDataDir }: { app: ElectronApplication; page: Page; userDataDir: string },
  info: TestInfo,
  mode: 'sdr' | 'hdr',
) {
  test.setTimeout(150000)
  let source = 'tests/fixtures/sony-zv1.ARW'
  if (mode === 'sdr') {
    const directory = info.outputPath('authored')
    await mkdir(directory, { recursive: true })
    source = (await hdrJpegFixture(directory)).path
  }
  await importPhotos(app, page, [source], false, 'keyboard')
  const { id: photoId } = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
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

    const args = { photoId, expectedRevision: 0 }
    const preview = await photoContext(photoId)
    if (mode === 'sdr') {
      // The flat bright neutral patch of the authored HDR fixture is 4× white.
      // Its preserved sRGB primary is gray code 240, so this patch has zero SDR clipping.
      const patch = { x: 210, y: 5, width: 32, height: 60 }
      const fixed = await inspect({
        ...args,
        target: 'sdr',
        region: { units: 'pixels', gridIdentity: preview.gridIdentity, ...patch },
      })
      expect(fixed).toMatchObject({
        photoId,
        revision: 0,
        bounds: patch,
        sourceDynamicRange: 'hdr',
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
      return
    }

    await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
    await page.evaluate(() => window.irodori.setPreviewPreference('hdr'))
    await expect
      .poll(
        async () => {
          const reply = await call('irodori_get_photo_presentation_context', args)
          const context = reply.structuredContent as unknown as AgentPresentationContext
          return context?.frame
        },
        { timeout: 60000 },
      )
      .toMatchObject({ status: 'presented', mode: 'hdr' })
    const context = (await call('irodori_get_photo_presentation_context', args))
      .structuredContent as unknown as AgentPresentationContext
    const generation = context.workspaceTarget.targetGeneration
    const bounds = { x: 3, y: 62, width: 130, height: 67 }
    const region = { units: 'pixels', gridIdentity: preview.gridIdentity, ...bounds }
    const current = await inspect({ ...args, region, targetGeneration: generation })
    expect(current).toMatchObject({
      photoId,
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
          ...args,
          region: { ...region, gridIdentity: 'stale' },
          targetGeneration: generation,
        })
      ).isError,
    ).toBe(true)
    expect(
      (
        await call('irodori_get_photo_diagnostics', {
          ...args,
          region,
          targetGeneration: generation + 1,
        })
      ).isError,
    ).toBe(true)
    expect(await page.evaluate((id) => window.irodori.getEdits(id), photoId)).toMatchObject({
      revision: 0,
    })
  } finally {
    await client.close()
    await transport.close()
  }
}
