import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import type { PreviewContext } from '../src/shared/inspection'
import type {
  EditComparisonSession,
  EditComparisonInspectionResult,
} from '../src/shared/edit-comparisons'

type ImageBlock = { type: string; data?: string }
for (const fixture of [
  { name: 'photographic raster', path: 'tests/fixtures/photos/alpine-lake.jpg' },
  { name: 'Sony RAW', path: 'tests/fixtures/sony-zv1.ARW' },
])
  test(`${fixture.name}: named native regions reproduce their saved denoise/detail/local-mask passes instead of Current`, async ({
    irodori,
  }, info) => {
    test.setTimeout(300000)
    const { app, page } = irodori
    const defaults = await page.evaluate(() => window.irodori.getResourceSettings())
    // Full-source RAW Texture keeps its normal admission gates under a recorded test budget.
    if (fixture.name === 'Sony RAW')
      await page.evaluate(
        (settings) => window.irodori.setResourceSettings({ ...settings, vramMiB: 4096 }),
        defaults.settings,
      )
    const qualification = await page.evaluate(() => window.irodori.getResourceSettings())
    await importPhotos(app, page, [resolve(fixture.path)], true, 'keyboard')
    const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/main/editor-mcp.js')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
    const client = new Client({ name: 'checkpoint-photographic', version: '1' })
    try {
      await client.connect(transport)
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: 240000,
        })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        return result
      }
      const first = await page.evaluate(async (id) => {
        const current = await window.irodori.getEdits(id)
        const adjusted = await window.irodori.updateEdits(
          id,
          {
            exposureEv: 0.2,
            noiseReduction: { luminance: 8, chroma: 12 },
            detailSharpening: { amount: 15, radius: 1, threshold: 2 },
          },
          current.revision,
        )
        const maskId = crypto.randomUUID()
        const masked = await window.irodori.mutateMasks(id, adjusted.revision, {
          operations: [
            {
              kind: 'create',
              id: maskId,
              name: 'Subject',
              gradient: {
                kind: 'radial',
                center: { x: 0.5, y: 0.5 },
                radiusX: 0.3,
                radiusY: 0.35,
                rotation: 0,
                feather: 50,
              },
            },
            { kind: 'update', id: maskId, light: { exposureEv: 0.2 }, color: { saturation: 4 } },
          ],
        })
        const checkpoint = await window.irodori.createEditCheckpoint({
          photoId: id,
          name: 'Natural',
          expectedRevision: masked.revision,
        })
        return { revision: masked.revision, checkpoint, maskId }
      }, photo.id)
      const context = (
        await call('irodori_get_preview_context', {
          photoId: photo.id,
          expectedRevision: first.revision,
        })
      ).structuredContent as unknown as PreviewContext
      const inspection = {
        region: {
          units: 'pixels',
          gridIdentity: context.gridIdentity,
          x: Math.floor(context.width * 0.5),
          y: Math.floor(context.height * 0.5),
          width: Math.min(96, Math.floor(context.width * 0.2)),
          height: Math.min(80, Math.floor(context.height * 0.2)),
        },
        resolutionPercent: 100,
        encoding: { format: 'png' },
      }
      const image = (result: Awaited<ReturnType<typeof call>>) =>
        (result.content as ImageBlock[]).find((block) => block.type === 'image')!.data!
      const naturalPng = image(
        await call('irodori_get_photo_preview', {
          photoId: photo.id,
          expectedRevision: first.revision,
          inspection,
        }),
      )
      const second = await page.evaluate(
        async ({ id, maskId, revision }) => {
          const adjusted = await window.irodori.updateEdits(
            id,
            {
              exposureEv: 0.8,
              contrast: 15,
              noiseReduction: { luminance: 18, chroma: 22 },
              detailSharpening: { amount: 45, radius: 1.5, threshold: 4 },
            },
            revision,
          )
          const masked = await window.irodori.mutateMasks(id, adjusted.revision, {
            operations: [
              {
                kind: 'update',
                id: maskId,
                light: { exposureEv: 0.65 },
                color: { saturation: 15 },
                texture: 12,
              },
            ],
          })
          const checkpoint = await window.irodori.createEditCheckpoint({
            photoId: id,
            name: 'Stronger',
            expectedRevision: masked.revision,
          })
          return { revision: masked.revision, checkpoint }
        },
        { id: photo.id, maskId: first.maskId, revision: first.revision },
      )
      const strongerPng = image(
        await call('irodori_get_photo_preview', {
          photoId: photo.id,
          expectedRevision: second.revision,
          inspection,
        }),
      )
      expect(naturalPng).not.toBe(strongerPng)
      await page.evaluate(
        async ({ id, revision }) => {
          await window.irodori.updateEdits(id, { exposureEv: -0.7, contrast: -10 }, revision)
        },
        { id: photo.id, revision: second.revision },
      )
      const history = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
      const prepared = await call('irodori_prepare_edit_comparison', {
        photoId: photo.id,
        baseline: {
          kind: 'checkpoint',
          checkpointId: first.checkpoint.id,
          expectedCheckpointRevision: 1,
        },
        target: {
          kind: 'checkpoint',
          checkpointId: second.checkpoint.id,
          expectedCheckpointRevision: 1,
        },
      })
      const session = prepared.structuredContent as unknown as EditComparisonSession
      try {
        expect(session.context.gridIdentity).toBe(context.gridIdentity)
        const pair = await call('irodori_get_edit_comparison_preview', {
          photoId: photo.id,
          comparisonId: session.id,
          inspection,
        })
        const blocks = (pair.content as ImageBlock[]).filter((block) => block.type === 'image')
        const metadata = pair.structuredContent as unknown as EditComparisonInspectionResult
        expect(blocks).toHaveLength(2)
        for (let index = 0; index < 2; index++) {
          const expected = await sharp(
            Buffer.from(index === 0 ? naturalPng : strongerPng, 'base64'),
          )
            .raw()
            .toBuffer()
          const actual = await sharp(Buffer.from(blocks[index].data!, 'base64')).raw().toBuffer()
          expect(actual.equals(expected)).toBe(true)
          expect(metadata.members[index]).toMatchObject({
            label: index === 0 ? 'a' : 'b',
            revision: index === 0 ? first.revision : second.revision,
            native: 'photo-native',
            effectiveRendition: 'sdr',
            width: inspection.region.width,
            height: inspection.region.height,
            photoBounds: {
              x: inspection.region.x,
              y: inspection.region.y,
              width: inspection.region.width,
              height: inspection.region.height,
            },
          })
          expect(metadata.members[index].version.source).toMatchObject({
            kind: 'checkpoint',
            checkpointId: index === 0 ? first.checkpoint.id : second.checkpoint.id,
          })
        }
        expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)).toEqual(
          history,
        )
      } finally {
        await call('irodori_dispose_edit_comparison', {
          photoId: photo.id,
          comparisonId: session.id,
        })
      }
    } finally {
      const policyPath = info.outputPath('checkpoint-resource-policy.json')
      await writeFile(
        policyPath,
        JSON.stringify(
          {
            defaults,
            qualification,
            completed: await page
              .evaluate(() => window.irodori.getResourceSettings())
              .catch(String),
          },
          null,
          2,
        ),
      )
      await info.attach('checkpoint-resource-policy', {
        path: policyPath,
        contentType: 'application/json',
      })
      await client.close()
      await transport.close()
    }
  })
