import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { PreviewEngine } from '../src/main/preview-engine'
import { prepareSource, type PreparedSource } from '../src/main/merge/prepare'
import { syntheticMerge } from './merge.helpers'
import { runMerge } from '../src/main/merge/engine'
import { savePreparation, loadPreparation } from '../src/main/merge/preparation-cache'
import { ALIGNMENT_CONSTANTS, type MergeSource, type MergeSettings } from '../src/shared/merge'
import { gpuOutput } from '../src/main/merge/gpu-output'
import { outputHdr, encodeHdr, SDR_TARGET, luminance } from '../src/shared/hdr'
import { librawDecoder } from '../src/main/processing/decoders/libraw'
import { correctionPlan } from '../src/main/processing/lens-correction'
import { unavailableProfile } from '../src/main/processing/metadata'
import { coverageGpu } from '../src/main/merge/gpu-coverage'
import { coverage, noiseVariance, motionDifferent } from '../src/main/merge/math'
import { identityTransform } from '../src/main/merge/alignment'
import { saveSensorCache, readSensorCache, packedBits } from '../src/main/merge/sensor-cache'
import { accumulateGpu } from '../src/main/merge/gpu-accumulation'
import { band, resetMergeReads } from '../src/main/merge/sampling'

test('merge GPU preparation applies every sensor orientation exactly once with clipping masks', async () => {
  const session = await librawDecoder.open('tests/fixtures/sony-zv1.ARW'),
    gpu = new RawGpuRenderer(),
    engine = new PreviewEngine(),
    metadata = await engine.inspect('tests/fixtures/sony-zv1.ARW'),
    directory = await mkdtemp(join(tmpdir(), 'luma-sensor-agreement-'))
  try {
    const original = session.gpuSource(true)!,
      width = 64,
      height = 48,
      pixels = new Uint16Array(width * height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) pixels[y * width + x] = 1500 + x * 40 + y * 20
    // An unclipped red patch exercises signed camera conversion and values above white.
    for (let y = 20; y < 40; y++)
      for (let x = 30; x < 54; x++) {
        const c = original.cfa[(y % 2) * 2 + (x % 2)]
        pixels[y * width + x] =
          c === 0
            ? original.normalization!.sourceSaturation!.thresholds[c] - 512
            : original.black[c] + 16
      }
    pixels[12 * width + 10] = original.normalization!.sourceSaturation!.thresholds[original.cfa[0]]
    const raw = { ...original, width, height, rawWidth: width, left: 0, top: 0, pixels },
      plan = correctionPlan(width, height, unavailableProfile, {
        distortion: false,
        vignetting: false,
        chromaticAberration: false,
      })
    let baseline: Float32Array | undefined
    for (let flip = 0; flip < 8; flip++) {
      const strips: Buffer[] = [],
        frame = await gpu.render({ ...raw, flip }, plan, undefined, false, false, {
          gains: original.normalization!.gains.slice(0, 3),
          reviewWidth: 8,
          reviewHeight: 6,
          checkpoint: async () => {},
          strip: async (_, bytes) => {
            strips.push(Buffer.from(bytes))
          },
        }),
        buffer = Buffer.concat(strips),
        data = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      expect([frame.width, frame.height]).toEqual(flip & 4 ? [height, width] : [width, height])
      if (!flip) baseline = data
      let maximumError = 0
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          let sx = flip & 4 ? y : x,
            sy = flip & 4 ? x : y
          if (flip & 1) sx = width - 1 - sx
          if (flip & 2) sy = height - 1 - sy
          for (let c = 0; c < 4; c++)
            maximumError = Math.max(
              maximumError,
              Math.abs(data[(y * frame.width + x) * 4 + c] - baseline![(sy * width + sx) * 4 + c]),
            )
        }
      expect(maximumError).toBe(0)
      const alpha = new Uint8Array(frame.width * frame.height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
      const path = join(directory, `source-${flip}.f32`)
      await writeFile(path, buffer)
      const prepared: PreparedSource = {
          path,
          strips: [createHash('sha256').update(buffer).digest('hex')],
          width: frame.width,
          height: frame.height,
          normalization: original.normalization!,
          decoder: 'fixture',
          cameraProfile: 'sony-zv1',
          plane: { width: 1, height: 1, data: new Float32Array([1]) },
          sensor: await saveSensorCache(
            directory,
            flip,
            { ...raw, flip },
            original.normalization!.gains.slice(0, 3),
            plan,
            packedBits(alpha),
          ),
        },
        settings: MergeSettings = {
          mode: 'noise',
          autoAlign: false,
          autoCrop: true,
          deghost: true,
          strength: 65,
          referenceId: 'a'.repeat(64),
        },
        sources = ['a', 'b'].map((id) => ({
          photo: {
            id: id.repeat(64),
            filename: 'fixture.ARW',
            width: frame.width,
            height: frame.height,
            bytes: 0,
            format: 'ARW',
            importedAt: '',
            thumbnailUrl: '',
            previewUrl: '',
            previewSource: 'decoded',
          },
          metadata,
          capture: metadata.capture!,
          relativeEv: 0,
        })) as MergeSource[],
        transforms = [
          identityTransform(),
          {
            ...identityTransform(),
            matrix: [
              1,
              -1 / 512,
              0.3125,
              1 / 512,
              1,
              0.6875,
              1 / 65536,
              -1 / 131072,
              1,
            ] as import('../src/shared/merge').MergeMatrix,
            tiles: {
              columns: 2,
              rows: 2,
              width: frame.width,
              height: frame.height,
              offsets: [0.1, -0.1, -0.15, 0.1, 0.05, -0.15, 0.1, 0.05],
            },
            diagnostics: {
              algorithm: ALIGNMENT_CONSTANTS.version,
              model: 'identity' as const,
              matches: 0,
              inliers: 0,
              cells: 0,
              nativePatches: [],
              movingRegions: [{ left: 12, top: 6, width: 18, height: 8 }],
              runtimeMs: 0,
              wasmMemoryBytes: 0,
            },
          },
        ],
        scales = [0.7, 1.3],
        common = coverage(frame.width, frame.height, transforms).mask,
        motion = new Uint8Array(alpha.length),
        featherPixels = flip & 1 ? 8 : 0,
        output = join(directory, `output-${flip}`)
      await mkdir(output)
      resetMergeReads()
      const result = await accumulateGpu(
        gpu,
        [prepared, prepared],
        sources,
        transforms,
        scales,
        settings,
        common,
        motion,
        frame,
        output,
        async () => {},
        featherPixels,
      )
      expect(result.kernel).toBe('sensor-warp')
      expect(result.peakBytes).toBeLessThanOrEqual(1024 ** 3)
      const actualBytes = await readFile(join(output, 'accumulation.f32')),
        actual = new Float32Array(
          actualBytes.buffer,
          actualBytes.byteOffset,
          actualBytes.length / 4,
        ),
        gets = await Promise.all(transforms.map((t) => band(prepared, t, 0, frame.height))),
        value = [0, 0, 0, 0],
        expectedMotion = new Uint8Array(alpha.length)
      let maximum = 0
      for (let y = 0; y < frame.height; y++)
        for (let x = 0; x < frame.width; x++) {
          const k = y * frame.width + x,
            i = k * 4,
            sum = [0, 0, 0, 0],
            refY = luminance([data[i], data[i + 1], data[i + 2]])
          for (let s = 0; s < 2; s++) {
            // Independent distance to the rectangular exclusion in reference coordinates.
            const distance = Math.max(12 - x, 0, x - 29) + Math.max(6 - y, 0, y - 13),
              d = featherPixels ? Math.min(1, distance / featherPixels) : Number(distance > 0),
              confidence =
                s === 0
                  ? 1
                  : distance
                    ? Math.max(1, Math.round(d * d * (3 - 2 * d) * 255)) / 255
                    : 0
            if (!common[k] || !confidence || !gets[s](x, y, value) || !value[3]) continue
            const v = noiseVariance(luminance(value), scales[s], sources[s].capture.iso),
              weight = confidence / v
            if (
              s === 1 &&
              data[i + 3] &&
              motionDifferent(
                luminance(value) / scales[s],
                refY,
                v + noiseVariance(refY, 1, sources[0].capture.iso),
                settings.strength,
              )
            )
              expectedMotion[k] = 1
            for (let c = 0; c < 3; c++) sum[c] += (value[c] / scales[s]) * weight
            sum[3] += weight
          }
          for (let c = 0; c < 3; c++) {
            const expected = sum[3] ? sum[c] / sum[3] : data[i + c]
            maximum = Math.max(
              maximum,
              Math.abs(actual[i + c] - expected) / (2e-6 + 2e-5 * Math.abs(expected)),
            )
          }
          expect(actual[i + 3]).toBe(Number(common[k] > 0 && sum[3] > 0))
        }
      expect(maximum).toBeLessThanOrEqual(1)
      expect(motion).toEqual(expectedMotion)
      expect(await readFile(join(output, 'reference.f32'))).toEqual(buffer)
      expect(result.referenceReused).toBe(true)
      const bandOutput = join(directory, `prepared-${flip}`),
        bandMotion = new Uint8Array(alpha.length),
        withoutSensor = { ...prepared, sensor: undefined }
      await mkdir(bandOutput)
      const bandResult = await accumulateGpu(
        gpu,
        [withoutSensor, withoutSensor],
        sources,
        transforms,
        scales,
        settings,
        common,
        bandMotion,
        frame,
        bandOutput,
        async () => {},
        featherPixels,
      )
      expect(bandResult.kernel).toBe('prepared-bands')
      const bandBytes = await readFile(join(bandOutput, 'accumulation.f32')),
        bandPixels = new Float32Array(bandBytes.buffer, bandBytes.byteOffset, bandBytes.length / 4)
      let bandError = 0
      for (let i = 0; i < actual.length; i++)
        bandError = Math.max(
          bandError,
          Math.abs(bandPixels[i] - actual[i]) / (2e-6 + 2e-5 * Math.abs(actual[i])),
        )
      expect(bandError).toBeLessThanOrEqual(1)
      expect(bandMotion).toEqual(expectedMotion)
      if (flip === 7) {
        const cancelled = new RawGpuRenderer(),
          cancelOutput = join(directory, 'cancelled'),
          abort = new AbortController()
        await mkdir(cancelOutput)
        let checkpoints = 0
        try {
          await expect(
            accumulateGpu(
              cancelled,
              [prepared, prepared],
              sources,
              transforms,
              scales,
              settings,
              common,
              new Uint8Array(alpha.length),
              frame,
              cancelOutput,
              async () => {
                if (++checkpoints === 3) abort.abort(new Error('Cancelled sensor accumulation.'))
                abort.signal.throwIfAborted()
              },
              featherPixels,
            ),
          ).rejects.toThrow('Cancelled sensor accumulation')
          expect(cancelled.failure).toBe('Cancelled sensor accumulation.')
          expect(await readFile(prepared.path)).toEqual(buffer)
        } finally {
          cancelled.close()
        }
        await expect(
          gpu.render({ ...raw, flip }, undefined, undefined, false, false, undefined, {
            reservedBytes: 1024 ** 3,
            checkpoint: async () => {},
            consume: async () => {
              throw new Error('An over-budget consumer must never run.')
            },
          }),
        ).rejects.toThrow('GPU processing memory limit')
      }
    }
    expect(baseline![(12 * width + 10) * 4 + 3]).toBe(0)
    expect(baseline![(30 * width + 30) * 4 + 3]).toBe(1)
    expect(baseline!.some((v, i) => i % 4 !== 3 && v < 0)).toBe(true)
    expect(baseline!.some((v, i) => i % 4 !== 3 && v > 1)).toBe(true)
  } finally {
    session.close()
    gpu.close()
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('native GPU coverage matches independent double-precision projective and tile geometry', async () => {
  test.setTimeout(120000)
  const renderer = new RawGpuRenderer(),
    width = 5496,
    height = 3672,
    transforms = [
      identityTransform(),
      {
        ...identityTransform(),
        matrix: [
          0.997, -0.004, 5.25, 0.004, 0.997, -3.5, 1e-7, -1.5e-7, 1,
        ] as import('../src/shared/merge').MergeMatrix,
        tiles: {
          columns: 2,
          rows: 2,
          width,
          height,
          offsets: [0.3, -0.2, -0.1, 0.4, 0.25, -0.15, -0.35, 0.1],
        },
      },
    ]
  try {
    const gpu = await coverageGpu(renderer, width, height, transforms, async () => {}),
      cpu = coverage(width, height, transforms)
    expect(gpu.crop).toEqual(cpu.crop)
    expect(Buffer.from(gpu.mask).equals(Buffer.from(cpu.mask))).toBe(true)
    expect(gpu.peakBytes).toBeLessThanOrEqual(1024 ** 3)
  } finally {
    renderer.close()
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('merge GPU preparation agrees with independent LibRaw CPU preparation and device-failure fallback', async ({}, info) => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'luma-merge-gpu-')),
    engine = new PreviewEngine(),
    gpu = new RawGpuRenderer(),
    broken = new RawGpuRenderer()
  try {
    const path = 'tests/fixtures/sony-zv1.ARW',
      metadata = await engine.inspect(path)
    const source: MergeSource = {
      photo: {
        id: 'a'.repeat(64),
        filename: 'sony-zv1.ARW',
        width: 5496,
        height: 3672,
        bytes: 0,
        format: 'ARW',
        importedAt: '',
        thumbnailUrl: '',
        previewUrl: '',
        previewSource: 'decoded',
      },
      capture: metadata.capture!,
      metadata,
      relativeEv: 0,
    }
    broken.render = async () => {
      throw new Error('GPU device lost during preparation.')
    }
    const actual = await prepareSource(path, directory, 0, source, source, gpu),
      cpu = await prepareSource(path, directory, 1, source, source, broken)
    expect(actual.measurement?.backend, JSON.stringify(actual.measurement)).toBe('gpu')
    expect(cpu.measurement).toMatchObject({
      backend: 'cpu',
      fallback: 'GPU device lost during preparation.',
    })
    expect([actual.width, actual.height]).toEqual([cpu.width, cpu.height])
    const a = await readFile(actual.path),
      b = await readFile(cpu.path),
      cached = await readSensorCache(actual.sensor!),
      aa = new Float32Array(a.buffer, a.byteOffset, a.length / 4),
      bb = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
    let sum = 0,
      large = 0,
      negative = 0,
      above = 0,
      masks = 0,
      sensorMasks = 0
    for (let i = 0; i < aa.length; i += 4) {
      masks += Number(aa[i + 3] !== bb[i + 3])
      const k = i / 4
      sensorMasks += Number(((cached.alpha[k >>> 5] >>> (k & 31)) & 1) !== aa[i + 3])
      for (let c = 0; c < 3; c++) {
        const e = Math.abs(aa[i + c] - bb[i + c])
        sum += e
        large += Number(e > 128 / 65535)
        negative += Number(aa[i + c] < 0)
        above += Number(aa[i + c] > 1)
      }
    }
    const measurements = {
      gpu: actual.measurement,
      cpu: cpu.measurement,
      mean: sum / ((aa.length / 4) * 3),
      largeFraction: large / ((aa.length / 4) * 3),
      masks,
      negative,
      above,
    }
    await info.attach('merge-preparation-agreement', {
      body: JSON.stringify(measurements),
      contentType: 'application/json',
    })
    expect(measurements.mean).toBeLessThanOrEqual(16 / 65535)
    expect(measurements.largeFraction).toBeLessThanOrEqual(0.002)
    expect(masks).toBe(0)
    expect(sensorMasks).toBe(0)
    expect(negative).toBeGreaterThan(0)
    expect(above).toBeGreaterThan(0)
    expect(actual.sensor).toBeDefined()
    for (const plane of [actual.sensor!.sensor, actual.sensor!.alpha, actual.sensor!.lens]) {
      const bytes = await readFile(plane.path),
        damaged = Buffer.from(bytes)
      damaged[50] ^= 1
      await writeFile(plane.path, damaged)
      await expect(readSensorCache(actual.sensor!)).rejects.toThrow('Damaged merge sensor cache')
      await writeFile(plane.path, bytes)
    }
    await savePreparation(directory, 0, source.photo.id, actual)
    expect((await loadPreparation(directory, 0, source.photo.id))?.plane.data).toEqual(
      actual.plane.data,
    )
    const bytes = await readFile(join(directory, 'source-0.plane'))
    bytes[50] ^= 1
    await writeFile(join(directory, 'source-0.plane'), bytes)
    await expect(loadPreparation(directory, 0, source.photo.id)).rejects.toThrow(
      'Damaged merge preparation plane',
    )
  } finally {
    gpu.close()
    broken.close()
    await engine.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('tiled GPU warp, accumulation, deghost and output agree with independent CPU bands', async () => {
  test.setTimeout(120000)
  const f = await syntheticMerge([0.25, 1, 4], {
      width: 256,
      height: 2051,
      motion: true,
      deghost: true,
    }),
    previous = process.env.LUMA_MERGE_BACKEND
  try {
    const recipe = structuredClone(f.result.recipe)
    recipe.resolution = 'preview'
    recipe.sources[0].transform.matrix![2] = 1.25
    recipe.sources[2].transform.matrix![5] = -0.75
    recipe.sources[0].transform.tiles = {
      columns: 2,
      rows: 2,
      width: 256,
      height: 2051,
      offsets: [0.2, -0.3, -0.1, 0.1, 0.15, -0.2, -0.25, 0.05],
    }
    for (const s of [0, 2])
      recipe.sources[s].transform.diagnostics = {
        algorithm: ALIGNMENT_CONSTANTS.version,
        model: 'identity',
        matches: 0,
        inliers: 0,
        cells: 0,
        nativePatches: [],
        movingRegions: [{ left: s === 0 ? 0 : 110, top: 150, width: 150, height: 280 }],
        runtimeMs: 0,
        wasmMemoryBytes: 0,
      }
    const gpu = await runMerge({
      ...f.job,
      recipe,
      comparisons: true,
      output: join(f.directory, 'gpu'),
    })
    expect(gpu.measurements.accumulation.backend, JSON.stringify(gpu.measurements)).toBe('gpu')
    expect(gpu.measurements.coverage, JSON.stringify(gpu.measurements)).toEqual({ backend: 'gpu' })
    expect(gpu.measurements.output, JSON.stringify(gpu.measurements)).toMatchObject({
      backend: 'gpu',
      conversion: {
        batches: Math.ceil(gpu.asset.height / 64) + 1,
        pairedBatches: Math.ceil(gpu.asset.height / 64),
        images: Math.ceil(gpu.asset.height / 64) * 2 + 1,
      },
    })
    process.env.LUMA_MERGE_BACKEND = 'cpu'
    const cpu = await runMerge({
      ...f.job,
      recipe,
      comparisons: true,
      output: join(f.directory, 'cpu'),
    })
    expect(cpu.measurements.accumulation.backend).toBe('cpu')
    const a = await readFile(join(f.directory, 'gpu', 'linear.f32')),
      b = await readFile(join(f.directory, 'cpu', 'linear.f32')),
      aa = new Float32Array(a.buffer, a.byteOffset, a.length / 4),
      bb = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
    expect(a.length).toBe(b.length)
    let maximum = 0
    for (let i = 0; i < aa.length; i++)
      maximum = Math.max(maximum, Math.abs(aa[i] - bb[i]) / (2e-6 + 2e-5 * Math.abs(bb[i])))
    expect(maximum).toBeLessThanOrEqual(1)
    const renderer = new RawGpuRenderer()
    try {
      const converter = await gpuOutput(renderer, 512),
        pixels = new Float32Array(bb.slice(0, 512 * 4)),
        bytes = await converter.convert(pixels)
      try {
        const first = await converter.convert(pixels.subarray(0, 256 * 4)),
          second = await converter.convert(pixels.subarray(256 * 4)),
          paired = await converter.convert(pixels.subarray(0, 256 * 4), pixels.subarray(256 * 4))
        expect(paired).toEqual(Buffer.concat([first, second]))
        expect(bytes).toEqual(paired)
        const short = pixels.subarray(0, 11 * 4),
          shortExpected = await converter.convert(short),
          shortPair = await converter.convert(short, short)
        expect(shortPair).toEqual(Buffer.concat([shortExpected, shortExpected]))
        await expect(converter.convert(pixels, pixels)).rejects.toThrow(
          'Output tile exceeds its allocation.',
        )
        for (let i = 0; i < 512; i++) {
          const expected = outputHdr(
            [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]],
            SDR_TARGET,
          ).rgb
          for (let c = 0; c < 3; c++)
            expect(
              Math.abs(bytes[i * 4 + c] - Math.round(encodeHdr(expected[c]) * 255)),
            ).toBeLessThanOrEqual(1)
          expect(bytes[i * 4 + 3]).toBe(Math.round(pixels[i * 4 + 3] * 255))
        }
      } finally {
        converter.close()
      }
    } finally {
      renderer.close()
    }
    expect(await readFile(join(f.directory, 'gpu', 'motion.mask'))).toEqual(
      await readFile(join(f.directory, 'cpu', 'motion.mask')),
    )
    const sharp = (await import('sharp')).default
    for (const name of ['result', 'reference', 'overlay'] as const) {
      const filename = `${name}.png`
      for (const [directory, result] of [
        ['gpu', gpu],
        ['cpu', cpu],
      ] as const) {
        const asset = result.asset,
          raw = await readFile(join(f.directory, directory, `${name}.rgba`)),
          current = await readFile(join(f.directory, directory, filename)),
          currentLevel = name === 'overlay' ? 1 : 0
        expect(result.measurements.output?.work?.png[name]?.compressionLevel).toBe(currentLevel)
        // All lossless levels share the same raw scanlines and worst-case
        // stream bound, including alpha and the partial final native strip.
        const encodedBound = asset.width * asset.height * 5 + 1024 ** 2
        for (const level of [0, 1, 6] as const) {
          const encoded =
            level === currentLevel
              ? current
              : await sharp(raw, {
                  raw: { width: asset.width, height: asset.height, channels: 4 },
                })
                  .png({ compressionLevel: level })
                  .toBuffer()
          expect(encoded.byteLength, `${directory} level ${level} ${filename}`).toBeLessThanOrEqual(
            encodedBound,
          )
          const decoded = await sharp(encoded)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
          expect(decoded.info).toMatchObject({
            width: asset.width,
            height: asset.height,
            channels: 4,
          })
          expect(decoded.data.byteLength).toBe(asset.width * asset.height * 4)
          expect(decoded.data, `${directory} level ${level} lossless RGBA ${filename}`).toEqual(raw)
        }
      }
      const ar = await sharp(join(f.directory, 'gpu', filename))
          .raw()
          .toBuffer(),
        br = await sharp(join(f.directory, 'cpu', filename))
          .raw()
          .toBuffer()
      expect(ar.length).toBe(br.length)
      let difference = 0
      for (let i = 0; i < ar.length; i++) difference = Math.max(difference, Math.abs(ar[i] - br[i]))
      expect(difference, filename).toBeLessThanOrEqual(1)
    }
    const reused = await runMerge({
      ...f.job,
      settings: { ...f.job.settings, strength: 65 },
      output: join(f.directory, 'reused'),
    })
    expect(reused.measurements.attempts).toHaveLength(0)
    expect(reused.measurements.preparation.every((p) => p.reused)).toBe(true)
    expect(reused.measurements.preparation.every((p) => !p.work && !p.gpu)).toBe(true)
    delete process.env.LUMA_MERGE_BACKEND
    const method = RawGpuRenderer.prototype.mergeDevice
    RawGpuRenderer.prototype.mergeDevice = async () => {
      throw new Error('GPU device lost during accumulation.')
    }
    try {
      const fallback = await runMerge({ ...f.job, recipe, output: join(f.directory, 'fallback') })
      expect(fallback.measurements.accumulation).toMatchObject({
        backend: 'cpu',
        fallback: 'GPU device lost during accumulation.',
      })
      expect(await readFile(join(f.directory, 'fallback', 'linear.f32'))).toEqual(b)
    } finally {
      RawGpuRenderer.prototype.mergeDevice = method
    }
    const map = GPUBuffer.prototype.mapAsync,
      range = GPUBuffer.prototype.getMappedRange,
      tileReadbackBytes = 256 * 1024 * 36
    let tileReadbacks = 0
    GPUBuffer.prototype.mapAsync = function (mode, offset, size) {
      if (this.size === tileReadbackBytes && ++tileReadbacks === 2)
        return Promise.reject(new Error('GPU device lost after partial accumulation.'))
      return map.call(this, mode, offset, size)
    }
    GPUBuffer.prototype.getMappedRange = function (offset, size) {
      const bytes = range.call(this, offset, size)
      if (this.size === tileReadbackBytes && tileReadbacks === 1) {
        // A failed attempt's previously returned mask must never reach the CPU result.
        const mask = new Uint32Array(bytes, 256 * 1024 * 32, 256 * 1024)
        mask[20 * 256 + 200] = 1
      }
      return bytes
    }
    try {
      const fallback = await runMerge({
        ...f.job,
        recipe,
        output: join(f.directory, 'partial-fallback'),
      })
      expect(tileReadbacks).toBe(2)
      expect(fallback.measurements.accumulation).toMatchObject({
        backend: 'cpu',
        fallback: 'GPU device lost after partial accumulation.',
      })
      expect(await readFile(join(f.directory, 'partial-fallback', 'linear.f32'))).toEqual(b)
      expect(await readFile(join(f.directory, 'partial-fallback', 'motion.mask'))).toEqual(
        await readFile(join(f.directory, 'cpu', 'motion.mask')),
      )
    } finally {
      GPUBuffer.prototype.mapAsync = map
      GPUBuffer.prototype.getMappedRange = range
    }
  } finally {
    if (previous === undefined) delete process.env.LUMA_MERGE_BACKEND
    else process.env.LUMA_MERGE_BACKEND = previous
    await f.close()
  }
})
