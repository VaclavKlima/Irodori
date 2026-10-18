import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GraphExecutor } from '../scripts/research/pipeline/graph'
import { DurableMasks } from '../scripts/research/pipeline/assets'
import { operations } from '../scripts/research/pipeline/operations'
import { adaptLegacy, imageSpec, node, workloads } from '../scripts/research/pipeline/workloads'
import { whole, type Evaluation, type Recipe } from '../scripts/research/pipeline/contract'
import { initialSettings } from '../src/shared/edits'
import { ResearchScheduler } from '../scripts/research/pipeline/scheduler'
import {
  cadence,
  detail,
  FrameInputSchedule,
  interaction,
  meetsSamplingFrequency,
  SharpNavigationTiles,
} from '../scripts/research/pipeline/metrics'

const request = (recipe: Recipe, revision = 1): Evaluation => ({
  purpose: 'preview',
  region: whole(recipe.nodes.find((n) => n.id === recipe.output)!.output),
  revision,
  scale: 1,
  approximation: 'exact',
})
function maximumDifference(a: Float32Array, b: Float32Array) {
  expect(a.length).toBe(b.length)
  let maximum = 0
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]))
  return maximum
}
test('all extensibility workloads execute through one registry, executor, cache and request contract', () => {
  const w = workloads()
  const engine = new GraphExecutor(operations, w.assets, 8 * 1024 ** 2, 32)
  for (const recipe of Object.values(w.recipes)) {
    const result = engine.render(recipe, request(recipe))
    expect(result.data.every(Number.isFinite)).toBe(true)
    expect(result.data.length).toBe(result.spec.width * result.spec.height * result.spec.channels)
    const exported = engine.render(recipe, { ...request(recipe, 2), purpose: 'export' })
    expect(exported.identity).toBe(result.identity)
    expect(maximumDifference(result.data, exported.data)).toBe(0)
    expect(exported.revision).toBe(2)
  }
  expect(engine.stats.peakBytes).toBeLessThanOrEqual(engine.budgetBytes)
})
test('ordered fusion matches unfused float32 intermediates; grading edits retain reusable exposure/source', () => {
  const w = workloads(),
    recipe = w.recipes.fused
  const engine = new GraphExecutor(operations, w.assets)
  const fused = engine.render(recipe, request(recipe))
  const plain = new GraphExecutor(operations, w.assets, 32 * 1024 ** 2, 64, false).render(
    recipe,
    request(recipe),
  )
  expect(maximumDifference(fused.data, plain.data)).toBe(0)
  expect(engine.stats.fusedOperations).toBeGreaterThan(0)
  const reversed = structuredClone(recipe)
  reversed.nodes[1].operation = 'grading'
  reversed.nodes[1].parameters = { amount: 0.25 }
  reversed.nodes[2].operation = 'exposure'
  reversed.nodes[2].parameters = { ev: 0.7 }
  expect(
    maximumDifference(engine.render(reversed, request(reversed)).data, fused.data),
  ).toBeGreaterThan(0.01)
  engine.render(w.recipes.grading, request(w.recipes.grading))
  const before = { ...engine.stats }
  const edited = structuredClone(w.recipes.grading)
  edited.nodes.at(-1)!.parameters.amount = 0.5
  engine.render(edited, request(edited, 4))
  expect(engine.stats.sourceTiles).toBe(before.sourceTiles)
  expect(engine.stats.misses - before.misses).toBe(4)
  expect(engine.stats.hits).toBeGreaterThan(before.hits)
})
for (const radius of [0, 1, 3, 9])
  test(`tiled blur radius ${radius} agrees with independent untiled 2D reference at seams and edges`, () => {
    const w = workloads(undefined, imageSpec(73, 51)),
      recipe = w.recipes[`blur-${radius}`]
    const engine = new GraphExecutor(operations, w.assets, 2 * 1024 ** 2, 17)
    const actual = engine.render(recipe, request(recipe)).data
    const reference = new Float32Array(actual.length)
    const { width, height } = w.spec
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 4; c++) {
          const i = (y * width + x) * 4 + c
          if (c === 3) {
            reference[i] = w.data[i]
            continue
          }
          let sum = 0
          for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++)
              sum +=
                w.data[
                  (Math.max(0, Math.min(height - 1, y + dy)) * width +
                    Math.max(0, Math.min(width - 1, x + dx))) *
                    4 +
                    c
                ]
          reference[i] = sum / (2 * radius + 1) ** 2
        }
    expect(maximumDifference(actual, reference)).toBeLessThanOrEqual(5e-7)
  })
