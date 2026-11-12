import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import type { PreviewContext } from '../src/shared/inspection'
import type { MaskPreviewResult } from '../src/shared/mask-preview'
import type { Page } from '@playwright/test'

async function presentedPhoto(page: Page, photoId: string, filename: string, revision: number) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('aria-label', filename)
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 120000 })
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', String(revision), {
    timeout: 120000,
  })
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full', {
    timeout: 120000,
  })
  await expect(canvas).toBeVisible()
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ photoId, revision }) => {
            const context = await window.irodori.getPhotoPresentationContext({
              photoId,
              expectedRevision: revision,
            })
            const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
            return (
              context.frame.status === 'presented' &&
              !!canvas &&
              (!canvas.dataset.requestedSerial ||
                canvas.dataset.requestedSerial === canvas.dataset.completedEditSerial)
            )
          },
          { photoId, revision },
        ),
      { timeout: 120000 },
    )
    .toBe(true)
}

async function persistedPhotoView(page: Page, photoId: string) {
  // The saved owner must acknowledge this exact presented view, including crop-driven fit.
  await expect
    .poll(
      () =>
        page.getByTestId('preview-viewport').evaluate(async (viewport, photoId) => {
          const workspace = await window.irodori.getWorkspaceState()
          const preview = workspace.state?.preview
          const scale = Number(viewport.dataset.scale)
          const width = Number(viewport.dataset.imageWidth),
            height = Number(viewport.dataset.imageHeight)
          const centerX = Math.max(
            0,
            Math.min(1, 0.5 - Number(viewport.dataset.panX) / (scale * width)),
          )
          const centerY = Math.max(
            0,
            Math.min(1, 0.5 - Number(viewport.dataset.panY) / (scale * height)),
          )
          return (
            workspace.state?.activeId === photoId &&
            workspace.selected.some((photo) => photo.id === photoId) &&
            preview?.photoId === photoId &&
            preview.fit === (viewport.dataset.mode === 'fit') &&
            preview.scale === scale &&
            preview.centerX === centerX &&
            preview.centerY === centerY
          )
        }, photoId),
      { timeout: 15000 },
    )
    .toBe(true)
}

