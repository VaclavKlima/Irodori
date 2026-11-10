import { expect, test } from '@playwright/test'
import reference from '../assets/tests/references/mask-color/reference.json' with { type: 'json' }
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { hdrRenderingWgsl } from '../src/renderer/src/preview/hdr-shader'
import { localMasksWgsl, packLocalMasks } from '../src/shared/masks-gpu'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { maskColorReferenceMasks, maskColorReferencePoint } from './helpers/mask-color'

test('common mask color matches independent signed/HDR balance→Light→saturation and single-blend references', async () => {
  const gpu = new RawGpuRenderer()
  try {
    const { device, adapter } = await gpu.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    for (const frontend of ['raster', 'authored-hdr', 'scene-linear'] as const) {
      const scene = frontend !== 'raster',
        canonical = frontend === 'scene-linear',
        module = device.createShaderModule({
          code:
            (canonical ? hdrRenderingWgsl : '') +
            localMasksWgsl(1, undefined, canonical ? 'acesPow' : 'pow') +
            `
struct ColorCase{pixel:vec4f,settings:vec4f}
@group(0) @binding(0) var<storage,read> cases:array<ColorCase>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&cases)){return;}let c=cases[id.x];
 output[id.x]=vec4f(applyLocalMasks(c.pixel.rgb,vec2f(${maskColorReferencePoint.join(',')}),c.settings.x,${scene}),c.pixel.a);
}`,
        }),
        pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'check' },
        })
      let maximumRatio = 0,
        worst: unknown
      for (const entry of reference.cases) {
        const buffers: GPUBuffer[] = [],
          allocate = (size: number, usage: number) => {
            const buffer = device.createBuffer({ size, usage })
            buffers.push(buffer)
            return buffer
          }
        try {
          const vectors = reference.vectors.filter(
              (vector) =>
                vector.case === entry.id && vector.primaries === (scene ? 'rec2020' : 'srgb'),
            ),
            packed = packLocalMasks(
              {
                localMasks: maskColorReferenceMasks(entry.id),
                maskGeometry: identityMaskGeometry(1, 1),
              },
              { width: 1, height: 1 },
            ),
            masks = allocate(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
            input = allocate(vectors.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
            output = allocate(
              vectors.length * 16,
              GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            ),
            staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
          device.queue.writeBuffer(masks, 0, packed)
          device.queue.writeBuffer(
            input,
            0,
            new Float32Array(
              vectors.flatMap((v, i) => [...v.input, (i % 4) / 3, v.white, 0, 0, 0]),
            ),
          )
          const group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: input } },
                { binding: 1, resource: { buffer: masks } },
                { binding: 2, resource: { buffer: output } },
              ],
            }),
            encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(Math.ceil(vectors.length / 64))
          pass.end()
          encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
          device.queue.submit([encoder.finish()])
          await staging.mapAsync(GPUMapMode.READ)
          try {
            const actual = new Float32Array(staging.getMappedRange())
            for (const [index, vector] of vectors.entries()) {
              expect(actual[index * 4 + 3]).toBe(Math.fround((index % 4) / 3))
              for (const [channel, expected] of vector.output.entries()) {
                const value = actual[index * 4 + channel]
                expect(Number.isFinite(value)).toBe(true)
                if (['neutral', 'zero-coverage', 'disabled'].includes(vector.case))
                  expect(value).toBe(vector.input[channel])
                const ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
                if (ratio > maximumRatio) {
                  maximumRatio = ratio
                  worst = { vector, channel, value, expected }
                }
              }
            }
          } finally {
            staging.unmap()
          }
        } finally {
          for (const buffer of buffers) buffer.destroy()
        }
      }
      expect(maximumRatio, JSON.stringify({ frontend, worst })).toBeLessThanOrEqual(1)
    }
    expect(gpu.failure).toBeUndefined()
  } finally {
    gpu.close()
  }
})