test('feathered mask keeps photo alpha independent and zero-coverage tiles survive localized asset changes', () => {
  const w = workloads(undefined, imageSpec(128, 128)),
    recipe = w.recipes.local
  const engine = new GraphExecutor(operations, w.assets, 8 * 1024 ** 2, 16)
  const first = engine.render(recipe, request(recipe))
  const before = { ...engine.stats }
  const changed = structuredClone(recipe)
  const hash = w.assets.addMask({
    version: 1,
    coordinates: 'normalized-source-v1',
    center: [0.45, 0.5],
    radius: 0.2,
    feather: 0.3,
  })
  changed.nodes.find((n) => n.id === 'mask')!.parameters.asset = hash
  changed.assets = [hash]
  const after = engine.render(changed, request(changed, 2))
  expect(engine.stats.sourceTiles).toBe(before.sourceTiles)
  expect(engine.stats.misses - before.misses).toBeLessThan(2 * 64)
  expect(maximumDifference(first.data, after.data)).toBeGreaterThan(0)
  let alphaDifference = 0
  for (let i = 3; i < after.data.length; i += 4)
    alphaDifference = Math.max(alphaDifference, Math.abs(after.data[i] - w.data[i]))
  expect(alphaDifference).toBe(0)
  expect(after.data[0]).toBe(w.data[0])
})
test('masked blur followed by grading agrees with independent blend/order calculation', () => {
  const w = workloads(),
    recipe = w.recipes.masked
  const engine = new GraphExecutor(operations, w.assets, 8 * 1024 ** 2, 19)
  const actual = engine.render(recipe, request(recipe)).data
  const blur = engine.render(w.recipes['blur-3'], request(w.recipes['blur-3'])).data
  const maskRecipe = { ...recipe, output: 'mask' }
  const mask = engine.render(maskRecipe, request(maskRecipe)).data
  const reference = new Float32Array(actual.length)
  for (let i = 0; i < actual.length; i++) {
    if (i % 4 === 3) {
      reference[i] = w.data[i]
      continue
    }
    const m = mask[Math.floor(i / 4)],
      v = Math.fround(w.data[i] * (1 - m) + blur[i] * m)
    reference[i] = v + (0.25 * v * Math.abs(v)) / (1 + Math.abs(v))
  }
  expect(maximumDifference(actual, reference)).toBe(0)
})
test('source masks remain registered through every orientation, radial lens geometry and crop', () => {
  const w = workloads(undefined, imageSpec(64, 48))
  for (const orientation of [0, 90, 180, 270])
    for (const lensK1 of [0, 0.08, -0.08, 0.3, -0.3]) {
      const recipe = structuredClone(w.recipes.geometry)
      const swapped = orientation === 90 || orientation === 270
      const crop = { x: 3, y: 5, width: (swapped ? 48 : 64) - 6, height: (swapped ? 64 : 48) - 10 }
      for (const n of recipe.nodes.filter(
        (n) => n.output.coordinates === 'oriented-lens-crop-v1',
      )) {
        n.output.width = crop.width
        n.output.height = crop.height
        if (n.parameters.geometry) n.parameters.geometry = { orientation, lensK1, crop }
      }
      const engine = new GraphExecutor(operations, w.assets, 4 * 1024 ** 2, 11)
      const actual = engine.render(recipe, request(recipe)).data
      const maskRecipe = { ...recipe, output: 'mask' }
      const mask = engine.render(maskRecipe, request(maskRecipe)).data
      let maximum = 0
      // Independently map crop/orientation and bilinearly sample the source mask.
      for (let y = 0; y < crop.height; y++)
        for (let x = 0; x < crop.width; x++) {
          const px = x + crop.x,
            py = y + crop.y
          let sx =
            orientation === 90
              ? py
              : orientation === 180
                ? 63 - px
                : orientation === 270
                  ? 63 - py
                  : px
          let sy =
            orientation === 90
              ? 47 - px
              : orientation === 180
                ? 47 - py
                : orientation === 270
                  ? px
                  : py
          const dx = sx - 31.5,
            dy = sy - 23.5,
            factor = 1 + (lensK1 * (dx * dx + dy * dy)) / 1600
          sx = 31.5 + dx * factor
          sy = 23.5 + dy * factor
          const ix = Math.floor(sx),
            iy = Math.floor(sy),
            fx = sx - ix,
            fy = sy - iy
          const sample = (
            data: Float32Array,
            xx: number,
            yy: number,
            channels: number,
            c: number,
          ) =>
            data[
              (Math.max(0, Math.min(47, yy)) * 64 + Math.max(0, Math.min(63, xx))) * channels + c
            ]
          const interp = (data: Float32Array, channels: number, c: number) =>
            (sample(data, ix, iy, channels, c) * (1 - fx) +
              sample(data, ix + 1, iy, channels, c) * fx) *
              (1 - fy) +
            (sample(data, ix, iy + 1, channels, c) * (1 - fx) +
              sample(data, ix + 1, iy + 1, channels, c) * fx) *
              fy
          const coverage = Math.fround(interp(mask, 1, 0))
          const base = Math.fround(interp(w.data, 4, 0)),
            effect = Math.fround(base * 2 ** 0.7)
          maximum = Math.max(
            maximum,
            Math.abs(
              actual[(y * crop.width + x) * 4] - (base * (1 - coverage) + effect * coverage),
            ),
          )
        }
      expect(maximum).toBeLessThan(3e-7)
    }
})
test('sharp navigation never mixes rendering identities; detail and stale/missing-frame metrics expose blur and dropped inputs', () => {
  const tiles = new SharpNavigationTiles(4),
    value = new Float32Array([0.2])
  tiles.put('revision-a', '0:0', value)
  tiles.put('revision-a', '1:0', value)
  expect(tiles.select('revision-a', ['0:0', '1:0'])).toHaveLength(2)
  tiles.put('revision-b', '0:0', value)
  expect(tiles.select('revision-b', ['0:0', '1:0'])).toBeUndefined()
  expect(tiles.select('revision-a', ['0:0', '1:0'])).toHaveLength(2)
  const spec = imageSpec(16, 16),
    w = workloads(undefined, spec)
  const blurred = new GraphExecutor(operations, w.assets).render(
    w.recipes['blur-3'],
    request(w.recipes['blur-3']),
  )
  expect(detail(w.data, blurred.data, 16, 16).edgeEnergyRatio).toBeLessThan(0.6)
  const measured = interaction(
    [
      { serial: 1, at: 0 },
      { serial: 2, at: 16 },
      { serial: 3, at: 32 },
    ],
    [
      { serial: 1, at: 40 },
      { serial: 3, at: 50 },
    ],
  )
  expect(measured.missingPresentations).toBe(1)
  expect(measured.staleAgeMs.max).toBe(32)
  expect(measured.meets33msTarget).toBe(false)
})
test('analysis is streamed once and unchanged by downstream grading; changed upstream exposure reruns it', () => {
  const w = workloads(),
    recipe = w.recipes.analysis
  const engine = new GraphExecutor(operations, w.assets, 8 * 1024 ** 2, 32)
  engine.render(recipe, request(recipe))
  expect(engine.stats.reductions).toBe(1)
  const edited = structuredClone(recipe)
  edited.nodes.at(-1)!.parameters.amount = -0.4
  engine.render(edited, request(edited, 2))
  expect(engine.stats.reductions).toBe(1)
  edited.nodes.splice(1, 0, node('upstream', 'exposure', { image: 'source' }, w.spec, { ev: 1 }))
  edited.nodes.find((n) => n.id === 'histogram')!.inputs.image = 'upstream'
  engine.render(edited, request(edited, 3))
  expect(engine.stats.reductions).toBe(2)
})
test('a new neighborhood operation registers without executor or transport changes', () => {
  const w = workloads(),
    recipe = structuredClone(w.recipes.grading)
  const blur = operations.find((op) => op.name === 'blur-x')!
  const sharpen = {
    ...blur,
    name: 'proof-sharpen',
    cpu(context: Parameters<typeof blur.cpu>[0]) {
      blur.cpu(context)
      for (let y = 0; y < context.region.height; y++)
        for (let x = 0; x < context.region.width; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * context.region.width + x) * 4 + c
            const r = context.inputs.image.region
            const original =
              context.inputs.image.data[
                ((y + context.region.y - r.y) * r.width + x + context.region.x - r.x) * 4 + c
              ]
            context.output[i] = original * 2 - context.output[i]
          }
    },
  }
  recipe.nodes.push(
    node('sharpen', 'proof-sharpen', { image: recipe.output }, w.spec, { radius: 2 }),
  )
  recipe.output = 'sharpen'
  const engine = new GraphExecutor([...operations, sharpen], w.assets)
  expect(engine.render(recipe, request(recipe)).data.every(Number.isFinite)).toBe(true)
})
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('history mask assets survive cache eviction and restart; missing or corrupted content is explicit', async ({}, info) => {
  const w = workloads(),
    durable = new DurableMasks(join(info.outputPath('owned-photo'), 'masks'))
  const hash = await durable.put(w.assets.mask(w.maskHash))
  const history = [w.recipes.local, w.recipes.masked]
  expect(durable.retained(history).has(hash)).toBe(true)
  const engine = new GraphExecutor(operations, w.assets)
  engine.render(history[0], request(history[0]))
  engine.clear()
  const restarted = new DurableMasks(durable.directory)
  expect(await restarted.read(hash)).toEqual(w.assets.mask(hash))
  await expect(restarted.read('f'.repeat(64))).rejects.toThrow()
  const path = join(durable.directory, `${hash}.json`)
  const bytes = JSON.parse(await readFile(path, 'utf8'))
  bytes.radius = 0.1
  await writeFile(path, JSON.stringify(bytes))
  await expect(restarted.read(hash)).rejects.toThrow('checksum')
})
test('bounds, cycles, unknown versions, incompatible domains, missing assets and unsupported policies fail explicitly', () => {
  const w = workloads(),
    engine = new GraphExecutor(operations, w.assets)
  const cyclic = structuredClone(w.recipes.grading)
  cyclic.nodes[1].inputs.image = cyclic.output
  expect(() => engine.render(cyclic, request(cyclic))).toThrow('Cyclic')
  const version = structuredClone(w.recipes.local)
  version.nodes[1].version = 2
  expect(() => engine.render(version, request(version))).toThrow('Unknown operation')
  const domain = structuredClone(w.recipes.local)
  domain.nodes[2].output.domain = 'scene-linear-rec2020'
  expect(() => engine.render(domain, request(domain))).toThrow('contract')
  const missing = { ...w.recipes.local, assets: [] }
  expect(() => engine.render(missing, request(missing))).toThrow('durable history asset')
  expect(() => engine.render(w.recipes.local, { ...request(w.recipes.local), scale: 0.5 })).toThrow(
    'native scale',
  )
  const unsupported = { ...request(w.recipes.local), approximation: 'preview-lut' as const }
  expect(() => engine.render(w.recipes.local, unsupported)).toThrow('exact policy')
  const invalid = structuredClone(w.recipes.grading)
  invalid.nodes[1].parameters.ev = NaN
  expect(() => engine.render(invalid, request(invalid))).toThrow('Nonfinite')
})
test('memory eviction reuses buffers, cancellation releases leases, and originals remain byte-identical', () => {
  const w = workloads(undefined, imageSpec(128, 128)),
    original = w.assets.image(w.sourceHash).data.slice()
  const engine = new GraphExecutor(operations, w.assets, 512 * 1024, 16)
  engine.render(w.recipes.masked, request(w.recipes.masked))
  expect(engine.stats.peakBytes).toBeLessThanOrEqual(engine.budgetBytes)
  expect(engine.stats.reusedBuffers).toBeGreaterThan(0)
  expect(maximumDifference(w.assets.image(w.sourceHash).data, original)).toBe(0)
  const controller = new AbortController()
  controller.abort()
  expect(() =>
    engine.render(w.recipes.masked, { ...request(w.recipes.masked), signal: controller.signal }),
  ).toThrow()
  expect(() => engine.clear()).not.toThrow()
  const tiny = new GraphExecutor(operations, w.assets, 1024, 16)
  expect(() => tiny.render(w.recipes.grading, request(w.recipes.grading))).toThrow('memory budget')
  expect(() => tiny.clear()).not.toThrow()
})
test('legacy settings adapter retains exact versioned settings and requires already prepared pixels', () => {
  const w = workloads(),
    settings = initialSettings()
  settings.contrast = 25
  settings.exposureEv = 0.5
  const recipe = adaptLegacy(settings, w.sourceHash, w.spec)
  const result = new GraphExecutor(operations, w.assets).render(recipe, request(recipe))
  expect(recipe.legacySettings).toEqual(settings)
  expect(maximumDifference(result.data, w.data)).toBe(0)
})
test('foreground work preempts at cooperative boundaries; two-photo admission and cancellation clean up', async () => {
  const scheduler = new ResearchScheduler(),
    order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let cleaned = false
  const background = scheduler.submit({
    kind: 'background',
    steps: (async function* () {
      try {
        order.push('background-start')
        await gate
        yield
        order.push('background-end')
        return 1
      } finally {
        cleaned = true
      }
    })(),
  })
  const foreground = scheduler.submit({
    kind: 'foreground',
    steps: (async function* () {
      order.push('foreground')
      yield
      return 2
    })(),
  })
  await expect(
    scheduler.submit({
      kind: 'background',
      steps: (async function* () {
        yield
        return 3
      })(),
    }),
  ).rejects.toThrow('admission')
  scheduler.setEditing(true)
  release()
  expect(await foreground).toBe(2)
  expect(await background).toBe(1)
  expect(order).toEqual(['background-start', 'foreground', 'background-end'])
  expect(cleaned).toBe(true)
  const cancel = new AbortController()
  cancel.abort()
  await expect(
    scheduler.submit({
      kind: 'background',
      signal: cancel.signal,
      steps: (async function* () {
        yield
        return 4
      })(),
    }),
  ).rejects.toThrow()
})

