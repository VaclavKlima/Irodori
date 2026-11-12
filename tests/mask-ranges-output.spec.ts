/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect, type TestInfo } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { MaskRangeService } from '../src/main/mask-ranges/service'
import { MaskEdgeProcess } from '../src/main/mask-edges/process'
import type { OutputProofs } from '../src/main/export/proofs'
import type { ExportSource } from '../src/main/export/types'
import { defaultExportOptions, type ExportOptions } from '../src/shared/export'
import { identityCrop } from '../src/shared/crop'
import { defaultColorMaskRange } from '../src/shared/mask-ranges'
import { cropAdmission } from './crop-frame.helpers'
import { sourceFor } from './helpers/mask-rendering'
import { readGainJpeg, reconstruct, srgbLinear, to2020 } from './export-reference'

/** Real production owners, with only built-worker paths injected for direct TypeScript imports. */
async function rangeOutputFixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-range-output-'))
  const create = async () => {
    const args: ConstructorParameters<typeof PhotoLibrary> = [
      join(root, 'library'),
      {
        async process() {
          throw new Error('Range output acceptance does not import through the fixture processor.')
        },
        async close() {},
      },
      () => {},
    ]
    args[15] = new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    )
    args[16] = new PreviewProcess(resolve('out/main/preview-worker.js'))
    const library = new PhotoLibrary(...args)
    await library.open()
    library.cropAdmission = async () => cropAdmission()
    library.fullPreviews.installCropAdmission(library.cropAdmission)
    const oldRanges = library.maskRanges
    await oldRanges.close()
    library.maskRanges = new MaskRangeService(
      Reflect.get(oldRanges, 'root'),
      Reflect.get(oldRanges, 'owner'),
      {
        decoder: new PreviewProcess(resolve('out/main/preview-worker.js')),
        runtime: new MaskEdgeProcess({ workerPath: resolve('out/main/mask-edge-worker.js') }),
      },
    )
    const decode: ConstructorParameters<typeof OutputProofs>[7] = async (
      path,
      directory,
      job,
      signal,
    ) => {
      const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
      try {
        return await worker.decodeOutputProof(path, directory, job, signal)
      } finally {
        await worker.close(true)
      }
    }
    Reflect.set(library.outputProofs, 'decode', decode)
    return library
  }
  let library = await create()
  return {
    root,
    get library() {
      return library
    },
    async restart() {
      await library.close()
      library = await create()
    },
    async close() {
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function decodedProof(library: PhotoLibrary, photoId: string, options: ExportOptions) {
  const prepared = await library.exports.prepare([photoId])
  const proof = await library.outputProofs.request('range-acceptance', {
    preparationId: prepared.id,
    photoId,
    options,
    token: randomUUID(),
  })
  const primaryLease = library.outputProofs.acquire(new URL(proof.primary.url))!
  let primary: Buffer
  try {
    primary = await readFile(primaryLease.path)
  } finally {
    primaryLease.release()
  }
  let linear: Buffer | undefined
  if (proof.linear?.url) {
    const lease = library.outputProofs.acquire(new URL(proof.linear.url))!
    try {
      linear = await readFile(lease.path)
    } finally {
      lease.release()
    }
  }
  return {
    prepared,
    proof,
    primary,
    linear,
    release: () => library.outputProofs.release('range-acceptance', proof.id),
  }
}

function difference(a: Uint8Array, b: Uint8Array) {
  expect(a.length).toBe(b.length)
  let maximum = 0
  for (let i = 0; i < a.length; i++)
    if (i % 4 !== 3) maximum = Math.max(maximum, Math.abs(a[i] - b[i]))
  return maximum
}

async function verifyHdr(jpeg: Buffer, linearBytes: Buffer, width: number, height: number) {
  const linear = new Float32Array(
    linearBytes.buffer,
    linearBytes.byteOffset,
    linearBytes.byteLength / 4,
  )
  const parsed = readGainJpeg(jpeg)
  const rgb = await sharp(parsed.primary).removeAlpha().raw().toBuffer()
  const gain = await sharp(parsed.gain, { ignoreIcc: true }).removeAlpha().raw().toBuffer()
  expect(gain.length).toBe(width * height * 3)
  let maximum = 0
  for (const fy of [0.25, 0.5, 0.75])
    for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const index = Math.floor(height * fy) * width + Math.floor(width * fx)
      const reconstructed = reconstruct(
        to2020([0, 1, 2].map((c) => srgbLinear(rgb[index * 3 + c] / 255))),
        [0, 1, 2].map((c) => gain[index * 3 + c] / 255),
        parsed.metadata,
        100,
      )
      for (let c = 0; c < 3; c++)
        maximum = Math.max(maximum, Math.abs(linear[index * 4 + c] - reconstructed[c]))
      expect(linear[index * 4 + 3]).toBe(1)
    }
  expect(maximum).toBeLessThan(0.02)
  return maximum
}

async function publish(library: PhotoLibrary, root: string, source: ExportSource) {
  const directory = join(root, 'library', 'originals', source.photo.id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, source.hdr ? 'original.arw' : 'original.jpg'),
    await readFile(source.path),
  )
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: { ...source.photo, filename: source.hdr ? 'Sony.ARW' : 'Forest.jpg' },
      processingIdentity: source.processing.processing!,
      metadata: source.processing.metadata,
      createdAt: source.photo.importedAt,
    },
  })
}

