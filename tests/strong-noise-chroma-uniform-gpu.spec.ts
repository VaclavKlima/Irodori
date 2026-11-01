import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  createPatchwiseResearchGpu,
  PATCHWISE_RESEARCH_GPU_BYTES,
  PATCHWISE_RESEARCH_WORKING_BYTES,
  type PatchwiseResearchJob,
  type ResearchChromaSpatialPolicy,
} from '../scripts/research/strong-noise/gpu'
import {
  patchwiseNoiseWgsl,
  patchwiseNoiseWgslForChromaSpatialPolicy,
} from '../scripts/research/strong-noise/gpu-wgsl'
import { DETAIL_NOISE_ESTIMATE_VERSION } from '../src/shared/detail-noise-estimate'

const children = new Set<ChildProcess>()
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
const referenceKind = 'chroma-uniform-patchwise-decimal80-v1'
const candidateId = 'noise-scaled-k40-chroma-uniform'
const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const directory = resolve('scripts/research/strong-noise/reference')

async function run(
  executable: string,
  args: string[],
  input: string,
  info: TestInfo,
  name: string,
): Promise<{ error: Error | null; stdout: string }> {
  const logs = info.outputPath(name)
  await mkdir(logs, { recursive: true })
  return new Promise((accept, reject) => {
    const child = execFile(
      executable,
      args,
      { timeout: 240_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(logs, 'stdout.txt'), stdout),
          writeFile(join(logs, 'stderr.txt'), stderr),
        ]).then(() => accept({ error, stdout }), reject)
      },
    )
    children.add(child)
    child.stdin!.end(input)
  })
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

