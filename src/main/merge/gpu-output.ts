import { displayRenderingWgsl } from '../../shared/display-rendering-wgsl'
import { prepareDisplayRendering } from '../../shared/display-rendering'
import { packAces, ACES_DATA_BYTES } from '../../shared/aces-data'
import { SDR_TARGET } from '../../shared/hdr'
import type { RawGpuRenderer } from '../gpu/raw-renderer'

/** The same Float32 SDR conversion as HDR presentation, with bounded readback. */
export async function gpuOutput(gpu: Pick<RawGpuRenderer, 'mergeDevice'>, capacity: number) {
  const { device } = await gpu.mergeDevice(),
    resources: GPUBuffer[] = []
  const buffer = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage })
    resources.push(b)
    return b
  }
  try {
    const uniform = buffer(176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      input = buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      output = buffer(capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      tables = buffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      staging = buffer(capacity * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const values = new Float32Array(44)
    values[14] = 1
    device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(SDR_TARGET)))
    device.queue.writeBuffer(uniform, 0, values)
    const module = device.createShaderModule({
      code:
        displayRenderingWgsl +
        `
struct Params { values:array<vec4f,11> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(2) var<storage,read> input:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(256) fn convert(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=u32(u.values[0].x)) {return;}
 let pixel=input[id.x]; let rgba=vec4u(vec4f(round(clamp(encodeDisplayRgb(renderDisplayRgb(pixel.rgb,1.)),vec3f(0),vec3f(1))*255.),round(pixel.a*255.)));
 output[id.x]=rgba.x | (rgba.y << 8u) | (rgba.z << 16u) | (rgba.w << 24u);
}`,
    })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) {
      for (const b of resources) b.destroy()
      throw new Error(errors.map((m) => m.message).join('\n'))
    }
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'convert' },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: input } },
          { binding: 3, resource: { buffer: output } },
          { binding: 4, resource: { buffer: tables } },
        ],
      })
    return {
      peakBytes: resources.reduce((n, b) => n + b.size, 0),
      async convert(pixels: Float32Array<ArrayBuffer>): Promise<Buffer> {
        const count = pixels.length / 4
        if (count > capacity) throw new Error('Output tile exceeds its allocation.')
        values[0] = count
        device.queue.writeBuffer(uniform, 0, values)
        device.queue.writeBuffer(input, 0, pixels)
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(Math.ceil(count / 256))
        pass.end()
        encoder.copyBufferToBuffer(output, 0, staging, 0, count * 4)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        const bytes = Buffer.from(new Uint8Array(staging.getMappedRange()).slice(0, count * 4))
        staging.unmap()
        return bytes
      },
      close() {
        for (const b of resources) b.destroy()
      },
    }
  } catch (error) {
    for (const b of resources) b.destroy()
    throw error
  }
}
