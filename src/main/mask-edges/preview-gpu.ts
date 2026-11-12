import type { MaskGeometry } from '../../shared/mask-geometry'
import type { InspectionBounds } from '../../shared/inspection'
import { MASK_PREVIEW_ROWS } from '../../shared/mask-preview'
import type { ResolvedMask } from '../../shared/masks'
import { localMasksWgsl, maskBaseAtlasPlan, packLocalMasks } from '../../shared/masks-gpu'
import { createMaskBaseAtlas } from '../gpu/mask-bases'
import { verifiedMaskBaseBytes } from '../mask-store'

const sampling = `
struct PreviewStrip { width:u32,height:u32,rows:u32,top:u32,region:vec4f }
@group(0) @binding(0) var<uniform> strip:PreviewStrip;
@group(0) @binding(1) var<storage,read_write> coverage:array<u32>;
@group(0) @binding(2) var<storage,read_write> overlay:array<u32>;
@group(0) @binding(3) var<storage,read> photo:array<u32>;
@compute @workgroup_size(256) fn inspectMask(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=strip.width || id.y>=strip.rows){return;}
 let index=id.y*strip.width+id.x;
 let point=strip.region.xy+(vec2f(f32(id.x),f32(strip.top+id.y))+vec2f(.5))*strip.region.zw/vec2f(f32(strip.width),f32(strip.height));
 let amount=clamp(maskCoverage(0u,maskCanonical(point)),0.,1.);
 coverage[index]=pack4x8unorm(vec4f(vec3f(amount),1.));
 let original=unpack4x8unorm(photo[index]);
 overlay[index]=pack4x8unorm(vec4f(mix(original.rgb,vec3f(.96,.30,.16),amount*.38),1.));
}
`
export interface MaskPreviewGpuInput {
  mask: ResolvedMask
  geometry: MaskGeometry
  grid: { width: number; height: number }
  bounds: InspectionBounds
  width: number
  height: number
  coverage: boolean
  photo?: Uint8Array
}

/** Evaluate the stored root in the current photo grid, using presentation's shared WGSL. */
export async function renderMaskPreviewGpu(
  device: GPUDevice,
  input: MaskPreviewGpuInput,
  signal: AbortSignal,
): Promise<{ coverage?: Buffer; overlay?: Buffer }> {
  signal.throwIfAborted()
  const { width, height } = input
  if (
    ![width, height, input.grid.width, input.grid.height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 32768,
    ) ||
    width * height > 32 * 1024 ** 2 ||
    (input.photo && input.photo.byteLength !== width * height * 4)
  )
    throw new Error('Mask preview dimensions or SDR pixel bytes are invalid.')
  const parameters = { localMasks: [input.mask], maskGeometry: input.geometry }
  const packed = packLocalMasks(parameters, input.grid, true)
  const plan = maskBaseAtlasPlan(parameters, true)
  for (const base of plan.bases) verifiedMaskBaseBytes(base)
  const resources: GPUBuffer[] = []
  let atlas: GPUTexture | undefined
  let failure: unknown
  const coverage = input.coverage ? Buffer.alloc(width * height * 4) : undefined
  const overlay = input.photo ? Buffer.alloc(width * height * 4) : undefined
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    if (
      !Number.isSafeInteger(size) ||
      size < 4 ||
      size > device.limits.maxBufferSize ||
      ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
    )
      throw new Error(
        'Mask preview exceeds this GPU buffer limit. Reduce resolutionPercent or the inspection region.',
      )
    const result = device.createBuffer({ size, usage })
    resources.push(result)
    return result
  }
  device.pushErrorScope('validation')
  try {
    const descriptors = buffer(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const uniform = buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const stripBytes = width * Math.min(MASK_PREVIEW_ROWS, height) * 4
    const source = buffer(stripBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const plane = buffer(stripBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const tint = buffer(stripBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const readback = buffer(stripBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    device.queue.writeBuffer(descriptors, 0, packed)
    atlas = await createMaskBaseAtlas(device, parameters, true)
    const module = device.createShaderModule({
      label: 'Stored mask inspection in current photo grid',
      code: localMasksWgsl(16, 18) + sampling,
    })
    const errors = (await module.getCompilationInfo()).messages.filter(
      (item) => item.type === 'error',
    )
    if (errors.length) throw new Error(errors.map((item) => item.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'inspectMask' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: plane } },
        { binding: 2, resource: { buffer: tint } },
        { binding: 3, resource: { buffer: source } },
        { binding: 16, resource: { buffer: descriptors } },
        { binding: 18, resource: atlas.createView({ dimension: '2d-array' }) },
      ],
    })
    for (let top = 0; top < height; top += MASK_PREVIEW_ROWS) {
      signal.throwIfAborted()
      const rows = Math.min(MASK_PREVIEW_ROWS, height - top),
        bytes = width * rows * 4
      const values = new ArrayBuffer(32)
      new Uint32Array(values, 0, 4).set([width, height, rows, top])
      new Float32Array(values, 16, 4).set([
        input.bounds.x,
        input.bounds.y,
        input.bounds.width,
        input.bounds.height,
      ])
      device.queue.writeBuffer(uniform, 0, values)
      if (input.photo)
        device.queue.writeBuffer(
          source,
          0,
          new Uint8Array(input.photo.subarray(top * width * 4, top * width * 4 + bytes)),
        )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(width / 256), rows)
      pass.end()
      device.queue.submit([encoder.finish()])
      for (const [target, output] of [
        [coverage, plane],
        [overlay, tint],
      ] as const) {
        if (!target) continue
        const copy = device.createCommandEncoder()
        copy.copyBufferToBuffer(output, 0, readback, 0, bytes)
        device.queue.submit([copy.finish()])
        await readback.mapAsync(GPUMapMode.READ, 0, bytes)
        try {
          signal.throwIfAborted()
          target.set(new Uint8Array(readback.getMappedRange(0, bytes)), top * width * 4)
        } finally {
          readback.unmap()
        }
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
  return { coverage, overlay }
}
