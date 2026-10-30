import { RawGpuRenderer } from './raw-renderer'
import type { CropGeometry } from '../../shared/crop'
import {
  CROP_COVERAGE_FLOOR,
  resampleCropTile,
  type CropRectangle,
  type CropSourceWindow,
} from '../../shared/crop-filter'
import {
  CROP_GPU_PARAMETER_BYTES,
  cropFilteringWgsl,
  packCropTile,
} from '../../shared/crop-filter-wgsl'

import { CROP_WINDOW_BYTES, CROP_TILE_BYTES, CROP_COMPUTE_BYTES } from '../../shared/crop-resources'
export const CROP_GPU_INPUT_BYTES = CROP_WINDOW_BYTES
export const CROP_GPU_OUTPUT_BYTES = CROP_TILE_BYTES
export const CROP_GPU_BYTES = CROP_COMPUTE_BYTES
export interface CropGpu {
  readonly adapter: string
  readonly bytes: number
  readonly precisionRecoveryTiles: number
  render(
    geometry: CropGeometry,
    tile: CropRectangle,
    source: CropSourceWindow,
    signal: AbortSignal,
  ): Promise<Float32Array>
  close(): Promise<void>
}

/** One reusable bounded compute owner in the isolated image worker. */
export async function createCropGpu(): Promise<CropGpu> {
  if (process.versions.electron)
    throw new Error('Crop computation requires the isolated Node worker.')
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  try {
    const { device, adapter } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      if (
        size > device.limits.maxBufferSize ||
        ((usage & GPUBufferUsage.STORAGE) !== 0 && size > device.limits.maxStorageBufferBindingSize)
      )
        throw new Error('Crop tile exceeds the GPU allocation limit.')
      const value = device.createBuffer({ size, usage })
      buffers.push(value)
      return value
    }
    const uniform = allocate(
        CROP_GPU_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      ),
      input = allocate(CROP_GPU_INPUT_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      output = allocate(CROP_GPU_OUTPUT_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      staging = allocate(CROP_GPU_OUTPUT_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      module = device.createShaderModule({ code: cropFilteringWgsl }),
      pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'warpCrop' },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: input } },
          { binding: 2, resource: { buffer: output } },
        ],
      })
    let disposed = false,
      recoveries = 0,
      pending: Promise<Float32Array> | undefined,
      closing: Promise<void> | undefined
    return {
      adapter,
      bytes: CROP_GPU_BYTES,
      get precisionRecoveryTiles() {
        return recoveries
      },
      render(geometry, tile, source, signal) {
        if (disposed || pending)
          return Promise.reject(new Error('The crop GPU owner is unavailable or busy.'))
        const work = (async () => {
          signal.throwIfAborted()
          const parameters = packCropTile(geometry, tile, source),
            count = tile.width * tile.height
          if (source.data.byteLength > input.size || !(source.data.buffer instanceof ArrayBuffer))
            throw new Error('Invalid crop upload window.')
          device.queue.writeBuffer(uniform, 0, parameters)
          device.queue.writeBuffer(
            input,
            0,
            source.data.buffer,
            source.data.byteOffset,
            source.data.byteLength,
          )
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(Math.ceil(count / 64))
          pass.end()
          encoder.copyBufferToBuffer(output, 0, staging, 0, count * 16)
          device.queue.submit([encoder.finish()])
          await staging.mapAsync(GPUMapMode.READ, 0, count * 16)
          let result: Float32Array
          try {
            signal.throwIfAborted()
            result = new Float32Array(staging.getMappedRange(0, count * 16).slice(0))
          } finally {
            staging.unmap()
          }
          let lowCoverage = false
          for (let i = 0; i < result.length; i++) {
            if (!Number.isFinite(result[i]))
              throw new Error('The GPU crop returned nonfinite working pixels.')
            if (i % 4 === 3) {
              if (result[i] < 0 || result[i] > 1)
                throw new Error('The GPU crop returned invalid coverage.')
              if (result[i] <= 16 * CROP_COVERAGE_FLOOR) lowCoverage = true
            }
          }
          if (lowCoverage) {
            let partial = false
            for (let i = 3; i < source.data.length; i += 4)
              if (source.data[i] !== 1) {
                partial = true
                break
              }
            if (!partial) throw new Error('The GPU crop lost opaque source coverage.')
            // Near the discontinuous coverage guard, reconstruct with canonical
            // Float64 coordinates instead of trusting a rounded GPU classification.
            result = resampleCropTile(geometry, tile, source)
            recoveries++
          }
          signal.throwIfAborted()
          return result
        })()
        pending = work
        return work.finally(() => {
          if (pending === work) pending = undefined
        })
      },
      close() {
        if (closing) return closing
        disposed = true
        closing = (async () => {
          await pending?.catch(() => undefined)
          await device.queue.onSubmittedWorkDone().catch(() => undefined)
          for (const buffer of buffers) buffer.destroy()
          gpu.close()
        })()
        return closing
      },
    }
  } catch (error) {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
    throw error
  }
}
