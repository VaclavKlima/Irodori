import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { cropTileSourceBounds, resampleCropTile } from '../src/shared/crop-filter'
import reference from './fixtures/crop-filter-reference.json' with { type: 'json' }
import { catmullRom } from '../src/shared/reconstruction'

test('crop CPU reconstruction matches independent Decimal80 Hermite and coverage-edge references', async () => {
  expect(reference.precision).toBe(80)
  expect(
    createHash('sha256')
      .update(await readFile('scripts/research/crop-filter-reference.py'))
      .digest('hex'),
  ).toBe(reference.generatorSha256)
  let maximumRatio = 0,
    checked = 0,
    worst: unknown
  for (const scene of reference.scenes) {
    const window = {
      left: 0,
      top: 0,
      width: 9,
      height: 9,
      data: new Float32Array(scene.data.flat()),
    }
    for (const vector of scene.vectors) {
      const geometry = cropGeometry(window, {
          ...identityCrop,
          width: 1 / 9,
          height: 1 / 9,
          centerX: (vector.x + 0.5) / 9,
          centerY: (vector.y + 0.5) / 9,
        }),
        tile = { left: 0, top: 0, width: 1, height: 1 },
        actual = resampleCropTile(geometry, tile, window, new Float64Array(4)),
        published = resampleCropTile(geometry, tile, window)
      for (let c = 0; c < 4; c++) {
        const expected = vector.output[c],
          ratio = Math.abs(actual[c] - expected) / (2e-10 + 2e-10 * Math.abs(expected))
        if (ratio > maximumRatio) {
          maximumRatio = ratio
          worst = { scene: scene.name, vector, c, value: actual[c] }
        }
        expect(Number.isFinite(published[c])).toBe(true)
        expect(Math.abs(published[c] - Math.fround(expected))).toBeLessThanOrEqual(
          2e-6 + 2e-5 * Math.abs(expected),
        )
      }
      if (
        scene.name === 'quadratic' &&
        vector.x >= 1 &&
        vector.x <= 7 &&
        vector.y >= 1 &&
        vector.y <= 7
      ) {
        const analytic = [
          (vector.x - 4) ** 2 / 16,
          (vector.y - 4) ** 2 / 16,
          (vector.x * vector.y) / 16 - 1,
        ]
        for (let c = 0; c < 3; c++)
          expect(Math.abs(actual[c] - analytic[c])).toBeLessThanOrEqual(
            2e-10 + 2e-10 * Math.abs(analytic[c]),
          )
      }
      checked++
    }
  }
  expect(checked).toBe(648)
  expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
})

test('fixed chart gates select Catmull-Rom over bilinear softness and Lanczos3 step ringing', () => {
  const accepted = reference.quality.filter(
    (q) => q.sinusoidRms['0.2'] <= 0.03 && q.stepOvershoot <= 0.075 && q.quadrantOvershoot <= 0.155,
  )
  expect(accepted.map((q) => q.method)).toEqual(['catmull-rom'])
  expect(
    reference.quality.find((q) => q.method === 'bilinear')!.sinusoidRms['0.2'],
  ).toBeGreaterThan(0.03)
  expect(reference.quality.find((q) => q.method === 'lanczos3')!.stepOvershoot).toBeGreaterThan(
    0.075,
  )
  // Exercise the production kernel on the same charts, not only the fixture's candidates.
  const candidate = reference.quality.find((q) => q.method === 'catmull-rom')!
  const reconstruct = (x: number, value: (i: number) => number) => {
    let total = 0
    for (let i = Math.floor(x) - 1; i <= Math.floor(x) + 2; i++)
      total += value(i) * catmullRom(x - i)
    return total
  }
  for (const frequency of [0.05, 0.15, 0.2, 0.3] as const) {
    let squared = 0
    for (let phase = 0; phase < 64; phase++)
      for (let k = 0; k < 64; k++) {
        const x = k + (phase + 0.5) / 64,
          signal = (p: number) => Math.sin(2 * Math.PI * frequency * p)
        squared += (reconstruct(x, signal) - signal(x)) ** 2
      }
    const rms = Math.sqrt(squared / 4096)
    expect(
      Math.abs(
        rms - candidate.sinusoidRms[String(frequency) as keyof typeof candidate.sinusoidRms],
      ),
    ).toBeLessThanOrEqual(2e-12)
    if (frequency === 0.2) expect(rms).toBeLessThanOrEqual(0.03)
  }
  let lo = Infinity,
    hi = -Infinity
  for (let j = 0; j <= 4096; j++) {
    const value = reconstruct(-2 + j / 1024, (i) => Number(i >= 0))
    lo = Math.min(lo, value)
    hi = Math.max(hi, value)
  }
  const overshoot = Math.max(-lo, hi - 1),
    quadrant = Math.max(-lo * hi, hi * hi - 1, lo * lo - 1)
  expect(Math.abs(overshoot - candidate.stepOvershoot)).toBeLessThanOrEqual(2e-12)
  expect(Math.abs(quadrant - candidate.quadrantOvershoot)).toBeLessThanOrEqual(2e-12)
  expect(overshoot).toBeLessThanOrEqual(0.075)
  expect(quadrant).toBeLessThanOrEqual(0.155)
})

