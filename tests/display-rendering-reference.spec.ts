import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import reference from './fixtures/aces-reference.json' with { type: 'json' }
import { hdrRenderingWgsl } from '../src/renderer/src/preview/hdr-shader'
import { prepareDisplayRendering } from '../src/shared/display-rendering'
import { packAces, ACES_DATA_BYTES } from '../src/shared/aces-data'
import { buildAcesReference, referenceAces } from './aces-reference'

let retainedGpu: GPU | undefined
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('actual forward WGSL agrees with independent Float64 CTL, including signed channels, alpha and encoded output', async ({}, info) => {
  const directory = info.outputPath('reference')
  await mkdir(directory, { recursive: true })
  const binary = buildAcesReference(directory)
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(
    adapter?.info.isFallbackAdapter,
    'A hardware GPU is required for reference conformance.',
  ).toBe(false)
  const device = await adapter!.requestDevice()
  const count = reference.inputs.length
  const texture = device.createTexture({
    size: [count, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const tables = device.createBuffer({
    size: ACES_DATA_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const output = device.createBuffer({
    size: count * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const staging = device.createBuffer({
    size: output.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const module = device.createShaderModule({
    code:
      hdrRenderingWgsl +
      `
    @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
    @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) p:vec3u){
      let pixel=textureLoad(pixels,vec2i(p.xy),0);
      let rendered=outputRgb(pixel.rgb);
      result[p.x]=vec4f(select(rendered,encoded(rendered),u.values[3].w>0.),pixel.a);
    }`,
  })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'check' },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer: output } },
      { binding: 4, resource: { buffer: tables } },
    ],
  })
  device.queue.writeTexture(
    { texture },
    new Float32Array(reference.inputs.flatMap((v, i) => [...v, [0, 0.25, 1][i % 3]])),
    { bytesPerRow: count * 16 },
    [count, 1],
  )
  let maximumRatio = 0,
    maximumEncodedRatio = 0,
    worst: unknown
  try {
    for (const sample of reference.targets) {
      const space = sample.colorSpace as 'srgb' | 'display-p3' | 'rec2020'
      const independent = referenceAces(binary, reference.inputs, sample.peak, space)
      expect(independent).toEqual(sample.rgb)
      device.queue.writeBuffer(
        tables,
        0,
        packAces(
          prepareDisplayRendering({
            mode: sample.peak === 1 ? 'sdr' : 'hdr',
            peak: sample.peak,
            colorSpace: space,
          }),
        ),
      )
      let linear: Float32Array
      for (const encoding of [false, true]) {
        const params = new Float32Array(44)
        params[14] = sample.peak
        params[15] = Number(encoding)
        device.queue.writeBuffer(uniform, 0, params)
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(count)
        pass.end()
        encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        const actual = new Float32Array(staging.getMappedRange())
        for (let i = 0; i < count; i++) {
          expect(actual[i * 4 + 3]).toBe([0, 0.25, 1][i % 3])
          for (let c = 0; c < 3; c++) {
            const v = encoding ? linear![i * 4 + c] : independent[i][c]
            const expected = encoding
              ? v <= 0.0031308
                ? 12.92 * v
                : 1.055 * v ** (1 / 2.4) - 0.055
              : v
            const ratio =
              Math.abs(actual[i * 4 + c] - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = {
                i,
                c,
                space,
                peak: sample.peak,
                encoding,
                expected,
                actual: actual[i * 4 + c],
              }
            }
            if (encoding) maximumEncodedRatio = Math.max(maximumEncodedRatio, ratio)
          }
        }
        if (!encoding) linear = actual.slice()
        staging.unmap()
      }
    }
    await writeFile(
      info.outputPath('conformance.json'),
      JSON.stringify(
        {
          revision: reference.revision,
          adapter: adapter!.info,
          maximumRatio,
          maximumEncodedRatio,
          worst,
        },
        null,
        2,
      ),
    )
    expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
  } finally {
    texture.destroy()
    uniform.destroy()
    tables.destroy()
    output.destroy()
    staging.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})
