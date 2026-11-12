import type { AdjustmentParameters } from '../../shared/adjustments'
import { CLIPPING_COVERAGE_ROWS, clippingCoverageMasks } from '../../shared/clipping-coverage'
import { localMasksWgsl, maskBaseAtlasPlan, packLocalMasks } from '../../shared/masks-gpu'
import { createMaskBaseAtlas } from '../gpu/mask-bases'
import { verifiedMaskBaseBytes } from '../mask-store'

const sampling = `
struct CoverageStrip { width:u32,rows:u32,top:u32,count:u32 }
@group(0) @binding(0) var<uniform> strip:CoverageStrip;
@group(0) @binding(1) var<storage,read_write> coverage:array<f32>;
@compute @workgroup_size(256) fn sampleCoverage(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=strip.width || id.y>=strip.rows*strip.count){return;}
 let root=id.y%strip.count;let row=id.y/strip.count;
 let point=maskCanonical(vec2f(f32(id.x)+.5,f32(strip.top+row)+.5));
 coverage[(row*strip.width+id.x)*strip.count+root]=maskCoverage(root,point);
}
`

/** Same shared Float32 coverage as presentation, without an R8 quantization. */
export async function sampleClippingCoverage(
  device: GPUDevice,
  parameters: AdjustmentParameters,
  width: number,
  height: number,
  signal: AbortSignal,
  consume: (bytes: Uint8Array) => Promise<void>,
): Promise<number> {
  signal.throwIfAborted()
  const selected = { ...parameters, localMasks: clippingCoverageMasks(parameters) }
  const count = selected.localMasks.length
  if (!count) throw new Error('Clipping coverage requires active local adjustments.')
  const packed = packLocalMasks(selected, { width, height })
  const plan = maskBaseAtlasPlan(selected)
  for (const base of plan.bases) verifiedMaskBaseBytes(base)
  const resources: GPUBuffer[] = []
  let atlas: GPUTexture | undefined
  let failure: unknown
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    if (
      !Number.isSafeInteger(size) ||
      size < 4 ||
      size > device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
    )
      throw new Error('Clipping coverage exceeds this GPU buffer limit.')
    const result = device.createBuffer({ size, usage })
    resources.push(result)
    return result
  }
  device.pushErrorScope('validation')
  try {
    const descriptors = buffer(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const uniform = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const stripBytes = width * Math.min(CLIPPING_COVERAGE_ROWS, height) * count * 4
    const output = buffer(stripBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const readback = buffer(stripBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    device.queue.writeBuffer(descriptors, 0, packed)
    atlas = await createMaskBaseAtlas(device, selected)
    signal.throwIfAborted()
    const module = device.createShaderModule({
      label: 'Exact clipping GPU coverage',
      code: localMasksWgsl(16, 18) + sampling,
    })
    const errors = (await module.getCompilationInfo()).messages.filter(
      (item) => item.type === 'error',
    )
    if (errors.length) throw new Error(errors.map((item) => item.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'sampleCoverage' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: output } },
        { binding: 16, resource: { buffer: descriptors } },
        { binding: 18, resource: atlas.createView({ dimension: '2d-array' }) },
      ],
    })
    for (let top = 0; top < height; top += CLIPPING_COVERAGE_ROWS) {
      signal.throwIfAborted()
      const rows = Math.min(CLIPPING_COVERAGE_ROWS, height - top)
      const bytes = width * rows * count * 4
      device.queue.writeBuffer(uniform, 0, new Uint32Array([width, rows, top, count]))
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(width / 256), rows * count)
      pass.end()
      encoder.copyBufferToBuffer(output, 0, readback, 0, bytes)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ, 0, bytes)
      try {
        signal.throwIfAborted()
        await consume(new Uint8Array(readback.getMappedRange(0, bytes)))
      } finally {
        readback.unmap()
      }
    }
  } catch (error) {
    failure = error
  } finally {
    await device.queue.onSubmittedWorkDone().catch((error: unknown) => {
      failure ??= error
    })
    for (const resource of resources) resource.destroy()
    atlas?.destroy()
    const validation = await device.popErrorScope()
    if (validation) failure ??= new Error(validation.message)
  }
  if (failure) throw failure
  return count
}
