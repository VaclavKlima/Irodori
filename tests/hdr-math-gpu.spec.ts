import { expect, test } from '@playwright/test'
import { hdrRenderingWgsl } from '../src/renderer/src/preview/hdr-shader'
import { adjustHdr, REC2020_TO_SRGB, REC2020_TO_P3, SDR_TARGET, type RGB } from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { referenceAdjust } from './hdr-reference'
import { prepareDisplayRendering, renderDisplay } from '../src/shared/display-rendering'
import { packAces, ACES_DATA_BYTES } from '../src/shared/aces-data'
import { buildAcesReference, referenceAces } from './aces-reference'
import { mkdir } from 'node:fs/promises'
import {
  sensorBlendParameters,
  sensorBlendRgb,
  sensorBlendWgsl,
} from '../src/main/gpu/sensor-blend'
import { hdrRangeColor, hdrRangesWgsl } from '../src/renderer/src/preview/hdr-ranges'

let retainedGpu: GPU | undefined
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('HDR edits and actual WGSL agree with independent Float64 CTL through extreme adjustments', async ({}, info) => {
  const referenceDirectory = info.outputPath('reference')
  await mkdir(referenceDirectory, { recursive: true })
  const binary = buildAcesReference(referenceDirectory)
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(
    adapter?.info.isFallbackAdapter,
    'Required hardware GPU is unavailable: no hardware adapter.',
  ).toBe(false)
  const device = await adapter!.requestDevice()
  const input: RGB[] = [0, 0.18, 1, 2, 4, 16, -0.1].map((v) => [v, v, v])
  for (let i = 0; i < 256; i++) input.push([i / 16, (255 - i) / 128, Math.sin(i) * 0.1])
  input.push([-2, 4, 1], [16, -0.1, 4], [0, 16, 0], [4, 0, 0])
  const buffer = device.createBuffer({
    size: input.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const staging = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const tables = device.createBuffer({
    size: ACES_DATA_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const texture = device.createTexture({
    size: [input.length, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  device.queue.writeTexture(
    { texture },
    new Float32Array(input.flatMap((v, i) => [...v, [0, 0.25, 1][i % 3]])),
    { bytesPerRow: input.length * 16 },
    [input.length, 1],
  )
  const code =
    hdrRenderingWgsl +
    `\n@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
  @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) p:vec3u) {
    let pixel=textureLoad(pixels,vec2i(p.xy),0);
    let rgb=adjusted(pixel.rgb);
    result[p.x]=vec4f(select(rgb,outputRgb(rgb),u.values[3].w>0.),pixel.a);
  }`
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float' },
      },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  })
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code }), entryPoint: 'check' },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer } },
      { binding: 4, resource: { buffer: tables } },
    ],
  })
  let maximumRatio = 0,
    worst: unknown
  try {
    for (const wb of [undefined, [1.1, 0.02, -0.01, -0.01, 0.9, 0.03, 0.02, -0.03, 1.2]])
      for (const extreme of [0, -100, 100])
        for (const space of ['srgb', 'display-p3', 'rec2020'] as const)
          for (const peak of space === 'rec2020' ? [10] : [1, 2, 4, 8])
            for (const output of [0, 1]) {
              const params = {
                ...neutralAdjustments,
                exposureEv: extreme / 20,
                contrast: extreme,
                highlights: extreme,
                shadows: extreme,
                whites: extreme,
                blacks: extreme,
              }
              const target = {
                ...SDR_TARGET,
                mode: peak === 1 ? ('sdr' as const) : ('hdr' as const),
                peak,
                colorSpace: space,
              }
              device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(target)))
              const referenceInputs = input.map((v) => {
                const source = v.map(Math.fround)
                const balanced = wb
                  ? [0, 1, 2].map((r) => source.reduce((sum, x, c) => sum + x * wb[r * 3 + c], 0))
                  : source
                return referenceAdjust(balanced, params)
              })
              const independent = output
                ? referenceAces(binary, referenceInputs, peak, space)
                : referenceInputs
              const values = new Float32Array(44)
              values.set(
                [params.exposureEv, extreme, extreme, extreme, extreme, extreme, peak, output],
                8,
              )
              if (wb) {
                values[19] = 1
                for (let r = 0; r < 3; r++) values.set(wb.slice(r * 3, r * 3 + 3), 20 + r * 4)
              }
              const matrix = space === 'srgb' ? REC2020_TO_SRGB : REC2020_TO_P3
              for (let row = 0; row < 3; row++)
                values.set(matrix.slice(row * 3, row * 3 + 3), 32 + row * 4)
              device.queue.writeBuffer(uniform, 0, values)
              const encoder = device.createCommandEncoder(),
                pass = encoder.beginComputePass()
              pass.setPipeline(pipeline)
              pass.setBindGroup(0, group)
              pass.dispatchWorkgroups(input.length)
              pass.end()
              encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size)
              device.queue.submit([encoder.finish()])
              await staging.mapAsync(GPUMapMode.READ)
              const actual = new Float32Array(staging.getMappedRange())
              for (let i = 0; i < input.length; i++) {
                const source = input[i].map(Math.fround) as RGB
                const reference = independent[i]
                const cpuAdjusted = adjustHdr(source, params, wb)
                const cpu = output ? renderDisplay(cpuAdjusted, target).rgb : cpuAdjusted
                expect(actual[i * 4 + 3]).toBe([0, 0.25, 1][i % 3])
                for (let c = 0; c < 3; c++)
                  for (const value of [actual[i * 4 + c], cpu[c]]) {
                    const ratio =
                      Math.abs(value - reference[c]) / (2e-6 + 2e-5 * Math.abs(reference[c]))
                    if (ratio > maximumRatio) {
                      maximumRatio = ratio
                      worst = {
                        source,
                        extreme,
                        space,
                        peak,
                        output,
                        c,
                        value,
                        reference: reference[c],
                        gpu: actual[i * 4 + c],
                      }
                    }
                  }
              }
              staging.unmap()
            }
    console.log({ maximumToleranceRatio: maximumRatio, worst })
    expect(maximumRatio).toBeLessThanOrEqual(1)
  } finally {
    texture.destroy()
    buffer.destroy()
    staging.destroy()
    uniform.destroy()
    tables.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})