function job(data: Float32Array, width: number, height: number): PatchwiseResearchJob {
  const identity = sha(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  return {
    image: { width, height },
    tile: { left: 0, top: 0, width, height },
    source: { left: 0, top: 0, width, height, data },
    estimate: {
      version: DETAIL_NOISE_ESTIMATE_VERSION,
      source: { width, height, primaries: 'rec2020', identity, sha256: identity },
      variance: [0.0004, 0.0004, 0.0004],
    },
    luminance: 50,
    chroma: 50,
    chromaSigmaFactor: 0.4,
    admission: {
      maxGpuBytes: PATCHWISE_RESEARCH_GPU_BYTES,
      maxWorkingBytes: PATCHWISE_RESEARCH_WORKING_BYTES,
    },
  }
}

test('chroma uniform shader is explicit while the default shader and luminance expression stay unchanged', () => {
  expect(patchwiseNoiseWgslForChromaSpatialPolicy()).toBe(patchwiseNoiseWgsl)
  expect(patchwiseNoiseWgslForChromaSpatialPolicy('gaussian-search-v1')).toBe(patchwiseNoiseWgsl)
  const uniform = patchwiseNoiseWgslForChromaSpatialPolicy('uniform-search-v1'),
    luminance = 'weights.x=baseWeight*exp(-corrected.x*patchParams.noise.z-corrected.y/(.12*.12))'
  expect(uniform).toContain(luminance)
  expect(patchwiseNoiseWgsl).toContain(luminance)
  expect(uniform).toContain(
    'weights.y=neighbor.a*exp(-corrected.x/(.08*.08)-corrected.y*patchParams.noise.w)',
  )
  expect(uniform).not.toContain('weights.y=baseWeight*exp(')
  expect(patchwiseNoiseWgsl).toContain('weights.y=baseWeight*exp(')
  expect(() =>
    patchwiseNoiseWgslForChromaSpatialPolicy('unknown' as ResearchChromaSpatialPolicy),
  ).toThrow('Unknown research chroma spatial policy')
})

test('the owner freezes its matching policy and keeps exact neutral copies and admission ahead of device initialization', async () => {
  let creations = 0
  const makeRenderer = () => {
      creations++
      throw new Error('A neutral or rejected request must not initialize a device.')
    },
    options: { chromaSpatialPolicy: ResearchChromaSpatialPolicy } = {
      chromaSpatialPolicy: 'uniform-search-v1',
    },
    gpu = createPatchwiseResearchGpu(makeRenderer, options),
    data = new Float32Array([-0, 0.25, -0.5, 0, 8, -2, 0.5, 1]),
    neutral = { ...job(data, 2, 1), luminance: 0, chroma: 0 }
  options.chromaSpatialPolicy = 'gaussian-search-v1'
  expect(gpu.chromaSpatialPolicy).toBe('uniform-search-v1')
  try {
    const copied = await gpu.render(neutral, signal())
    expect(new Uint32Array(copied.buffer)).toEqual(new Uint32Array(data.buffer))
    expect(gpu.allocatedBytes).toBe(0)
    await expect(
      gpu.render(
        { ...job(data, 2, 1), admission: { maxGpuBytes: 0, maxWorkingBytes: 0 } },
        signal(),
      ),
    ).rejects.toThrow('admitted numeric storage')
    expect(creations).toBe(0)
    expect(() =>
      createPatchwiseResearchGpu(makeRenderer, {
        chromaSpatialPolicy: 'mean-guard' as ResearchChromaSpatialPolicy,
      }),
    ).toThrow('Unknown research chroma spatial policy')
    expect(() =>
      createPatchwiseResearchGpu(makeRenderer, {
        chromaSpatialPolicy: null as unknown as ResearchChromaSpatialPolicy,
      }),
    ).toThrow('Unknown research chroma spatial policy')
    expect(creations).toBe(0)
  } finally {
    await gpu.close()
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('the isolated child reports its frozen policy and refuses switching or undeclared fields without initializing a GPU', async ({}, info) => {
  await mkdir(info.outputDir, { recursive: true })
  const built = await run(
    process.execPath,
    [resolve('scripts/research/strong-noise/build-gpu-child.mjs'), info.outputPath('bundle')],
    '',
    info,
    'build',
  )
  expect(built.error, built.stdout).toBeNull()
  const bundle = JSON.parse(built.stdout).bundle as string,
    inputPath = info.outputPath('source.f32'),
    source = Buffer.alloc(16)
  source.writeFloatLE(-0, 0)
  source.writeFloatLE(0.5, 4)
  source.writeFloatLE(-0.25, 8)
  source.writeFloatLE(1, 12)
  await writeFile(inputPath, source)
  const request = {
      id: 0,
      inputPath,
      outputPath: info.outputPath('first.f32'),
      width: 1,
      height: 1,
      sourceSha256: sha(source),
      primaries: 'rec2020',
      luminance: 0,
      chroma: 0,
      chromaSigmaFactor: 0.4,
      chromaSpatialPolicy: 'uniform-search-v1',
    },
    switched = await run(
      process.execPath,
      [bundle, info.outputDir],
      JSON.stringify(request) +
        '\n' +
        JSON.stringify({
          ...request,
          id: 1,
          outputPath: info.outputPath('switched.f32'),
          chromaSpatialPolicy: 'gaussian-search-v1',
        }) +
        '\n',
      info,
      'policy-switch',
    ),
    replies = switched.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  expect(switched.error).not.toBeNull()
  expect(replies).toHaveLength(2)
  expect(replies[0]).toMatchObject({
    id: 0,
    chromaSpatialPolicy: 'uniform-search-v1',
    gpuBytes: 0,
    outputSha256: sha(source),
  })
  expect(replies[0].adapter).toBeUndefined()
  expect(replies[1]).toMatchObject({ id: 1 })
  expect(replies[1].error).toContain('cannot switch its frozen chroma spatial policy')
  expect(await readFile(request.outputPath)).toEqual(source)
  await expect(access(info.outputPath('switched.f32'))).rejects.toThrow()
  const unknown = await run(
    process.execPath,
    [bundle, info.outputDir],
    JSON.stringify({ ...request, id: 2, undeclaredMeanGuard: true }) + '\n',
    info,
    'unknown-field',
  )
  expect(unknown.error).not.toBeNull()
  expect(JSON.parse(unknown.stdout)).toMatchObject({ id: 2 })
  expect(JSON.parse(unknown.stdout).error).toContain('unknown or missing fields')
  const defaultRequest = { ...request, chromaSpatialPolicy: undefined }
  const ordinary = await run(
    process.execPath,
    [bundle, info.outputDir],
    JSON.stringify({ ...defaultRequest, id: 3, outputPath: info.outputPath('ordinary.f32') }) +
      '\n',
    info,
    'default-policy',
  )
  expect(ordinary.error, ordinary.stdout).toBeNull()
  expect(JSON.parse(ordinary.stdout)).toMatchObject({
    id: 3,
    chromaSpatialPolicy: 'gaussian-search-v1',
    gpuBytes: 0,
  })
  expect(await readFile(info.outputPath('ordinary.f32'))).toEqual(source)
})

interface ReferencePlan {
  referenceKind: string
  candidateId: string
  planSha256: string
  candidateImported: boolean
  group: string
  configurations: number
  baseLuminanceMaximum: string
  baseChromaMaximum: string
  chromaSigmaFactor: string
  chromaSpatialPolicy: string
  primaries: ('srgb' | 'rec2020')[]
  controls: number[][]
  cases: {
    id: string
    width: number
    height: number
    points: number[][]
    frozenVariance: string[]
  }[]
  pairChecks: { left: string; right: string }[]
  sharedGeneratorSha256: string
  sharedInputPlanSha256: string
}
interface ReferenceScene {
  id: string
  width: number
  height: number
  inputRgba32leHex: string
  sourceSha256: string
  frozenVariance: string[]
  cases: {
    primaries: 'srgb' | 'rec2020'
    luminance: number
    chroma: number
    hLMax: string
    hCBase: string
    chromaSigmaFactor: string
    chromaSpatialPolicy: string
    points: { x: number; y: number; outputFloat64: number[] }[]
  }[]
}

for (const [group, expectedConfigurations] of [
  ['core', 108],
  ['alpha', 84],
  ['asymmetric', 12],
  ['identity', 180],
] as const) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  test(`chroma-only uniform ${group} matches independent reference while retaining Gaussian C0 output`, async ({}, info) => {
    test.setTimeout(300_000)
    await mkdir(info.outputDir, { recursive: true })
    const generator = join(directory, 'chroma-uniform.py'),
      generatorBytes = await readFile(generator),
      sharedGeneratorBytes = await readFile(join(directory, 'reference.py')),
      sharedPlanBytes = await readFile(join(directory, 'input-plan.json')),
      selected = await run(python, [generator, '--plan', '--group', group], '', info, 'plan')
    expect(selected.error, selected.stdout).toBeNull()
    const plan = JSON.parse(selected.stdout) as ReferencePlan
    expect(plan.referenceKind).toBe(referenceKind)
    expect(plan.candidateId).toBe(candidateId)
    expect(plan.candidateImported).toBe(false)
    expect(plan.group).toBe(group)
    expect(plan.configurations).toBe(expectedConfigurations)
    expect(plan.primaries).toEqual(['srgb', 'rec2020'])
    expect(plan.baseLuminanceMaximum).toBe('0.024')
    expect(plan.baseChromaMaximum).toBe('0.024')
    expect(plan.chromaSigmaFactor).toBe('0.4')
    expect(plan.chromaSpatialPolicy).toBe('uniform-search-v1')
    expect(plan.sharedGeneratorSha256).toBe(sha(sharedGeneratorBytes))
    expect(plan.sharedInputPlanSha256).toBe(sha(sharedPlanBytes))
    expect(plan.cases.length * plan.controls.length * plan.primaries.length).toBe(
      expectedConfigurations,
    )
    const approval = info.outputPath('approval.json'),
      referencePath = info.outputPath('reference.json')
    await writeFile(
      approval,
      JSON.stringify({
        referenceGenerationApproved: true,
        referenceKind,
        generatorSha256: sha(generatorBytes),
        sharedGeneratorSha256: sha(sharedGeneratorBytes),
        sharedInputPlanSha256: sha(sharedPlanBytes),
        planSha256: plan.planSha256,
        group,
      }),
    )
    const generated = await run(
      python,
      [
        generator,
        '--generate',
        '--group',
        group,
        '--approved-freeze',
        approval,
        '--output',
        referencePath,
      ],
      '',
      info,
      'generation',
    )
    expect(generated.error, generated.stdout).toBeNull()
    const reference = JSON.parse(await readFile(referencePath, 'utf8')) as {
      referenceKind: string
      candidateId: string
      generatorSha256: string
      planSha256: string
      chromaSpatialPolicy: string
      candidateImported: boolean
      scenes: ReferenceScene[]
      selection: {
        cases: string[]
        controls: number[][]
        primaries: string[]
        configurations: number
      }
    }
    expect(reference.referenceKind).toBe(referenceKind)
    expect(reference.candidateId).toBe(candidateId)
    expect(reference.generatorSha256).toBe(sha(generatorBytes))
    expect(reference.planSha256).toBe(plan.planSha256)
    expect(reference.candidateImported).toBe(false)
    expect(reference.chromaSpatialPolicy).toBe('uniform-search-v1')
    expect(reference.selection).toEqual({
      cases: plan.cases.map((scene) => scene.id),
      controls: plan.controls,
      primaries: plan.primaries,
      configurations: expectedConfigurations,
    })
    expect(reference.scenes.map((scene) => scene.id)).toEqual(plan.cases.map((scene) => scene.id))
    const uniform = createPatchwiseResearchGpu(undefined, {
        chromaSpatialPolicy: 'uniform-search-v1',
      }),
      gaussian = createPatchwiseResearchGpu(),
      outputs = new Map<string, Map<string, { words: Uint32Array; alpha: Float32Array }>>()
    let completed = 0,
      refused = 0,
      checkedRgbChannels = 0,
      alphaWords = 0,
      c0Words = 0,
      identityWords = 0,
      pairedRgbWords = 0,
      maximumToleranceRatio = 0
    try {
      for (const [index, scene] of reference.scenes.entries()) {
        expect([scene.width, scene.height]).toEqual([
          plan.cases[index].width,
          plan.cases[index].height,
        ])
        expect(scene.frozenVariance).toEqual(plan.cases[index].frozenVariance)
        expect(
          scene.cases.map((entry) => [entry.primaries, entry.luminance, entry.chroma]),
        ).toEqual(
          plan.primaries.flatMap((primary) => plan.controls.map(([l, c]) => [primary, l, c])),
        )
        const bytes = Buffer.from(scene.inputRgba32leHex, 'hex')
        expect(bytes.length).toBe(scene.width * scene.height * 16)
        expect(sha(bytes)).toBe(scene.sourceSha256)
        const data = new Float32Array(bytes.length / 4)
        for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(i * 4)
        const sourceWords = new Uint32Array(data.buffer),
          base = job(data, scene.width, scene.height),
          tiny = Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]).some(
            (alpha) => alpha > 0 && alpha < 2 ** -20,
          ),
          sceneOutputs = new Map<string, { words: Uint32Array; alpha: Float32Array }>()
        outputs.set(scene.id, sceneOutputs)
        for (const entry of scene.cases) {
          expect([entry.hLMax, entry.hCBase, entry.chromaSigmaFactor]).toEqual([
            '0.024',
            '0.024',
            '0.4',
          ])
          expect(entry.chromaSpatialPolicy).toBe('uniform-search-v1')
          expect(entry.points.map((point) => [point.x, point.y])).toEqual(plan.cases[index].points)
          const current: PatchwiseResearchJob = {
            ...base,
            luminance: entry.luminance,
            chroma: entry.chroma,
            estimate: {
              ...base.estimate,
              source: { ...base.estimate.source, primaries: entry.primaries },
              variance: scene.frozenVariance.map(Number) as [number, number, number],
            },
          }
          if (tiny && (entry.luminance || entry.chroma)) {
            await expect(uniform.render(current, signal())).rejects.toThrow('Float64 recovery')
            if (entry.chroma === 0)
              await expect(gaussian.render(current, signal())).rejects.toThrow('Float64 recovery')
            refused++
            continue
          }
          const actual = await uniform.render(current, signal()),
            words = new Uint32Array(actual.buffer)
          for (let i = 0; i < data.length; i += 4) {
            expect(words[i + 3]).toBe(sourceWords[i + 3])
            alphaWords++
            if (data[i + 3] === 0 || (entry.luminance === 0 && entry.chroma === 0))
              for (let c = 0; c < 3; c++) {
                expect(words[i + c]).toBe(sourceWords[i + c])
                identityWords++
              }
            for (let c = 0; c < 3; c++) expect(Number.isFinite(actual[i + c])).toBe(true)
          }
          if (entry.chroma === 0) {
            const old = await gaussian.render(current, signal())
            expect(words).toEqual(new Uint32Array(old.buffer))
            c0Words += words.length
          }
          for (const point of entry.points)
            for (let c = 0; c < 3; c++) {
              const at = (point.y * scene.width + point.x) * 4 + c,
                expected = point.outputFloat64[c],
                ratio = Math.abs(actual[at] - expected) / (2e-6 + 2e-5 * Math.abs(expected))
              maximumToleranceRatio = Math.max(maximumToleranceRatio, ratio)
              expect(
                ratio,
                JSON.stringify({
                  group,
                  scene: scene.id,
                  primaries: entry.primaries,
                  controls: [entry.luminance, entry.chroma],
                  point: [point.x, point.y],
                  c,
                  actual: actual[at],
                  expected,
                }),
              ).toBeLessThanOrEqual(1)
              checkedRgbChannels++
            }
          sceneOutputs.set(`${entry.primaries}:${entry.luminance}:${entry.chroma}`, {
            words,
            alpha: data,
          })
          completed++
        }
      }
      for (const pair of plan.pairChecks) {
        const left = outputs.get(pair.left),
          right = outputs.get(pair.right)
        expect(left).toBeDefined()
        expect(right).toBeDefined()
        for (const [key, entry] of left!) {
          const other = right!.get(key)
          if (!other) continue
          expect(entry.words.length).toBe(other.words.length)
          for (let i = 0; i < entry.words.length; i += 4) {
            if (entry.alpha[i + 3] === 0 || other.alpha[i + 3] === 0) continue
            for (let c = 0; c < 3; c++) {
              expect(
                entry.words[i + c],
                JSON.stringify({ group, pair, key, pixel: i / 4, c }),
              ).toBe(other.words[i + c])
              pairedRgbWords++
            }
          }
        }
      }
      expect(completed + refused).toBe(expectedConfigurations)
      expect(completed).toBeGreaterThan(0)
      expect(alphaWords).toBeGreaterThan(0)
      expect(c0Words).toBeGreaterThan(0)
      if (group === 'asymmetric') expect(identityWords).toBe(0)
      else expect(identityWords).toBeGreaterThan(0)
      if (group === 'identity') expect(checkedRgbChannels).toBe(0)
      else expect(checkedRgbChannels).toBeGreaterThan(0)
      if (group === 'alpha' || group === 'identity') expect(refused).toBeGreaterThan(0)
      if (group === 'alpha') expect(pairedRgbWords).toBeGreaterThan(0)
      expect(uniform.allocatedBytes).toBe(PATCHWISE_RESEARCH_GPU_BYTES)
      expect(uniform.programCount).toBe(3)
      const activeGaussian = plan.controls.some(
        ([luminance, chroma]) => luminance > 0 && chroma === 0,
      )
      expect(gaussian.allocatedBytes).toBe(activeGaussian ? PATCHWISE_RESEARCH_GPU_BYTES : 0)
      expect(gaussian.programCount).toBe(activeGaussian ? 3 : 0)
      await writeFile(
        info.outputPath('agreement.json'),
        JSON.stringify(
          {
            group,
            plannedConfigurations: expectedConfigurations,
            completed,
            explicitlyRefusedTinyAlpha: refused,
            checkedRgbChannels,
            exactAlphaWords: alphaWords,
            C0GaussianRgbaWords: c0Words,
            neutralOrHiddenRgbWords: identityWords,
            pairedRgbWords,
            maximumToleranceRatio,
            adapter: uniform.adapter,
            gpuBytesPerOwner: uniform.allocatedBytes,
            scope:
              'C11 numerical prototype only; no full-source photographic quality, tiny-alpha recovery, production adoption or cadence claim.',
          },
          null,
          2,
        ),
      )
    } finally {
      await uniform.close()
      await gaussian.close()
    }
    expect(uniform.allocatedBytes).toBe(0)
    expect(gaussian.allocatedBytes).toBe(0)
    for (const [path, bytes] of [
      [generator, generatorBytes],
      [join(directory, 'reference.py'), sharedGeneratorBytes],
      [join(directory, 'input-plan.json'), sharedPlanBytes],
    ] as const)
      expect(await readFile(path)).toEqual(bytes)
  })
}
