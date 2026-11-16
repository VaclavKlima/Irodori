import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { MERGE_VERSION } from '../src/shared/merge'
import { identityCrop } from '../src/shared/crop'
import { defaultExportOptions, type ExportOptions } from '../src/shared/export'
import { verifyMaster } from '../src/main/merge/store'
import { test, expect } from './electron.fixture'
import { activateButton } from './button.helpers'
import { revealEditorPhoto } from './collection-ui.helpers'
import { importPhotos } from './import.helpers'
import {
  acceptanceHash,
  acceptedExport,
  completedTask,
  durableBundleHashes,
  managedOriginalHashes,
} from './professional-editing-acceptance.helpers'
import { readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

/** Inspect native bytes in bounded strips; this is an independent test witness, not a classifier. */
async function brightNeighborhood(path: string, width: number, height: number) {
  const file = await open(path, 'r')
  let best = { x: 0, y: 0, luminance: -Infinity }
  const coefficients = [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157]
  try {
    for (let y = 128; y < height - 128; y += 32) {
      const bytes = Buffer.alloc(width * 16)
      expect((await file.read(bytes, 0, bytes.length, y * width * 16)).bytesRead).toBe(bytes.length)
      for (let x = 128; x < width - 128; x += 32) {
        const at = x * 16
        const luminance = coefficients.reduce(
          (sum, coefficient, c) => sum + coefficient * bytes.readFloatLE(at + c * 4),
          0,
        )
        if (luminance > best.luminance) best = { x, y, luminance }
      }
    }
    let weight = 0
    let luminance = 0
    for (let dy = -3; dy <= 3; dy++) {
      const bytes = Buffer.alloc(7 * 16)
      expect(
        (await file.read(bytes, 0, bytes.length, ((best.y + dy) * width + best.x - 3) * 16))
          .bytesRead,
      ).toBe(bytes.length)
      for (let x = 0; x < 7; x++) {
        const alpha = bytes.readFloatLE(x * 16 + 12)
        weight += alpha
        luminance +=
          coefficients.reduce(
            (sum, coefficient, c) => sum + coefficient * bytes.readFloatLE(x * 16 + c * 4),
            0,
          ) * alpha
      }
    }
    return { ...best, luminance: (100 * luminance) / weight, validPixels: 49 }
  } finally {
    await file.close()
  }
}

function maximumCodes(a: Uint8Array, b: Uint8Array) {
  expect(a.length).toBe(b.length)
  let maximum = 0
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]))
  return maximum
}