test('sensor blend and HDR range colors agree between CPU and hardware WGSL', async () => {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const source: RGB[] = [
    [1, 0.5, 0.75],
    [0.95, 0.475, 0.7125],
    [0.85, 0.1, 0.6],
    [0.99, 0.99, 0.99],
    [0.9, 0.45, 0.675],
    [1, 0.2, 0.1],
    [0.2, 0.5, 0.1],
    ...[0, 0.5, 0.9999, 1.0001, 1.9999, 2.0001, 3.9999, 4.0001, 7.9999, 8.0001, 16].map(
      (v): RGB => [v, v, v],
    ),
    [0.7, 0, 0],
    [0.8, 0, 0],
  ]
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const blendBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const texture = device.createTexture({
    size: [source.length, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  const buffer = device.createBuffer({
    size: source.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const staging = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const module = device.createShaderModule({
    code:
      hdrRenderingWgsl +
      hdrRangesWgsl +
      sensorBlendWgsl +
      `
    struct Blend { saturation:vec4f, white:vec4f }
    @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
    @group(0) @binding(3) var<uniform> blend:Blend;
    @compute @workgroup_size(1) fn checkRanges(@builtin(global_invocation_id) p:vec3u) {
      let rgb=textureLoad(pixels,vec2i(p.xy),0).rgb;
      if(u.values[3].w>0.) { result[p.x]=hdrRangeColor(rgb,vec2f(f32(p.x),0.)); }
      else if(blend.white.w>0.) { result[p.x]=vec4f(sensorBlendRgb(rgb,blend.saturation.xyz,blend.white.xyz,blend.saturation.w),1.); }
      else { result[p.x]=vec4f(rgb,1.); }
    }`,
  })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'checkRanges' },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer } },
      { binding: 3, resource: { buffer: blendBuffer } },
    ],
  })
  const parameters = sensorBlendParameters({
    black: [64, 64, 64, 64],
    maximum: 1000,
    gains: [2, 1, 1.5, 1],
    restoreGain: 2,
    referenceWhite: 1,
    sourceSaturation: { thresholds: [964, 964, 964, 964], saturatedSites: 0, totalSites: 4 },
  })!
  const input = source.map((rgb) => rgb.map(Math.fround) as RGB)
  device.queue.writeTexture(
    { texture },
    new Float32Array(input.flatMap((rgb) => [...rgb, 1])),
    { bytesPerRow: source.length * 16 },
    [source.length, 1],
  )
  try {
    for (const ranges of [false, true])
      for (const enabled of [false, true])
        for (const space of ['srgb', 'display-p3'] as const)
          for (const peak of [1, 4, 16]) {
            const values = new Float32Array(44)
            values[14] = peak
            values[15] = Number(ranges)
            values[42] = 1
            values[43] = peak
            const matrix = space === 'srgb' ? REC2020_TO_SRGB : REC2020_TO_P3
            for (let row = 0; row < 3; row++)
              values.set(matrix.slice(row * 3, row * 3 + 3), 32 + row * 4)
            device.queue.writeBuffer(uniform, 0, values)
            device.queue.writeBuffer(
              blendBuffer,
              0,
              new Float32Array([
                ...parameters.saturation,
                parameters.clip,
                ...parameters.white,
                Number(enabled),
              ]),
            )
            const encoder = device.createCommandEncoder(),
              pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, group)
            pass.dispatchWorkgroups(source.length)
            pass.end()
            encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size)
            device.queue.submit([encoder.finish()])
            await staging.mapAsync(GPUMapMode.READ)
            const actual = new Float32Array(staging.getMappedRange())
            for (let i = 0; i < input.length; i++) {
              const color = ranges
                ? hdrRangeColor(
                    input[i],
                    { ...SDR_TARGET, colorSpace: space, peak, headroom: peak },
                    i,
                    0,
                  )
                : null
              const expected = ranges
                ? [...(color ?? [0, 0, 0]), Number(!!color)]
                : [...sensorBlendRgb(input[i], enabled ? parameters : null), 1]
              for (let c = 0; c < 4; c++)
                expect(
                  actual[i * 4 + c],
                  JSON.stringify({ i, c, ranges, enabled, space, peak }),
                ).toBeCloseTo(expected[c], 5)
            }
            staging.unmap()
          }
  } finally {
    texture.destroy()
    uniform.destroy()
    blendBuffer.destroy()
    buffer.destroy()
    staging.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})
