import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  createPatchwiseResearchGpu,
  packPatchwiseResearch,
  PATCHWISE_RESEARCH_GPU_BYTES,
  PATCHWISE_RESEARCH_WORKING_BYTES,
  type PatchwiseResearchJob,
} from '../scripts/research/strong-noise/gpu'
import { DETAIL_NOISE_ESTIMATE_VERSION } from '../src/shared/detail-noise-estimate'
import { detailSourceBounds } from '../src/shared/spatial-detail'

const python = process.env.IRODORI_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const directory = resolve('scripts/research/strong-noise/reference')
const planPath = resolve('assets/tests/references/detail/strong-noise/noise-scaled-input-plan.json')

async function runPython(args: string[], info: TestInfo, name: string): Promise<void> {
  const logs = info.outputPath(name)
  await mkdir(logs, { recursive: true })
  await new Promise<void>((accept, reject) => {
    const child = execFile(
      python,
      args,
      { timeout: 240_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(logs, 'stdout.txt'), stdout),
          writeFile(join(logs, 'stderr.txt'), stderr),
        ]).then(() => {
          if (error)
            reject(
              new Error(`Patchwise research reference command failed: ${stderr}`, { cause: error }),
            )
          else accept()
        }, reject)
      },
    )
    children.add(child)
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
  return {
    image: { width, height },
    tile: { left: 0, top: 0, width, height },
    source: { left: 0, top: 0, width, height, data },
    estimate: {
      version: DETAIL_NOISE_ESTIMATE_VERSION,
      source: {
        width,
        height,
        primaries: 'rec2020',
        identity: 'a'.repeat(64),
        sha256: sha(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      },
      variance: [0.0004, 0.0004, 0.0004],
    },
    luminance: 50,
    chroma: 50,
    chromaSigmaFactor: 0.55,
    admission: {
      maxGpuBytes: PATCHWISE_RESEARCH_GPU_BYTES,
      maxWorkingBytes: PATCHWISE_RESEARCH_WORKING_BYTES,
    },
  }
}

test('research admission, exact neutral copies, cancellation and tiny-alpha refusal precede GPU initialization', async () => {
  let creations = 0
  const gpu = createPatchwiseResearchGpu(() => {
      creations++
      throw new Error('Unexpected GPU initialization.')
    }),
    data = new Float32Array([-0, 2, -1, -0]),
    original = job(data, 1, 1),
    neutral = {
      ...original,
      luminance: 0,
      chroma: 0,
      admission: { maxGpuBytes: 0, maxWorkingBytes: 16 },
    }
  try {
    expect(new Uint32Array((await gpu.render(neutral, signal())).buffer)).toEqual(
      new Uint32Array(data.buffer),
    )
    await expect(
      gpu.render({ ...neutral, admission: { maxGpuBytes: 0, maxWorkingBytes: 15 } }, signal()),
    ).rejects.toThrow('admitted')
    const tiny = job(new Float32Array([1, 2, 3, 2 ** -149]), 1, 1)
    await expect(gpu.render(tiny, signal())).rejects.toThrow('Float64 recovery')
    await expect(
      gpu.render(
        { ...original, estimate: { ...original.estimate, variance: [NaN, 0, 0] } },
        signal(),
      ),
    ).rejects.toThrow('estimate')
    await expect(
      gpu.render(
        {
          ...original,
          estimate: { ...original.estimate, source: { ...original.estimate.source, width: 2 } },
        },
        signal(),
      ),
    ).rejects.toThrow('estimate')
    await expect(
      gpu.render(
        {
          ...original,
          admission: {
            maxGpuBytes: PATCHWISE_RESEARCH_GPU_BYTES - 1,
            maxWorkingBytes: PATCHWISE_RESEARCH_WORKING_BYTES,
          },
        },
        signal(),
      ),
    ).rejects.toThrow('admitted')
    const aborted = new AbortController()
    aborted.abort()
    await expect(gpu.render(original, aborted.signal)).rejects.toThrow()
    expect(gpu.allocatedBytes).toBe(0)
    expect(gpu.programCount).toBe(0)
    expect(creations).toBe(0)
    // Integer uniforms retain exact geometry within the shared image limits.
    const large = {
      ...original,
      image: { width: 16_777_219, height: 1 },
      tile: { left: 16_777_218, top: 0, width: 1, height: 1 },
      source: { left: 16_777_213, top: 0, width: 6, height: 1, data: new Float32Array(24) },
      estimate: {
        ...original.estimate,
        source: { ...original.estimate.source, width: 16_777_219 },
      },
    }
    expect(() => packPatchwiseResearch(large)).toThrow('supported display size')
    const bounded = {
      ...large,
      image: { width: 32768, height: 1 },
      tile: { left: 32767, top: 0, width: 1, height: 1 },
      source: { ...large.source, left: 32762 },
      estimate: { ...large.estimate, source: { ...large.estimate.source, width: 32768 } },
    }
    const words = new Uint32Array(packPatchwiseResearch(bounded))
    expect(words[0]).toBe(32768)
    expect(words[12]).toBe(32767)
  } finally {
    await gpu.close()
  }
  await expect(gpu.render(neutral, signal())).rejects.toThrow('unavailable')
})