for (const requested of [60, 120])
  test(`absolute deadlines preserve ${requested} Hz average on 144 Hz native frames`, () => {
    const clock = new FrameInputSchedule(requested)
    const samples = []
    for (let frame = 0; frame <= 1440; frame++) {
      const sample = clock.takeFrame(1000 + (frame * 1000) / 144)
      if (sample) samples.push(sample)
    }
    const measured = cadence(samples.map((sample) => sample.nativeFrameAt))
    expect(samples).toHaveLength(requested * 10 + 1)
    expect(samples[0]).toEqual({ scheduledAt: 1000, nativeFrameAt: 1000 })
    expect(measured.frequencyHz).toBeCloseTo(requested, 8)
    expect(measured.intervalMs!.min).toBeGreaterThan(1000 / 144 - 1e-8)
    expect(measured.intervalMs!.max).toBeLessThanOrEqual(
      (Math.ceil(144 / requested) * 1000) / 144 + 1e-8,
    )
    for (const [index, sample] of samples.entries()) {
      expect(sample.scheduledAt).toBeCloseTo(1000 + (index * 1000) / requested, 8)
      expect(sample.nativeFrameAt - sample.scheduledAt).toBeLessThan(1000 / 144)
    }
  })
for (const [native, requested] of [
  [60, 120],
  [144, 240],
])
  test(`${native} Hz native frames cannot fabricate ${requested} Hz inputs`, () => {
    const clock = new FrameInputSchedule(requested)
    const samples = []
    for (let frame = 0; frame <= native * 10; frame++) {
      const at = (frame * 1000) / native
      const sample = clock.takeFrame(at)
      if (sample) samples.push(sample)
      expect(clock.takeFrame(at)).toBeUndefined()
    }
    expect(cadence(samples.map((sample) => sample.nativeFrameAt)).frequencyHz).toBeCloseTo(
      native,
      8,
    )
    expect(samples.at(-1)!.nativeFrameAt - samples.at(-1)!.scheduledAt).toBeGreaterThan(1000)
  })
