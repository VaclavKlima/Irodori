import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { hdrCacheKernel, hdrShader } from '../src/renderer/src/preview/hdr-shader'
import { grid8ReferenceKernel } from '../scripts/research/pipeline/grid8-reference'
import { packAces, ACES_DATA_BYTES } from '../src/shared/aces-data'
import { prepareDisplayRendering } from '../src/shared/display-rendering'
import { acesRegressionInputs } from './aces-regression-inputs'
import { renderDisplay } from '../src/shared/display-rendering'
import { buildAcesReference, referenceAces } from './aces-reference'

let retainedGpu: GPU | undefined
const kind = 'linear64' as const
for (const tile of [64, 128, 256]) {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  test(`${kind} ${tile}-pixel cached WGSL tiles retain reference accuracy, alpha and seamless single-encoded sampling`, async ({}, info) => {
    const directory = info.outputPath('reference')
    await mkdir(directory, { recursive: true })
    const binary = buildAcesReference(directory)
    const { create, globals } = await import('webgpu')
    Object.assign(globalThis, globals)
    retainedGpu = create([])
    const adapter = await retainedGpu.requestAdapter()
    expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
    const device = await adapter!.requestDevice()
    const baselineKernel = grid8ReferenceKernel
    const kernel = hdrCacheKernel()
    const width = tile + 44,
      height = 2,
      extent = tile + 2
    const input = Array.from({ length: width * height }, (_, i) => [
      ...[i / 75, (width * height - 1 - i) / 120, Math.sin(i) * 0.1].map(Math.fround),
      [0, 0.25, 1][i % 3],
    ])
    input[0] = [0, 0, 0, 1]
    input[tile] = [-2, 4, 1, 0.25]
    input[width * height - 1] = [16, -0.1, 4, 1].map(Math.fround)
    acesRegressionInputs.forEach((rgb, i) => {
      input[i + 1] = [...rgb, [0, 0.25, 1][i % 3]]
    })
    input[width + tile] = [-2, 4, 1, 0.25]
    const source = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    const cached = device.createTexture({
      size: [extent, extent, 4],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    const makeBuffer = (size: number, usage: GPUBufferUsageFlags) =>
      device.createBuffer({ size, usage })
    const uniform = makeBuffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const tables = makeBuffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const jobs = makeBuffer(64, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const lookup = makeBuffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const bytesPerRow = Math.ceil((extent * 16) / 256) * 256
    const staging = makeBuffer(
      bytesPerRow * extent * 4,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    )
    const sampled = makeBuffer(12 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const sampleReadback = makeBuffer(
      sampled.size,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    )
    device.queue.writeTexture(
      { texture: source },
      new Float32Array(input.flat()),
      { bytesPerRow: width * 16 },
      [width, height],
    )
    device.queue.writeBuffer(
      jobs,
      0,
      new Uint32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 2, 1, 1, 0, 3, 1]),
    )
    device.queue.writeBuffer(lookup, 0, new Int32Array([0, 1, 2, 3]))
    const cacheLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
    const baselineRendering = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
      compute: {
        module: device.createShaderModule({ code: baselineKernel.shader }),
        entryPoint: 'renderTile',
      },
    })
    const rendering = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
      compute: {
        module: device.createShaderModule({ code: kernel.shader }),
        entryPoint: 'renderTile',
      },
    })
    const cacheGroup = device.createBindGroup({
      layout: cacheLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: source.createView() },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: { buffer: tables } },
        { binding: 5, resource: { buffer: jobs } },
      ],
    })
    // Exercise the production sampler across the halo, source edges and Before/After plane.
    const points = [-0.5, 0.25, tile - 0.25, tile + 0.25, width - 1.25, width - 0.5]
    const sampleLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    })
    const sampling = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [sampleLayout] }),
      compute: {
        module: device.createShaderModule({
          code:
            hdrShader +
            `
      @group(0) @binding(6) var<storage,read_write> result:array<vec4f>;
      @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) p:vec3u) {
        let points=array<f32,6>(${points.join(',')});
        let pixel=sampleCached(vec2f(points[p.x%6u],.25),p.x>=6u);
        result[p.x]=vec4f(encoded(pixel.rgb),pixel.a);
      }`,
        }),
        entryPoint: 'check',
      },
    })
    const sampleGroup = device.createBindGroup({
      layout: sampleLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: lookup } },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 6, resource: { buffer: sampled } },
      ],
    })
    let maximumRatio = 0,
      maximumSampleRatio = 0,
      maximumBaselineRatio = 0,
      alphaError = 0,
      worst: unknown
    const kernelComparisons: unknown[] = []
    try {
      for (const space of ['srgb', 'display-p3', 'rec2020'] as const)
        for (const peak of space === 'rec2020' ? [10] : [1, 2, 4, 8]) {
          const expected = [
            referenceAces(
              binary,
              input.map((v) => v.slice(0, 3).map((x) => x * 4)),
              peak,
              space,
            ),
            referenceAces(
              binary,
              input.map((v) => v.slice(0, 3)),
              peak,
              space,
            ),
          ]
          for (let variant = 0; variant < expected.length; variant++)
            for (let i = 0; i < input.length; i++) {
              const cpu = renderDisplay(
                input[i].slice(0, 3).map((x) => x * (variant === 0 ? 4 : 1)) as [
                  number,
                  number,
                  number,
                ],
                { mode: peak === 1 ? 'sdr' : 'hdr', peak, colorSpace: space },
              ).rgb
              for (let c = 0; c < 3; c++)
                expect(
                  Math.abs(cpu[c] - expected[variant][i][c]),
                  `CPU CTL sample ${i}/${c}`,
                ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(expected[variant][i][c]))
            }
          device.queue.writeBuffer(
            tables,
            0,
            packAces(
              prepareDisplayRendering({
                mode: peak === 1 ? 'sdr' : 'hdr',
                peak,
                colorSpace: space,
              }),
            ),
          )
          const values = new Float32Array(48)
          values[6] = 0.75
          values[8] = 2
          values[14] = peak
          values.set([2, 2, width, height], 32)
          device.queue.writeBuffer(uniform, 0, values)
          const baselineEncoder = device.createCommandEncoder()
          const baselinePass = baselineEncoder.beginComputePass()
          baselinePass.setPipeline(baselineRendering)
          baselinePass.setBindGroup(0, cacheGroup)
          baselinePass.dispatchWorkgroups(...baselineKernel.dispatch(extent, 4))
          baselinePass.end()
          baselineEncoder.copyTextureToBuffer(
            { texture: cached },
            { buffer: staging, bytesPerRow, rowsPerImage: extent },
            [extent, extent, 4],
          )
          device.queue.submit([baselineEncoder.finish()])
          await staging.mapAsync(GPUMapMode.READ)
          const baselineWords = new Uint32Array(staging.getMappedRange().slice(0))
          const baselineValues = new Float32Array(baselineWords.buffer)
          staging.unmap()
          const encoder = device.createCommandEncoder()
          const compute = encoder.beginComputePass()
          compute.setPipeline(rendering)
          compute.setBindGroup(0, cacheGroup)
          compute.dispatchWorkgroups(...kernel.dispatch(extent, 4))
          compute.end()
          encoder.copyTextureToBuffer(
            { texture: cached },
            { buffer: staging, bytesPerRow, rowsPerImage: extent },
            [extent, extent, 4],
          )
          const samplePass = encoder.beginComputePass()
          samplePass.setPipeline(sampling)
          samplePass.setBindGroup(0, sampleGroup)
          samplePass.dispatchWorkgroups(12)
          samplePass.end()
          encoder.copyBufferToBuffer(sampled, 0, sampleReadback, 0, sampled.size)
          device.queue.submit([encoder.finish()])
          await staging.mapAsync(GPUMapMode.READ)
          const mapped = staging.getMappedRange()
          const actual = new Float32Array(mapped)
          const candidateWords = new Uint32Array(mapped)
          let differingWords = 0
          let firstDifference: unknown
          for (let i = 0; i < candidateWords.length; i++)
            if (candidateWords[i] !== baselineWords[i]) {
              differingWords++
              firstDifference ??= {
                index: i,
                current: baselineWords[i],
                candidate: candidateWords[i],
              }
            }
          let maximumComparisonRatio = 0,
            maximumAbsoluteDifference = 0,
            differingPixelWords = 0,
            worstComparison: unknown
          for (let layer = 0; layer < 4; layer++)
            for (let y = 0; y < extent; y++)
              for (let x = 0; x < extent; x++) {
                const index =
                  Math.max(0, Math.min(height - 1, y - 1)) * width +
                  Math.max(0, Math.min(width - 1, (layer % 2) * tile + x - 1))
                const offset = (((layer * extent + y) * bytesPerRow) / 16 + x) * 4
                alphaError = Math.max(
                  alphaError,
                  Math.abs(actual[offset + 3] - input[index][3]),
                  Math.abs(actual[offset + 3] - baselineValues[offset + 3]),
                )
                for (let c = 0; c < 4; c++)
                  differingPixelWords += Number(
                    candidateWords[offset + c] !== baselineWords[offset + c],
                  )
                for (let c = 0; c < 3; c++) {
                  const baseline = baselineValues[offset + c]
                  const difference = Math.abs(actual[offset + c] - baseline)
                  const comparisonRatio = difference / (2e-6 + 2e-5 * Math.abs(baseline))
                  if (!Number.isFinite(comparisonRatio) || comparisonRatio > maximumComparisonRatio)
                    worstComparison = {
                      layer,
                      x,
                      y,
                      c,
                      current: baseline,
                      candidate: actual[offset + c],
                      currentWord: baselineWords[offset + c],
                      candidateWord: candidateWords[offset + c],
                      ratio: comparisonRatio,
                    }
                  maximumComparisonRatio = Math.max(maximumComparisonRatio, comparisonRatio)
                  maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, difference)
                  const reference = expected[Math.floor(layer / 2)][index][c]
                  const ratio =
                    Math.abs(actual[offset + c] - reference) / (2e-6 + 2e-5 * Math.abs(reference))
                  if (ratio > maximumRatio) {
                    maximumRatio = ratio
                    worst = {
                      space,
                      peak,
                      layer,
                      x,
                      y,
                      c,
                      source: input[index],
                      reference,
                      actual: actual[offset + c],
                    }
                  }
                }
              }
          expect(
            differingPixelWords,
            JSON.stringify({ kind, tile, space, peak, firstDifference }),
          ).toBe(0)
          maximumBaselineRatio = Math.max(maximumBaselineRatio, maximumComparisonRatio)
          kernelComparisons.push({
            space,
            peak,
            comparedPixels: 4 * extent * extent,
            differingWords,
            differingPixelWords,
            firstDifference,
            maximumAbsoluteDifference,
            maximumRatio: maximumComparisonRatio,
            worst: worstComparison,
          })
          // Sampling and encoding are verified separately using measured cached linear texels,
          // so reference-transform error cannot hide an interpolation or double-encoding error.
          await sampleReadback.mapAsync(GPUMapMode.READ)
          const samples = new Float32Array(sampleReadback.getMappedRange())
          const linear = (x: number, y: number, before: boolean) => {
            x = Math.max(0, Math.min(width - 1, x))
            const layer = Math.floor(x / tile) + (before ? 2 : 0)
            const offset = (((layer * extent + y + 1) * bytesPerRow) / 16 + (x % tile) + 1) * 4
            return Array.from(actual.slice(offset, offset + 4))
          }
          for (let i = 0; i < 12; i++) {
            const x = Math.floor(points[i % 6]),
              fraction = points[i % 6] - x
            const neighbors = [
              linear(x, 0, i >= 6),
              linear(x + 1, 0, i >= 6),
              linear(x, 1, i >= 6),
              linear(x + 1, 1, i >= 6),
            ]
            const weights = [
              (1 - fraction) * 0.75,
              fraction * 0.75,
              (1 - fraction) * 0.25,
              fraction * 0.25,
            ]
            const alpha = neighbors.reduce((sum, v, j) => sum + weights[j] * v[3], 0)
            alphaError = Math.max(alphaError, Math.abs(samples[i * 4 + 3] - alpha))
            for (let c = 0; c < 3; c++) {
              const rgb = alpha
                ? neighbors.reduce((sum, v, j) => sum + weights[j] * v[c] * v[3], 0) / alpha
                : 0
              const encoded = rgb <= 0.0031308 ? rgb * 12.92 : 1.055 * rgb ** (1 / 2.4) - 0.055
              maximumSampleRatio = Math.max(
                maximumSampleRatio,
                Math.abs(samples[i * 4 + c] - encoded) / (2e-6 + 2e-5 * Math.abs(encoded)),
              )
            }
          }
          sampleReadback.unmap()
          staging.unmap()
        }
      await writeFile(
        info.outputPath('conformance.json'),
        JSON.stringify(
          {
            kernel: kind,
            baselineKernel: baselineKernel.kind,
            tile,
            adapter: adapter!.info,
            maximumRatio,
            maximumSampleRatio,
            maximumBaselineRatio,
            kernelComparisons,
            alphaError,
            worst,
          },
          null,
          2,
        ),
      )
      expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
      expect(maximumSampleRatio).toBeLessThanOrEqual(1)
      expect(maximumBaselineRatio).toBeLessThanOrEqual(1)
      expect(alphaError).toBe(0)
    } finally {
      for (const resource of [
        source,
        cached,
        uniform,
        tables,
        jobs,
        lookup,
        staging,
        sampled,
        sampleReadback,
      ])
        resource.destroy()
      device.destroy()
      retainedGpu = undefined
    }
  })
}
