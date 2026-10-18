import { test, expect } from '@playwright/test'
import { syntheticMerge } from './merge.helpers'
import { ALIGNMENT_CONSTANTS } from '../src/shared/merge'
import { runMerge } from '../src/main/merge/engine'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('independent HDR ramp recovers ratios above white and negative color values', async () => {
  const f = await syntheticMerge([0.25, 1, 4], { isoVariation: true })
  try {
    const errors: number[] = []
    for (let i = 0; i < f.pixels.length; i += 4)
      if (f.clean[i] > 0.03) {
        errors.push(Math.abs(Math.log2(f.pixels[i] / f.clean[i])))
        expect(f.pixels[i + 2]).toBeLessThan(0)
      }
    errors.sort((a, b) => a - b)
    expect(errors[Math.floor(errors.length * 0.5)]).toBeLessThanOrEqual(0.05)
    expect(errors[Math.floor(errors.length * 0.95)]).toBeLessThanOrEqual(0.1)
    expect(Math.max(...f.pixels)).toBeGreaterThan(1)
    expect(f.result.recipe.sources.map((s) => s.scale)).toEqual([0.25, 1, 4])
    const timeline = f.result.measurements.timeline!
    expect(timeline.clock).toBe('merge-worker-performance')
    expect(timeline.preparation.map((source) => source.sourceId)).toEqual([
      f.job.settings.referenceId,
      ...f.sources
        .map((source) => source.photo.id)
        .filter((id) => id !== f.job.settings.referenceId),
    ])
    const spans = [
      timeline.preflight!,
      ...timeline.preparation.map((source) => source.span),
      ...(timeline.referenceFallback ? [timeline.referenceFallback] : []),
      timeline.registration!,
      timeline.coverage!,
      timeline.accumulation!,
      timeline.output!,
    ]
    for (const span of spans) {
      expect(span.startedMs).toBeGreaterThanOrEqual(0)
      expect(span.completedMs).toBeGreaterThanOrEqual(span.startedMs)
      expect(span.completedMs).toBeLessThanOrEqual(f.result.measurements.runtimeMs)
    }
    for (let index = 1; index < spans.length; index++)
      expect(spans[index].startedMs).toBeGreaterThanOrEqual(spans[index - 1].completedMs)
  } finally {
    await f.close()
  }
})
test('four equal frames improve SNR with conservative static deghosting', async () => {
  const f = await syntheticMerge([1, 1, 1, 1], { noise: 0.002, deghost: true, edge: true })
  try {
    let source = 0,
      merged = 0
    for (let i = 0; i < f.pixels.length; i += 4)
      if (f.clean[i] < 0.8) {
        source += (f.frames[0][i] - f.clean[i]) ** 2
        merged += (f.pixels[i] - f.clean[i]) ** 2
      }
    expect(10 * Math.log10(source / merged)).toBeGreaterThanOrEqual(3)
    expect(f.result.recipe.affectedPercent).toBeLessThanOrEqual(1)
    let left = 0,
      right = 0
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 80; x++) {
        left += f.pixels[(y * 160 + x) * 4]
        right += f.pixels[(y * 160 + x + 80) * 4]
      }
    const contrast = (right - left) / (80 * 96)
    expect(Math.abs(contrast / 0.5 - 1)).toBeLessThanOrEqual(0.1)
  } finally {
    await f.close()
  }
})
test('moving regions resolve to the reference instead of secondary edges', async () => {
  const f = await syntheticMerge([1, 1, 1], { motion: true, deghost: true })
  try {
    expect(f.result.recipe.affectedPercent).toBeGreaterThan(1)
    for (let y = 30; y < 60; y++)
      for (let x = 23; x < 58; x++) {
        const i = (y * 160 + x) * 4
        expect(Math.abs(f.pixels[i] - f.frames[1][i])).toBeLessThan(0.01)
      }
  } finally {
    await f.close()
  }
})

test('source exclusions retain independently valid contributors and reference detail', async () => {
  const f = await syntheticMerge([1, 1, 1], { noise: 0.001, deghost: true, edge: true }),
    previous = process.env.LUMA_MERGE_BACKEND
  try {
    const recipe = structuredClone(f.result.recipe)
    recipe.resolution = 'preview'
    for (const s of [0, 2])
      recipe.sources[s].transform.diagnostics = {
        algorithm: ALIGNMENT_CONSTANTS.version,
        model: 'identity',
        matches: 0,
        inliers: 0,
        cells: 0,
        nativePatches: [],
        movingRegions: [{ left: s === 0 ? 0 : 64, top: 0, width: s === 0 ? 96 : 64, height: 96 }],
        runtimeMs: 0,
        wasmMemoryBytes: 0,
      }
    process.env.LUMA_MERGE_BACKEND = 'cpu'
    const result = await runMerge({ ...f.job, recipe, output: join(f.directory, 'excluded') }),
      bytes = await readFile(join(f.directory, 'excluded', 'linear.f32')),
      pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
    expect(result.recipe.affectedPercent).toBeLessThan(30)
    for (const x of [24, 80, 140]) {
      const i = (12 * 160 + x) * 4,
        usable = x === 24 ? [1, 2] : x === 80 ? [1] : [0, 1, 2]
      let total = 0
      const expected = [0, 0, 0]
      for (const s of usable) {
        const p = f.frames[s],
          luma = p[i] * 0.2627 + p[i + 1] * 0.678 + p[i + 2] * 0.0593,
          scale = recipe.sources[s].scale,
          weight = scale ** 2 / (0.0015 ** 2 + 0.0001 * Math.max(0, luma))
        total += weight
        for (let c = 0; c < 3; c++) expected[c] += (p[i + c] / scale) * weight
      }
      for (let c = 0; c < 3; c++)
        expect(Math.abs(pixels[i + c] - expected[c] / total)).toBeLessThan(2e-6)
    }
  } finally {
    if (previous === undefined) delete process.env.LUMA_MERGE_BACKEND
    else process.env.LUMA_MERGE_BACKEND = previous
    await f.close()
  }
})

