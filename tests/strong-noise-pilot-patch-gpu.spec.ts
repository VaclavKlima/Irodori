import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  createPilotPatchGpu,
  PILOT_PATCH_GPU_BYTES,
  PILOT_PATCH_MAX_EDGE,
  PILOT_PATCH_WORKING_BYTES,
} from '../scripts/research/strong-noise/pilot-patch-gpu'
import { DETAIL_NOISE_ESTIMATE_VERSION } from '../src/shared/detail-noise-estimate'

type Primaries = 'srgb' | 'rec2020'
interface NumericCase {
  primaries: Primaries
  luminance: number
  chroma: number
  points: { x: number; y: number; rgba32Words: string[] }[]
}
interface Scene {
  id: string
  origin: 'core' | 'alpha'
  width: number
  height: number
  frozenVariance: [number, number, number]
  inputRgba32leHex: string
  sourceSha256: string
  completeRgbOracle: boolean
  cases: NumericCase[]
}
interface Fixture {
  version: number
  referenceKind: string
  candidateId: string
  license: string
  provenance: {
    origins: Record<
      'core' | 'alpha',
      {
        path: string
        referenceSha256: string
        generatorSha256: string
        hostAdapterSha256: string
        approvalSha256: string
        planSha256: string
      }
    >
  }
  limits: { absolute: number; relative: number; alpha: string; hiddenRgba: string; scope: string }
  scenes: Scene[]
}
type Job = Parameters<ReturnType<typeof createPilotPatchGpu>['render']>[0]

const fixturePath = 'assets/tests/references/detail/strong-noise/chroma-pilot-patch-gpu.json'
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
const loadFixture = async () => JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture
const words = (data: Float32Array) => new Uint32Array(data.buffer, data.byteOffset, data.length)

function source(scene: Scene): Float32Array {
  const bytes = Buffer.from(scene.inputRgba32leHex, 'hex'),
    data = new Float32Array(scene.width * scene.height * 4)
  for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(i * 4)
  return data
}

function job(scene: Scene, entry: Pick<NumericCase, 'primaries' | 'luminance' | 'chroma'>): Job {
  const image = { width: scene.width, height: scene.height }
  return {
    image,
    tile: { left: 0, top: 0, ...image },
    source: { left: 0, top: 0, ...image, data: source(scene) },
    estimate: {
      version: DETAIL_NOISE_ESTIMATE_VERSION,
      source: {
        ...image,
        primaries: entry.primaries,
        identity: scene.sourceSha256,
        sha256: scene.sourceSha256,
      },
      variance: scene.frozenVariance,
    },
    luminance: entry.luminance,
    chroma: entry.chroma,
    admission: { maxGpuBytes: PILOT_PATCH_GPU_BYTES, maxWorkingBytes: PILOT_PATCH_WORKING_BYTES },
  }
}

function publishedFloat(word: string): number {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(Number.parseInt(word, 16))
  return bytes.readFloatLE()
}

