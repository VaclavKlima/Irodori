import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { LibRaw } from '@colorhythm/libraw-wasm'
import { openCv } from '../src/main/merge/opencv'
import { loadUltraHdr, halfFloat } from '../src/main/export/codec'
import { distribution } from '../scripts/research/pipeline/metrics'
import { provenance } from '../scripts/research/pipeline/provenance'
import sharp from 'sharp'
import { attachResearchEvidence } from './research.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

const exec = promisify(execFile)
const binary = (component: string) =>
  process.env[`LUMA_RESEARCH_${component.toUpperCase().replaceAll('-', '_')}_BINARY`] ??
  resolve(`artifacts/research-build/${process.platform}-${process.arch}/${component}`)
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('equivalent single-thread LibRaw WASM/native camera-linear output and source preservation', async ({}, info) => {
  test.setTimeout(300000)
  const native = binary('libraw')
  test.skip(
    !existsSync(native),
    'Native LibRaw is not built; run node scripts/research/build-native.mjs libraw with the matching development package. No WASM/native conclusion.',
  )
  await LibRaw.initialize()
  const fixture = resolve('tests/fixtures/sony-zv1.ARW'),
    bytes = await readFile(fixture),
    times: number[] = [],
    nativeTimes: number[] = [],
    nativeCompute: number[] = [],
    cold: unknown[] = []
  let maximum = 0,
    sum = 0,
    samples = 0,
    library = '',
    aboveTwo = 0
  let worst: unknown
  for (let i = 0; i < 30; i++) {
    const decoder = new LibRaw()
    await decoder.waitUntilReady()
    try {
      const at = performance.now()
      decoder.open(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      decoder.setHalfSize(0)
      decoder.setDemosaic(3)
      decoder.setUseCameraWb(1)
      decoder.setOutputColor(0)
      decoder.setOutputBps(16)
      decoder.setGamma(0, 1)
      decoder.setGamma(1, 1)
      decoder.setNoAutoBright(1)
      decoder.unpack()
      decoder.dcrawProcess()
      const result = decoder.dcrawMakeMemImage()
      times.push(performance.now() - at)
      const path = info.outputPath('native-output.rgb16'),
        nativeAt = performance.now()
      const child = await exec(native, [fixture, path], {
        env: { ...process.env, OMP_NUM_THREADS: '1', OMP_DYNAMIC: 'FALSE' },
      })
      const meta = JSON.parse(child.stdout)
      nativeCompute.push(meta.computeMs)
      nativeTimes.push(performance.now() - nativeAt)
      library = meta.library
      if (i < 5)
        cold.push({
          job: i,
          nativeWorkerLaunchThroughOutputMs: nativeTimes.at(-1),
          wasmWarmedModuleFreshDecoderMs: times.at(-1),
        })
      expect([meta.width, meta.height]).toEqual([result.width, result.height])
      const data = await readFile(path)
      expect(data.byteLength).toBe(result.data.byteLength)
      const actual = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2),
        expected = new Uint16Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength / 2,
        )
      for (let p = 0; p < expected.length; p++) {
        const d = Math.abs(actual[p] - expected[p])
        if (d > maximum) {
          maximum = d
          worst = {
            observation: i,
            x: Math.floor(p / 3) % result.width,
            y: Math.floor(p / (3 * result.width)),
            channel: p % 3,
            native: actual[p],
            wasm: expected[p],
          }
        }
        aboveTwo += Number(d > 2)
        sum += d
        samples++
      }
    } finally {
      decoder.dispose()
    }
  }
  await writeFile(
    info.outputPath('libraw-measurements.json'),
    JSON.stringify(
      {
        provenance: await provenance([
          'tests/fixtures/sony-zv1.ARW',
          'scripts/research/native/libraw.cpp',
          'src/main/processing/decoders/libraw.ts',
        ]),
        wasmVersion: LibRaw.version(),
        nativeVersion: library,
        nativeBuild: JSON.parse(await readFile(`${native}.json`, 'utf8')),
        threads: 1,
        cold,
        wasmMs: distribution(times),
        nativeLaunchAndDiskMs: distribution(nativeTimes),
        nativeComputeMs: distribution(nativeCompute),
        maximumUint16Difference: maximum,
        aboveTwoFraction: aboveTwo / samples,
        worst,
        meanUint16Difference: sum / samples,
        limitation:
          'Native includes launch and logical output write; WASM keeps module warm. Native SIMD/compiler configuration requires manifest review. Unoriented memory-image output compared before current sensor normalization.',
      },
      null,
      2,
    ),
  )
  expect((await readFile(fixture)).equals(bytes)).toBe(true)
  test.skip(
    library !== LibRaw.version(),
    'Decoder versions differ; equivalence remains incomplete. Evidence retained.',
  )
  expect(maximum).toBeLessThanOrEqual(2)
})
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('existing masked OpenCV ECC bridge versus equivalent native call at one thread before bounded parallelism', async ({}, info) => {
  test.setTimeout(120000)
  const native = binary('opencv')
  test.skip(
    !existsSync(native),
    'Native OpenCV 4.13.0 is not built; run node scripts/research/build-native.mjs opencv. Custom SIMD patch kernels are not covered by the ECC experiment.',
  )
  const width = 192,
    height = 128
  const a = Float32Array.from(
    { length: width * height },
    (_, i) =>
      0.5 +
      Math.sin((i % width) / 5) * Math.cos(Math.floor(i / width) / 7) * 0.2 +
      Math.sin(i * 0.31) * 0.05,
  )
  const b = Float32Array.from(a, (v, i) => (i % width > 1 ? a[i - 1] : v)),
    mask = new Uint8Array(a.length).fill(255)
  const paths = ['a.f32', 'b.f32', 'a.mask', 'b.mask'].map((name) => info.outputPath(name))
  for (const [index, data] of [a, b, mask, mask].entries())
    await writeFile(paths[index], new Uint8Array(data.buffer))
  const cv = await openCv(),
    cases: unknown[] = []
  const wasm: number[] = [],
    nativeMs: number[] = []
  for (const threads of [1, 2, 4]) {
    let matrixDifference = 0
    const nativeObservations: number[] = [],
      computeObservations: number[] = []
    for (let i = 0; i < 30; i++) {
      const at = performance.now()
      const reference = cv.ecc({ data: a, width, height, mask }, { data: b, width, height, mask })
      const wasmMs = performance.now() - at
      const nativeAt = performance.now(),
        child = await exec(native, [String(width), String(height), ...paths, String(threads)])
      const result = JSON.parse(child.stdout)
      nativeObservations.push(performance.now() - nativeAt)
      computeObservations.push(result.computeMs)
      expect(result.library).toBe('4.13.0')
      expect(reference.correlation).toBeGreaterThan(0.9)
      expect(result.score).toBeGreaterThan(0.9)
      for (let c = 0; c < 9; c++)
        matrixDifference = Math.max(
          matrixDifference,
          Math.abs(reference.matrix[c] - result.matrix[c]),
        )
      if (threads === 1) {
        wasm.push(wasmMs)
        nativeMs.push(performance.now() - nativeAt)
      }
    }
    cases.push({
      threads,
      maximumMatrixDifference: matrixDifference,
      nativeLaunchMs: distribution(nativeObservations),
      nativeComputeMs: distribution(computeObservations),
    })
  }
  await writeFile(
    info.outputPath('opencv-measurements.json'),
    JSON.stringify(
      {
        provenance: await provenance([
          'scripts/opencv/bridge.cpp',
          'scripts/research/native/opencv.cpp',
          'vendor/opencv/SHA256SUMS',
        ]),
        wasmMs: distribution(wasm),
        nativeBuild: JSON.parse(await readFile(`${native}.json`, 'utf8')),
        nativeLaunchMs: distribution(nativeMs),
        cases,
        limitation:
          'Synthetic ECC calibration only; not native-detail patch registration or real RAW merge acceptance.',
      },
      null,
      2,
    ),
  )
  for (const result of cases as { maximumMatrixDifference: number }[])
    expect(result.maximumMatrixDifference).toBeLessThan(1e-3)
})
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('single-thread native/WASM HDR JPEG encoding retains dimensions, gain-map metadata and reconstruction', async ({}, info) => {
  test.setTimeout(180000)
  const native = binary('hdr-1')
  test.skip(
    !existsSync(native),
    'Single-thread research Ultra HDR is not built. Reuse verified archives from build:export-native, then run node scripts/research/build-native.mjs hdr-1. Linux evidence remains incomplete on macOS.',
  )
  const width = 256,
    height = 192,
    half = new Uint16Array(width * height * 4)
  for (let i = 0; i < half.length; i++)
    half[i] = halfFloat(i % 4 === 3 ? 1 : 0.01 + ((i % (width * 4)) / (width * 4)) * 8)
  const jpeg = await sharp({
    create: { width, height, channels: 3, background: { r: 110, g: 100, b: 90 } },
  })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer()
  const halfPath = info.outputPath('input.half'),
    jpegPath = info.outputPath('primary.jpg')
  await writeFile(halfPath, new Uint8Array(half.buffer))
  await writeFile(jpegPath, jpeg)
  const codec = await loadUltraHdr(),
    wasmMs: number[] = [],
    nativeMs: number[] = [],
    sizes: unknown[] = []
  let maxReconstruction = 0
  for (let i = 0; i < 30; i++) {
    let at = performance.now()
    const reference = codec.encode(new Uint8Array(half.buffer), width, height, jpeg, 100, 10)
    wasmMs.push(performance.now() - at)
    at = performance.now()
    const output = info.outputPath(`native-${i}.jpg`)
    const result = await exec(native, [String(width), String(height), halfPath, jpegPath, output])
    nativeMs.push(performance.now() - at)
    const encoded = await readFile(output),
      actual = codec.inspect(encoded, 10),
      expected = codec.inspect(reference, 10)
    expect(actual.info).toEqual(expected.info)
    expect([actual.info[18], actual.info[19]]).toEqual([width, height])
    expect(actual.map.length).toBeGreaterThan(0)
    for (let p = 0; p < actual.pixels!.length; p++)
      maxReconstruction = Math.max(
        maxReconstruction,
        Math.abs(actual.pixels![p] - expected.pixels![p]),
      )
    sizes.push({
      wasm: reference.length,
      native: encoded.length,
      compute: JSON.parse(result.stdout),
    })
  }
  await writeFile(
    info.outputPath('hdr-codec-measurements.json'),
    JSON.stringify(
      {
        provenance: await provenance([
          'scripts/ultrahdr/bridge.cpp',
          'scripts/research/native/hdr.cpp',
          'vendor/ultrahdr/SHA256SUMS',
        ]),
        nativeBuild: JSON.parse(await readFile(`${native}.json`, 'utf8')),
        width,
        height,
        quality: 100,
        gainMapScale: 1,
        threads: 1,
        wasmMs: distribution(wasmMs),
        nativeLaunchAndDiskMs: distribution(nativeMs),
        maximumHalfCodeDifference: maxReconstruction,
        sizes,
        linuxAcceptance:
          process.platform === 'linux'
            ? 'local codec calibration; full exports still required'
            : 'incomplete: requires the Bazzite system',
        limitation:
          'Synthetic encoder calibration, not original-size exports, real photographs, batch quality, or HDR interoperability certification.',
      },
      null,
      2,
    ),
  )
  expect(maxReconstruction).toBeLessThanOrEqual(2)
})