test('input cadence retains actual dispatch delays and absolute deadlines after stalled frames', () => {
  const clock = new FrameInputSchedule(60)
  const first = clock.takeFrame(1000)!
  const late = clock.takeFrame(1100)!
  const next = clock.takeFrame(1107)!
  expect(late.scheduledAt).toBeCloseTo(1000 + 1000 / 60, 8)
  expect(next.scheduledAt).toBeCloseTo(1000 + 2000 / 60, 8)
  const measured = interaction(
    [first, late, next].map((sample, serial) => ({
      ...sample,
      serial,
      at: sample.nativeFrameAt + 2,
    })),
    [{ serial: 2, at: 1120 }],
  )
  expect(measured.inputCadence.frequencyHz).toBeCloseTo(2000 / 107, 8)
  expect(measured.inputCadence.intervalMs!.observations).toEqual([100, 7])
  expect(measured.inputDeadlineOffsetMs!.observations).toEqual([
    2,
    1102 - late.scheduledAt,
    1109 - next.scheduledAt,
  ])
  expect(cadence([1000]).frequencyHz).toBeNull()
  expect(cadence([1000]).intervalMs).toBeNull()
  expect(() => cadence([1000, 1000])).toThrow('increasing')
  expect(() => cadence([1000, NaN])).toThrow('finite')
  expect(() => new FrameInputSchedule(0)).toThrow('positive')
  expect(() => clock.takeFrame(1090)).toThrow('ordered')
})

test('sampling completeness requires native and actual input cadence within one percent of the requested frequency', () => {
  for (const [actual, requested] of [
    [100, 120],
    [50, 60],
    [48, 60],
    [72, 120],
  ])
    expect(meetsSamplingFrequency(actual, requested)).toBe(false)
  for (const [actual, requested] of [
    [144, 120],
    [120, 120],
    [60, 60],
    [119.9077, 120],
    [59.9569, 60],
  ])
    expect(meetsSamplingFrequency(actual, requested)).toBe(true)
  expect(meetsSamplingFrequency(118.8, 120)).toBe(true)
  expect(meetsSamplingFrequency(118.79, 120)).toBe(false)
  expect(meetsSamplingFrequency(null, 120)).toBe(false)
  expect(meetsSamplingFrequency(NaN, 120)).toBe(false)
  expect(() => meetsSamplingFrequency(144, 0)).toThrow('positive')
  const display = meetsSamplingFrequency(144, 120)
  const underdrivenInputs = [120, 119.9, 72].map((actual) => meetsSamplingFrequency(actual, 120))
  expect(display && underdrivenInputs.every(Boolean)).toBe(false)
})
