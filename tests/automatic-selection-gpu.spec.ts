/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { createObjectSelectionGpu } from '../src/main/object-selection/gpu'
import { refineAutomaticSelection } from '../src/main/object-selection/automatic-gpu'
import { ObjectSelectionProcess } from '../src/main/object-selection/process'
import { sha256 } from '../src/main/object-selection/model'
import { maskCapabilities } from '../src/shared/masks'
import reference from '../assets/tests/references/automatic-selection/guided-filter.json' with { type: 'json' }
import sampling from '../assets/tests/references/automatic-selection/sampling.json' with { type: 'json' }

test('automatic input sizes and normalization agree with frozen independent Torch sampling in RGB units', async () => {
  expect(sha256(await readFile(sampling.generator))).toBe(sampling.generatorSha256)
  expect(sampling.maxRgbError).toBe(1e-6)
  for (const fixture of sampling.fixtures) {
    const rgba = Uint8Array.from({ length: fixture.width * fixture.height * 4 }, (_, index) =>
      index % 4 === 3 ? 255 : (index * 97 + 31) % 256,
    )
    const gpu = await createObjectSelectionGpu(fixture.edge, fixture.normalize, fixture.monochrome)
    try {
      const actual = await gpu.preprocess(rgba, fixture.width, fixture.height)
      for (const sample of fixture.samples) {
        const channel = Math.floor(sample.index / (fixture.edge * fixture.edge))
        const scale = fixture.normalize ? [0.229, 0.224, 0.225][channel] : 1
        expect(Math.abs(actual[sample.index] - sample.value) * scale).toBeLessThanOrEqual(
          sampling.maxRgbError,
        )
      }
    } finally {
      gpu.close()
    }
  }
})

test('both automatic models identify their native GPU provider and physical adapter independently of Dawn', async ({}, info) => {
  test.setTimeout(150000)
  const require = createRequire(import.meta.url)
  const platform = process.platform === 'win32' ? 'win' : process.platform
  const executable = join(
    dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  const output = info.outputPath('native-automatic-ort')
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(
    executable,
    [
      resolve('tests/object-selection-runtime-child.mjs'),
      resolve('out/main/object-selection-model'),
      output,
      'automatic',
    ],
    { env, timeout: 120000, maxBuffer: 1024 * 1024 },
  )
  const report = JSON.parse(await readFile(join(output, 'runtime-device.json'), 'utf8'))
  expect(report.status).toBe('passed')
  expect(report.profiles).toHaveLength(2)
  for (const profile of report.profiles) {
    expect(profile.nodes).toBeGreaterThan(0)
    expect(profile.providers).toEqual(['WebGpuExecutionProvider'])
  }
  if (process.platform === 'linux') expect(report.activeDevices.length).toBeGreaterThan(0)
})

test('RGB guided coverage agrees with independent OpenCV pixels and preserves native odd dimensions', async ({}, info) => {
  expect(sha256(await readFile(reference.generator))).toBe(reference.generatorSha256)
  const rgba = gunzipSync(Buffer.from(reference.rgbaGzipBase64, 'base64'))
  const expected = gunzipSync(Buffer.from(reference.expectedGzipBase64, 'base64'))
  expect(sha256(rgba)).toBe(reference.rgbaSha256)
  expect(sha256(expected)).toBe(reference.expectedSha256)
  const guide = new Float32Array(128 * 128 * 3)
  const mask = new Float32Array(128 * 128)
  for (let i = 0; i < mask.length; i++) {
    for (let c = 0; c < 3; c++) guide[c * mask.length + i] = rgba[i * 4 + c] / 255
    mask[i] = i % 128 >= 64 ? 1 : 0
  }
  const gpu = await createObjectSelectionGpu(128)
  try {
    const actual = await refineAutomaticSelection(gpu.device, rgba, guide, mask, 128, 128, 128)
    await writeFile(info.outputPath('guided-actual.r8'), actual)
    let maximum = 0
    for (let i = 0; i < actual.length; i++)
      maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]))
    expect(maximum).toBeLessThanOrEqual(reference.maxByteError)
    // A model-grid mask must reconstruct every native pixel, including its final packed tail.
    const native = new Uint8Array(513 * 263 * 4).fill(127)
    for (const value of [0, 1]) {
      const result = await refineAutomaticSelection(
        gpu.device,
        native,
        guide,
        new Float32Array(mask.length).fill(value),
        513,
        263,
        128,
      )
      expect(result.byteLength).toBe(513 * 263)
      expect(result.every((pixel) => pixel === value * 255)).toBe(true)
    }
  } finally {
    gpu.close()
  }
})