test('all crop rotations have exact Float32 tile seams with only their bounded native windows', () => {
  const source = { width: 26, height: 19 },
    data = new Float32Array(source.width * source.height * 4)
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++)
      data.set(
        [x / 7 - 1, y / 9 - 0.5, 16 + ((x * y) % 11), x < 6 ? x / 6 : 1],
        (y * source.width + x) * 4,
      )
  let checked = 0
  for (const quarterTurns of [0, 1, 2, 3] as const)
    for (const angle of [-12.34, 0, 22.5]) {
      const crop = fitCrop(source, {
          ...identityCrop,
          quarterTurns,
          angle,
          width: 0.8,
          height: 0.7,
        }),
        geometry = cropGeometry(source, crop),
        expected = resampleCropTile(
          geometry,
          { left: 0, top: 0, width: geometry.width, height: geometry.height },
          { ...source, left: 0, top: 0, data },
        ),
        stitched = new Float32Array(expected.length)
      for (let top = 0; top < geometry.height; top += 3)
        for (let left = 0; left < geometry.width; left += 2) {
          const tile = {
              left,
              top,
              width: Math.min(2, geometry.width - left),
              height: Math.min(3, geometry.height - top),
            },
            bounds = cropTileSourceBounds(geometry, tile),
            window = new Float32Array(bounds.width * bounds.height * 4)
          for (let y = 0; y < bounds.height; y++)
            window.set(
              data.subarray(
                ((bounds.top + y) * source.width + bounds.left) * 4,
                ((bounds.top + y) * source.width + bounds.left + bounds.width) * 4,
              ),
              y * bounds.width * 4,
            )
          const result = resampleCropTile(geometry, tile, { ...bounds, data: window })
          for (let y = 0; y < tile.height; y++)
            stitched.set(
              result.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
              ((top + y) * geometry.width + left) * 4,
            )
          checked++
        }
      expect(
        Buffer.from(stitched.buffer).equals(Buffer.from(expected.buffer)),
        JSON.stringify(crop),
      ).toBe(true)
    }
  expect(checked).toBeGreaterThan(300)
})

test('invalid processing bounds and source windows reject before allocating or overwriting pixels', () => {
  const geometry = cropGeometry({ width: 9, height: 9 }, identityCrop),
    source = { left: 0, top: 0, width: 9, height: 9, data: new Float32Array(9 * 9 * 4) },
    tile = { left: 0, top: 0, width: 3, height: 3 }
  expect(() => resampleCropTile(geometry, { ...tile, width: 1e9 }, source)).toThrow('tile')
  expect(() => resampleCropTile(geometry, { ...tile, top: -1 }, source)).toThrow('tile')
  expect(() => resampleCropTile(geometry, tile, { ...source, width: 1 })).toThrow('window')
  expect(() => resampleCropTile(geometry, tile, source, new Float32Array(1))).toThrow('destination')
  expect(() =>
    resampleCropTile(geometry, tile, source, source.data.subarray(0, 3 * 3 * 4)),
  ).toThrow('destination')
})