test('research close waits for cancelled initialization and queue retirement and rejects concurrent jobs', async () => {
  let publishDevice!: (context: { device: GPUDevice; adapter: string }) => void,
    retireQueue!: () => void,
    rendererClosed = 0,
    retirementStarted = false
  const context = new Promise<{ device: GPUDevice; adapter: string }>((accept) => {
      publishDevice = accept
    }),
    retirement = new Promise<void>((accept) => {
      retireQueue = accept
    }),
    gpu = createPatchwiseResearchGpu(() => ({
      mergeDevice: () => context,
      close: () => {
        rendererClosed++
      },
    })),
    controller = new AbortController(),
    input = job(new Float32Array([1, 2, 3, 1]), 1, 1),
    pending = gpu.render(input, controller.signal)
  const rejection = expect(pending).rejects.toThrow()
  await expect(gpu.render(input, signal())).rejects.toThrow('busy')
  const closing = gpu.close()
  controller.abort()
  publishDevice({
    device: {
      queue: {
        onSubmittedWorkDone: () => {
          retirementStarted = true
          return retirement
        },
      },
    } as unknown as GPUDevice,
    adapter: 'controlled initialization',
  })
  await rejection
  await new Promise<void>((accept) => setImmediate(accept))
  expect(retirementStarted).toBe(true)
  expect(rendererClosed).toBe(0)
  expect(gpu.allocatedBytes).toBe(0)
  retireQueue()
  await closing
  await gpu.close()
  expect(rendererClosed).toBe(1)
  await expect(gpu.render(input, signal())).rejects.toThrow('unavailable')
})

interface ReferenceScene {
  id: string
  width: number
  height: number
  sourceSha256: string
  inputRgba32leHex: string
  frozenVariance: string[]
  cases: {
    primaries: 'srgb' | 'rec2020'
    luminance: number
    chroma: number
    points: { x: number; y: number; outputFloat64: number[] }[]
  }[]
}

