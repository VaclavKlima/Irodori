import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import {
  acceptedExport,
  completedTask,
  inspectAcceptedJpeg,
} from './professional-editing-acceptance.helpers'
import { defaultExportOptions } from '../src/shared/export'
import { identityCrop } from '../src/shared/crop'
import type { ObjectSelectionContext } from '../src/shared/object-selection'

test('automatic sky bases register on a genuine Sony RAW and three-RAW HDR master through crop, corrections, frozen SDR/HDR output and restart', async ({
  irodori,
}, info) => {
  test.setTimeout(300000)
  const { app } = irodori
  let { page } = irodori
  const resources = await page.evaluate(() => window.irodori.getResourceSettings())
  await page.evaluate(
    (settings) => window.irodori.setResourceSettings({ ...settings, vramMiB: 4096 }),
    resources.settings,
  )
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  const paths = ['DSC03277.ARW', 'DSC03278.ARW', 'DSC03279.ARW'].map((name) =>
    resolve('assets/tests/images/raw/sony-zv-1a/forest-bracket/originals', name),
  )
  const originals = await Promise.all(paths.map((path) => readFile(path)))
  const ids = originals.map((bytes) => createHash('sha256').update(bytes).digest('hex'))
  await importPhotos(app, page, paths, false, 'keyboard')
  const review = await page.evaluate(
    (photoIds) => window.irodori.createMergeReview(photoIds, 'hdr'),
    ids,
  )
  const preview = await page.evaluate(
    ({ id, revision }) => window.irodori.requestMergePreview(id, revision),
    review,
  )
  expect(preview.recipe.sources.map((source) => source.id)).toEqual(ids)
  expect(preview.recipe.resolution).toBe('native')
  const taskId = await page.evaluate(
    ({ id, revision }) => window.irodori.startMerge(id, revision),
    review,
  )
  const merged = await completedTask(page, taskId)
  expect(merged).toMatchObject({ status: 'completed', errorCount: 0 })
  expect(merged.resultPhotoId).toMatch(/^[a-f0-9]{64}$/)
  const destination = join(irodori.userDataDir, 'sky-exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, destination)
  const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
  expect(grant?.available).toBe(true)
  const retained = []
  for (const photoId of [ids[0], merged.resultPhotoId!]) {
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
      timeout: 60000,
    })
    const state = await page.evaluate((id) => window.irodori.getEdits(id), photoId)
    // Foreground navigation may preempt a different photo's background geometry read.
    // Retry only that declared cancellation, keeping the same frozen revision.
    let context: ObjectSelectionContext | undefined
    await expect
      .poll(
        async () => {
          try {
            context = await page.evaluate(
              ({ id, revision }) => window.irodori.getObjectSelectionContext(id, revision),
              { id: photoId, revision: state.revision },
            )
            return true
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/Statistics interrupted by (active|foreground) preview/.test(error.message)
            )
              throw error
            return false
          }
        },
        { timeout: 30000 },
      )
      .toBe(true)
    if (!context) throw new Error('The confirmed source geometry is unavailable.')
    const proposal = await page.evaluate(
      ({ id, revision, gridIdentity }) =>
        window.irodori.createObjectSelection({
          photoId: id,
          expectedRevision: revision,
          gridIdentity,
          selection: 'sky',
          prompts: { positivePoints: [], negativePoints: [] },
        }),
      { id: photoId, revision: state.revision, gridIdentity: context.gridIdentity },
    )
    expect(proposal.mask.base).toMatchObject({
      width: context.geometry.canonicalWidth,
      height: context.geometry.canonicalHeight,
    })
    await writeFile(
      info.outputPath(`${photoId}-sky.png`),
      Buffer.from(proposal.mask.base!.pngBase64, 'base64'),
    )
    const accepted = await page.evaluate(
      ({ photoId, proposalId, revision }) =>
        window.irodori.acceptObjectSelection({ photoId, proposalId, expectedRevision: revision }),
      { photoId, proposalId: proposal.id, revision: state.revision },
    )
    const maskId = accepted.settings.maskStack[0].id
    const edited = await page.evaluate(
      ({ photoId, revision, maskId }) =>
        window.irodori.mutateMasks(photoId, revision, {
          operations: [
            {
              kind: 'update',
              id: maskId,
              light: { exposureEv: 0.25 },
              color: { saturation: 7, tint: 3 },
              edge: { featherPx: 1.5, shiftPx: 0 },
            },
            {
              kind: 'stroke',
              id: maskId,
              stroke: {
                mode: 'subtract',
                radius: 0.01,
                feather: 0.75,
                points: [{ x: 0.45, y: 0.45 }],
              },
            },
          ],
        }),
      { photoId, revision: accepted.revision, maskId },
    )
    const cropped = await page.evaluate(
      ({ id, revision, crop }) => window.irodori.updateEdits(id, { crop }, revision),
      {
        id: photoId,
        revision: edited.revision,
        crop: { ...identityCrop, width: 0.9, height: 0.9, angle: 1 },
      },
    )
    const mask = cropped.settings.maskStack[0]
    expect(mask.base).toEqual(accepted.settings.maskStack[0].base)
    expect(mask.resultHead).toBeTruthy()
    retained.push({ photoId, mask })
    for (const output of ['sdr', 'hdr'] as const) {
      const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), photoId)
      const exportId = await page.evaluate((request) => window.irodori.startExport(request), {
        preparationId: preparation.id,
        destinationId: grant!.id,
        action: 'custom' as const,
        options: {
          ...defaultExportOptions,
          output,
          metadata: 'none' as const,
          size: {
            mode: 'longest' as const,
            edge: 512,
            allowEnlargement: false,
            method: 'lanczos3' as const,
          },
          names: { mode: 'sequence' as const, prefix: `${photoId.slice(0, 8)}-${output}-` },
        },
      })
      expect(await completedTask(page, exportId)).toMatchObject({
        status: 'completed',
        export: { exported: 1, failed: 0 },
      })
      const frozen = acceptedExport(irodori.userDataDir, exportId)
      expect(frozen.manifest.sources[0].processing.adjustments?.localMasks?.[0].base?.hash).toBe(
        mask.base!.hash,
      )
      const dimensions = await sharp(join(destination, frozen.files[0].outputName!)).metadata()
      expect(Math.max(dimensions.width!, dimensions.height!)).toBe(512)
      await writeFile(
        info.outputPath(`${photoId}-${output}.jpg`),
        await readFile(join(destination, frozen.files[0].outputName!)),
      )
      await inspectAcceptedJpeg(
        join(destination, frozen.files[0].outputName!),
        output === 'hdr',
        dimensions.width!,
        dimensions.height!,
      )
    }
  }
  ;({ page } = await irodori.restart())
  for (const { photoId, mask } of retained)
    expect(
      (await page.evaluate((id) => window.irodori.getEdits(id), photoId)).settings.maskStack[0],
    ).toEqual(mask)
  for (let index = 0; index < paths.length; index++)
    expect(await readFile(paths[index])).toEqual(originals[index])
})
