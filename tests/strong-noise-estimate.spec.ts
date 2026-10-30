import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  DETAIL_NOISE_ESTIMATE_MAX_PAIRS,
  DETAIL_NOISE_ESTIMATE_VERSION,
  detailNoiseEstimateMemory,
  estimateDetailNoise,
  type DetailNoiseEstimate,
  type DetailNoiseSource,
} from '../src/shared/detail-noise-estimate'
import type { ColorPrimaries } from '../src/shared/color-model'

const identity = 'a'.repeat(64)
const sha256 = 'b'.repeat(64)
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const independentEstimator = String.raw`
import hashlib, importlib.util, json, pathlib, struct, sys
root=pathlib.Path.cwd()
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
model=load('independent_estimator_coordinates',root/'scripts/research/detail-candidates.py')
method=load('independent_estimator_medians',root/'scripts/research/strong-noise/pixelwise.py')
input_path,output_path,width,height,primary=sys.argv[1:]
data=pathlib.Path(input_path).read_bytes()
source=list(struct.iter_unpack('<4f',data))
assert len(source)==int(width)*int(height)
features=[model.encode(p,model.LUMINANCE[primary]) if p[3]>0 else (0.,0.,0.) for p in source]
result=method.estimate(features,[p[3] for p in source],int(width),int(height))
result['sourceSha256']=hashlib.sha256(data).hexdigest()
result['generatorSha256']=hashlib.sha256((root/'scripts/research/strong-noise/pixelwise.py').read_bytes()).hexdigest()
pathlib.Path(output_path).write_text(json.dumps(result,allow_nan=False))
`

type Pixel = readonly [number, number, number, number]
type PixelAt = (x: number, y: number) => Pixel
type NumericEstimate = Pick<
  DetailNoiseEstimate,
  'version' | 'directions' | 'sigma' | 'variance' | 'available'
>
interface Sampling {
  source: DetailNoiseSource
  calls: number[]
  destinations: Set<number>
}
function sampler(
  width: number,
  height: number,
  pixel: PixelAt,
  primaries: ColorPrimaries = 'rec2020',
  chunkRows = 1,
): Sampling {
  const calls: number[] = [],
    destinations = new Set<number>()
  let first = -1,
    cache = new Float32Array(0)
  const source: DetailNoiseSource = {
    width,
    height,
    identity,
    sha256,
    primaries,
    async readRow(row, destination, signal) {
      signal.throwIfAborted()
      calls.push(row)
      destinations.add(destination.byteOffset)
      const block = Math.floor(row / chunkRows) * chunkRows
      if (first !== block) {
        first = block
        cache = new Float32Array(width * Math.min(chunkRows, height - block) * 4)
        for (let y = block; y < Math.min(block + chunkRows, height); y++)
          for (let x = 0; x < width; x++) cache.set(pixel(x, y), ((y - block) * width + x) * 4)
      }
      destination.set(cache.subarray((row - first) * width * 4, (row - first + 1) * width * 4))
    },
  }
  return { source, calls, destinations }
}
const budget = (source: DetailNoiseSource) => ({
  maxWorkingBytes: detailNoiseEstimateMemory(source).workingBytes,
})
const signal = () => new AbortController().signal
const pattern: PixelAt = (x, y) => [
  (((x * 17 + y * 31) % 43) - 21) / 32,
  (((x * 7 + y * 13) % 37) - 18) / 64,
  (((x * 23 + y * 5) % 41) - 20) / 128,
  [0, 2 ** -149, 2 ** -20, 0.25, 0.5, 1][(x + 3 * y) % 6],
]