test('genuine published Sony HDR master retains neutral above-white range sampling, temporary coverage and frozen output across edits and restart', async ({
  irodori,
}, info) => {
  test.setTimeout(360000)
  const fixtureRoot = 'assets/tests/images/raw/sony-zv-1a/forest-bracket'
  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8')) as {
    fixtureSet: string
    sequence: { members: string[]; relativeMetadataEv: number[] }
    files: { name: string; path: string; sha256: string; numericExif: { Orientation: number } }[]
  }
  expect(manifest.fixtureSet).toBe('sony-zv-1a-tree-covered-bracket-v1')
  expect(manifest.sequence.relativeMetadataEv).toEqual([0, -2, 2])
  const entries = manifest.sequence.members.map((name) =>
    manifest.files.find((f) => f.name === name)!,
  )
  expect(entries).toHaveLength(3)
  expect(entries.every((entry) => entry.numericExif.Orientation === 8)).toBe(true)
  const paths = entries.map((entry) => join(fixtureRoot, entry.path))
  // Exact tracked originals and the recorded permission/privacy review make this input reproducible.
  execFileSync('git', [
    'ls-files',
    '--error-unmatch',
    ...paths,
    join(fixtureRoot, 'README.md'),
    join(fixtureRoot, 'manifest.json'),
  ])
  expect(await Promise.all(paths.map(acceptanceHash))).toEqual(entries.map((entry) => entry.sha256))
  const { userDataDir } = irodori
  let { app, page } = irodori
  await importPhotos(
    app,
    page,
    paths.map((path) => resolve(path)),
    false,
    'keyboard',
  )
  await activateButton(page.getByRole('button', { name: 'Library', exact: true }))
  const sourceIds = entries.map((entry) => entry.sha256)
  const sourcePhotos = (await page.evaluate(() => window.irodori.listPhotos())).photos.filter(
    (photo) => sourceIds.includes(photo.id),
  )
  const originals = await managedOriginalHashes(userDataDir, sourcePhotos)
  const sourceHistories = await page.evaluate(
    (ids) => Promise.all(ids.map((id) => window.irodori.getEditHistory(id))),
    sourceIds,
  )
  const review = await page.evaluate(
    (ids) => window.irodori.createMergeReview(ids, 'hdr'),
    sourceIds,
  )
  const reviewed = await page.evaluate(
    ({ id, revision }) => window.irodori.requestMergePreview(id, revision),
    review,
  )
  expect(reviewed.recipe).toMatchObject({ version: MERGE_VERSION, resolution: 'native' })
  expect(reviewed.recipe.sources.map((source) => source.id)).toEqual(sourceIds)
  const taskId = await page.evaluate(
    ({ id, revision }) => window.irodori.startMerge(id, revision),
    review,
  )
  const task = await completedTask(page, taskId)
  expect(task).toMatchObject({ status: 'completed', errorCount: 0 })
  const id = task.resultPhotoId!
  expect(id).toMatch(/^[a-f0-9]{64}$/)
  const provenance = await page.evaluate((id) => window.irodori.getMergeProvenance(id), id)
  expect(provenance).toMatchObject({ reproducible: true, manifest: { version: MERGE_VERSION } })
  const masterDirectory = join(userDataDir, 'library', 'originals', id)
  await verifyMaster(masterDirectory, provenance.manifest)
  const bundle = await durableBundleHashes(masterDirectory)
  const referenceGeometry = await page.evaluate(
    (id) => window.irodori.getMaskContext(id, 0),
    review.settings.referenceId,
  )
  expect(referenceGeometry.geometry.flip).not.toBe(0)
  expect(referenceGeometry.geometry.correction?.distortion).toHaveLength(4096)
  const masterPath = join(masterDirectory, 'linear.f32')
  const { width, height, sha256 } = provenance.manifest.asset
  expect(await acceptanceHash(masterPath)).toBe(sha256)
  const bright = await brightNeighborhood(masterPath, width, height)
  expect(bright.luminance).toBeGreaterThan(100)
  const point = { x: (bright.x + 0.5) / width, y: (bright.y + 0.5) / height }
  const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id)
  const sample = async () =>
    page.evaluate(
      async ({ id, point }) => {
        const state = await window.irodori.getEdits(id)
        const context = await window.irodori.getMaskContext(id, state.revision)
        return {
          context,
          sample: await window.irodori.sampleMaskRange({
            photoId: id,
            expectedRevision: state.revision,
            renderingIdentity: context.renderingIdentity,
            point,
          }),
        }
      },
      { id, point },
    )
  const beforeDiagnostic = await history()
  const first = await sample()
  expect(first.context.geometry).toMatchObject({
    canonicalWidth: width,
    canonicalHeight: height,
    flip: 0,
  })
  expect(first.sample).toMatchObject({
    photoId: id,
    revision: beforeDiagnostic.revision,
    validPixels: bright.validPixels,
  })
  expect(first.sample.luminance).toBeCloseTo(bright.luminance, 7)
  expect(first.sample.color).not.toBeNull()
  const rootId = randomUUID()
  const temporary = async () =>
    page.evaluate(
      async ({ id, rootId, point }) => {
        const state = await window.irodori.getEdits(id)
        const result = await window.irodori.prepareMaskCoverage({
          photoId: id,
          revision: state.revision,
          maskIds: [rootId],
          mutation: {
            operations: [
              {
                kind: 'create',
                id: rootId,
                name: 'Temporary above-white range',
                range: { version: 1, kind: 'luminance', lower: 100, upper: null, softness: 0 },
              },
            ],
          },
        })
        const base = result.rangeBases![rootId]
        const image = await createImageBitmap(
          new Blob([Uint8Array.from(atob(base.pngBase64), (c) => c.charCodeAt(0))], {
            type: 'image/png',
          }),
        )
        const canvas = new OffscreenCanvas(1, 1)
        const context = canvas.getContext('2d')!
        context.drawImage(
          image,
          Math.floor(point.x * base.width),
          Math.floor(point.y * base.height),
          1,
          1,
          0,
          0,
          1,
          1,
        )
        const selected = Array.from(context.getImageData(0, 0, 1, 1).data)
        image.close()
        return {
          sourceIdentity: result.sourceIdentity,
          range: { key: base.key, hash: base.hash, width: base.width, height: base.height },
          selected,
        }
      },
      { id, rootId, point },
    )
  const coverage = await temporary()
  expect(coverage.range).toMatchObject({ width, height })
  expect(coverage.selected).toEqual([255, 255, 255, 255])
  expect(await history()).toEqual(beforeDiagnostic)
  expect(await durableBundleHashes(masterDirectory)).toEqual(bundle)
  let state = await page.evaluate(
    (id) => window.irodori.updateEdits(id, { exposureEv: -0.5, saturation: 35, contrast: 20 }, 0),
    id,
  )
  for (const preference of ['sdr', 'hdr'] as const) {
    const target = await page.evaluate(
      (preference) => window.irodori.setPreviewPreference(preference),
      preference,
    )
    const current = await sample()
    expect(current.sample).toMatchObject({
      sourceIdentity: first.sample.sourceIdentity,
      color: first.sample.color,
      luminance: first.sample.luminance,
    })
    expect(await temporary()).toEqual(coverage)
    await info.attach(`merged-range-${preference}-target`, {
      contentType: 'application/json',
      body: JSON.stringify({ target, sample: current.sample, coverage }),
    })
  }
  expect((await history()).revision).toBe(state.revision)
  expect(await durableBundleHashes(masterDirectory)).toEqual(bundle)
  await page.evaluate((id) => window.irodori.cancelMaskCoverage(id), id)
  // Output is bounded by a real crop; range preparation continues to use the whole durable master.
  state = await page.evaluate(
    ({ id, revision, crop }) => window.irodori.updateEdits(id, { crop }, revision),
    {
      id,
      revision: state.revision,
      crop: {
        ...identityCrop,
        centerX: point.x,
        centerY: point.y,
        width: 145 / width,
        height: 97 / height,
      },
    },
  )
  const neutralPreparation = await page.evaluate((id) => window.irodori.prepareExport([id]), id)
  const neutralProof = await page.evaluate(
    (request) => window.irodori.requestOutputProof(request),
    {
      preparationId: neutralPreparation.id,
      photoId: id,
      options: {
        ...structuredClone(defaultExportOptions),
        output: 'sdr' as const,
        quality: 100,
        metadata: 'none' as const,
      },
      token: randomUUID(),
    },
  )
  const neutralPrimary = Buffer.from(
    await page.evaluate(
      async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
      neutralProof.primary.url,
    ),
  )
  await page.evaluate((id) => window.irodori.releaseOutputProof(id), neutralProof.id)
  await page.evaluate((id) => window.irodori.disposeExportPreparation(id), neutralPreparation.id)
  state = await page.evaluate(
    ({ id, revision, rootId }) =>
      window.irodori.mutateMasks(id, revision, {
        operations: [
          {
            kind: 'create',
            id: rootId,
            name: 'Above-white output',
            range: { version: 1, kind: 'luminance', lower: 100, upper: null, softness: 0 },
          },
          { kind: 'update', id: rootId, light: { exposureEv: -1.5 } },
        ],
      }),
    { id, revision: state.revision, rootId },
  )
  const acceptedSettings = structuredClone(state.settings)
  const destination = join(userDataDir, 'range-master-exports')
  await mkdir(destination)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, destination)
  const grant = await page.evaluate(() => window.irodori.chooseExportDestination())
  expect(grant?.available).toBe(true)
  const outputs: {
    output: string
    primary: Buffer
    linear?: Buffer
    jpeg: Buffer
    maxCodes: number
    hdrMaximum: number | null
  }[] = []
  let maximumLocalChange = 0
  for (const output of ['sdr', 'hdr'] as const) {
    const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), id)
    const options: ExportOptions = {
      ...structuredClone(defaultExportOptions),
      output,
      quality: 100,
      metadata: 'none',
      names: { mode: 'sequence', prefix: `range-${output}-` },
    }
    const proof = await page.evaluate((request) => window.irodori.requestOutputProof(request), {
      preparationId: preparation.id,
      photoId: id,
      options,
      token: randomUUID(),
    })
    expect([proof.width, proof.height]).toEqual([145, 97])
    const pixels = await page.evaluate(
      async (proof) => ({
        primary: Array.from(new Uint8Array(await (await fetch(proof.primary.url)).arrayBuffer())),
        linear: proof.linear?.url
          ? Array.from(new Uint8Array(await (await fetch(proof.linear.url)).arrayBuffer()))
          : undefined,
      }),
      proof,
    )
    const primary = Buffer.from(pixels.primary)
    if (output === 'sdr') {
      maximumLocalChange = maximumCodes(neutralPrimary, primary)
      expect(maximumLocalChange).toBeGreaterThan(4)
    }
    const linear = pixels.linear ? Buffer.from(pixels.linear) : undefined
    const jobId = await page.evaluate((request) => window.irodori.startExport(request), {
      preparationId: preparation.id,
      destinationId: grant!.id,
      action: 'custom' as const,
      options,
    })
    state = await page.evaluate(
      ({ id, revision, rootId }) =>
        window.irodori.mutateMasks(id, revision, {
          operations: [{ kind: 'update', id: rootId, light: { exposureEv: 0.2 } }],
        }),
      { id, revision: state.revision, rootId },
    )
    expect(await completedTask(page, jobId)).toMatchObject({
      status: 'completed',
      export: { exported: 1, failed: 0 },
    })
    const accepted = acceptedExport(userDataDir, jobId)
    expect(accepted.manifest.sources[0].processing.metadata.mergeMaster?.asset.sha256).toBe(sha256)
    expect(
      accepted.manifest.sources[0].processing.adjustments?.localMasks?.[0].light.exposureEv,
    ).toBe(-1.5)
    const jpeg = await readFile(join(destination, accepted.files[0].outputName!))
    const decoded = await sharp(jpeg).toColourspace('srgb').ensureAlpha().raw().toBuffer()
    const maxCodes = maximumCodes(primary, decoded)
    expect(maxCodes).toBeLessThanOrEqual(2)
    let hdrMaximum: number | null = null
    if (output === 'hdr') {
      const parsed = readGainJpeg(jpeg)
      const rgb = await sharp(parsed.primary).removeAlpha().raw().toBuffer()
      const gain = await sharp(parsed.gain, { ignoreIcc: true }).removeAlpha().raw().toBuffer()
      const expected = new Float32Array(linear!.buffer, linear!.byteOffset, linear!.byteLength / 4)
      hdrMaximum = 0
      for (const fy of [0.25, 0.5, 0.75])
        for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const index = Math.floor(proof.height * fy) * proof.width + Math.floor(proof.width * fx)
          const actual = reconstruct(
            to2020([0, 1, 2].map((c) => srgbLinear(rgb[index * 3 + c] / 255))),
            [0, 1, 2].map((c) => gain[index * 3 + c] / 255),
            parsed.metadata,
            100,
          )
          for (let c = 0; c < 3; c++)
            hdrMaximum = Math.max(hdrMaximum, Math.abs(actual[c] - expected[index * 4 + c]))
        }
      expect(hdrMaximum).toBeLessThan(0.02)
    }
    outputs.push({ output, primary, linear, jpeg, maxCodes, hdrMaximum })
    await page.evaluate((id) => window.irodori.releaseOutputProof(id), proof.id)
    await page.evaluate((id) => window.irodori.disposeExportPreparation(id), preparation.id)
    state = await page.evaluate(({ id, revision }) => window.irodori.undoEdit(id, revision), {
      id,
      revision: state.revision,
    })
    expect(state.settings).toEqual(acceptedSettings)
  }
  const redone = await page.evaluate(({ id, revision }) => window.irodori.redoEdit(id, revision), {
    id,
    revision: state.revision,
  })
  expect(redone.settings.maskStack[0].light.exposureEv).toBe(0.2)
  state = await page.evaluate(({ id, revision }) => window.irodori.undoEdit(id, revision), {
    id,
    revision: redone.revision,
  })
  expect(state.settings).toEqual(acceptedSettings)
  const savedHistory = await history()
  expect(await durableBundleHashes(masterDirectory)).toEqual(bundle)
  ;({ app, page } = await irodori.restart(true))
  expect(await history()).toEqual(savedHistory)
  expect((await page.evaluate((id) => window.irodori.getMergeProvenance(id), id)).manifest).toEqual(
    provenance.manifest,
  )
  for (const retained of outputs) {
    const preparation = await page.evaluate((id) => window.irodori.prepareExport([id]), id)
    const proof = await page.evaluate((request) => window.irodori.requestOutputProof(request), {
      preparationId: preparation.id,
      photoId: id,
      options: {
        ...structuredClone(defaultExportOptions),
        output: retained.output as 'sdr' | 'hdr',
        quality: 100,
        metadata: 'none' as const,
      },
      token: randomUUID(),
    })
    const primary = await page.evaluate(
      async (url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
      proof.primary.url,
    )
    expect(Buffer.from(primary)).toEqual(retained.primary)
    await page.evaluate((id) => window.irodori.releaseOutputProof(id), proof.id)
    await page.evaluate((id) => window.irodori.disposeExportPreparation(id), preparation.id)
  }
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await activateButton(page.getByRole('button', { name: 'Editor', exact: true }))
  await (await revealEditorPhoto(page, id)).click()
  const preview = page.getByTestId('main-preview')
  await expect(preview).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(preview).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
  await expect(preview).toHaveAttribute('data-frame-geometry-revision', String(state.revision), {
    timeout: 60000,
  })
  await expect
    .poll(
      () =>
        preview.evaluate(
          (element) => element.dataset.completedEditSerial === element.dataset.requestedSerial,
        ),
      { timeout: 60000 },
    )
    .toBe(true)
  const browser = await preview.evaluate(async (element) => {
    const canvas = element as HTMLCanvasElement
    const config = canvas.getContext('webgpu')!.getConfiguration()!
    await config.device.queue.onSubmittedWorkDone()
    const adapter = config.device.adapterInfo
    return {
      backend: element.dataset.backend,
      sourceUrl: element.dataset.src,
      revision: element.dataset.frameGeometryRevision,
      adapter: {
        vendor: adapter.vendor,
        architecture: adapter.architecture,
        device: adapter.device,
        description: adapter.description,
        isFallbackAdapter: adapter.isFallbackAdapter,
      },
      format: config.format,
      colorSpace: config.colorSpace,
      toneMapping: config.toneMapping,
    }
  })
  const presentation = await app.evaluate(async ({ app, screen }) => ({
    gpu: await app.getGPUInfo('complete'),
    displays: screen.getAllDisplays(),
  }))
  await info.attach('range-browser-adapters', {
    contentType: 'application/json',
    body: JSON.stringify({ browser, presentation }),
  })
  // Chromium may redact description/device while retaining the active hardware family.
  expect(browser.adapter.isFallbackAdapter).toBe(false)
  if (process.platform === 'darwin') {
    expect(browser.adapter.vendor).toBe('apple')
    expect(JSON.stringify(presentation.gpu)).toMatch(/ANGLE_METAL/)
  }
  expect(JSON.stringify({ browser, presentation })).not.toMatch(/swiftshader|llvmpipe/i)
  expect(await durableBundleHashes(masterDirectory)).toEqual(bundle)
  expect(await managedOriginalHashes(userDataDir, sourcePhotos)).toEqual(originals)
  expect(
    await page.evaluate(
      (ids) => Promise.all(ids.map((id) => window.irodori.getEditHistory(id))),
      sourceIds,
    ),
  ).toEqual(sourceHistories)
  expect(await Promise.all(paths.map(acceptanceHash))).toEqual(entries.map((entry) => entry.sha256))
  await info.attach('genuine-master-range-qualification', {
    contentType: 'application/json',
    body: JSON.stringify({
      sourceIds,
      asset: provenance.manifest.asset,
      recipe: provenance.manifest.recipe,
      bundle,
      bright,
      sample: first.sample,
      geometry: first.context.geometry,
      referenceGeometry: {
        ...referenceGeometry,
        geometry: {
          ...referenceGeometry.geometry,
          correction: referenceGeometry.geometry.correction
            ? {
                ...referenceGeometry.geometry.correction,
                distortion: { samples: referenceGeometry.geometry.correction.distortion.length },
              }
            : undefined,
        },
      },
      coverage,
      browser,
      presentation,
      maximumLocalChange,
      output: outputs.map(({ output, maxCodes, hdrMaximum }) => ({ output, maxCodes, hdrMaximum })),
      limitations:
        'Numerical source and software GPU/output qualification only; no physical HDR luminance or photographic merge-quality certification.',
    }),
  })
})