test('actual sky/background workers produce native editable coverage and explain no-sky without publishing a result', async ({}, info) => {
  test.setTimeout(120000)
  const directory = info.outputPath('native-worker')
  await mkdir(directory, { recursive: true })
  const runtime = new ObjectSelectionProcess({
    workerPath: resolve('out/main/object-selection-worker.js'),
    modelDirectory: resolve('out/main/object-selection-model'),
  })
  const cases = [
    {
      name: 'golden-horizon',
      file: 'tests/fixtures/photos/mountain-ridge.jpg',
      selection: 'sky' as const,
    },
    {
      name: 'blue-needles',
      file: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Treesky.jpg',
      selection: 'sky' as const,
    },
    {
      name: 'sunset-branches',
      file: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Sunset_through_branches_0528.jpg',
      selection: 'sky' as const,
    },
    {
      name: 'storm',
      file: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Storm_clouds_over_a_field.jpg',
      selection: 'sky' as const,
    },
    {
      name: 'architecture',
      file: 'assets/tests/images/raster/wikimedia/sky-selection/originals/Sky_bridge.jpg',
      selection: 'sky' as const,
    },
    {
      name: 'bird-background',
      file: 'assets/tests/images/raster/wikimedia/object-selection/originals/European_Robin_(Erithacus_rubecula)_with_mealworm.jpeg',
      selection: 'background' as const,
    },
  ]
  try {
    for (const fixture of cases) {
      const { data, info: image } = await sharp(fixture.file)
        .rotate()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const path = join(directory, `${fixture.name}.rgba`)
      await writeFile(path, data)
      const source = {
        key: sha256(data),
        path,
        width: image.width,
        height: image.height,
        format: 'rgba8' as const,
      }
      const result = await runtime.run(
        source,
        { key: source.key },
        join(directory, `${fixture.name}.png`),
        new AbortController().signal,
        fixture.selection,
      )
      expect(result).toMatchObject({ width: image.width, height: image.height, key: source.key })
      expect(result.modelIdentity).toContain(fixture.selection)
      expect(result.encodedBytes).toBeLessThanOrEqual(maskCapabilities.maxBaseEncodedBytes)
      const coverage = await sharp(result.path).toColourspace('b-w').raw().toBuffer()
      expect(coverage.byteLength).toBe(image.width * image.height)
      expect(coverage.some((value) => value > 240)).toBe(true)
      expect(coverage.some((value) => value < 15)).toBe(true)
      if (fixture.name === 'sunset-branches') {
        // Orange sky away from the sun, disconnected by branches, must also be selected.
        for (const [x, y] of [
          [0.44, 0.03],
          [0.84, 0.03],
          [0.86, 0.12],
        ])
          expect(
            coverage[Math.floor(y * image.height) * image.width + Math.floor(x * image.width)],
          ).toBeGreaterThan(200)
        expect(
          coverage[Math.floor(0.7 * image.height) * image.width + Math.floor(0.61 * image.width)],
        ).toBeLessThan(50)
      }
      expect(sha256(await readFile(result.path))).toBe(result.sha256)
      // Fit and 1:1 review artifacts stay out of Git.
      await sharp(result.path)
        .resize({ width: 900, height: 700, fit: 'inside' })
        .png()
        .toFile(join(directory, `${fixture.name}-fit.png`))
    }
    const { data, info: image } = await sharp(
      'assets/tests/images/raster/wikimedia/object-selection/originals/Mug_image.jpg',
    )
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const path = join(directory, 'no-sky.rgba'),
      output = join(directory, 'no-sky.png')
    await writeFile(path, data)
    const source = {
      key: sha256(data),
      path,
      width: image.width,
      height: image.height,
      format: 'rgba8' as const,
    }
    await expect(
      runtime.run(source, { key: source.key }, output, new AbortController().signal, 'sky'),
    ).rejects.toThrow(/No sky was found/)
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    // Cancel a fresh automatic operation, drain its owned child, then retry the same source.
    await runtime.close()
    const cancelledOutput = join(directory, 'cancelled.png')
    const cancellation = new AbortController()
    const pending = runtime.run(
      source,
      { key: source.key },
      cancelledOutput,
      cancellation.signal,
      'sky',
    )
    const rejection = expect(pending).rejects.toThrow(/cancelled/i)
    cancellation.abort()
    await rejection
    await expect(readFile(cancelledOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${cancelledOutput}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      runtime.run(source, { key: source.key }, output, new AbortController().signal, 'sky'),
    ).rejects.toThrow(/No sky was found/)
  } finally {
    await runtime.close()
  }
})