async function oracle(
  source: DetailNoiseSource,
  pixel: PixelAt,
  info: TestInfo,
  name: string,
): Promise<NumericEstimate> {
  const bytes = Buffer.alloc(source.width * source.height * 16)
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const p = pixel(x, y)
      for (let c = 0; c < 4; c++) bytes.writeFloatLE(p[c], ((y * source.width + x) * 4 + c) * 4)
    }
  const directory = info.outputPath(name)
  await mkdir(directory, { recursive: true })
  const input = join(directory, 'input.f32'),
    output = join(directory, 'reference.json')
  await writeFile(input, bytes)
  await new Promise<void>((accept, reject) => {
    const child = execFile(
      python,
      [
        '-c',
        independentEstimator,
        input,
        output,
        String(source.width),
        String(source.height),
        source.primaries,
      ],
      { timeout: 30_000, maxBuffer: 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(directory, 'stdout.txt'), stdout),
          writeFile(join(directory, 'stderr.txt'), stderr),
        ]).then(() => {
          if (error) reject(new Error(`Independent estimator failed: ${stderr}`, { cause: error }))
          else accept()
        }, reject)
      },
    )
    children.add(child)
  })
  const result = JSON.parse(await readFile(output, 'utf8'))
  expect(result.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(result.generatorSha256).toBe(
    createHash('sha256')
      .update(await readFile('scripts/research/strong-noise/pixelwise.py'))
      .digest('hex'),
  )
  return result as NumericEstimate
}
function agrees(actual: DetailNoiseEstimate, expected: NumericEstimate): void {
  expect(actual.version).toBe(expected.version)
  expect(actual.available).toBe(expected.available)
  const near = (a: number | null, b: number | null) => {
    if (a === null || b === null) expect(a).toBe(b)
    else expect(Math.abs(a - b)).toBeLessThanOrEqual(2e-12 + 2e-11 * Math.abs(b))
  }
  for (let c = 0; c < 3; c++) {
    near(actual.sigma[c], expected.sigma[c])
    near(actual.variance[c], expected.variance[c])
  }
  for (let d = 0; d < 4; d++) {
    const a = actual.directions[d],
      b = expected.directions[d]
    expect(a.direction).toEqual(b.direction)
    expect([a.availablePairs, a.stratifiedPairs, a.validPairs]).toEqual([
      b.availablePairs,
      b.stratifiedPairs,
      b.validPairs,
    ])
    for (let c = 0; c < 3; c++) {
      near(a.centers[c], b.centers[c])
      near(a.sigma[c], b.sigma[c])
    }
  }
}
test.afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((accept) => {
          if (child.exitCode !== null || child.signalCode !== null) return accept()
          child.once('close', () => accept())
          child.kill('SIGTERM')
        }),
    ),
  )
  children.clear()
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('full-source MAD agrees with independently committed Python medians across signed HDR, fractional and minimum-subnormal alpha', async ({}, info) => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const sample = sampler(23, 19, pattern, primaries)
    const actual = await estimateDetailNoise(sample.source, budget(sample.source), signal())
    agrees(actual, await oracle(sample.source, pattern, info, primaries))
    expect(actual.available).toBe(true)
    expect(sample.destinations.size).toBeLessThanOrEqual(2)
    expect(sample.calls.length).toBeLessThanOrEqual(4 * sample.source.height + 4)
    expect(
      Object.isFrozen(actual) &&
        Object.isFrozen(actual.source) &&
        Object.isFrozen(actual.directions),
    ).toBe(true)
    expect(
      Object.isFrozen(actual.directions[0]) && Object.isFrozen(actual.directions[0].centers),
    ).toBe(true)
    expect(actual.source.verification).toBe('caller-owned-source-lease-and-hashes')
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('exact even half-weight ties average adjacent values and require sixteen valid pairs', async ({}, info) => {
  const alternating: PixelAt = (_x, y) => (y % 2 ? [0.25, 0.125, -0.125, 1] : [0, 0, 0, 1])
  const enough = sampler(1, 17, alternating)
  const result = await estimateDetailNoise(enough.source, budget(enough.source), signal())
  agrees(result, await oracle(enough.source, alternating, info, 'ties'))
  expect(result.directions[1].validPairs).toBe(16)
  expect(result.directions[1].centers).toEqual([0, 0, 0])
  expect(result.sigma[0]).toBeGreaterThan(0)
  const short = sampler(1, 16, alternating)
  const unavailable = await estimateDetailNoise(short.source, budget(short.source), signal())
  expect(unavailable.available).toBe(false)
  expect(unavailable.directions[1].validPairs).toBe(15)
  expect(unavailable.directions[1].sigma).toEqual([null, null, null])
  expect(unavailable.variance).toEqual([0, 0, 0])
})

test('constant scenes, alpha-zero payload changes and caller read chunking do not invent variance', async () => {
  const flat: PixelAt = () => [0.25, 0.25, 0.25, 1]
  const constant = sampler(19, 17, flat)
  const neutral = await estimateDetailNoise(constant.source, budget(constant.source), signal())
  expect(neutral.available).toBe(true)
  expect(neutral.sigma).toEqual([0, 0, 0])
  const hidden: PixelAt = (x, y) =>
    pattern(x, y)[3] === 0 ? [NaN, Infinity, -Infinity, 0] : pattern(x, y)
  const first = sampler(23, 19, pattern, 'rec2020', 1),
    second = sampler(23, 19, hidden, 'rec2020', 8)
  const a = await estimateDetailNoise(first.source, budget(first.source), signal())
  const b = await estimateDetailNoise(second.source, budget(second.source), signal())
  expect(b.directions).toEqual(a.directions)
  expect(b.variance).toEqual(a.variance)
  expect(second.destinations.size).toBeLessThanOrEqual(2)
})

test('common exact power-two alpha scaling preserves medians and global coefficients', async () => {
  const opaque: PixelAt = (x, y) => {
    const p = pattern(x, y)
    return [p[0], p[1], p[2], [2 ** -20, 0.25, 0.5, 1][(x + y) % 4]]
  }
  const scaled: PixelAt = (x, y) => {
    const p = opaque(x, y)
    return [p[0], p[1], p[2], p[3] * 2 ** -80]
  }
  const a = sampler(23, 19, opaque),
    b = sampler(23, 19, scaled)
  const first = await estimateDetailNoise(a.source, budget(a.source), signal())
  const second = await estimateDetailNoise(b.source, budget(b.source), signal())
  expect(second.directions).toEqual(first.directions)
  expect(second.variance).toEqual(first.variance)
})

test('stratification caps pairs and samples midpoint coordinates rather than a truncated prefix', async () => {
  // 256*257 origins: exactly origin128 is omitted around the first midpoint gap.
  // Alpha0 at pixel(128,0) invalidates selected origin127; omitted origin128
  // must not be counted as a second invalid sampled pair.
  const scene = sampler(257, 257, (x, y) => [0.25, 0.25, 0.25, x === 128 && y === 0 ? 0 : 1])
  const plan = detailNoiseEstimateMemory(scene.source)
  expect(plan.maximumPairs).toBe(DETAIL_NOISE_ESTIMATE_MAX_PAIRS)
  expect(plan.statisticsBytes).toBe(65_536 * 36)
  expect(plan.rowBytes).toBe(257 * 32)
  const result = await estimateDetailNoise(scene.source, budget(scene.source), signal())
  expect(result.directions[0]).toMatchObject({
    availablePairs: 256 * 257,
    stratifiedPairs: 65_536,
    validPairs: 65_535,
  })
  expect(result.variance).toEqual([0, 0, 0])
  expect(scene.calls.length).toBeLessThanOrEqual(4 * 257 + 4)
})

test('admission, geometry and malformed rows fail before unbounded storage or further reads', async () => {
  const sample = sampler(32, 24, pattern)
  const plan = detailNoiseEstimateMemory(sample.source)
  await expect(
    estimateDetailNoise(sample.source, { maxWorkingBytes: plan.workingBytes - 1 }, signal()),
  ).rejects.toThrow('admitted working bytes')
  expect(sample.calls).toEqual([])
  expect(() => detailNoiseEstimateMemory({ width: 32768, height: 1025 })).toThrow()
  expect(() => detailNoiseEstimateMemory({ width: 0, height: 1 })).toThrow()
  const large = detailNoiseEstimateMemory({ width: 5496, height: 3672 })
  expect(large.workingBytes).toBe(2_359_296 + 5496 * 32 + large.scratchBytes)
  expect(large.workingBytes).toBeLessThan(3 * 1024 ** 2)
  for (const alpha of [NaN, -0.1, 1.1, Infinity]) {
    const invalid = sampler(4, 4, () => [0.1, 0.1, 0.1, alpha])
    await expect(
      estimateDetailNoise(invalid.source, budget(invalid.source), signal()),
    ).rejects.toThrow('source row')
    expect(invalid.calls).toHaveLength(1)
  }
  const incomplete: DetailNoiseSource = { ...sample.source, async readRow() {} }
  await expect(estimateDetailNoise(incomplete, budget(incomplete), signal())).rejects.toThrow(
    'source row',
  )
  const visible = sampler(4, 4, () => [NaN, 0, 0, 1])
  await expect(
    estimateDetailNoise(visible.source, budget(visible.source), signal()),
  ).rejects.toThrow('source row')
})

test('cancellation before reading, during a row and during CPU work never publishes a partial estimate', async () => {
  const cancelled = new AbortController(),
    reason = new Error('cancel estimator')
  cancelled.abort(reason)
  const before = sampler(23, 19, pattern)
  await expect(
    estimateDetailNoise(before.source, budget(before.source), cancelled.signal),
  ).rejects.toBe(reason)
  expect(before.calls).toEqual([])
  const active = new AbortController(),
    sample = sampler(23, 19, pattern)
  const during: DetailNoiseSource = {
    ...sample.source,
    async readRow(y, row, requestSignal) {
      await sample.source.readRow(y, row, requestSignal)
      active.abort(reason)
    },
  }
  await expect(estimateDetailNoise(during, budget(during), active.signal)).rejects.toBe(reason)
  expect(sample.calls).toHaveLength(1)
  const computing = new AbortController(),
    field = sampler(257, 257, () => [0.2, 0.1, 0.3, 1])
  const timer = setTimeout(() => computing.abort(reason), 0)
  try {
    await expect(
      estimateDetailNoise(field.source, budget(field.source), computing.signal),
    ).rejects.toBe(reason)
  } finally {
    clearTimeout(timer)
  }
})

test('source provenance is frozen before the first asynchronous read without claiming authentication', async () => {
  const sample = sampler(19, 17, () => [0.25, 0.25, 0.25, 1])
  const mutable = {
    ...sample.source,
    async readRow(y: number, row: Float32Array, requestSignal: AbortSignal) {
      mutable.identity = 'c'.repeat(64)
      mutable.sha256 = 'd'.repeat(64)
      await sample.source.readRow(y, row, requestSignal)
    },
  }
  const result = await estimateDetailNoise(mutable, budget(mutable), signal())
  expect(result.version).toBe(DETAIL_NOISE_ESTIMATE_VERSION)
  expect(result.source.identity).toBe(identity)
  expect(result.source.sha256).toBe(sha256)
  expect(result.source.verification).toBe('caller-owned-source-lease-and-hashes')
})