async function imageEvidence(
  info: TestInfo,
  name: string,
  bytes: Buffer,
  width: number,
  height: number,
) {
  await sharp(bytes, { raw: { width, height, channels: 4 } })
    .resize({ width: 800, height: 700, fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(info.outputPath(`${name}.png`))
}

test('real raster and Sony range edits change pixels and keep frozen SDR/HDR proof-export output through later edits and restart', async ({}, info) => {
  test.setTimeout(240000)
  const f = await rangeOutputFixture()
  const inputs = [
    await sourceFor(resolve('tests/fixtures/photos/forest-light.jpg')),
    await sourceFor(resolve('tests/fixtures/sony-zv1.ARW'), true),
  ]
  try {
    for (const [index, input] of inputs.entries()) {
      await publish(f.library, f.root, input)
      const id = input.photo.id
      const crop = input.hdr
        ? { ...identityCrop, width: 0.05, height: 0.05, quarterTurns: 1 as const, angle: 1.25 }
        : { ...identityCrop, width: 0.7, height: 0.7, quarterTurns: 1 as const, angle: 2 }
      let state = await f.library.updateEdits(id, { crop }, 0)
      const context = await f.library.getMaskContext(id, state.revision)
      const sample = await f.library.sampleMaskRange({
        photoId: id,
        expectedRevision: state.revision,
        renderingIdentity: context.renderingIdentity,
        point: { x: 0.5, y: 0.5 },
      })
      expect(sample.color).not.toBeNull()
      const options: ExportOptions = {
        ...structuredClone(defaultExportOptions),
        output: input.hdr ? 'hdr' : 'sdr',
        quality: 100,
        metadata: 'none',
      }
      const baseline = await decodedProof(f.library, id, options)
      const original = baseline.primary
      const baseDimensions = { width: baseline.proof.width, height: baseline.proof.height }
      await baseline.release()
      f.library.exports.dispose(baseline.prepared.id)
      const rootId = randomUUID(),
        partId = randomUUID()
      const radius = input.hdr ? 0.015 : 0.15
      const aspect = context.geometry.canonicalHeight / context.geometry.canonicalWidth
      state = await f.library.mutateMasks(id, state.revision, {
        operations: [
          {
            kind: 'create',
            id: rootId,
            name: 'Source color',
            range: defaultColorMaskRange(sample.color!),
          },
          {
            kind: 'component-add',
            id: rootId,
            componentId: partId,
            name: 'Spatial intersection',
            operator: 'intersect',
            gradient: {
              kind: 'radial',
              center: sample.canonicalPoint,
              radiusX: radius * aspect,
              radiusY: radius,
              rotation: 0,
              feather: 20,
            },
          },
          {
            kind: 'update',
            id: rootId,
            light: { exposureEv: 0.8 },
            color: { saturation: 8 },
            edge: { featherPx: 2.5, shiftPx: 1 },
          },
        ],
      })
      const acceptedSettings = structuredClone(state.settings)
      const edited = await decodedProof(f.library, id, options)
      expect({ width: edited.proof.width, height: edited.proof.height }).toEqual(baseDimensions)
      const maximumChange = difference(original, edited.primary)
      expect(maximumChange).toBeGreaterThan(4)
      for (const fy of [0.05, 0.95])
        for (const fx of [0.05, 0.95]) {
          const x = Math.floor(edited.proof.width * fx),
            y = Math.floor(edited.proof.height * fy)
          let outsideDifference = 0
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
              for (let c = 0; c < 3; c++) {
                const at = ((y + dy) * edited.proof.width + x + dx) * 4 + c
                outsideDifference = Math.max(
                  outsideDifference,
                  Math.abs(original[at] - edited.primary[at]),
                )
              }
          expect(outsideDifference, `Unmasked corner ${fx},${fy}`).toBeLessThanOrEqual(2)
        }
      await imageEvidence(
        info,
        `range-${index}-neutral`,
        original,
        edited.proof.width,
        edited.proof.height,
      )
      await imageEvidence(
        info,
        `range-${index}-edited`,
        edited.primary,
        edited.proof.width,
        edited.proof.height,
      )
      const directory = info.outputPath(`range-${index}-export`)
      await mkdir(directory, { recursive: true })
      const destination = await f.library.exports.store.authorize(directory)
      const frozenSource = f.library.exports.acquireProofSource(edited.prepared.id, id)
      let frozen: ExportSource
      try {
        frozen = structuredClone(frozenSource.source)
      } finally {
        frozenSource.release()
      }
      const jobId = await f.library.exports.start({
        preparationId: edited.prepared.id,
        destinationId: destination.id,
        action: 'custom',
        options,
      })
      state = await f.library.mutateMasks(id, state.revision, {
        operations: [{ kind: 'update', id: rootId, light: { exposureEv: -0.8 } }],
      })
      expect(frozen.processing.adjustments!.localMasks![0].light.exposureEv).toBe(0.8)
      await expect
        .poll(() => f.library.exports.list().find((task) => task.id === jobId)?.status, {
          timeout: 120000,
        })
        .not.toMatch(/^(running|cancelling)$/)
      const task = f.library.exports.list().find((task) => task.id === jobId)!
      expect(task, task.detail).toMatchObject({
        status: 'completed',
        export: { exported: 1, failed: 0 },
      })
      const file = f.library.exports.store.files(jobId)[0]
      expect(file.status, file.message).toBe('exported')
      const jpeg = await readFile(join(directory, file.outputName!))
      const decoded = await sharp(jpeg)
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect(difference(decoded.data, edited.primary)).toBeLessThanOrEqual(2)
      const hdrMaximum = input.hdr
        ? await verifyHdr(jpeg, edited.linear!, edited.proof.width, edited.proof.height)
        : null
      await edited.release()
      const changedContext = await f.library.getMaskContext(id, state.revision)
      const changedSample = await f.library.sampleMaskRange({
        photoId: id,
        expectedRevision: state.revision,
        renderingIdentity: changedContext.renderingIdentity,
        point: { x: 0.5, y: 0.5 },
      })
      expect(changedSample.sourceIdentity).toBe(sample.sourceIdentity)
      expect(changedSample.color).toEqual(sample.color)
      expect(changedSample.luminance).toBe(sample.luminance)
      const undone = await f.library.undoEdit(id, state.revision)
      expect(undone.settings).toEqual(acceptedSettings)
      const saved = structuredClone(undone.settings)
      await f.restart()
      expect((await f.library.getEdits(id)).settings).toEqual(saved)
      const restored = await decodedProof(f.library, id, options)
      expect(restored.primary).toEqual(edited.primary)
      await restored.release()
      f.library.exports.dispose(restored.prepared.id)
      await info.attach(`range-${index}-output-scope`, {
        contentType: 'application/json',
        body: JSON.stringify({
          fixture: input.path,
          sourceSha256: input.photo.id,
          sourceIdentity: sample.sourceIdentity,
          nativeCrop: baseDimensions,
          range: acceptedSettings.maskStack[0].range,
          edges: acceptedSettings.maskStack[0].edge,
          maximumChange,
          proofExportMaximumCodes: 2,
          hdrMaximum,
          frozenRevision: edited.proof.revision,
          savedSettingsVersion: saved.version,
        }),
      })
    }
  } finally {
    await f.close()
  }
})
