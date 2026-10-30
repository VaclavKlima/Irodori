import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { MERGE_VERSION } from '../src/shared/merge'
import { verifyMaster } from '../src/main/merge/store'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import {
  acceptanceHash,
  acceptedExport,
  completedTask,
  durableBundleHashes,
  inspectAcceptedJpeg,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'
import { identityCrop, type CropSettings } from '../src/shared/crop'
import type { EditPatch } from '../src/shared/edits'
import { defaultEditTransferGroups } from '../src/shared/edit-transfer'
import { defaultExportOptions } from '../src/shared/export'
import { jpegReferencePrerequisite } from './jpeg-ycbcr-reference.helpers'

const jpegPrerequisite = jpegReferencePrerequisite()
test.skip(!jpegPrerequisite.available, jpegPrerequisite.available ? '' : jpegPrerequisite.reason)

/** Camera RAW and licensed photography are real inputs; the ISO gain-map chart is explicitly synthetic.
 * This exercises application ownership and round trips, not photographic-quality or timing acceptance. */
test('real Sony, photographic raster and decoded ISO input preserve combined Goal 1 edits, selective batch history and frozen enlarged exports across restart', async ({
  irodori,
}, info) => {
  test.setTimeout(900000)
  const rawFixtureRoot = 'assets/tests/images/raw/sony-zv-1a/fog-dogs',
    rawPath = resolve(rawFixtureRoot, 'originals/DSC03280.ARW'),
    rawFixtureManifestBytes = await readFile(resolve(rawFixtureRoot, 'manifest.json')),
    rasterPath = resolve('tests/fixtures/photos/alpine-lake.jpg'),
    chartDirectory = info.outputPath('gain-map-input')
  await mkdir(chartDirectory)
  const chart = await hdrJpegFixture(chartDirectory),
    inputPaths = [rawPath, rasterPath, chart.path],
    inputHashes = await Promise.all(inputPaths.map(acceptanceHash))
  expect(inputHashes[0]).toBe('dead1a70a02909faf8458119fcc8f7067733b756978fd26921710e3008364605')
  const { app } = irodori
  let { page } = irodori
  await importPhotos(app, page, inputPaths, false, 'keyboard')
  // Suspend the renderer while exercising background library APIs; no DOM, display or GPU capability is mocked.
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  const photos = (await page.evaluate(() => window.irodori.listPhotos())).photos,
    source = photos.find((photo) => photo.format === 'ARW')!,
    raster = photos.find((photo) => photo.filename === 'alpine-lake.jpg')!,
    authored = photos.find((photo) => photo.filename === 'authored-hdr.jpg')!,
    ordered = [source, raster, authored],
    ids = ordered.map((photo) => photo.id),
    originals = await managedOriginalHashes(irodori.userDataDir, ordered)
  expect(originals.map((value) => value.sha256)).toEqual(inputHashes)
  const initial = await Promise.all(
    ids.map((id) => page.evaluate((id) => window.irodori.getEdits(id), id)),
  )
  expect(initial[0]).toMatchObject({ settings: { processing: 'hdr-v1' }, hdrEligible: true })
  expect(initial[0].whiteBalanceProfile).toBeDefined()
  expect(initial[1].settings.processing).toBe('display-referred-v1')
  expect(initial[2].hdrJpeg).toMatchObject({ state: 'supported' })

  const patch: EditPatch = {
    exposureEv: 0.35,
    contrast: 14,
    highlights: -20,
    shadows: 15,
    whites: -8,
    blacks: 4,
    saturation: 12,
    vibrance: 18,
    whiteBalance: { mode: 'custom', kelvin: 5800, tint: 5 },
    colorMixer: { ranges: { red: { hue: 8, saturation: 4 }, blue: { luminance: -6 } } },
    colorGrading: {
      tones: {
        shadows: { hue: 220, saturation: 8 },
        midtones: { hue: 35, saturation: 6 },
        highlights: { hue: 45, saturation: 5 },
      },
      blending: 55,
      balance: 5,
    },
    noiseReduction: { luminance: 20, chroma: 25 },
    detailSharpening: { amount: 25, radius: 1.2, threshold: 50 },
  }
  const crops: CropSettings[] = [],
    cropSizes: { width: number; height: number }[] = []
  for (const [index, photo] of ordered.entries()) {
    const context = await page.evaluate(
        ({ id, revision }) => window.irodori.getCropContext(id, revision),
        { id: photo.id, revision: 0 },
      ),
      width = Math.min(97, Math.floor(context.source.height / 2)),
      height = Math.min(65, Math.floor(context.source.width / 2)),
      crop: CropSettings = {
        ...identityCrop,
        quarterTurns: 1,
        angle: 3.25,
        width: width / context.source.height,
        height: height / context.source.width,
      }
    expect(width).toBeGreaterThan(1)
    expect(height).toBeGreaterThan(1)
    crops.push(crop)
    cropSizes.push({ width, height })
    const updated = await page.evaluate(
      ({ id, patch }) => window.irodori.updateEdits(id, patch, 0),
      {
        id: photo.id,
        patch: index === 0 ? { ...patch, crop } : { crop },
      },
    )
    expect(updated.revision).toBe(1)
    const after = await page.evaluate((id) => window.irodori.getCropContext(id, 1), photo.id)
    expect(after.geometry).toMatchObject({ width, height })
    expect(after.source).toEqual(context.source)
  }

  const clipboard = await page.evaluate((id) => window.irodori.copyEdits(id), source.id),
    destinationsBefore = await Promise.all(
      [raster, authored].map((photo) =>
        page.evaluate((id) => window.irodori.getEditHistory(id), photo.id),
      ),
    ),
    prepared = await page.evaluate(
      ({ clipboardId, photoIds, groups }) =>
        window.irodori.preparePasteEdits({ clipboardId, photoIds, groups }),
      {
        clipboardId: clipboard.id,
        photoIds: [raster.id, authored.id],
        groups: defaultEditTransferGroups,
      },
    ),
    pasteId = await page.evaluate((id) => window.irodori.startPasteEdits(id), prepared.id)
  expect(prepared.targets.every((target) => !target.unavailable)).toBe(true)
  expect(await completedTask(page, pasteId)).toMatchObject({
    status: 'completed',
    errorCount: 0,
    editApplication: { applied: 2, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
  })
  const copiedSource = await page.evaluate((id) => window.irodori.getEdits(id), source.id)
  for (const [index, photo] of [raster, authored].entries()) {
    const before = destinationsBefore[index],
      after = await page.evaluate((id) => window.irodori.getEditHistory(id), photo.id)
    expect(after.snapshots).toHaveLength(before.snapshots.length + 1)
    expect(after.settings).toMatchObject({
      ...patch,
      whiteBalance: before.settings.whiteBalance,
      lens: before.settings.lens,
      crop: before.settings.crop,
      processing: before.settings.processing,
    })
    expect(after.settings.colorMixer).toEqual(copiedSource.settings.colorMixer)
    expect(after.settings.colorGrading).toEqual(copiedSource.settings.colorGrading)
    const undone = await page.evaluate(
      ({ id, revision }) => window.irodori.undoEdit(id, revision),
      { id: photo.id, revision: after.revision },
    )
    expect(undone.settings).toEqual(before.settings)
    const redone = await page.evaluate(
      ({ id, revision }) => window.irodori.redoEdit(id, revision),
      { id: photo.id, revision: undone.revision },
    )
    expect(redone.settings).toEqual(after.settings)
  }
  const incompatible = await page.evaluate(
    ({ clipboardId, photoIds }) =>
      window.irodori.preparePasteEdits({ clipboardId, photoIds, groups: ['white-balance'] }),
    { clipboardId: clipboard.id, photoIds: [raster.id, authored.id] },
  )
  expect(
    incompatible.targets.every((target) => target.unavailable?.includes('compatible verified')),
  ).toBe(true)
  await page.evaluate((id) => window.irodori.disposePastePreparation(id), incompatible.id)

  const destination = join(irodori.userDataDir, 'acceptance-exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
  }, destination)
  const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
  expect(grant?.available).toBe(true)
  const settingsBeforeExport = await Promise.all(
      ids.map((id) => page.evaluate((id) => window.irodori.getEdits(id), id)),
    ),
    options = {
      ...defaultExportOptions,
      output: 'auto' as const,
      quality: 100,
      metadata: 'none' as const,
      size: {
        mode: 'longest' as const,
        edge: 194,
        allowEnlargement: true,
        method: 'lanczos3' as const,
      },
      names: { mode: 'sequence' as const, prefix: 'reference-' },
    }
  async function startExport(prefix: string) {
    const preparation = await page.evaluate((ids) => window.irodori.prepareExport(ids), ids)
    expect([preparation.hdr, preparation.sdr]).toEqual([2, 1])
    return page.evaluate((request) => window.irodori.startExport(request), {
      preparationId: preparation.id,
      destinationId: grant!.id,
      action: 'custom' as const,
      options: { ...options, names: { mode: 'sequence' as const, prefix } },
    })
  }
  const referenceId = await startExport('reference-')
  expect(await completedTask(page, referenceId)).toMatchObject({
    status: 'completed',
    export: { exported: 3, failed: 0 },
  })
  const frozenId = await startExport('frozen-'),
    accepted = acceptedExport(irodori.userDataDir, frozenId)
  for (const [index, frozen] of accepted.manifest.sources.entries()) {
    expect(frozen.photo.id).toBe(ids[index])
    expect(frozen.processing).toMatchObject({
      revision: settingsBeforeExport[index].revision,
      noiseReduction: settingsBeforeExport[index].settings.noiseReduction,
      detailSharpening: settingsBeforeExport[index].settings.detailSharpening,
      crop: crops[index],
      adjustments: { saturation: 12, vibrance: 18 },
    })
  }
  for (const [index, id] of ids.entries())
    await page.evaluate(
      ({ id, revision }) => window.irodori.updateEdits(id, { exposureEv: -1.25 }, revision),
      { id, revision: settingsBeforeExport[index].revision },
    )
  expect(await completedTask(page, frozenId)).toMatchObject({
    status: 'completed',
    export: { exported: 3, failed: 0 },
  })
  const frozen = acceptedExport(irodori.userDataDir, frozenId),
    reference = acceptedExport(irodori.userDataDir, referenceId)
  expect(frozen.manifest).toEqual(accepted.manifest)
  const retainedExports = info.outputPath('accepted-exports')
  await mkdir(retainedExports)
  const outputEvidence = []
  for (const [index, result] of frozen.files.entries()) {
    expect(result.status).toBe('exported')
    const path = join(destination, result.outputName!),
      referencePath = join(destination, reference.files[index].outputName!)
    expect(await readFile(path)).toEqual(await readFile(referencePath))
    const size = cropSizes[index],
      scale = 194 / Math.max(size.width, size.height)
    outputEvidence.push(
      await inspectAcceptedJpeg(
        path,
        index !== 1,
        Math.round(size.width * scale),
        Math.round(size.height * scale),
      ),
    )
    expect(result.diagnostics?.resize).toMatchObject({ input: size, enlarged: true })
    expect(result.diagnostics?.detail).toBeDefined()
    await copyFile(path, join(retainedExports, result.outputName!))
  }
  expect(await managedOriginalHashes(irodori.userDataDir, ordered)).toEqual(originals)
  const histories = await Promise.all(
    ids.map((id) => page.evaluate((id) => window.irodori.getEditHistory(id), id)),
  )
  ;({ page } = await irodori.restart())
  expect(await page.evaluate(() => window.irodori.getEditClipboard())).toBeNull()
  for (const [index, id] of ids.entries())
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
      histories[index],
    )
  expect(
    (
      await page.evaluate((id) => window.irodori.getEditApplicationResults(id), pasteId)
    ).results.map((result) => result.outcome),
  ).toEqual(['applied', 'applied'])
  expect(acceptedExport(irodori.userDataDir, frozenId).manifest).toEqual(accepted.manifest)
  expect(await managedOriginalHashes(irodori.userDataDir, ordered)).toEqual(originals)
  expect(await Promise.all(inputPaths.map(acceptanceHash))).toEqual(inputHashes)
  await writeFile(
    info.outputPath('real-source-acceptance.json'),
    JSON.stringify(
      {
        rawFixture: {
          path: rawFixtureRoot,
          manifestSha256: createHash('sha256').update(rawFixtureManifestBytes).digest('hex'),
        },
        inputs: ordered.map((photo, index) => ({
          filename: photo.filename,
          photoId: photo.id,
          sha256: inputHashes[index],
          kind:
            index === 0
              ? 'real-camera-raw'
              : index === 1
                ? 'licensed-photograph'
                : 'synthetic-encoded-iso-chart',
        })),
        settingsBeforeExport,
        cropSizes,
        outputEvidence,
        frozenExport: frozen,
        referenceExport: reference,
        originalHashes: originals,
        limitations: [
          'No durable merge master is fabricated or covered by this case.',
          'Independent operator quality, full-source CPU/GPU math, native photographic/input and performance acceptance remain separate.',
        ],
      },
      null,
      2,
    ),
  )
})

