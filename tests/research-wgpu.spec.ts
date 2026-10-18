import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hdrCacheShader } from '../src/renderer/src/preview/hdr-shader'
import { packAces } from '../src/shared/aces-data'
import { prepareDisplayRendering, renderDisplay } from '../src/shared/display-rendering'
import { imageSpec, pattern } from '../scripts/research/pipeline/workloads'
import { distribution } from '../scripts/research/pipeline/metrics'
import { provenance } from '../scripts/research/pipeline/provenance'
import { attachResearchEvidence } from './research.helpers'

const exec = promisify(execFile)
let retainedGpu: GPU | undefined
interface Observation {
  totalMs: number
  submissionMs: number
  batchWaitMs: number
  completionFenceMs: number
  submissions: number
}
interface ComponentCase {
  batchSize: number
  repetition: number
  warmups: Observation[]
  observations: Observation[]
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test.afterEach(async ({}, info) => attachResearchEvidence(info))

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Dawn and pinned wgpu complete identical exact Float32 tile kernels on the same hardware adapter', async ({}, info) => {
  test.setTimeout(180000)
  const requestedAdapter = process.env.LUMA_RESEARCH_GPU_ADAPTER
  test.skip(
    !requestedAdapter,
    'Set LUMA_RESEARCH_GPU_ADAPTER to the same native adapter name for Dawn and wgpu; hardware comparison incomplete.',
  )
  const binary = resolve(
    process.env.LUMA_RESEARCH_WGPU_BINARY || 'artifacts/research-wgpu/release/luma-wgpu-research',
  )
  test.skip(
    !(await access(binary).then(
      () => true,
      () => false,
    )),
    'Build the pinned isolated helper with node scripts/research/build-wgpu.mjs; comparison incomplete.',
  )
  const directory = info.outputPath('component-input')
  await mkdir(directory, { recursive: true })
  const spec = imageSpec(1024, 684)
  const input = pattern(spec)
  const tables = packAces(prepareDisplayRendering({ mode: 'hdr', peak: 10, colorSpace: 'rec2020' }))
  const columns = Math.ceil(spec.width / 64)
  const layers = columns * Math.ceil(spec.height / 64)
  const jobs = new Uint32Array(layers * 4)
  for (let layer = 0; layer < layers; layer++)
    jobs.set([layer % columns, Math.floor(layer / columns), layer, 0], layer * 4)
  const uniforms = new Float32Array(44 * 30)
  for (let frame = 0; frame < 30; frame++) {
    const p = uniforms.subarray(frame * 44, (frame + 1) * 44)
    p.set([914, 502, spec.width, spec.height, 0, 0, 1, 2])
    p[8] = (frame - 15) / 20
    p[14] = 10
    p.set([columns, layers, spec.width, spec.height], 32)
    p[36] = 65536
    p[37] = 10
    p[38] = 2
    p[39] = 1
  }
  const inputFiles: Record<string, string | Uint8Array> = {
    'render.wgsl': hdrCacheShader,
    'source.f32': new Uint8Array(input.buffer),
    'tables.f32': new Uint8Array(tables.buffer, tables.byteOffset, tables.byteLength),
    'uniforms.f32': new Uint8Array(uniforms.buffer),
    'jobs.u32': new Uint8Array(jobs.buffer),
  }
  for (const [name, bytes] of Object.entries(inputFiles))
    await writeFile(join(directory, name), bytes)
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  const backend = process.platform === 'darwin' ? 'metal' : 'vulkan'
  const dawnOptions = [
    `backend=${backend}`,
    ...(requestedAdapter ? [`adapter=${requestedAdapter}`] : []),
  ]
  retainedGpu = create(dawnOptions)
  const adapter = await retainedGpu.requestAdapter({
    powerPreference: 'high-performance',
  })
  test.skip(
    !adapter || adapter.info.isFallbackAdapter,
    'Hardware Dawn adapter unavailable; equivalent backend comparison is incomplete.',
  )
  const adapterSubstring = requestedAdapter!
  expect(adapterSubstring.length).toBeGreaterThan(0)
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const buffers: GPUBuffer[] = []
  const textures: GPUTexture[] = []
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    buffers.push(value)
    return value
  }
  const texture = (width: number, height: number, depth = 1) => {
    const value = device.createTexture({
      size: [width, height, depth],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    textures.push(value)
    return value
  }
  const cases: ComponentCase[] = []
  let dawnTiles: Float32Array
  let uploadMs: number
  let compileMs: number
  let readbackMs: number
  try {
    const source = texture(spec.width, spec.height)
    const cached = texture(66, 66, 256)
    const uniform = buffer(176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const tableBuffer = buffer(tables.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const jobsBuffer = buffer(256 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const uploadAt = performance.now()
    const stripRows = Math.max(1, Math.floor((8 * 1024 ** 2) / (spec.width * 16)))
    for (let y = 0; y < spec.height; y += stripRows) {
      const rows = Math.min(stripRows, spec.height - y)
      device.queue.writeTexture(
        { texture: source, origin: [0, y] },
        input.slice(y * spec.width * 4, (y + rows) * spec.width * 4),
        { bytesPerRow: spec.width * 16 },
        [spec.width, rows],
      )
      await device.queue.onSubmittedWorkDone()
    }
    device.queue.writeBuffer(tableBuffer, 0, tables)
    await device.queue.onSubmittedWorkDone()
    uploadMs = performance.now() - uploadAt
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba32float',
            viewDimension: '2d-array',
          },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })
    const compileAt = performance.now()
    const pipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: hdrCacheShader }),
        entryPoint: 'renderTile',
      },
    })
    compileMs = performance.now() - compileAt
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: source.createView() },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: { buffer: tableBuffer } },
        { binding: 5, resource: { buffer: jobsBuffer } },
      ],
    })
    const render = async (frame: number, batch: number): Promise<Observation> => {
      const at = performance.now()
      device.queue.writeBuffer(uniform, 0, uniforms.subarray(frame * 44, (frame + 1) * 44))
      let submissionMs = 0
      let batchWaitMs = 0
      let submissions = 0
      for (let start = 0; start < jobs.length; start += batch * 4) {
        const submitAt = performance.now()
        const chunk = jobs.subarray(start, start + batch * 4)
        device.queue.writeBuffer(jobsBuffer, 0, chunk)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(9, 9, chunk.length / 4)
        pass.end()
        device.queue.submit([encoder.finish()])
        submissionMs += performance.now() - submitAt
        submissions++
        if (batch === 8) {
          const waitAt = performance.now()
          await device.queue.onSubmittedWorkDone()
          batchWaitMs += performance.now() - waitAt
        }
      }
      const fenceAt = performance.now()
      await device.queue.onSubmittedWorkDone()
      return {
        totalMs: performance.now() - at,
        submissionMs,
        batchWaitMs,
        completionFenceMs: performance.now() - fenceAt,
        submissions,
      }
    }
    for (const batchSize of [8, 32, 128]) {
      const warmups: Observation[] = []
      for (let i = 0; i < 5; i++) warmups.push(await render(i, batchSize))
      for (let repetition = 0; repetition < 3; repetition++) {
        const observations: Observation[] = []
        for (let i = 0; i < 30; i++) observations.push(await render(i, batchSize))
        cases.push({ batchSize, repetition, warmups, observations })
      }
    }
    await render(15, 32)
    const readbackAt = performance.now()
    const readback = buffer(1280 * 66 * layers, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: cached },
      { buffer: readback, bytesPerRow: 1280, rowsPerImage: 66 },
      [66, 66, layers],
    )
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    dawnTiles = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    readbackMs = performance.now() - readbackAt
    await writeFile(join(directory, 'dawn-tiles.f32'), new Uint8Array(dawnTiles.buffer))
  } finally {
    buffers.forEach((value) => value.destroy())
    textures.forEach((value) => value.destroy())
    device.destroy()
  }
  const nativeRun = await exec(
    binary,
    [directory, String(spec.width), String(spec.height), adapterSubstring],
    { timeout: 120000, maxBuffer: 1024 ** 2 },
  ).catch(async (error: Error & { stdout?: string; stderr?: string }) => {
    await writeFile(
      info.outputPath('wgpu-failure.json'),
      JSON.stringify(
        {
          message: error.message,
          stdout: error.stdout,
          stderr: error.stderr,
          dawnCases: cases,
        },
        null,
        2,
      ),
    )
    throw error
  })
  const wgpu = JSON.parse(await readFile(join(directory, 'wgpu.json'), 'utf8'))
  const nativeBytes = await readFile(join(directory, 'wgpu-tiles.f32'))
  expect(nativeBytes.byteLength).toBe(dawnTiles.byteLength)
  const nativeTiles = new Float32Array(
    nativeBytes.buffer,
    nativeBytes.byteOffset,
    nativeBytes.byteLength / 4,
  )
  let dawnRatio = 0
  let wgpuRatio = 0
  let crossMaximum = 0
  let alphaDifference = 0
  for (let y = 0; y < spec.height; y++)
    for (let x = 0; x < spec.width; x++) {
      const sourceAt = (y * spec.width + x) * 4
      const layer = Math.floor(y / 64) * columns + Math.floor(x / 64)
      const tileAt = layer * 320 * 66 + ((y % 64) + 1) * 320 + ((x % 64) + 1) * 4
      const expected = renderDisplay([input[sourceAt], input[sourceAt + 1], input[sourceAt + 2]], {
        mode: 'hdr',
        peak: 10,
        colorSpace: 'rec2020',
      }).rgb
      for (let c = 0; c < 3; c++) {
        const tolerance = 2e-6 + 2e-5 * Math.abs(expected[c])
        dawnRatio = Math.max(dawnRatio, Math.abs(dawnTiles[tileAt + c] - expected[c]) / tolerance)
        wgpuRatio = Math.max(wgpuRatio, Math.abs(nativeTiles[tileAt + c] - expected[c]) / tolerance)
        crossMaximum = Math.max(
          crossMaximum,
          Math.abs(dawnTiles[tileAt + c] - nativeTiles[tileAt + c]),
        )
      }
      alphaDifference = Math.max(
        alphaDifference,
        Math.abs(dawnTiles[tileAt + 3] - input[sourceAt + 3]),
        Math.abs(nativeTiles[tileAt + 3] - input[sourceAt + 3]),
      )
    }
  const summarize = (values: ComponentCase[]) =>
    values.map((value) => ({
      ...value,
      completedMs: distribution(value.observations.map((observation) => observation.totalMs)),
    }))
  await writeFile(
    info.outputPath('wgpu-comparison.json'),
    JSON.stringify(
      {
        provenance: await provenance([
          'tests/research-wgpu.spec.ts',
          'scripts/research/wgpu/Cargo.lock',
          'scripts/research/wgpu/src/main.rs',
          'src/renderer/src/preview/hdr-shader.ts',
          'src/shared/aces-wgsl.ts',
        ]),
        nativeBuild: JSON.parse(await readFile(`${binary}.json`, 'utf8')),
        inputHashes: Object.fromEntries(
          Object.entries(inputFiles).map(([name, bytes]) => [
            name,
            createHash('sha256').update(bytes).digest('hex'),
          ]),
        ),
        source: spec,
        tileExtent: 66,
        cachedLayers: 256,
        evaluatedLayers: layers,
        adapterSubstring,
        backend,
        requestedFeatures: [],
        requestedLimits: 'WebGPU default limits; both backends',
        dawn: {
          options: dawnOptions,
          adapter: {
            vendor: adapter!.info.vendor,
            architecture: adapter!.info.architecture,
            device: adapter!.info.device,
            description: adapter!.info.description,
          },
          sourceUploadAndTablesMs: uploadMs!,
          shaderAndPipelineMs: compileMs!,
          readbackMs: readbackMs!,
          cases: summarize(cases),
          limits: {
            maxTextureDimension2D: device.limits.maxTextureDimension2D,
            maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
            maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
          },
        },
        wgpu: {
          ...wgpu,
          cases: summarize(wgpu.cases),
          stdout: nativeRun.stdout,
          stderr: nativeRun.stderr,
        },
        correctness: {
          dawnMaximumToleranceRatio: dawnRatio,
          wgpuMaximumToleranceRatio: wgpuRatio,
          maximumCrossBackendDifference: crossMaximum,
          alphaMaximumDifference: alphaDifference,
          tolerance: '2e-6 + 2e-5 * abs(independent CPU reference); unchanged',
        },
        timingBoundary:
          'uniform/jobs writes and all dispatch submission through completed queue fence; source/pipelines warm; full readback outside timing; three repetitions of 30 after five recorded warmups per batch',
        waitPolicy: '8 tiles waits each batch plus final; 32/128 tiles final fence only',
        knownOwnedGpuBytes:
          input.byteLength + 66 * 66 * 256 * 16 + 176 + tables.byteLength + 256 * 16,
        limitation:
          'Narrow full-source tile compute component only. No histogram, mips, region planner/cache reuse, canvas, React/history, application service, external textures, hardware timestamps, physical scanout or peak VRAM. Native blocking poll and JS async waits retain their own host overhead. One backend process at a time; fixed Dawn-then-wgpu order; driver caches uncontrolled. Not a production architecture or presentation benchmark.',
      },
      null,
      2,
    ),
  )
  expect(wgpu.adapter.name.toLowerCase()).toContain(adapterSubstring.toLowerCase())
  expect(wgpu.adapter.backend.toLowerCase()).toBe(backend)
  expect(dawnRatio).toBeLessThanOrEqual(1)
  expect(wgpuRatio).toBeLessThanOrEqual(1)
  expect(alphaDifference).toBe(0)
  expect(errors).toEqual([])
})