for (const source of ['raster', 'raw', 'merged-hdr'] as const)
  test(`${source}: existing mask inspection preserves confirmed edits and workspace through real source/worker/MCP owners`, async ({
    irodori,
  }) => {
    test.setTimeout(source === 'merged-hdr' ? 360000 : 180000)
    const { app, page } = irodori
    const paths =
      source === 'merged-hdr'
        ? [277, 278, 279].map((number) =>
            resolve(
              `assets/tests/images/raw/sony-zv-1a/forest-bracket/originals/DSC03${number}.ARW`,
            ),
          )
        : [
            resolve(
              source === 'raw'
                ? 'tests/fixtures/sony-zv1.ARW'
                : 'tests/fixtures/photos/alpine-lake.jpg',
            ),
          ]
    await importPhotos(app, page, paths, false, 'keyboard')
    let photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
    if (source === 'merged-hdr') {
      const review = await page.evaluate(
        (ids) => window.irodori.createMergeReview(ids, 'hdr'),
        photos.map((photo) => photo.id),
      )
      await page.evaluate(
        (review) => window.irodori.requestMergePreview(review.id, review.revision),
        review,
      )
      const taskId = await page.evaluate(
        (review) => window.irodori.startMerge(review.id, review.revision),
        review,
      )
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.irodori.listTasks())).find(
              (task) => task.id === taskId,
            )?.status,
          { timeout: 240000 },
        )
        .toBe('completed')
      photos = (await page.evaluate(() => window.irodori.listPhotos())).photos
    }
    const photo =
      source === 'merged-hdr' ? photos.find((photo) => photo.assetKind === 'derived')! : photos[0]
    expect(photo).toBeTruthy()
    const initial = await page.evaluate((id) => window.irodori.getEdits(id), photo.id)
    await presentedPhoto(page, photo.id, photo.filename, initial.revision)
    const maskId = randomUUID()
    const cropped = await page.evaluate(
      ({ photoId, revision }) =>
        window.irodori.updateEdits(
          photoId,
          {
            crop: {
              version: 1,
              quarterTurns: 2,
              angle: 0,
              centerX: 0.5,
              centerY: 0.5,
              width: 0.5,
              height: 0.5,
              aspectRatio: null,
            },
          },
          revision,
        ),
      { photoId: photo.id, revision: initial.revision },
    )
    await presentedPhoto(page, photo.id, photo.filename, cropped.revision)
    const state = await page.evaluate(
      ({ photoId, maskId, range, revision }) =>
        window.irodori.mutateMasks(photoId, revision, {
          operations: [
            {
              kind: 'create',
              id: maskId,
              name: 'Read-only inspection',
              ...(range
                ? {
                    range: {
                      version: 1 as const,
                      kind: 'luminance' as const,
                      lower: 35,
                      upper: null,
                      softness: 25,
                    },
                  }
                : {
                    gradient: {
                      kind: 'linear' as const,
                      start: { x: 0.2, y: 0.3 },
                      end: { x: 0.8, y: 0.7 },
                    },
                  }),
            },
            {
              kind: 'update',
              id: maskId,
              enabled: false,
              ...(range ? { edge: { featherPx: 1, shiftPx: 0 } } : {}),
            },
          ],
        }),
      { photoId: photo.id, maskId, range: source === 'merged-hdr', revision: cropped.revision },
    )
    await presentedPhoto(page, photo.id, photo.filename, state.revision)
    await persistedPhotoView(page, photo.id)
    const client = new Client({ name: 'mask-preview-real-source', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/main/editor-mcp.js')],
      env: { ...(process.env as Record<string, string>), IRODORI_PROFILE: irodori.userDataDir },
    })
    try {
      await client.connect(transport)
      const ctx = await client.callTool(
        {
          name: 'irodori_get_preview_context',
          arguments: { photoId: photo.id, expectedRevision: state.revision },
        },
        undefined,
        { timeout: 120000 },
      )
      expect(ctx.isError, JSON.stringify(ctx.content)).not.toBe(true)
      const context = ctx.structuredContent as unknown as PreviewContext
      const before = await page.evaluate(
        async (photoId) => ({
          edits: await window.irodori.getEdits(photoId),
          history: await window.irodori.getEditHistory(photoId),
          workspace: await window.irodori.getWorkspaceState(),
        }),
        photo.id,
      )
      const region = {
        units: 'pixels',
        gridIdentity: context.gridIdentity,
        x: Math.floor(context.width / 2) - 32,
        y: Math.floor(context.height / 2) - 24,
        width: 64,
        height: 48,
      }
      const result = await client.callTool(
        {
          name: 'irodori_get_mask_preview',
          arguments: {
            photoId: photo.id,
            expectedRevision: state.revision,
            maskId,
            inspection: { region, resolutionPercent: 100 },
          },
        },
        undefined,
        { timeout: 180000 },
      )
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const metadata = result.structuredContent as unknown as MaskPreviewResult
      expect(metadata).toMatchObject({
        photoId: photo.id,
        revision: state.revision,
        maskId,
        enabled: false,
        adjustmentsNeutral: true,
        coverageSemantics: 'stored-mask-shape',
      })
      expect(metadata.members.map((member) => member.label)).toEqual(['coverage', 'overlay'])
      const images = (result.content as { type: string; data?: string }[]).filter(
        (block) => block.type === 'image',
      )
      expect(images).toHaveLength(2)
      for (const image of images)
        expect(await sharp(Buffer.from(image.data!, 'base64')).metadata()).toMatchObject({
          format: 'png',
          width: 64,
          height: 48,
        })
      expect(metadata.members[1]).toMatchObject({
        sourceDynamicRange: source === 'raster' ? 'sdr' : 'hdr',
        rendition: 'sRGB SDR mask overlay',
        encoding: { format: 'png', lossless: true },
      })
      const after = await page.evaluate(
        async (photoId) => ({
          edits: await window.irodori.getEdits(photoId),
          history: await window.irodori.getEditHistory(photoId),
          workspace: await window.irodori.getWorkspaceState(),
        }),
        photo.id,
      )
      expect(after).toEqual(before)
      expect(await readdir(join(irodori.userDataDir, 'library', 'cache', 'mask-previews'))).toEqual(
        [],
      )
      const updated = await page.evaluate(
        ({ photoId, revision }) =>
          window.irodori.updateEdits(photoId, { exposureEv: 0.1 }, revision),
        { photoId: photo.id, revision: state.revision },
      )
      expect(updated.revision).toBe(state.revision + 1)
      const stale = await client.callTool({
        name: 'irodori_get_mask_preview',
        arguments: {
          photoId: photo.id,
          expectedRevision: state.revision,
          maskId,
          view: 'coverage',
        },
      })
      expect(stale.isError).toBe(true)
    } finally {
      await client.close()
      await transport.close()
    }
  })