// These are final RGB owner checks against retained independent vectors. They do
// not import a CPU filter or require equality of GPU intermediate stage words.
async function checkGpuCases(
  info: TestInfo,
  selected: (scene: Scene, entry: NumericCase) => boolean,
) {
  const fixture = await loadFixture(),
    gpu = createPilotPatchGpu(),
    evidence = {
      scope: fixture.limits.scope,
      adapter: undefined as string | undefined,
      cases: 0,
      rgbOwners: 0,
      alphaWords: 0,
      hiddenRgbaWords: 0,
      maximumToleranceRatio: 0,
      selections: [] as {
        scene: string
        primaries: Primaries
        luminance: number
        chroma: number
      }[],
    }
  try {
    for (const scene of fixture.scenes)
      for (const entry of scene.cases) {
        if (!selected(scene, entry)) continue
        const request = job(scene, entry),
          inputBytes = Buffer.from(request.source.data.buffer).toString('hex')
        let result: Float32Array
        try {
          result = await gpu.render(request, signal())
        } catch (error) {
          if (
            error instanceof Error &&
            /No hardware GPU adapter is available/.test(error.message)
          ) {
            info.annotations.push({ type: 'incomplete', description: error.message })
            test.skip(
              true,
              'Required hardware GPU is unavailable; C16 numeric verification is incomplete.',
            )
          }
          throw error
        }
        evidence.adapter = gpu.adapter
        expect(
          evidence.adapter,
          'The completed operator must identify its actual hardware adapter.',
        ).toBeTruthy()
        expect(result).toHaveLength(request.source.data.length)
        expect(
          Buffer.from(request.source.data.buffer).toString('hex'),
          'GPU input remains unchanged.',
        ).toBe(inputBytes)
        const actualWords = words(result),
          inputWords = words(request.source.data)
        for (let i = 0; i < result.length; i += 4) {
          expect(
            [...result.subarray(i, i + 4)].every(Number.isFinite),
            `${scene.id}: nonfinite output at ${i / 4}`,
          ).toBe(true)
          expect(actualWords[i + 3], `${scene.id}: alpha word at ${i / 4}`).toBe(inputWords[i + 3])
          evidence.alphaWords++
          if (request.source.data[i + 3] === 0) {
            expect(
              [...actualWords.subarray(i, i + 4)],
              `${scene.id}: hidden RGBA at ${i / 4}`,
            ).toEqual([...inputWords.subarray(i, i + 4)])
            evidence.hiddenRgbaWords += 4
          }
        }
        for (const point of entry.points) {
          const at = (point.y * scene.width + point.x) * 4
          for (let c = 0; c < 3; c++) {
            const expected = publishedFloat(point.rgba32Words[c]),
              limit = fixture.limits.absolute + fixture.limits.relative * Math.abs(expected),
              error = Math.abs(result[at + c] - expected)
            evidence.maximumToleranceRatio = Math.max(evidence.maximumToleranceRatio, error / limit)
            expect(
              error,
              `${scene.id}/${entry.primaries}/${entry.luminance},${entry.chroma} owner ${point.x},${point.y} channel ${c}`,
            ).toBeLessThanOrEqual(limit)
          }
          evidence.rgbOwners++
        }
        evidence.selections.push({
          scene: scene.id,
          primaries: entry.primaries,
          luminance: entry.luminance,
          chroma: entry.chroma,
        })
        evidence.cases++
      }
    expect(evidence.cases).toBeGreaterThan(0)
  } finally {
    await gpu.close()
    await info.attach('C16 GPU numeric scope', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
  }
  return evidence
}

test('compact vectors retain independent provenance, published RGB and the existing tolerance', async () => {
  const fixture = await loadFixture()
  expect(fixture).toMatchObject({
    version: 1,
    referenceKind: 'chroma-pilot-patch-decimal80-host-f64-v1',
    candidateId: 'noise-scaled-k40-c14-pilot-match5-owner-r10',
    license: 'CC0-1.0',
    limits: {
      absolute: 2e-6,
      relative: 2e-5,
      alpha: 'exact-source-word',
      hiddenRgba: 'exact-source-words',
    },
  })
  expect(fixture.provenance.origins.core.referenceSha256).toBe(
    '9c5f5f6b6bcf47cf360dd11dd4b72e122a1000cbeb6a7882f9c3b4cdad5cbb89',
  )
  expect(fixture.provenance.origins.alpha.referenceSha256).toBe(
    '4936e100d0145f4c951dc04ac6052c2fc51605bc73a63ceb3884017fc09789ba',
  )
  for (const origin of Object.values(fixture.provenance.origins)) {
    expect(origin.generatorSha256).toBe(
      'b448efc7b1ba8b2636166d1f0034f93129a0fd8dcda0afe600106545e89c1104',
    )
    expect(origin.hostAdapterSha256).toBe(
      '23f4b65f49e448612462a653efb29a79c6d7a25daa0d5e6f87c1f9cbaea7be47',
    )
    expect(origin.path).toMatch(/\/reference\.json$/)
    expect(origin.approvalSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(origin.planSha256).toMatch(/^[a-f0-9]{64}$/)
  }
  let cases = 0,
    owners = 0
  for (const scene of fixture.scenes) {
    expect(Math.max(scene.width, scene.height)).toBeLessThanOrEqual(9)
    const bytes = Buffer.from(scene.inputRgba32leHex, 'hex')
    expect(bytes.length).toBe(scene.width * scene.height * 16)
    expect(sha(bytes)).toBe(scene.sourceSha256)
    for (const entry of scene.cases) {
      expect(['srgb', 'rec2020']).toContain(entry.primaries)
      const locations = new Set<string>()
      for (const point of entry.points) {
        expect(point.x).toBeGreaterThanOrEqual(0)
        expect(point.x).toBeLessThan(scene.width)
        expect(point.y).toBeGreaterThanOrEqual(0)
        expect(point.y).toBeLessThan(scene.height)
        expect(point.rgba32Words).toHaveLength(4)
        for (const word of point.rgba32Words) expect(word).toMatch(/^[a-f0-9]{8}$/)
        expect(point.rgba32Words.map(publishedFloat).every(Number.isFinite)).toBe(true)
        expect(Number.parseInt(point.rgba32Words[3], 16)).toBe(
          bytes.readUInt32LE((point.y * scene.width + point.x) * 16 + 12),
        )
        locations.add(`${point.x},${point.y}`)
      }
      expect(locations.size).toBe(entry.points.length)
      if (scene.completeRgbOracle) expect(locations.size).toBe(scene.width * scene.height)
      cases++
      owners += entry.points.length
    }
  }
  expect(fixture.scenes).toHaveLength(7)
  expect(cases).toBe(18)
  expect(owners).toBe(62)
  expect(
    fixture.scenes.filter((scene) => scene.completeRgbOracle).map((scene) => scene.id),
  ).toEqual(['clamped-bias'])
})

for (const primaries of ['srgb', 'rec2020'] as const) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  test(`GPU ${primaries} keeps signed HDR, noisy and complete clamped outputs within the retained RGB tolerance`, async ({}, info) => {
    const evidence = await checkGpuCases(
      info,
      (scene, entry) => scene.origin === 'core' && entry.primaries === primaries,
    )
    expect(evidence.cases).toBe(6)
    expect(evidence.rgbOwners).toBe(20)
    expect(evidence.alphaWords).toBe(148)
  })
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('GPU partial alpha and hidden RGB retain independent RGB owners and exact whole-frame alpha/hidden words', async ({}, info) => {
  const evidence = await checkGpuCases(info, (scene) => scene.origin === 'alpha')
  expect(evidence.cases).toBe(6)
  expect(evidence.rgbOwners).toBe(22)
  expect(evidence.alphaWords).toBe(210)
  expect(evidence.hiddenRgbaWords).toBeGreaterThan(0)
})

test('neutral signed-zero, HDR and partial-alpha requests copy every source word without a device', async () => {
  const fixture = await loadFixture()
  let creations = 0
  const gpu = createPilotPatchGpu(() => {
    creations++
    throw new Error('A neutral request must not initialize a GPU.')
  })
  try {
    for (const id of ['signed-zero-identity', 'signed-hdr', 'partial-alpha']) {
      const scene = fixture.scenes.find((item) => item.id === id)!,
        request = job(scene, { primaries: 'rec2020', luminance: 0, chroma: 0 }),
        copied = await gpu.render(request, signal())
      expect([...words(copied)]).toEqual([...words(request.source.data)])
      expect(copied.buffer).not.toBe(request.source.data.buffer)
    }
    expect(creations).toBe(0)
    expect(gpu.allocatedBytes).toBe(0)
  } finally {
    await gpu.close()
  }
})

test('resource refusal, partial-image refusal and pre-cancellation happen before device creation', async () => {
  const fixture = await loadFixture(),
    scene = fixture.scenes.find((item) => item.id === 'noise-like-low')!
  let creations = 0
  const gpu = createPilotPatchGpu(() => {
      creations++
      throw new Error('Rejected requests must not initialize a GPU.')
    }),
    request = job(scene, { primaries: 'srgb', luminance: 75, chroma: 75 }),
    controller = new AbortController()
  try {
    expect(PILOT_PATCH_MAX_EDGE).toBeGreaterThanOrEqual(scene.width)
    expect(PILOT_PATCH_GPU_BYTES).toBeGreaterThan(0)
    expect(PILOT_PATCH_WORKING_BYTES).toBeGreaterThan(PILOT_PATCH_GPU_BYTES)
    await expect(
      gpu.render({ ...request, admission: { maxGpuBytes: 0, maxWorkingBytes: 0 } }, signal()),
    ).rejects.toThrow(/admi|budget|storage/i)
    await expect(
      gpu.render({ ...request, tile: { ...request.tile, width: scene.width - 1 } }, signal()),
    ).rejects.toThrow(/whole|partial|image|tile/i)
    const reason = new Error('C16 numeric pre-cancellation')
    controller.abort(reason)
    await expect(gpu.render(request, controller.signal)).rejects.toThrow(reason.message)
    expect(creations).toBe(0)
    expect(gpu.allocatedBytes).toBe(0)
  } finally {
    await gpu.close()
  }
})
