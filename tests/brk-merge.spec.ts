import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MergeReviews } from '../src/main/merge/reviews'
import {
  ALIGNMENT_CONSTANTS,
  MERGE_PIPELINE,
  MERGE_LIMITS,
  validateMergeSources,
  verifiedBracket,
} from '../src/shared/merge'
import { loadPreparation, savePreparation } from '../src/main/merge/preparation-cache'
import { syntheticMerge } from './merge.helpers'
import { bracketFrames } from './brk.helpers'
import { identityTransform, eccHypothesis } from '../src/main/merge/alignment'
import { resizedTransform } from '../src/main/merge/matrix'
import { patchRegistrationCandidate, motionMeasurements } from '../src/main/merge/motion-alignment'
import { validateGlobalNative } from '../src/main/merge/native-alignment'
import { refineExposure } from '../src/main/merge/math'
import { estimateBracketExposure } from '../src/main/merge/exposure'
import { sourceExclusionBand, packedExclusionConfidence } from '../src/main/merge/exclusions'
import {
  CAMERA_REGISTRATION_POLICY,
  cameraRegistrationWriter,
  registrationSources,
} from '../src/main/merge/camera-registration'
import {
  prepareSource,
  prepareReferenceFallback,
  type PreparedSource,
} from '../src/main/merge/prepare'
import { registerNative } from '../src/main/merge/registration'
import { rawDecoders } from '../src/main/processing/decoders'
import type { RawSession, LinearFrame } from '../src/main/processing/contracts'
import type { RawSource } from '../src/main/gpu/raw-source'
import { matrixRgb, SRGB_TO_2020, luminance } from '../src/shared/hdr'
import { sensorBlendParameters, sensorBlendRgb } from '../src/main/gpu/sensor-blend'
import { correctionPlan, radial } from '../src/main/processing/lens-correction'
import { unavailableProfile } from '../src/main/processing/metadata'
import { automaticLensSettings, type LensProfile } from '../src/shared/lens'
import { areaContributions } from '../src/main/merge/area'

const numericLensProfile: LensProfile = {
  provider: 'test',
  version: '1',
  label: 'Non-identity numeric lens',
  identity: 'numeric-vignette-distortion-ca-1',
  distortion: { radii: [0, 0.5, 1], values: [1, 1.02, 1.06] },
  vignetting: { radii: [0, 0.5, 1], values: [1, 1.2, 1.6] },
  chromaticAberration: {
    red: { radii: [0, 0.5, 1], values: [1, 0.998, 0.995] },
    blue: { radii: [0, 0.5, 1], values: [1, 1.003, 1.008] },
  },
  unavailable: {},
}

function numericCameraFrame(height = 17) {
  const width = 139,
    data = new Float32Array(width * height * 4),
    rawWidth = width + 5,
    pixels = new Uint16Array(rawWidth * (height + 2)).fill(1200),
    normalization = {
      black: [0, 0, 0, 0],
      maximum: 4095,
      gains: [2, 1, 1.5, 1],
      restoreGain: 2,
      referenceWhite: 1,
      sourceSaturation: {
        thresholds: [3800, 3800, 3800, 3800],
        saturatedSites: 1,
        totalSites: width * height,
      },
    },
    frame: LinearFrame = {
      width,
      height,
      flip: 5,
      data,
      matrix: [1.8, -0.6, -0.2, 0, -0.1, 1.2, -0.1, 0, -0.1, -0.6, 1.7, 0],
      normalization,
    },
    raw: RawSource = {
      width,
      height,
      rawWidth,
      left: 2,
      top: 1,
      flip: 5,
      pixels,
      cfa: [0, 1, 3, 2],
      black: normalization.black,
      scale: [1, 1, 1, 1],
      matrix: frame.matrix,
      normalization,
    }
  pixels[(8 + raw.top) * rawWidth + 70 + raw.left] = 4000
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          0.02 + (x / (width - 1)) * 0.9,
          0.03 + (y / (height - 1)) * 0.45,
          0.02 + ((x + y) % 7) / 21,
          1,
        ],
        (y * width + x) * 4,
      )
  return { width, height, data, normalization, frame, raw, rawWidth }
}