test('research rejects overflowed internal HDR features instead of returning a finite unchanged image', async () => {
  const gpu = createPatchwiseResearchGpu(),
    extreme = job(new Float32Array([3e38, 3e38, 3e38, 1]), 1, 1)
  try {
    await expect(gpu.render(extreme, signal())).rejects.toThrow('nonfinite RGB')
    await expect(gpu.render(extreme, signal())).rejects.toThrow('unavailable')
  } finally {
    await gpu.close()
  }
  expect(gpu.allocatedBytes).toBe(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('three-pass research GPU agrees with direct Decimal80 and explicitly refuses unsupported tiny-alpha cases', async ({}, info) => {
  test.setTimeout(300_000)
  await mkdir(info.outputDir, { recursive: true })
  const planBytes = await readFile(planPath),
    plan = JSON.parse(planBytes.toString()),
    generator = join(directory, 'noise-scaled-reference.py'),
    shared = join(directory, 'reference.py'),
    approval = info.outputPath('approval.json'),
    reference = info.outputPath('reference.json'),
    equations = Object.fromEntries(
      Object.entries(plan.math).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  await writeFile(
    approval,
    JSON.stringify({
      referenceGenerationApproved: true,
      referenceKind: plan.referenceKind,
      inputPlanSha256: sha(planBytes),
      generatorSha256: sha(await readFile(generator)),
      sharedGeneratorSha256: sha(await readFile(shared)),
      equationsSha256: sha(JSON.stringify(equations)),
      sigmaFactors: plan.sigmaFactors,
      scope: 'Research GPU numerical reference only; no quality or production adoption.',
    }),
  )
  await runPython(
    [
      generator,
      '--approved-freeze',
      approval,
      '--input-plan',
      planPath,
      '--factor',
      '0.55',
      '--output',
      reference,
    ],
    info,
    'generation',
  )
  const frozen = JSON.parse(await readFile(reference, 'utf8')) as { scenes: ReferenceScene[] },
    gpu = createPatchwiseResearchGpu()
  let configurations = 0,
    refused = 0,
    checked = 0,
    worst = 0
  try {
    for (const scene of frozen.scenes) {
      const bytes = Buffer.from(scene.inputRgba32leHex, 'hex')
      expect(sha(bytes)).toBe(scene.sourceSha256)
      const data = new Float32Array(bytes.length / 4)
      for (let i = 0; i < data.length; i++) data[i] = bytes.readFloatLE(i * 4)
      const sourceWords = new Uint32Array(data.buffer),
        base = job(data, scene.width, scene.height),
        tiny = Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + 3]).some(
          (a) => a > 0 && a < 2 ** -20,
        )
      for (const entry of scene.cases) {
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
          await expect(gpu.render(current, signal())).rejects.toThrow('Float64 recovery')
          refused++
          continue
        }
        const result = await gpu.render(current, signal()),
          words = new Uint32Array(result.buffer)
        for (let i = 0; i < data.length; i += 4) {
          expect(words[i + 3]).toBe(sourceWords[i + 3])
          if (data[i + 3] === 0 || (entry.luminance === 0 && entry.chroma === 0))
            for (let c = 0; c < 3; c++) expect(words[i + c]).toBe(sourceWords[i + c])
        }
        for (const point of entry.points)
          for (let c = 0; c < 3; c++) {
            const at = (point.y * scene.width + point.x) * 4 + c,
              expected = point.outputFloat64[c],
              ratio = Math.abs(result[at] - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            worst = Math.max(worst, ratio)
            expect(
              ratio,
              JSON.stringify({
                scene: scene.id,
                primaries: entry.primaries,
                controls: [entry.luminance, entry.chroma],
                point: [point.x, point.y],
                c,
                actual: result[at],
                expected,
              }),
            ).toBeLessThanOrEqual(1)
            checked++
          }
        configurations++
      }
    }
    expect(configurations + refused).toBe(690)
    expect(configurations).toBeGreaterThan(400)
    expect(refused).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(3000)
    expect(gpu.allocatedBytes).toBe(PATCHWISE_RESEARCH_GPU_BYTES)
    expect(gpu.programCount).toBe(3)
    await writeFile(
      info.outputPath('agreement.json'),
      JSON.stringify(
        {
          configurations,
          explicitlyRefusedTinyAlpha: refused,
          checkedRgbChannels: checked,
          maximumToleranceRatio: worst,
          adapter: gpu.adapter,
          gpuBytes: gpu.allocatedBytes,
          scope:
            'CPU-independent reference versus unenabled noise-only GPU prototype. Tiny-alpha recovery, full-source photographs, quality and performance remain open.',
        },
        null,
        2,
      ),
    )
  } finally {
    await gpu.close()
  }
  expect(gpu.allocatedBytes).toBe(0)
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('research tiles preserve full-source context across internal seams and true image edges', async ({}, info) => {
  const width = 37,
    height = 31,
    data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          (((x * 17 + y * 31) % 43) - 21) / 8,
          (((x * 7 + y * 13) % 37) - 18) / 16,
          (((x * 23 + y * 5) % 41) - 20) / 32,
          [0, 0.25, 0.5, 1][(x + 3 * y) % 4],
        ],
        (y * width + x) * 4,
      )
  const base = job(data, width, height),
    input = info.outputPath('source.f32'),
    expectedPath = info.outputPath('cpu.f32')
  await mkdir(info.outputDir, { recursive: true })
  await writeFile(input, Buffer.from(data.buffer))
  const script = String.raw`
import importlib.util, pathlib, struct, sys
root=pathlib.Path.cwd()
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
model=load('gpu_context_model',root/'scripts/research/detail-candidates.py')
method=load('gpu_context_candidate',root/'scripts/research/strong-noise/noise-scaled-patchwise.py')
source=list(struct.iter_unpack('<4f',pathlib.Path(sys.argv[1]).read_bytes()))
candidate={'aggregation':'normalized-patch-estimates-f32-zero-v1','luminanceBandwidthMaximum':.024,'chromaBandwidthMaximum':.024,'bandwidthPolicy':'global-chroma-sigma-floor-v1','chromaSigmaFactor':.55}
output,_=method.denoise(model,source,37,31,model.LUMINANCE['rec2020'],50,50,candidate,estimate_snapshot={'version':'frozen-global-directional-mad-v1','variance':[.0004,.0004,.0004]})
pathlib.Path(sys.argv[2]).write_bytes(b''.join(struct.pack('<4f',*p) for p in output))
`
  await runPython(['-c', script, input, expectedPath], info, 'cpu-command')
  const cpuBytes = await readFile(expectedPath),
    cpu = new Float32Array(data.length)
  for (let i = 0; i < cpu.length; i++) cpu[i] = cpuBytes.readFloatLE(i * 4)
  const gpu = createPatchwiseResearchGpu()
  let worst = 0
  try {
    const whole = await gpu.render(base, signal()),
      stitched = new Float32Array(data.length)
    for (let top = 0; top < height; top += 11)
      for (let left = 0; left < width; left += 13) {
        const tile = {
            left,
            top,
            width: Math.min(13, width - left),
            height: Math.min(11, height - top),
          },
          bounds = detailSourceBounds(base.image, tile, 5),
          window = new Float32Array(bounds.width * bounds.height * 4)
        for (let y = 0; y < bounds.height; y++) {
          const offset = ((bounds.top + y) * width + bounds.left) * 4
          window.set(data.subarray(offset, offset + bounds.width * 4), y * bounds.width * 4)
        }
        const result = await gpu.render(
          { ...base, tile, source: { ...bounds, data: window } },
          signal(),
        )
        for (let y = 0; y < tile.height; y++)
          stitched.set(
            result.subarray(y * tile.width * 4, (y + 1) * tile.width * 4),
            ((top + y) * width + left) * 4,
          )
      }
    expect(new Uint32Array(stitched.buffer)).toEqual(new Uint32Array(whole.buffer))
    for (let i = 0; i < cpu.length; i++) {
      if (i % 4 === 3) expect(whole[i]).toBe(cpu[i])
      else {
        const ratio = Math.abs(whole[i] - cpu[i]) / (2e-6 + 2e-5 * Math.abs(cpu[i]))
        worst = Math.max(worst, ratio)
        expect(ratio, `Pixel channel ${i}`).toBeLessThanOrEqual(1)
      }
    }
    await writeFile(
      info.outputPath('context-agreement.json'),
      JSON.stringify(
        {
          pixels: width * height,
          tiles: 9,
          sourceSha256: sha(new Uint8Array(data.buffer)),
          cpuSha256: sha(cpuBytes),
          wholeAndStitchedExact: true,
          maximumCpuToleranceRatio: worst,
        },
        null,
        2,
      ),
    )
  } finally {
    await gpu.close()
  }
})