/** A fresh genuine BRK merge, not a synthetic descriptor or an unsupported retained recipe. */
test('genuine Sony v4 review and publication retain a durable master through global edits, selective paste, enlarged HDR/SDR export and restart', async ({
  irodori,
}, info) => {
  test.setTimeout(900000)
  const fixtureRelativeRoot = 'assets/tests/images/raw/sony-zv-1a/forest-bracket',
    fixtureRoot = resolve(fixtureRelativeRoot),
    fixtureManifestBytes = await readFile(join(fixtureRoot, 'manifest.json')),
    fixtureManifest = JSON.parse(fixtureManifestBytes.toString('utf8')) as {
      version: number
      fixtureSet: string
      sequence: {
        kind: string
        members: string[]
        recordedAperture: number
        recordedIso: number
        relativeMetadataEv: number[]
      }
      files: {
        name: string
        path: string
        sha256: string
        bytes: number
        captureSequence: {
          ReleaseMode: number
          SequenceNumber: number
          ReleaseMode2: number
          SequenceImageNumber: number
          SequenceFileNumber: number
          SequenceLength: number
          ReleaseMode3: number
        }
        numericExif: { ISO: number; FNumber: number; Orientation: number }
      }[]
    },
    sequence = fixtureManifest.sequence
  expect(fixtureManifest).toMatchObject({
    version: 1,
    fixtureSet: 'sony-zv-1a-tree-covered-bracket-v1',
  })
  expect(sequence).toMatchObject({
    kind: 'Genuine metadata-identified continuous exposure bracket',
    members: ['DSC03277.ARW', 'DSC03278.ARW', 'DSC03279.ARW'],
    recordedAperture: 4,
    recordedIso: 400,
    relativeMetadataEv: [0, -2, 2],
  })
  expect(sequence.members).toHaveLength(3)
  const entries = sequence.members.map((name) =>
      fixtureManifest.files.find((file) => file.name === name)!,
    ),
    paths = entries.map((entry) => resolve(fixtureRoot, entry.path))
  expect(entries.map((entry) => entry.captureSequence)).toEqual(
    [1, 2, 3].map((index) => ({
      ReleaseMode: 5,
      SequenceNumber: index,
      ReleaseMode2: 2,
      SequenceImageNumber: index,
      SequenceFileNumber: index,
      SequenceLength: 3,
      ReleaseMode3: 2,
    })),
  )
  for (const entry of entries)
    expect(entry.numericExif).toMatchObject({ ISO: 400, FNumber: 4, Orientation: 8 })
  expect(paths.every((path) => path.startsWith(fixtureRoot + sep))).toBe(true)
  expect(new Set(entries.map((entry) => entry.sha256)).size).toBe(3)
  expect(await Promise.all(paths.map(acceptanceHash))).toEqual(entries.map((entry) => entry.sha256))
  const { app } = irodori
  let { page } = irodori
  await importPhotos(app, page, paths, false, 'keyboard')
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  const imported = (await page.evaluate(() => window.irodori.listPhotos())).photos,
    sourcePhotos = entries.map((entry) => imported.find((photo) => photo.id === entry.sha256)!),
    sourceIds = sourcePhotos.map((photo) => photo.id),
    originals = await managedOriginalHashes(irodori.userDataDir, sourcePhotos)
  expect(sourcePhotos.map((photo) => photo.bytes)).toEqual(entries.map((entry) => entry.bytes))
  expect(originals.map((entry) => entry.sha256)).toEqual(entries.map((entry) => entry.sha256))
  const review = await page.evaluate(
    (ids) => window.irodori.createMergeReview(ids, 'hdr'),
    sourceIds,
  )
  expect(review.settings).toMatchObject({
    mode: 'hdr',
    autoAlign: true,
    deghost: true,
    autoCrop: true,
  })
  const preview = await page.evaluate(
    ({ id, revision }) => window.irodori.requestMergePreview(id, revision),
    review,
  )
  expect(preview.recipe).toMatchObject({ version: MERGE_VERSION, resolution: 'native' })
  expect(preview.recipe.sources.map((source) => source.id)).toEqual(sourceIds)
  expect(preview.width).toBeGreaterThan(3000)
  expect(preview.height).toBeGreaterThan(3000)
  const reviewedDirectory = join(
      irodori.userDataDir,
      'library',
      'merge-reviews',
      review.id,
      `revision-${review.revision}`,
    ),
    reviewed = {
      linear: await acceptanceHash(join(reviewedDirectory, 'linear.f32')),
      mask: await acceptanceHash(join(reviewedDirectory, 'motion.mask')),
    }
  expect(reviewed.mask).toBe(preview.recipe.maskSha256)
  const mergeTaskId = await page.evaluate(
      ({ id, revision }) => window.irodori.startMerge(id, revision),
      review,
    ),
    mergeTask = await completedTask(page, mergeTaskId)
  expect(mergeTask).toMatchObject({ status: 'completed', errorCount: 0 })
  expect(mergeTask.resultPhotoId).toMatch(/^[a-f0-9]{64}$/)
  const masterId = mergeTask.resultPhotoId!,
    master = (await page.evaluate(() => window.irodori.listPhotos())).photos.find(
      (photo) => photo.id === masterId,
    )!,
    masterDirectory = join(irodori.userDataDir, 'library', 'originals', masterId),
    provenance = await page.evaluate((id) => window.irodori.getMergeProvenance(id), masterId)
  expect(master.assetKind).toBe('derived')
  expect(provenance).toMatchObject({
    reproducible: true,
    manifest: { version: MERGE_VERSION, recipe: { version: MERGE_VERSION, resolution: 'native' } },
  })
  expect(provenance.manifest.asset.sha256).toBe(reviewed.linear)
  expect(provenance.manifest.recipe.maskSha256).toBe(reviewed.mask)
  expect([provenance.manifest.asset.width, provenance.manifest.asset.height]).toEqual([
    preview.width,
    preview.height,
  ])
  await verifyMaster(masterDirectory, provenance.manifest)
  const durableBefore = await durableBundleHashes(masterDirectory)
  expect(durableBefore.find((file) => file.name === 'linear.f32')?.sha256).toBe(reviewed.linear)
  expect(durableBefore.find((file) => file.name === 'motion.mask')?.sha256).toBe(reviewed.mask)
  expect(await managedOriginalHashes(irodori.userDataDir, sourcePhotos)).toEqual(originals)

  // Crop the native master itself; all scene-linear working pixels remain in its durable bundle.
  const masterInitial = await page.evaluate((id) => window.irodori.getEdits(id), masterId),
    context = await page.evaluate(
      ({ id, revision }) => window.irodori.getCropContext(id, revision),
      { id: masterId, revision: masterInitial.revision },
    ),
    crop: CropSettings = {
      ...identityCrop,
      quarterTurns: 1,
      angle: -2.25,
      width: 145 / context.source.height,
      height: 97 / context.source.width,
    }
  expect(masterInitial.referenceWhiteBalance).toBe(true)
  await page.evaluate(
    ({ id, revision, crop }) => window.irodori.updateEdits(id, { crop }, revision),
    { id: masterId, revision: masterInitial.revision, crop },
  )
  const framed = await page.evaluate((id) => window.irodori.getCropContext(id, 1), masterId)
  expect(framed.geometry).toMatchObject({ width: 145, height: 97 })
  const referenceId = review.settings.referenceId,
    referenceInitial = await page.evaluate((id) => window.irodori.getEdits(id), referenceId),
    referenceLens = await page.evaluate((id) => window.irodori.getLensSettings(id), referenceId)
  expect(referenceInitial.whiteBalanceProfile).toBeDefined()
  expect(referenceLens.profile.distortion).toBeDefined()
  const combined: EditPatch = {
    exposureEv: 0.35,
    contrast: 14,
    highlights: -20,
    shadows: 15,
    whites: -8,
    blacks: 4,
    saturation: 12,
    vibrance: 18,
    whiteBalance: { mode: 'custom', kelvin: 5800, tint: 5 },
    lens: { distortion: !referenceLens.settings.distortion },
    colorMixer: { ranges: { red: { hue: 8, saturation: 4 }, blue: { luminance: -6 } } },
    colorGrading: {
      tones: {
        shadows: { hue: 220, saturation: 8 },
        midtones: { hue: 35, saturation: 6 },
        highlights: { hue: 45, saturation: 5 },
      },
      blending: 55,
      balance: 5,
    },
    noiseReduction: { luminance: 20, chroma: 25 },
    detailSharpening: { amount: 25, radius: 1.2, threshold: 50 },
  }
  await page.evaluate(
    ({ id, revision, patch }) => window.irodori.updateEdits(id, patch, revision),
    { id: referenceId, revision: referenceInitial.revision, patch: combined },
  )
  const copied = await page.evaluate((id) => window.irodori.copyEdits(id), referenceId),
    otherOriginal = sourceIds.find((id) => id !== referenceId)!,
    targets = [masterId, otherOriginal],
    targetsBefore = await Promise.all(
      targets.map((id) => page.evaluate((id) => window.irodori.getEditHistory(id), id)),
    ),
    paste = await page.evaluate((request) => window.irodori.preparePasteEdits(request), {
      clipboardId: copied.id,
      photoIds: targets,
      groups: defaultEditTransferGroups,
    }),
    pasteId = await page.evaluate((id) => window.irodori.startPasteEdits(id), paste.id)
  expect(await completedTask(page, pasteId)).toMatchObject({
    status: 'completed',
    errorCount: 0,
    editApplication: { applied: 2, unchanged: 0, conflict: 0, unavailable: 0, failed: 0 },
  })
  for (const [index, id] of targets.entries()) {
    const before = targetsBefore[index],
      after = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
    expect(after.settings).toMatchObject({
      ...combined,
      whiteBalance: before.settings.whiteBalance,
      lens: before.settings.lens,
      crop: before.settings.crop,
      processing: before.settings.processing,
    })
    expect(after.snapshots).toHaveLength(before.snapshots.length + 1)
    const undone = await page.evaluate(
      ({ id, revision }) => window.irodori.undoEdit(id, revision),
      { id, revision: after.revision },
    )
    expect(undone.settings).toEqual(before.settings)
    const redone = await page.evaluate(
      ({ id, revision }) => window.irodori.redoEdit(id, revision),
      { id, revision: undone.revision },
    )
    expect(redone.settings).toEqual(after.settings)
  }
  expect(
    (await page.evaluate((id) => window.irodori.getEdits(id), masterId)).referenceWhiteBalance,
  ).toBe(true)
  expect(await durableBundleHashes(masterDirectory)).toEqual(durableBefore)

  const destination = join(irodori.userDataDir, 'merged-exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
  expect(grant?.available).toBe(true)
  async function exportMaster(output: 'hdr' | 'sdr', prefix: string) {
    const prepared = await page.evaluate((id) => window.irodori.prepareExport([id]), masterId)
    expect([prepared.hdr, prepared.sdr]).toEqual([1, 0])
    const id = await page.evaluate((request) => window.irodori.startExport(request), {
      preparationId: prepared.id,
      destinationId: grant!.id,
      action: 'custom' as const,
      options: {
        ...defaultExportOptions,
        output,
        quality: 100,
        metadata: 'none' as const,
        size: {
          mode: 'longest' as const,
          edge: 290,
          allowEnlargement: true,
          method: 'lanczos3' as const,
        },
        names: { mode: 'sequence' as const, prefix },
      },
    })
    expect(await completedTask(page, id)).toMatchObject({
      status: 'completed',
      export: { exported: 1, failed: 0 },
    })
    const accepted = acceptedExport(irodori.userDataDir, id),
      file = accepted.files[0],
      path = join(destination, file.outputName!)
    expect(file.status).toBe('exported')
    expect(file.diagnostics?.sourcePreparation).toBe('managed')
    expect(file.diagnostics?.resize).toMatchObject({
      input: { width: 145, height: 97 },
      output: { width: 290, height: 194 },
      enlarged: true,
    })
    expect(accepted.manifest.sources[0].processing.metadata.mergeMaster?.asset.sha256).toBe(
      reviewed.linear,
    )
    const inspection = await inspectAcceptedJpeg(path, output === 'hdr', 290, 194)
    return { id, accepted, path, inspection }
  }
  const hdr = await exportMaster('hdr', 'master-hdr-'),
    sdr = await exportMaster('sdr', 'master-sdr-')
  expect(
    await sharp(await readFile(hdr.path))
      .removeAlpha()
      .raw()
      .toBuffer(),
  ).toEqual(
    await sharp(await readFile(sdr.path))
      .removeAlpha()
      .raw()
      .toBuffer(),
  )
  const histories = await Promise.all(
    [...sourceIds, masterId].map((id) =>
      page.evaluate((id) => window.irodori.getEditHistory(id), id),
    ),
  )
  expect(await durableBundleHashes(masterDirectory)).toEqual(durableBefore)
  expect(await managedOriginalHashes(irodori.userDataDir, sourcePhotos)).toEqual(originals)
  ;({ page } = await irodori.restart(true))
  const reopened = await page.evaluate((id) => window.irodori.getMergeProvenance(id), masterId)
  expect(reopened.manifest).toEqual(provenance.manifest)
  expect(reopened.reproducible).toBe(true)
  await verifyMaster(masterDirectory, reopened.manifest)
  for (const [index, id] of [...sourceIds, masterId].entries())
    expect(await page.evaluate((id) => window.irodori.getEditHistory(id), id)).toEqual(
      histories[index],
    )
  const reopenedHdr = await exportMaster('hdr', 'master-reopened-')
  expect(await readFile(reopenedHdr.path)).toEqual(await readFile(hdr.path))
  expect(await durableBundleHashes(masterDirectory)).toEqual(durableBefore)
  expect(await managedOriginalHashes(irodori.userDataDir, sourcePhotos)).toEqual(originals)
  expect(await Promise.all(paths.map(acceptanceHash))).toEqual(entries.map((entry) => entry.sha256))
  // Keep a genuine current-format master for subsequent independent native-crop
  // review after the isolated library is removed. This never mutates its bundle.
  const retainedMaster = info.outputPath('accepted-master'),
    retainedExports = info.outputPath('accepted-exports')
  await mkdir(retainedMaster)
  await mkdir(retainedExports)
  for (const entry of durableBefore)
    await copyFile(join(masterDirectory, entry.name), join(retainedMaster, entry.name))
  expect(await durableBundleHashes(retainedMaster)).toEqual(durableBefore)
  for (const output of [hdr, sdr, reopenedHdr])
    await copyFile(output.path, join(retainedExports, output.accepted.files[0].outputName!))
  await writeFile(
    info.outputPath('durable-v4-source-acceptance.json'),
    JSON.stringify(
      {
        fixtureRoot: fixtureRelativeRoot,
        fixtureManifestSha256: createHash('sha256').update(fixtureManifestBytes).digest('hex'),
        inputEntries: entries,
        reviewed,
        preview,
        publishedManifest: provenance.manifest,
        sourceOriginalHashes: originals,
        durableBundleHashes: durableBefore,
        histories,
        outputs: [hdr, sdr, reopenedHdr],
        pasteId,
        mergeTask,
        limitations: [
          'This is correctness and persistence acceptance, not whole-merge timing or physical HDR luminance acceptance.',
          'Photographic detail quality and full-source CPU/GPU numerical/performance gates remain separate.',
        ],
      },
      null,
      2,
    ),
  )
})