test('camera registration reuses strips without changing native evidence, masks or area reduction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-camera-strip-'))
  try {
    let index = 0
    for (const profile of [unavailableProfile, numericLensProfile])
      for (const clipped of [false, true]) {
        const { raw } = numericCameraFrame(71)
        if (!clipped) {
          raw.pixels.fill(1200)
          raw.normalization!.sourceSaturation!.saturatedSites = 0
        }
        const plan = correctionPlan(raw.width, raw.height, profile, automaticLensSettings),
          width = plan.height,
          height = plan.width,
          rgba = Float32Array.from({ length: width * height * 4 }, (_, i) =>
            i % 4 === 3 ? 1 : (i % 31) / 17 - 0.2,
          ),
          runs = []
        for (const rows of [64, 128]) {
          const writer = await cameraRegistrationWriter(directory, index++, raw, plan, 7, 11)
          try {
            for (let top = 0; top < height; top += rows) {
              const pixels = rgba.subarray(
                top * width * 4,
                Math.min(height, top + rows) * width * 4,
              )
              await writer.write(
                top,
                Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
              )
            }
            const result = await writer.finish()
            expect((await readFile(result.path)).length).toBe(rgba.byteLength)
            expect(result.strips).toHaveLength(Math.ceil(height / 64))
            runs.push(result)
          } finally {
            await writer.close()
          }
        }
        expect((await readFile(runs[0].path)).equals(await readFile(runs[1].path))).toBe(true)
        expect(runs[0].strips).toEqual(runs[1].strips)
        expect(runs[0].planes).toEqual(runs[1].planes)
        const bytes = await readFile(runs[0].path),
          pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
          xs = areaContributions(width, 7),
          ys = areaContributions(height, 11),
          values = Array.from({ length: 3 }, () => new Float64Array(77)),
          weights = Array.from({ length: 3 }, () => new Float64Array(77)),
          totals = new Float64Array(77)
        // Retain the prior tuple-iterator accumulation as an independent reference.
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4,
              valid = pixels[at + 3]
            for (const [px, wx] of xs[x])
              for (const [py, wy] of ys[y]) {
                const p = py * 7 + px,
                  weight = wx * wy
                totals[p] += weight
                for (let c = 0; c < 3; c++)
                  if (valid & (1 << c) && pixels[at + c] > MERGE_LIMITS.readNoise * 3) {
                    values[c][p] += pixels[at + c] * weight
                    weights[c][p] += weight
                  }
              }
          }
        for (let c = 0; c < 3; c++) {
          const data = new Float32Array(77),
            mask = new Uint8Array(77)
          for (let p = 0; p < 77; p++) {
            mask[p] = weights[c][p] > 0 && Math.abs(weights[c][p] - totals[p]) < 1e-8 ? 255 : 0
            data[p] = mask[p] ? values[c][p] / weights[c][p] : 0
          }
          expect(runs[0].planes[c]).toEqual({ width: 7, height: 11, data, mask })
        }
      }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CPU strip preparation preserves exact matrix rounding, sensor masks and portrait coordinates', async () => {
  const decoder = rawDecoders[0],
    originalOpen = decoder.open
  const f = await syntheticMerge([1, 1, 1], { width: 139, height: 17 })
  const source = f.sources[0],
    { width, height, data, normalization, frame, raw, rawWidth } = numericCameraFrame()
  let active = 0,
    opened = 0,
    closed = 0
  decoder.open = async () => {
    opened++
    active++
    expect(active).toBe(1)
    let processed = false
    return {
      dimensions: { width, height, flip: 5 },
      metadata: {
        hdrEligible: true,
        make: 'Sony',
        model: 'ZV-1',
        rawWidth,
        rawHeight: 19,
        left: 2,
        top: 1,
        colors: 3,
        cfa: raw.cfa,
      },
      unpack: () => {},
      gpuSource: () => structuredClone(raw),
      linear: () => {
        expect(processed).toBe(false)
        processed = true
        return structuredClone(frame)
      },
      display: () => {
        throw new Error('Display decoding is outside this numeric fixture.')
      },
      close: () => {
        active--
        closed++
      },
    } satisfies RawSession
  }
  try {
    for (const highlightSafe of [false, true]) {
      const directory = join(
        f.directory,
        highlightSafe ? 'highlight-safe-numeric' : 'linear-numeric',
      )
      await mkdir(directory)
      const result = highlightSafe
          ? await prepareReferenceFallback(
              'numeric.ARW',
              directory,
              0,
              source,
              source,
              async () => {},
              {
                policy: MERGE_PIPELINE.preparation,
                capture: verifiedBracket(
                  f.sources.map((s, i) => ({ ...s, captureMetadata: bracketFrames()[i].metadata })),
                )!,
                commonCrop: { left: 0, top: 0, width, height },
                sources: [
                  {
                    id: source.photo.id,
                    width,
                    height,
                    flip: 5,
                    lensIdentity: source.metadata.lensProfile.identity,
                  },
                ],
              },
            )
          : await prepareSource('numeric.ARW', directory, 0, source, source),
        camera = data.slice(),
        blend = sensorBlendParameters(normalization),
        expected = new Float32Array(width * height * 4),
        expectedPlane = new Float32Array(width * height),
        expectedMask = new Uint8Array(width * height),
        gains = source.metadata.whiteBalance!.asShotGains
      if (highlightSafe)
        for (let i = 0; i < camera.length; i += 4)
          if (
            camera[i] > blend!.saturation[0] ||
            camera[i + 1] > blend!.saturation[1] ||
            camera[i + 2] > blend!.saturation[2]
          )
            camera.set(sensorBlendRgb([camera[i], camera[i + 1], camera[i + 2]], blend), i)
      // Identity lens geometry makes every sample an exact native point. Keep
      // the original array-based Float64 matrix reference independent of the hot loop.
      for (let y = 0; y < width; y++)
        for (let x = 0; x < height; x++) {
          const sx = width - 1 - y,
            sy = x,
            from = (sy * width + sx) * 4,
            at = (y * height + x) * 4,
            clipped = Math.abs(sx - 70) <= 2 && Math.abs(sy - 8) <= 2,
            rgb = [0, 1, 2].map(
              (c) =>
                (((camera[from + c] * Math.max(...normalization.gains)) / normalization.gains[c]) *
                  gains[c]) /
                Math.min(...gains),
            ),
            converted = matrixRgb(
              SRGB_TO_2020,
              [0, 1, 2].map(
                (c) =>
                  frame.matrix[c * 4] * rgb[0] +
                  frame.matrix[c * 4 + 1] * rgb[1] +
                  frame.matrix[c * 4 + 2] * rgb[2],
              ),
            ),
            value = Math.max(0, luminance(converted)),
            valid = !clipped && value > MERGE_LIMITS.readNoise * 3
          expected.set([...converted, Number(!clipped)], at)
          expectedPlane[at / 4] = valid ? value : 0
          expectedMask[at / 4] = valid ? 255 : 0
        }
      const bytes = await readFile(result.path),
        expectedBytes = Buffer.from(expected.buffer)
      expect([result.width, result.height]).toEqual([height, width])
      expect(bytes.equals(expectedBytes)).toBe(true)
      expect(result.plane.data).toEqual(expectedPlane)
      expect(result.plane.mask).toEqual(expectedMask)
      expect(result.strips).toEqual(
        Array.from({ length: 3 }, (_, i) =>
          createHash('sha256')
            .update(expectedBytes.subarray(i * 64 * height * 16, (i + 1) * 64 * height * 16))
            .digest('hex'),
        ),
      )
      expect(result.measurement!.decoder!.opens).toBe(1)
    }
    expect({ opened, closed, active }).toEqual({ opened: 2, closed: 2, active: 0 })
  } finally {
    decoder.open = originalOpen
    await f.close()
  }
})