test('recorded recipe reproduces master bytes and detects damaged preparation strips', async () => {
  const f = await syntheticMerge([0.25, 1, 4], { motion: true, deghost: true })
  try {
    const { runMerge } = await import('../src/main/merge/engine')
    const { join } = await import('node:path')
    const { open } = await import('node:fs/promises')
    const reproduced = await runMerge({
      ...f.job,
      output: join(f.directory, 'reproduced'),
      recipe: f.result.recipe,
    })
    expect(reproduced.asset.sha256).toBe(f.result.asset.sha256)
    const file = await open(join(f.directory, 'source-0.f32'), 'r+')
    try {
      await file.write(Buffer.from([123]), 0, 1, 100)
    } finally {
      await file.close()
    }
    await expect(runMerge({ ...f.job, output: join(f.directory, 'damaged') })).rejects.toThrow(
      'Damaged merge source strip',
    )
  } finally {
    await f.close()
  }
})

test('native review uses capped alignment planes and reproduces its full master from the recipe', async () => {
  const f = await syntheticMerge([0.25, 1, 4], { width: 320, height: 192 })
  try {
    const { readFile, writeFile } = await import('node:fs/promises'),
      { join } = await import('node:path')
    const { runMerge } = await import('../src/main/merge/engine')
    for (let s = 0; s < 3; s++) {
      const path = join(f.directory, `source-${s}.json`),
        cached = JSON.parse(await readFile(path, 'utf8'))
      const width = 80,
        height = 48,
        data: number[] = []
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          data.push(cached.source.plane.data[(y * 4 + 2) * 320 + x * 4 + 2])
      cached.source.plane = { width, height, data }
      await writeFile(path, JSON.stringify(cached))
    }
    const native = await runMerge({
      ...f.job,
      output: join(f.directory, 'native-review'),
      comparisons: true,
    })
    expect(native.asset.width).toBe(320)
    expect(native.asset.height).toBe(192)
    expect(native.recipe.crop).toEqual({ left: 0, top: 0, width: 320, height: 192 })
    expect(native.recipe.resolution).toBe('native')
    const sharp = (await import('sharp')).default
    for (const name of ['result', 'reference', 'overlay']) {
      const image = await sharp(join(f.directory, 'native-review', `${name}.png`)).metadata()
      expect(image.width).toBe(320)
      expect(image.height).toBe(192)
    }
    const full = await runMerge({
      ...f.job,
      output: join(f.directory, 'native-detail'),
      recipe: native.recipe,
    })
    expect(full.recipe.resolution).toBe('native')
    expect(full.asset.sha256).toBe(f.result.asset.sha256)
  } finally {
    await f.close()
  }
})

test('worker cancellation and crashes release the worker for subsequent jobs', async () => {
  const f = await syntheticMerge([1, 1])
  const { MergeProcess } = await import('../src/main/merge/process')
  const { join, resolve } = await import('node:path')
  const { writeFile } = await import('node:fs/promises')
  try {
    const worker = new MergeProcess(resolve('out/main/merge-worker.js'))
    worker.pause(true)
    const abort = new AbortController()
    const cancelled = worker.run(f.job, abort.signal, () => {})
    const assertion = expect(cancelled).rejects.toThrow('cancelled')
    abort.abort()
    await assertion
    worker.pause(false)
    expect(
      (
        await worker.run(
          { ...f.job, output: join(f.directory, 'after-cancel') },
          new AbortController().signal,
          () => {},
        )
      ).asset.sha256,
    ).toBe(f.result.asset.sha256)
    const crashPath = join(f.directory, 'crash.cjs')
    await writeFile(crashPath, 'process.exit(19)')
    const crashed = new MergeProcess(crashPath)
    await expect(crashed.run(f.job, new AbortController().signal, () => {})).rejects.toThrow(
      'worker stopped',
    )
    await expect(crashed.run(f.job, new AbortController().signal, () => {})).rejects.toThrow(
      'worker stopped',
    )
  } finally {
    await f.close()
  }
})

