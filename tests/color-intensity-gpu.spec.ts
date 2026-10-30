import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { hdrRenderingWgsl } from '../src/renderer/src/preview/hdr-shader'
import { colorIntensityWgsl } from '../src/shared/color-intensity'
import reference from './fixtures/color-intensity-reference.json' with { type: 'json' }

test('actual SDR and canonical HDR GPU color operators retain the frozen independent numeric tolerance', async () => {
  const gpu = new RawGpuRenderer()
  const buffers: GPUBuffer[] = []
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      return buffer
    }
    for (const primaries of ['srgb', 'rec2020'] as const) {
      const vectors = reference.vectors.filter((vector) => vector.primaries === primaries)
      const input = allocate(vectors.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      const output = allocate(vectors.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      const staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      device.queue.writeBuffer(
        input,
        0,
        new Float32Array(
          vectors.flatMap((v, i) => [...v.input, (i % 4) / 3, v.saturation, v.vibrance, 0, 0]),
        ),
      )
      const module = device.createShaderModule({
        code:
          (primaries === 'rec2020' ? hdrRenderingWgsl : colorIntensityWgsl('srgb')) +
          `
struct ColorCase { pixel:vec4f, color:vec4f }
@group(0) @binding(5) var<storage,read> cases:array<ColorCase>;
@group(0) @binding(6) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn checkColor(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=arrayLength(&cases)) {return;}
 let value=cases[id.x];
 result[id.x]=vec4f(applyColorIntensity(value.pixel.rgb,value.color.xy),value.pixel.a);
}`,
      })
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'checkColor' },
      })
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 5, resource: { buffer: input } },
          { binding: 6, resource: { buffer: output } },
        ],
      })
      const encoder = device.createCommandEncoder(),
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
        let maximumRatio = 0,
          worst: unknown
        for (const [i, vector] of vectors.entries()) {
          expect(actual[i * 4 + 3]).toBe(Math.fround((i % 4) / 3))
          for (let channel = 0; channel < 3; channel++) {
            const value = actual[i * 4 + channel]
            expect(Number.isFinite(value)).toBe(true)
            if (vector.saturation === 0 && vector.vibrance === 0)
              expect(value).toBe(Math.fround(vector.input[channel]))
            const expected = vector.output[channel]
            const ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = { vector, channel, value, expected }
            }
          }
        }
        expect(maximumRatio, JSON.stringify({ primaries, worst })).toBeLessThanOrEqual(1)
      } finally {
        staging.unmap()
      }
    }
  } finally {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})