test('CPU vignette cache preserves uncached Float64 sampling with distortion, CA and eviction', async () => {
  const decoder = rawDecoders[0],
    originalOpen = decoder.open,
    fixture = numericCameraFrame(71),
    { width, height, data, normalization, frame, raw, rawWidth } = fixture,
    f = await syntheticMerge([1, 1, 1], { width, height }),
    source = f.sources[0],
    plan = correctionPlan(width, height, numericLensProfile, automaticLensSettings),
    outputWidth = plan.height,
    outputHeight = plan.width,
    cx = (width - 1) / 2,
    cy = (height - 1) / 2,
    radius = Math.hypot(cx, cy)
  source.metadata.lensProfile = numericLensProfile
  let active = 0,
    opened = 0,
    closed = 0
  decoder.open = async () => {
    opened++
    active++
    expect(active).toBe(1)
    let processed = false
    return {
      dimensions: { width, height, flip: 5 },
      metadata: {
        hdrEligible: true,
        make: 'Sony',
        model: 'ZV-1',
        rawWidth,
        rawHeight: height + 2,
        left: 2,
        top: 1,
        colors: 3,
        cfa: raw.cfa,
      },
      unpack: () => {},
      gpuSource: () => structuredClone(raw),
      linear: () => {
        expect(processed).toBe(false)
        processed = true
        return structuredClone(frame)
      },
      display: () => {
        throw new Error('Display decoding is outside this numeric fixture.')
      },
      close: () => {
        active--
        closed++
      },
    } satisfies RawSession
  }
  try {
    expect(plan.applied).toEqual(automaticLensSettings)
    expect(plan.left).toBeGreaterThan(0)
    expect(plan.top).toBeGreaterThan(0)
    for (const highlightSafe of [false, true]) {
      const directory = join(f.directory, highlightSafe ? 'cached-safe' : 'cached-linear')
      await mkdir(directory)
      const result = highlightSafe
          ? await prepareReferenceFallback(
              'numeric.ARW',
              directory,
              0,
              source,
              source,
              async () => {},
              {
                policy: MERGE_PIPELINE.preparation,
                capture: verifiedBracket(
                  f.sources.map((s, i) => ({ ...s, captureMetadata: bracketFrames()[i].metadata })),
                )!,
                commonCrop: {
                  left: plan.left,
                  top: plan.top,
                  width: plan.width,
                  height: plan.height,
                },
                sources: [
                  {
                    id: source.photo.id,
                    width,
                    height,
                    flip: 5,
                    lensIdentity: numericLensProfile.identity,
                  },
                ],
              },
            )
          : await prepareSource('numeric.ARW', directory, 0, source, source),
        camera = data.slice(),
        blend = sensorBlendParameters(normalization),
        expected = new Float32Array(outputWidth * outputHeight * 4),
        expectedPlane = new Float32Array(outputWidth * outputHeight),
        expectedMask = new Uint8Array(outputWidth * outputHeight),
        gains = source.metadata.whiteBalance!.asShotGains,
        sampledCoordinates = new Set<number>()
      if (highlightSafe)
        for (let i = 0; i < camera.length; i += 4)
          if (
            camera[i] > blend!.saturation[0] ||
            camera[i + 1] > blend!.saturation[1] ||
            camera[i + 2] > blend!.saturation[2]
          )
            camera.set(sensorBlendRgb([camera[i], camera[i + 1], camera[i + 2]], blend), i)
      // The original uncached tap loop deliberately repeats every radial lookup
      // and array-based matrix operation; no cached value enters this reference.
      for (let y = 0; y < outputHeight; y++)
        for (let x = 0; x < outputWidth; x++) {
          const sx = plan.width - 1 - y,
            sy = x,
            qx = sx + plan.left - cx,
            qy = sy + plan.top - cy,
            r = Math.hypot(qx, qy) / radius,
            cameraRgb = [0, 0, 0]
          let clipped = false
          for (let c = 0; c < 3; c++) {
            const scale = radial(plan.lut, r, c),
              px = cx + qx * scale,
              py = cy + qy * scale,
              ix = Math.floor(px),
              iy = Math.floor(py),
              dx = px - ix,
              dy = py - iy
            let value = 0
            for (let yy = 0; yy < 2; yy++)
              for (let xx = 0; xx < 2; xx++) {
                const tx = Math.max(0, Math.min(width - 1, ix + xx)),
                  ty = Math.max(0, Math.min(height - 1, iy + yy)),
                  weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy)
                sampledCoordinates.add(ty * width + tx)
                value +=
                  camera[(ty * width + tx) * 4 + c] *
                  weight *
                  radial(plan.lut, Math.hypot(tx - cx, ty - cy) / radius, 3)
                if (weight > 0 && Math.abs(tx - 70) <= 2 && Math.abs(ty - 8) <= 2) clipped = true
              }
            cameraRgb[c] =
              (((value * Math.max(...normalization.gains)) / normalization.gains[c]) * gains[c]) /
              Math.min(...gains)
          }
          const converted = matrixRgb(
              SRGB_TO_2020,
              [0, 1, 2].map(
                (c) =>
                  frame.matrix[c * 4] * cameraRgb[0] +
                  frame.matrix[c * 4 + 1] * cameraRgb[1] +
                  frame.matrix[c * 4 + 2] * cameraRgb[2],
              ),
            ),
            at = (y * outputWidth + x) * 4,
            value = Math.max(0, luminance(converted)),
            valid = !clipped && value > MERGE_LIMITS.readNoise * 3
          expected.set([...converted, Number(!clipped)], at)
          expectedPlane[at / 4] = valid ? value : 0
          expectedMask[at / 4] = valid ? 255 : 0
        }
      // More distinct native coordinates than cache slots force tag collisions.
      expect(sampledCoordinates.size).toBeGreaterThan(2048)
      expect(expected.some((v, i) => i % 4 !== 3 && v < 0)).toBe(true)
      expect(expected.some((v, i) => i % 4 === 3 && v === 0)).toBe(true)
      expect(expected.some((v, i) => i % 4 === 3 && v === 1)).toBe(true)
      const bytes = await readFile(result.path),
        expectedBytes = Buffer.from(expected.buffer)
      expect([result.width, result.height]).toEqual([outputWidth, outputHeight])
      expect(bytes.equals(expectedBytes)).toBe(true)
      expect(result.plane.data).toEqual(expectedPlane)
      expect(result.plane.mask).toEqual(expectedMask)
      expect(result.strips).toEqual(
        Array.from({ length: Math.ceil(outputHeight / 64) }, (_, i) =>
          createHash('sha256')
            .update(
              expectedBytes.subarray(i * 64 * outputWidth * 16, (i + 1) * 64 * outputWidth * 16),
            )
            .digest('hex'),
        ),
      )
      expect(result.measurement!.decoder!.opens).toBe(1)
    }
    expect({ opened, closed, active }).toEqual({ opened: 2, closed: 2, active: 0 })
  } finally {
    decoder.open = originalOpen
    await f.close()
  }
})

