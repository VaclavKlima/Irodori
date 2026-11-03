import { RawGpuRenderer } from '../../../src/main/gpu/raw-renderer'
import {
  hdrPresentationWgsl,
  hdrRenderingShader,
} from '../../../src/renderer/src/preview/hdr-shader'
import { packAces } from '../../../src/shared/aces-data'
import { neutralAdjustments } from '../../../src/shared/adjustments'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../../../src/shared/display-rendering'
import {
  hdrAdjustmentMatrix,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../../../src/shared/hdr'

export const GPU_MASK_CANDIDATE = 'existing-preview-f32-mask-v1'
/** One bounded qualification of the existing preview math. No production entry
 * point imports this experiment, and a failed exact mask gate stops adoption. */
export async function gpuMaskCandidate(
  pixels: Float32Array<ArrayBuffer>,
  asset: HdrWorkingAsset,
  target: DisplayTarget,
) {
  if (asset.width * asset.height > 65536 || pixels.length !== asset.width * asset.height * 4)
    throw new Error('Mask qualification exceeds its bounded input.')
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  let texture: GPUTexture | undefined, queue: GPUQueue | undefined
  const started = performance.now()
  try {
    const { device, adapter } = await gpu.mergeDevice()
    queue = device.queue
    const buffer = (size: number, usage: number) => {
      const b = device.createBuffer({ size, usage })
      buffers.push(b)
      return b
    }
    const uniform = buffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      tablesData = packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)),
      tables = buffer(tablesData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      masks = buffer(pixels.length, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      staging = buffer(pixels.length, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      values = new Float32Array(48)
    values[14] = 10
    values[31] = Number(!!asset.source.display)
    values[37] = target.peak
    values[38] = target.colorSpace === 'display-p3' ? 2 : 1
    values[42] = Number(target.headroom !== null)
    values[43] = target.headroom ?? 0
    const wb = hdrAdjustmentMatrix(neutralAdjustments, asset.whiteBalance)
    if (wb) {
      values[19] = 1
      for (let row = 0; row < 3; row++) values.set(wb.slice(row * 3, row * 3 + 3), 20 + row * 4)
    }
    device.queue.writeBuffer(uniform, 0, values)
    device.queue.writeBuffer(tables, 0, tablesData)
    texture = device.createTexture({
      size: { width: asset.width, height: asset.height },
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture },
      pixels,
      { bytesPerRow: asset.width * 16 },
      { width: asset.width, height: asset.height },
    )
    const module = device.createShaderModule({
      code: `${hdrRenderingShader()}
${hdrPresentationWgsl}
@group(0) @binding(6) var<storage,read_write> masks:array<u32>;
@compute @workgroup_size(64) fn classify(@builtin(global_invocation_id) p:vec3u) {
 let size=textureDimensions(pixels);if(p.x>=size.x*size.y){return;}
 let pixel=textureLoad(pixels,vec2i(i32(p.x%size.x),i32(p.x/size.x)),0);
 masks[p.x]=0u;if(pixel.a==0.){return;}
 let content=outputRgb(adjusted(pixel.rgb));let y=dot(content,irodori);let converted=canvasRgb(content);
 let gamut=any(converted<vec3f(-.000002));
 let clipped=gamut||any(converted>vec3f(u.values[9].y+.000002));
 masks[p.x]=u32(clipped)|(u32(u.values[10].z>0.&&y>u.values[10].w)<<1u)|(u32(y>1.)<<2u)|(u32(gamut)<<3u);
}`,
    })
    const errors = (await module.getCompilationInfo()).messages.filter(
      (message) => message.type === 'error',
    )
    if (errors.length) throw new Error(errors.map((message) => message.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'classify' },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 4, resource: { buffer: tables } },
          { binding: 6, resource: { buffer: masks } },
        ],
      }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(pixels.length / 4 / 64))
    pass.end()
    encoder.copyBufferToBuffer(masks, 0, staging, 0, pixels.length)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    let result: Uint8Array<ArrayBuffer>
    try {
      result = Uint8Array.from(new Uint32Array(staging.getMappedRange()))
    } finally {
      staging.unmap()
    }
    return {
      candidate: GPU_MASK_CANDIDATE,
      mask: result,
      adapter,
      elapsedMs: performance.now() - started,
      gpuBytes: buffers.reduce((sum, b) => sum + b.size, 0) + pixels.byteLength,
    }
  } finally {
    await queue?.onSubmittedWorkDone().catch(() => undefined)
    for (const buffer of buffers) buffer.destroy()
    texture?.destroy()
    gpu.close()
  }
}