test('uncropped merges preserve reference framing with transparent nonshared edges', async () => {
  const f = await syntheticMerge([1, 1])
  try {
    const { runMerge } = await import('../src/main/merge/engine'),
      { join } = await import('node:path'),
      { readFile } = await import('node:fs/promises')
    const settings = { ...f.job.settings, autoCrop: false },
      recipe = structuredClone(f.result.recipe)
    recipe.settings = settings
    recipe.resolution = 'preview'
    recipe.sources[0].transform.matrix![2] = 4
    const output = join(f.directory, 'transparent'),
      result = await runMerge({ ...f.job, settings, recipe, output }),
      bytes = await readFile(join(output, 'linear.f32')),
      pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
    expect(result.asset.width).toBe(160)
    expect(result.asset.height).toBe(96)
    for (let y = 0; y < 96; y++) {
      expect(pixels[(y * 160 + 100) * 4 + 3]).toBe(1)
      for (let x = 156; x < 160; x++) expect(pixels[(y * 160 + x) * 4 + 3]).toBe(0)
    }
  } finally {
    await f.close()
  }
})

test('native validation accepts independently generated perspective with noise and a moving subject', async () => {
  const f = await syntheticMerge([1, 1.4], {
    width: 640,
    height: 480,
    reference: 0,
    autoAlign: true,
    noise: 0.0005,
    motion: true,
    deghost: true,
    transforms: [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [1.012, 0.009, 3, -0.007, 1.008, -2, 0.000015, -0.00001, 1],
    ],
  })
  try {
    const d = f.result.recipe.sources[1].transform.diagnostics!
    expect(d.inliers).toBeGreaterThanOrEqual(30)
    expect(d.cells).toBeGreaterThanOrEqual(6)
    expect(
      d.nativePatches.filter((p) => p.accepted).length / d.nativePatches.length,
    ).toBeGreaterThanOrEqual(0.7)
    expect(f.result.recipe.affectedPercent).toBeGreaterThan(0)
    const attempt = f.result.measurements.attempts.find((a) => a.success)!
    expect([0, 1]).toContain(attempt.lane)
    expect(attempt.queuedMs).toBeGreaterThanOrEqual(0)
    expect(attempt.reads!.nativePlanes.cacheMisses).toBeGreaterThanOrEqual(2)
    expect(attempt.reads!.nativePlanes.verifiedBytes).toBeGreaterThan(0)
    expect(attempt.reads!.nativePlanes.verifiedBytes).toBe(attempt.reads!.nativePlanes.readBytes)
  } finally {
    await f.close()
  }
})
test('native validation rejects a scene split between incompatible parallax planes', async () => {
  const attempt = syntheticMerge([1, 1], {
    width: 640,
    height: 480,
    autoAlign: true,
    parallax: true,
  })
  try {
    await expect(attempt).rejects.toThrow(/geometric|alignment/)
  } finally {
    await attempt.then(
      (f) => f.close(),
      () => {},
    )
  }
})

test('a large independently moving foreground preserves static camera geometry and reference detail', async () => {
  test.setTimeout(90000)
  const expected: import('../src/shared/merge').MergeMatrix = [
    1.006, 0.006, 2, -0.004, 1.003, -1, 0.000006, -0.000004, 1,
  ]
  const f = await syntheticMerge([1, 1.4], {
    width: 960,
    height: 720,
    reference: 0,
    autoAlign: true,
    noise: 0.0005,
    motion: 'large',
    deghost: true,
    transforms: [[1, 0, 0, 0, 1, 0, 0, 0, 1], expected],
  })
  try {
    const { point } = await import('../src/main/merge/matrix')
    const actual = f.result.recipe.sources[1].transform.matrix!
    for (const [x, y] of [
      [80, 80],
      [880, 80],
      [80, 640],
      [880, 640],
    ]) {
      const a = point(actual, x, y),
        b = point(expected, x, y)
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(0.5)
    }
    expect(f.result.recipe.affectedPercent).toBeGreaterThan(30)
    const crop = f.result.recipe.crop
    for (const [x, y] of [
      [400, 250],
      [500, 400],
      [450, 550],
    ]) {
      const i = ((y - crop.top) * crop.width + x - crop.left) * 4,
        j = (y * 960 + x) * 4
      expect(f.pixels[i]).toBeCloseTo(f.frames[0][j], 6)
    }
  } finally {
    await f.close()
  }
})

test('changing the reference inverts native geometry while preserving the independently known scene', async () => {
  const transforms: import('../src/shared/merge').MergeMatrix[] = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [1, 0.012, 3, -0.008, 1, -2, 0.000015, -0.00001, 1],
  ]
  const f = await syntheticMerge([1, 1.4], {
    width: 640,
    height: 480,
    reference: 1,
    autoAlign: true,
    transforms,
  })
  try {
    const { inverse, point } = await import('../src/main/merge/matrix')
    const expected = inverse(transforms[1]),
      actual = f.result.recipe.sources[0].transform.matrix!
    for (const [x, y] of [
      [50, 50],
      [590, 50],
      [50, 430],
      [590, 430],
    ]) {
      const a = point(actual, x, y),
        b = point(expected, x, y)
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.5)
    }
  } finally {
    await f.close()
  }
})