async function cameraEvidence(mode: 'photograph' | 'flat' | 'stripes' | 'clipping' | 'parallax') {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-camera-registration-')),
    width = 512,
    height = 384,
    count = width * height,
    photograph =
      mode === 'photograph' || mode === 'parallax'
        ? await (
            await import('sharp')
          )
            .default('tests/fixtures/photos/forest-light.jpg')
            .resize(width, height)
            .greyscale()
            .raw()
            .toBuffer()
        : undefined,
    sources: PreparedSource[] = []
  const signal = (x: number, y: number) =>
    photograph
      ? 0.04 + (photograph[y * width + x] / 255) * 0.35
      : mode === 'stripes'
        ? 0.2 + 0.1 * Math.sin(x / 3)
        : 0.2
  try {
    for (let frame = 0; frame < 2; frame++) {
      const rgba = new Float32Array(count * 4),
        camera = new Float32Array(count * 4),
        red = new Float32Array(count),
        redMask = new Uint8Array(count),
        fusion = new Float32Array(count),
        fusionMask = new Uint8Array(count)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const at = y * width + x,
            shift = frame
              ? mode === 'photograph'
                ? -3
                : mode === 'parallax'
                  ? x < width / 2
                    ? 4
                    : -4
                  : 0
              : 0,
            sx = x + shift,
            valid =
              sx >= 0 && sx < width && (mode !== 'clipping' || x < width * (frame ? 0.65 : 0.45)),
            value = signal(Math.max(0, Math.min(width - 1, sx)), y) * (frame ? 0.5 : 1)
          red[at] = valid ? value : 0
          redMask[at] = valid ? 255 : 0
          // Green and blue clip; the surviving red evidence is never fusion alpha.
          camera.set([value, 4, 4, valid ? 1 : 0], at * 4)
          rgba.set([value, 4, 4, 0], at * 4)
        }
      const path = join(directory, `source-${frame}.f32`),
        cameraPath = join(directory, `source-${frame}.camera.f32`),
        strips = (pixels: Float32Array) =>
          Array.from({ length: Math.ceil(height / 64) }, (_, row) =>
            createHash('sha256')
              .update(
                Buffer.from(pixels.buffer).subarray(
                  row * 64 * width * 16,
                  Math.min(pixels.byteLength, (row + 1) * 64 * width * 16),
                ),
              )
              .digest('hex'),
          )
      await writeFile(path, Buffer.from(rgba.buffer))
      await writeFile(cameraPath, Buffer.from(camera.buffer))
      sources.push({
        path,
        strips: strips(rgba),
        width,
        height,
        plane: { width, height, data: fusion, mask: fusionMask },
        decoder: 'isolated-camera-evidence-test',
        cameraProfile: 'synthetic',
        normalization: {
          black: [0, 0, 0, 0],
          maximum: 1,
          gains: [1, 1, 1, 1],
          restoreGain: 1,
          referenceWhite: 1,
          sourceSaturation: null,
        },
        cameraRegistration: {
          version: CAMERA_REGISTRATION_POLICY,
          path: cameraPath,
          strips: strips(camera),
          planes: [
            { width, height, data: red, mask: redMask },
            { width, height, data: fusion.slice(), mask: fusionMask.slice() },
            { width, height, data: fusion.slice(), mask: fusionMask.slice() },
          ],
        },
      })
    }
    return { sources, close: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('unclipped camera-channel evidence aligns a photograph while fusion masks stay strict', async () => {
  const fixture = await cameraEvidence('photograph')
  try {
    const [reference, source] = fixture.sources,
      original = fixture.sources.map((s) => ({ path: s.path, plane: s.plane, strips: s.strips })),
      selected = registrationSources([reference, reference, source]),
      repeated = registrationSources([reference, reference, source])
    expect(selected.channel).toBe('red')
    expect(selected.sources[0]).toBe(selected.sources[1])
    expect(repeated.sources[0]).toBe(selected.sources[0])
    expect(selected.sources[0].path).toBe(reference.cameraRegistration!.path)
    expect(
      registrationSources([reference, { ...source, cameraRegistration: undefined }]).channel,
    ).toBeUndefined()
    const result = await registerNative(
        reference,
        reference,
        source,
        identityTransform(),
        async () => {},
      ),
      diagnostics = result.transform.diagnostics!,
      accepted = diagnostics.nativePatches.filter((p) => p.accepted)
    expect(diagnostics.registrationChannel).toBe('red')
    expect(accepted.length).toBeGreaterThanOrEqual(8)
    expect(accepted.length / diagnostics.nativePatches.length).toBeGreaterThanOrEqual(0.7)
    expect(result.transform.matrix![2]).toBeCloseTo(3, 0)
    expect(result.transform.matrix![5]).toBeCloseTo(0, 0)
    fixture.sources.forEach((prepared, i) => {
      expect(prepared.path).toBe(original[i].path)
      expect(prepared.plane).toBe(original[i].plane)
      expect(prepared.strips).toBe(original[i].strips)
      expect(prepared.registrationChannel).toBeUndefined()
      expect(prepared.plane.mask!.some(Boolean)).toBe(false)
    })
  } finally {
    await fixture.close()
  }
})

for (const [mode, reason] of [
  ['flat', 'insufficient texture'],
  ['stripes', 'repeated stripes'],
  ['clipping', 'changing clipping boundaries'],
  ['parallax', 'two substantial parallax planes'],
] as const)
  test(`camera-channel registration rejects ${reason}`, async () => {
    test.setTimeout(120000)
    const fixture = await cameraEvidence(mode)
    try {
      const [reference, source] = fixture.sources
      expect(registrationSources([reference, source]).channel).toBe('red')
      await expect(
        registerNative(reference, reference, source, identityTransform(), async () => {}),
      ).rejects.toThrow(/patches|texture|features|alignment|ECC|parallax|geometric/i)
      expect(source.registrationChannel).toBeUndefined()
      expect(source.plane.mask!.some(Boolean)).toBe(false)
    } finally {
      await fixture.close()
    }
  })

test('source confidence retains exclusions and native scale independently of band boundaries', () => {
  const transform = identityTransform()
  transform.diagnostics = {
    algorithm: ALIGNMENT_CONSTANTS.version,
    model: 'identity',
    matches: 0,
    inliers: 0,
    cells: 0,
    nativePatches: [],
    movingRegions: [{ left: 64, top: 60, width: 32, height: 24 }],
    runtimeMs: 0,
    wasmMemoryBytes: 0,
  }
  const full = sourceExclusionBand(transform, 128, 95, 256, 190, 0, 95, 8),
    bands = new Uint8Array(full.length)
  for (let top = 0; top < 95; top += 15)
    bands.set(
      sourceExclusionBand(transform, 128, 95, 256, 190, top, Math.min(15, 95 - top), 8),
      top * 128,
    )
  expect(bands).toEqual(full)
  expect([32, 31, 30, 29, 28].map((x) => full[35 * 128 + x])).toEqual([255, 215, 127, 40, 0])
  expect(full[29 * 128 + 31]).toBe(127)
  expect(sourceExclusionBand(transform, 128, 95, 256, 190, 35, 1)[32]).toBe(1)
  expect(sourceExclusionBand(transform, 128, 95, 256, 190, 35, 1)[31]).toBe(0)
  const packed = packedExclusionConfidence(new Uint8Array([0, 40, 127, 255, 215]))
  expect(packed).toEqual(new Uint32Array([0xff7f2800, 215]))
})

test('BRK radiometry estimates actual linear gains with spatially held-out proof despite nominal exposure error', () => {
  const width = 640,
    height = 480,
    reference = {
      width,
      height,
      data: Float32Array.from(
        { length: width * height },
        (_, i) => 0.03 + (0.2 * (i % width)) / width + 0.02 * Math.sin(i / 103),
      ),
      mask: new Uint8Array(width * height).fill(255),
    },
    source = { ...reference, data: Float32Array.from(reference.data, (v) => v * 3.8) }
  expect(() =>
    refineExposure(reference, source, identityTransform(), 5.5, undefined, true),
  ).toThrow('metadata')
  const measured = estimateBracketExposure(reference, source, identityTransform(), 5.5, () => false)
  expect(measured.scale).toBeCloseTo(3.8, 5)
  expect(measured.diagnostics.metadataDeltaEv).toBeLessThan(-0.5)
  expect(measured.diagnostics.validationSamples).toBeGreaterThanOrEqual(128)
  expect(measured.diagnostics.validationCells).toBeGreaterThanOrEqual(4)
  expect(measured.diagnostics.agreement).toBe(1)
  expect(measured.diagnostics.medianResidualEv).toBeLessThan(0.001)
})

test('BRK radiometry remains unbiased with independent signal-dependent RAW noise and clipping', () => {
  const width = 640,
    height = 480,
    gain = 3.8,
    reference = {
      width,
      height,
      data: new Float32Array(width * height),
      mask: new Uint8Array(width * height).fill(255),
    },
    source = { width, height, data: new Float32Array(width * height), mask: reference.mask.slice() }
  let seed = 1907
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296 - 0.5
  }
  for (let i = 0; i < reference.data.length; i++) {
    const clean = 0.02 + (0.28 * (i % width)) / width + 0.025 * Math.sin(i / 103),
      noise = (v: number) =>
        (random() + random() + random()) * Math.sqrt(0.000004 + 0.00015 * Math.max(0, v))
    reference.data[i] = clean + noise(clean)
    source.data[i] = clean * gain + noise(clean * gain)
    if (source.data[i] >= 0.9) source.mask[i] = 0
  }
  const measured = estimateBracketExposure(reference, source, identityTransform(), 5.5, () => false)
  expect(Math.abs(Math.log2(measured.scale / gain))).toBeLessThan(0.02)
  expect(measured.diagnostics.agreement).toBeGreaterThanOrEqual(0.7)
  expect(measured.diagnostics.validationCells).toBeGreaterThanOrEqual(4)
  expect(measured.diagnostics.medianResidualEv).toBeLessThan(0.1)
})

test('BRK radiometry excludes localized illumination changes and rejects ambiguous or unsupported ratios', () => {
  const width = 640,
    height = 480,
    reference = {
      width,
      height,
      data: Float32Array.from({ length: width * height }, (_, i) => 0.1 + 0.01 * Math.sin(i / 73)),
      mask: new Uint8Array(width * height).fill(255),
    },
    source = {
      ...reference,
      data: Float32Array.from(reference.data, (v, i) => v * 4 * (i % width < width / 4 ? 0.6 : 1)),
    },
    measured = estimateBracketExposure(reference, source, identityTransform(), 4, () => false)
  expect(measured.scale).toBeCloseTo(4, 5)
  expect(measured.excludedRegions.length).toBeGreaterThan(0)
  expect(measured.diagnostics.agreement).toBeGreaterThanOrEqual(0.7)
  source.data = Float32Array.from(
    reference.data,
    (v, i) => v * 4 * (i % width < width / 2 ? 0.6 : 1.5),
  )
  expect(() =>
    estimateBracketExposure(reference, source, identityTransform(), 4, () => false),
  ).toThrow('ambiguous')
  source.data = Float32Array.from(
    reference.data,
    (v, i) => v * 4 * 2 ** (((i % width) / width) * 2 - 1),
  )
  expect(() =>
    estimateBracketExposure(reference, source, identityTransform(), 4, () => false),
  ).toThrow('inconsistent')
  expect(() =>
    estimateBracketExposure(reference, source, identityTransform(), 4, (x, y) => x > 40 || y > 40),
  ).toThrow(/across 1 cells/)
  source.mask = new Uint8Array(width * height)
  expect(() =>
    estimateBracketExposure(reference, source, identityTransform(), 4, () => false),
  ).toThrow('overlap')
})

test('sensor-certified overlap uses linear values above white while preserving exposure and residual limits', () => {
  const width = 320,
    height = 192,
    reference = {
      width,
      height,
      data: Float32Array.from({ length: width * height }, (_, i) => 0.3 + 0.05 * Math.sin(i / 71)),
      mask: new Uint8Array(width * height).fill(255),
    },
    source = {
      ...reference,
      data: Float32Array.from(reference.data, (v) => v * 4),
      mask: reference.mask.slice(),
    }
  expect(() => refineExposure(reference, source, identityTransform(), 4)).toThrow('overlap')
  expect(refineExposure(reference, source, identityTransform(), 4, undefined, true)).toBeCloseTo(
    4,
    5,
  )
  expect(() =>
    refineExposure(reference, source, identityTransform(), 2.8, undefined, true),
  ).toThrow('metadata')
  const changing = {
    ...source,
    data: Float32Array.from(source.data, (v, i) => v * 2 ** (((i % width) / width) * 2 - 1)),
  }
  expect(() =>
    refineExposure(reference, changing, identityTransform(), 4, undefined, true),
  ).toThrow('median residual')
  source.mask.fill(0)
  expect(() => refineExposure(reference, source, identityTransform(), 4, undefined, true)).toThrow(
    'overlap',
  )
  expect(() =>
    refineExposure(
      { ...reference, mask: undefined },
      source,
      identityTransform(),
      4,
      undefined,
      true,
    ),
  ).toThrow('both clipping masks')
})

test('aperture variation requires one evidenced BRK prefix in HDR mode', async () => {
  const f = await syntheticMerge([0.25, 1, 4]),
    frames = bracketFrames()
  try {
    const sources = structuredClone(f.sources)
    sources.forEach((s, i) => {
      s.metadata.model = 'ZV-1A'
      s.capture.aperture = [4, 6.3, 8][i]
      s.captureMetadata = frames[i].metadata
    })
    expect(() => validateMergeSources(sources, 'hdr')).not.toThrow()
    expect(() => validateMergeSources(sources.slice(0, 2), 'hdr')).not.toThrow()
    expect(verifiedBracket(sources.slice(0, 2))?.complete).toBe(false)
    expect(() => validateMergeSources(sources, 'noise')).toThrow(/source-1.*aperture/)
    expect(() => validateMergeSources(sources.slice(1), 'hdr')).toThrow('verified continuous BRK')
    for (const invalid of [
      sources.map((s) => ({ ...s, captureMetadata: undefined })),
      sources.map((s, i) => ({
        ...s,
        captureMetadata: { ...s.captureMetadata!, sequenceFileNumber: i ? 99 : 1 },
      })),
      sources.map((s) => ({
        ...s,
        captureMetadata: { ...s.captureMetadata!, releaseMode2: 23, sequenceLength: 1 },
      })),
    ])
      expect(() => validateMergeSources(invalid, 'hdr')).toThrow(/source-1.*aperture/)
    sources[2].capture.focalLength += 1
    expect(() => validateMergeSources(sources, 'hdr')).toThrow(/source-2.*focal length/)
  } finally {
    await f.close()
  }
})

test('reviews freeze current capture facts under source leases and preserve them through revisions', async () => {
  const f = await syntheticMerge([0.5, 1]),
    root = await mkdtemp(join(tmpdir(), 'irodori-brk-review-')),
    frames = bracketFrames(2)
  f.sources.forEach((s, i) => {
    s.metadata.model = 'ZV-1A'
    s.captureMetadata = frames[i].metadata
  })
  const reviews = new MergeReviews(root, async (id) => ({
    source: f.sources.find((s) => s.photo.id === id)!,
    path: id,
  }))
  try {
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'hdr',
    )
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(true)
    f.sources[0].captureMetadata!.sequenceNumber = 999
    expect(review.sources[0].captureMetadata!.sequenceNumber).toBe(1)
    const changed = await reviews.update(review.id, review.revision, {
      ...review.settings,
      strength: 60,
    })
    expect(verifiedBracket(changed.sources)?.complete).toBe(false)
    await reviews.dispose(review.id)
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(false)
  } finally {
    await reviews.close()
    await f.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('preparation reuse is sensitive to lens and common crop identity', async () => {
  const f = await syntheticMerge([1, 1])
  try {
    const prepared = (await loadPreparation(f.directory, 0, f.sources[1].photo.id))!
    prepared.identity = 'source-lens-and-common-crop-a'
    await savePreparation(f.directory, 0, f.sources[1].photo.id, prepared)
    expect(
      await loadPreparation(f.directory, 0, f.sources[1].photo.id, undefined, prepared.identity),
    ).toBeDefined()
    expect(
      await loadPreparation(
        f.directory,
        0,
        f.sources[1].photo.id,
        undefined,
        'changed-lens-or-crop',
      ),
    ).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('ECC estimates require coherent spatial patches and independent native proof', async () => {
  test.setTimeout(120000)
  const f = await syntheticMerge([0.5, 1], { width: 640, height: 480, autoAlign: true })
  try {
    const source = (await loadPreparation(f.directory, 0, f.sources[1].photo.id))!,
      reference = (await loadPreparation(f.directory, 1, f.sources[1].photo.id))!,
      estimate = await eccHypothesis(reference.plane, source.plane, false, async () => {}),
      native = resizedTransform(
        estimate,
        reference.plane.width,
        reference.plane.height,
        reference.width,
        reference.height,
      ),
      candidate = await patchRegistrationCandidate(reference, source, native, async () => {}),
      validated = await validateGlobalNative(reference, source, candidate, async () => {})
    expect(candidate.diagnostics!.patchSupport).toBeGreaterThanOrEqual(30)
    expect(candidate.diagnostics!.cells).toBeGreaterThanOrEqual(6)
    const patches = validated.diagnostics!.nativePatches
    expect(patches.filter((p) => p.accepted).length / patches.length).toBeGreaterThanOrEqual(0.7)
    const first = await motionMeasurements(reference, source, candidate, async () => {}),
      changed = { ...candidate, matrix: [...candidate.matrix!] as typeof candidate.matrix }
    changed.matrix![2] += 3
    expect(await motionMeasurements(reference, source, changed, async () => {})).not.toBe(first)
    expect(await motionMeasurements(reference, source, candidate, async () => {})).toBe(first)
  } finally {
    await f.close()
  }
})

for (const negative of [
  'insufficient texture',
  'repeated stripes',
  'clipping boundaries',
  'illumination changes',
  'competing parallax',
] as const)
  test(`alignment rejects ${negative} without discarding sources`, async () => {
    test.setTimeout(120000)
    const width = 384,
      height = 288,
      texture = new Float32Array(width * height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        texture[y * width + x] =
          negative === 'repeated stripes'
            ? 0.2 + 0.1 * Math.sin(x / 3)
            : negative === 'clipping boundaries'
              ? x < width / 2
                ? 0.1
                : 2
              : 0.2
    if (negative === 'competing parallax') {
      await expect(
        syntheticMerge([1, 1], { width, height, autoAlign: true, parallax: true }),
      ).rejects.toThrow(/geometric|alignment/)
    } else if (negative === 'illumination changes') {
      await expect(
        syntheticMerge([0.5, 1], {
          width,
          height,
          autoAlign: true,
          textures: [
            texture,
            Float32Array.from(texture, (v, i) => v * (i % width < width / 2 ? 1.5 : 0.6)),
          ],
        }),
      ).rejects.toThrow(/geometric|alignment|overlap|ECC/)
    } else {
      await expect(
        syntheticMerge([0.5, 1], { width, height, autoAlign: true, textures: [texture, texture] }),
      ).rejects.toThrow(/patches|texture|features|alignment|ECC/)
    }
    expect(identityTransform().diagnostics).toBeUndefined()
  })
