/* eslint-disable no-empty-pattern -- Playwright requires destructured fixtures for TestInfo. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { PreviewEngine } from '../src/main/preview-engine'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { prepareSource } from '../src/main/merge/prepare'
import { mergePreparation } from '../src/main/merge/preparation-policy'
import { detectCaptureSequences } from '../src/shared/capture-sequence'
import { MERGE_VERSION, type MergeSource } from '../src/shared/merge'
import { brkFixtures } from './brk.helpers'
import { nativeMasterCrop } from './brk-native.helpers'
import { scan, commit } from './library.helpers'
import { readSensorCache } from '../src/main/merge/sensor-cache'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { runMerge } from '../src/main/merge/engine'
import { outputHdr, encodeHdr, SDR_TARGET } from '../src/shared/hdr'
import { savePreparation, loadPreparation } from '../src/main/merge/preparation-cache'

const stems = [
  'DSC03243',
  'DSC03268',
  'DSC02040',
  'DSC01961',
  'DSC01964',
  'DSC01967',
  'DSC01984',
  'DSC01999',
  'DSC02002',
  'DSC02008',
  'DSC02058',
  'DSC02088',
  'DSC01940',
  'DSC01533',
]

test('private camera evidence verifies complete, partial, continuous and separate-trigger modes', async () => {
  test.setTimeout(180000)
  const manifest = await brkFixtures()
  test.skip(!manifest, 'Private BRK manifest unavailable; camera acceptance is incomplete.')
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const facts = new Map()
    for (const file of manifest!.files) {
      expect(
        createHash('sha256')
          .update(await readFile(file.path))
          .digest('hex'),
      ).toBe(file.sha256)
      const metadata = await worker.inspectCapture(file.path, new AbortController().signal)
      expect(metadata).toEqual(file.captureMetadata)
      facts.set(file.name, { id: file.sha256, metadata })
    }
    const captures = detectCaptureSequences([...facts.values()].reverse())
    for (const sequence of manifest!.sequences) {
      const ids = sequence.files.map((name) => facts.get(name).id)
      if (sequence.purpose === 'single-shot')
        expect(captures.some((s) => s.ids.some((id) => ids.includes(id)))).toBe(false)
      else
        expect(captures.find((s) => s.ids[0] === ids[0])).toMatchObject({
          ids,
          profile: sequence.profile,
          complete: sequence.complete,
        })
    }
  } finally {
    await worker.close()
  }
})

for (const stem of stems)
  test(`${stem} reaches native Auto Align review, publishes that master and survives restart`, async ({}, info) => {
    test.setTimeout(20 * 60 * 1000)
    const manifest = await brkFixtures()
    test.skip(!manifest, 'Private BRK manifest unavailable; camera acceptance is incomplete.')
    const fixture = manifest!.sequences.find((s) => s.files[0] === `${stem}.ARW`)!
    expect(fixture).toBeDefined()
    const files = fixture.files.map((name) => manifest!.files.find((f) => f.name === name)!),
      root = await mkdtemp(join(tmpdir(), 'luma-brk-native-')),
      workerPath = resolve('out/main/preview-worker.js'),
      make = () =>
        new PhotoLibrary(
          root,
          new PreviewProcess(workerPath),
          () => {},
          undefined,
          async (path) => {
            await rename(path, join(root, 'trash', basename(path)))
          },
          new PreviewProcess(workerPath),
          resolve('out/main/merge-worker.js'),
          undefined,
          new PreviewProcess(workerPath),
        )
    let library = make()
    await mkdir(join(root, 'trash'))
    try {
      await library.open()
      await commit(
        library,
        await scan(
          library,
          files.map((f) => f.path),
        ),
      )
      const photos = library.list().photos,
        review = await library.createMergeReview(
          photos.map((p) => p.id),
          'hdr',
        )
      expect(review.sources).toHaveLength(files.length)
      expect(review.settings.autoAlign).toBe(true)
      for (const source of review.sources) expect(source.captureMetadata?.version).toBe(2)
      let preview
      try {
        preview = await library.requestMergePreview(review.id, review.revision)
      } catch (error) {
        await writeFile(
          info.outputPath('failure.json'),
          JSON.stringify(library.getMergeDiagnostics(review.id, review.revision), null, 2),
        )
        if (process.env.LUMA_TEST_TRACE === '1')
          await cp(
            join(root, 'merge-reviews', review.id, 'prepared'),
            info.outputPath('prepared-failure'),
            { recursive: true },
          )
        throw error
      }
      expect(preview.recipe.version).toBe(MERGE_VERSION)
      expect(preview.recipe.resolution).toBe('native')
      expect(preview.recipe.settings.autoAlign).toBe(true)
      expect(preview.recipe.sources).toHaveLength(files.length)
      expect(preview.recipe.preparation!.capture.complete).toBe(files.length === 3)
      expect(preview.width).toBeGreaterThan(3000)
      expect(preview.width).toBe(preview.recipe.crop.width)
      const output = join(root, 'merge-reviews', review.id, `revision-${review.revision}`)
      for (const source of preview.recipe.sources) {
        expect(source.lensIdentity).toBe(
          review.sources.find((s) => s.photo.id === source.id)!.metadata.lensProfile.identity,
        )
        const diagnostics = source.transform.diagnostics
        if (source.id !== review.settings.referenceId) {
          const photometry = source.photometry!
          expect(photometry.policy.version).toBe('brk-tiled-radiometry-v4')
          expect(photometry.validationSamples).toBeGreaterThanOrEqual(128)
          expect(photometry.validationCells).toBeGreaterThanOrEqual(4)
          expect(photometry.agreement).toBeGreaterThanOrEqual(0.7)
          expect(photometry.medianResidualEv).toBeLessThanOrEqual(0.1)
          expect(Math.abs(photometry.metadataDeltaEv)).toBeLessThanOrEqual(1)
        }
        if (diagnostics) {
          expect(diagnostics.cells).toBeGreaterThanOrEqual(6)
          const patches = diagnostics.nativePatches
          expect(patches.filter((p) => p.accepted).length / patches.length).toBeGreaterThanOrEqual(
            0.7,
          )
          expect(
            patches.filter((p) => p.accepted).every((p) => Math.hypot(p.dx, p.dy) <= 0.5),
          ).toBe(true)
        }
      }
      const crops = [
        [0, 0],
        [preview.width - 512, 0],
        [0, preview.height - 512],
        [preview.width - 512, preview.height - 512],
        [Math.floor(preview.width / 2 - 256), Math.floor(preview.height / 2 - 256)],
      ]
      if (stem === 'DSC03268')
        crops.push(
          [Math.floor(preview.width * 0.4 - 256), Math.floor(preview.height * 0.2 - 256)],
          [Math.floor(preview.width * 0.9 - 256), Math.floor(preview.height * 0.45 - 256)],
        )
      if (stem === 'DSC01999')
        crops.push([400, 450], [2200, 450], [4600, 1450], [1100, 1150], [1550, 1150])
      for (const [index, [left, top]] of crops.entries())
        for (const name of ['result', 'reference']) {
          const safeReference =
              name === 'reference' && !!preview.recipe.measurements?.referenceFallback,
            cropped = name === 'result' || safeReference
          await nativeMasterCrop(
            join(
              output,
              name === 'result'
                ? 'linear.f32'
                : safeReference
                  ? 'reference-linear.f32'
                  : 'reference.f32',
            ),
            cropped ? { width: preview.width, height: preview.height } : preview.recipe,
            {
              left: left + (cropped ? 0 : preview.recipe.crop.left),
              top: top + (cropped ? 0 : preview.recipe.crop.top),
              width: 512,
              height: 512,
            },
            info.outputPath(`${name}-native-${index}.png`),
          )
        }
      await sharp(join(output, 'result.png'))
        .resize({ width: 1200 })
        .toFile(info.outputPath('overview.png'))
      const reviewed = createHash('sha256')
        .update(await readFile(join(output, 'linear.f32')))
        .digest('hex')
      if (stem === 'DSC03268') {
        const previous = process.env.LUMA_MERGE_BACKEND,
          cpuOutput = join(root, 'cpu-comparison')
        try {
          process.env.LUMA_MERGE_BACKEND = 'cpu'
          const cpu = await runMerge({
            directory: join(root, 'merge-reviews', review.id, 'prepared'),
            sources: review.sources,
            paths: review.sources.map((s) => files.find((f) => f.name === s.photo.filename)!.path),
            settings: review.settings,
            recipe: preview.recipe,
            output: cpuOutput,
          })
          expect(cpu.measurements.preparation.every((p) => p.reused)).toBe(true)
          expect(cpu.recipe.affectedPercent).toBeCloseTo(preview.recipe.affectedPercent, 3)
          const handles = await Promise.all(
              [output, cpuOutput].map((p) => open(join(p, 'linear.f32'), 'r')),
            ),
            buffers = handles.map(() => Buffer.alloc(preview.width * 64 * 16))
          let maximum = 0,
            maximumAbsolute = 0,
            totalError = 0,
            samples = 0,
            displayDifference = 0,
            worst: { x: number; y: number; channel: number; gpu: number; cpu: number } | undefined
          try {
            for (let top = 0; top < preview.height; top += 64) {
              const length = Math.min(64, preview.height - top) * preview.width * 16
              for (let i = 0; i < handles.length; i++)
                expect(
                  (await handles[i].read(buffers[i], 0, length, top * preview.width * 16))
                    .bytesRead,
                ).toBe(length)
              const [a, b] = buffers.map(
                (v) => new Float32Array(v.buffer, v.byteOffset, length / 4),
              )
              for (let i = 0; i < a.length; i++) {
                const error = Math.abs(a[i] - b[i])
                maximum = Math.max(maximum, error / (2e-6 + 2e-5 * Math.abs(b[i])))
                totalError += error
                samples++
                if (error > 1 / 65535 && i % 4 !== 3) {
                  const k = i - (i % 4),
                    aa = outputHdr([a[k], a[k + 1], a[k + 2]], SDR_TARGET).rgb,
                    bb = outputHdr([b[k], b[k + 1], b[k + 2]], SDR_TARGET).rgb
                  for (let c = 0; c < 3; c++)
                    displayDifference = Math.max(
                      displayDifference,
                      Math.abs(
                        Math.round(encodeHdr(aa[c]) * 255) - Math.round(encodeHdr(bb[c]) * 255),
                      ),
                    )
                }
                if (error > maximumAbsolute) {
                  maximumAbsolute = error
                  worst = {
                    x: (i >>> 2) % preview.width,
                    y: top + Math.floor((i >>> 2) / preview.width),
                    channel: i % 4,
                    gpu: a[i],
                    cpu: b[i],
                  }
                }
              }
            }
          } finally {
            for (const handle of handles) await handle.close()
          }
          await writeFile(
            info.outputPath('accumulation-agreement.json'),
            JSON.stringify(
              {
                maximumToleranceRatio: maximum,
                maximumAbsolute,
                meanAbsolute: totalError / samples,
                displayDifference,
                worst,
                gpu: preview.recipe.measurements!.accumulation,
                cpu: cpu.measurements.accumulation,
              },
              null,
              2,
            ),
          )
          // Native Float32 warp coordinates differ from CPU doubles at sharp
          // edges. Keep the established linear sensor tolerance, a tighter mean
          // bound and an independent display check for every larger difference.
          expect(maximumAbsolute).toBeLessThanOrEqual(128 / 65535)
          expect(totalError / samples).toBeLessThanOrEqual(1 / 65535)
          expect(displayDifference).toBeLessThanOrEqual(1)
          expect(await readFile(join(cpuOutput, 'motion.mask'))).toEqual(
            await readFile(join(output, 'motion.mask')),
          )
        } finally {
          if (previous === undefined) delete process.env.LUMA_MERGE_BACKEND
          else process.env.LUMA_MERGE_BACKEND = previous
        }
      }
      await writeFile(
        info.outputPath('review.json'),
        JSON.stringify(
          { fixture: fixture.name, reviewedSha256: reviewed, recipe: preview.recipe },
          null,
          2,
        ),
      )
      expect(preview.recipe.measurements!.peak.workerBytes).toBeLessThan(2 * 1024 ** 3)
      const task = library.startMerge(review.id, review.revision)
      await expect
        .poll(() => library.listTasks().find((t) => t.id === task)?.finishedAt, { timeout: 120000 })
        .toBeTruthy()
      const completed = library.listTasks().find((t) => t.id === task)!
      expect(completed.status, JSON.stringify(library.taskErrors(task))).toBe('completed')
      const resultId = completed.resultPhotoId!
      const provenance = await library.getMergeProvenance(resultId)
      expect(provenance.manifest.asset.sha256).toBe(reviewed)
      expect(
        createHash('sha256')
          .update(await readFile(join(root, 'originals', resultId, 'linear.f32')))
          .digest('hex'),
      ).toBe(reviewed)
      for (const file of files)
        expect(
          createHash('sha256')
            .update(await readFile(file.path))
            .digest('hex'),
        ).toBe(file.sha256)
      await library.close()
      library = make()
      await library.open()
      expect(library.list().photos.find((p) => p.id === resultId)?.assetKind).toBe('derived')
      expect((await library.getMergeProvenance(resultId)).manifest.asset.sha256).toBe(reviewed)
      expect((await library.getEdits(resultId)).revision).toBe(0)
    } finally {
      await library.close()
      await rm(root, { recursive: true, force: true })
    }
  })

test('BRK source-specific correction tables and common crop agree on CPU/GPU, including sensor cache', async ({}, info) => {
  test.setTimeout(240000)
  const manifest = await brkFixtures()
  test.skip(!manifest, 'Private BRK manifest unavailable; camera acceptance is incomplete.')
  const fixture = manifest!.sequences.find((s) => s.files[0] === 'DSC02040.ARW')!,
    files = fixture.files.map((name) => manifest!.files.find((f) => f.name === name)!),
    directory = await mkdtemp(join(tmpdir(), 'luma-brk-agreement-')),
    engine = new PreviewEngine(),
    gpu = new RawGpuRenderer(),
    sources: MergeSource[] = []
  try {
    for (const file of files) {
      const metadata = await engine.inspect(file.path),
        session = await librawDecoder.open(file.path)
      try {
        sources.push({
          photo: {
            id: file.sha256,
            filename: file.name,
            width: session.dimensions.width,
            height: session.dimensions.height,
            format: 'ARW',
            bytes: 0,
            importedAt: '',
            thumbnailUrl: '',
            previewUrl: '',
            previewSource: 'decoded',
          },
          capture: metadata.capture!,
          captureMetadata: file.captureMetadata,
          relativeEv: 0,
          metadata,
        })
      } finally {
        session.close()
      }
    }
    const preparation = await mergePreparation(
      files.map((f) => f.path),
      sources,
      {
        mode: 'hdr',
        autoAlign: true,
        autoCrop: true,
        deghost: true,
        strength: 50,
        referenceId: sources[0].photo.id,
      },
      async () => {},
    )
    expect(new Set(sources.map((s) => s.metadata.lensProfile.identity)).size).toBeGreaterThan(1)
    const actual = await prepareSource(
        files[2].path,
        directory,
        0,
        sources[2],
        sources[0],
        gpu,
        undefined,
        preparation,
      ),
      cpu = await prepareSource(
        files[2].path,
        directory,
        1,
        sources[2],
        sources[0],
        undefined,
        undefined,
        preparation,
      )
    expect(actual.measurement?.backend).toBe('gpu')
    expect([actual.width, actual.height]).toEqual([cpu.width, cpu.height])
    const a = await readFile(actual.path),
      b = await readFile(cpu.path),
      aa = new Float32Array(a.buffer, a.byteOffset, a.length / 4),
      bb = new Float32Array(b.buffer, b.byteOffset, b.length / 4),
      sensor = await readSensorCache(actual.sensor!)
    let sum = 0,
      large = 0,
      masks = 0,
      sensorMasks = 0
    for (let i = 0; i < aa.length; i += 4) {
      masks += Number(aa[i + 3] !== bb[i + 3])
      const k = i / 4
      sensorMasks += Number(((sensor.alpha[k >>> 5] >>> (k & 31)) & 1) !== aa[i + 3])
      for (let c = 0; c < 3; c++) {
        const error = Math.abs(aa[i + c] - bb[i + c])
        sum += error
        large += Number(error > 128 / 65535)
      }
    }
    const measurements = {
      mean: sum / ((aa.length / 4) * 3),
      largeFraction: large / ((aa.length / 4) * 3),
      masks,
      sensorMasks,
      preparation,
      gpu: actual.measurement,
      cpu: cpu.measurement,
    }
    await writeFile(info.outputPath('agreement.json'), JSON.stringify(measurements, null, 2))
    expect(measurements.mean).toBeLessThanOrEqual(16 / 65535)
    expect(measurements.largeFraction).toBeLessThanOrEqual(0.002)
    expect(masks).toBe(0)
    expect(sensorMasks).toBe(0)
    expect(sensor.correction).toMatchObject({ ...preparation!.commonCrop })
    expect(actual.cameraRegistration).toBeDefined()
    expect(cpu.cameraRegistration).toBeDefined()
    const cameras = await Promise.all(
        [actual, cpu].map((p) => open(p.cameraRegistration!.path, 'r')),
      ),
      cameraBuffers = cameras.map(() => Buffer.alloc(actual.width * 64 * 16))
    let channelError = 0,
      channelSamples = 0,
      channelMasks = 0,
      strictViolations = 0
    try {
      for (let top = 0; top < actual.height; top += 64) {
        const length = Math.min(64, actual.height - top) * actual.width * 16
        for (let i = 0; i < cameras.length; i++)
          expect(
            (await cameras[i].read(cameraBuffers[i], 0, length, top * actual.width * 16)).bytesRead,
          ).toBe(length)
        const [a, b] = cameraBuffers.map(
          (bytes) => new Float32Array(bytes.buffer, bytes.byteOffset, length / 4),
        )
        for (let i = 0; i < a.length; i += 4) {
          channelMasks += Number(a[i + 3] !== b[i + 3])
          strictViolations += Number(aa[top * actual.width * 4 + i + 3] > 0 && a[i + 3] !== 7)
          for (let c = 0; c < 3; c++)
            if (a[i + 3] & (1 << c)) {
              channelError += Math.abs(a[i + c] - b[i + c])
              channelSamples++
            }
        }
      }
    } finally {
      for (const handle of cameras) await handle.close()
    }
    expect(channelMasks).toBe(0)
    expect(strictViolations).toBe(0)
    expect(channelError / channelSamples).toBeLessThanOrEqual(32 / 65535)
    await savePreparation(directory, 0, sources[0].photo.id, actual)
    expect(
      (await loadPreparation(directory, 0, sources[0].photo.id))!.cameraRegistration!.planes[0]
        .data,
    ).toEqual(actual.cameraRegistration!.planes[0].data)
    const cameraPlanePath = join(directory, 'source-0.camera.plane'),
      cameraBytes = await readFile(cameraPlanePath),
      damaged = Buffer.from(cameraBytes)
    damaged[50] ^= 1
    await writeFile(cameraPlanePath, damaged)
    await expect(loadPreparation(directory, 0, sources[0].photo.id)).rejects.toThrow(
      'Damaged camera registration plane',
    )
    await writeFile(cameraPlanePath, cameraBytes)
    await writeFile(
      info.outputPath('channel-agreement.json'),
      JSON.stringify(
        { mean: channelError / channelSamples, channelMasks, strictViolations },
        null,
        2,
      ),
    )
    await expect(
      prepareSource(
        files[0].path,
        directory,
        2,
        sources[0],
        sources[0],
        gpu,
        async () => {
          throw new Error('Cancelled BRK preparation')
        },
        preparation,
      ),
    ).rejects.toThrow('Cancelled BRK preparation')
  } finally {
    gpu.close()
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})
