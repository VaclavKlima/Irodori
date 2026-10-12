import { open, link, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { RawGpuRenderer } from '../gpu/raw-renderer'
import { mergePreparationParameters } from '../gpu/merge-parameters'
import { mergeSensorShader } from '../gpu/merge-sensor-shader'
import { readSensorCache, packedBits } from './sensor-cache'
import { bandData, noteMergeRead } from './sampling'
import { identityTransform } from './alignment'
import { sourceExclusionBand, packedExclusionConfidence } from './exclusions'
import type { PreparedSource } from './prepare'
import type { MergeSettings, MergeSource, MergeTransform } from '../../shared/merge'

const limit = 1024 ** 3
/** Reserve all persistent merge buffers alongside the bounded 128-row AHD pipeline. */
export function supportsSensorAccumulation(
  device: GPUDevice,
  prepared: PreparedSource[],
  featherPixels = 0,
) {
  const { width, height } = prepared[0],
    n = width * height,
    reserved =
      n * 24 +
      Math.ceil(n / 32) * 4 +
      (featherPixels ? Math.ceil(n / 4) * 4 : Math.ceil(n / 32) * 4) +
      65536 +
      8192 +
      240
  return (
    n * 16 <= device.limits.maxStorageBufferBindingSize &&
    prepared.every((p) => {
      const c = p.sensor
      if (
        !c ||
        width !== (c.raw.flip & 4 ? c.correction.height : c.correction.width) ||
        height !== (c.raw.flip & 4 ? c.correction.width : c.correction.height)
      )
        return false
      return (
        reserved +
          c.raw.width * c.raw.height * 16 +
          c.sensor.bytes +
          c.raw.width * 140 * 80 +
          623072 <=
        limit
      )
    })
  )
}

/** Source order is frozen. Each sensor is decoded on the GPU once, then released. */
export async function accumulateSensorGpu(
  gpu: RawGpuRenderer,
  prepared: PreparedSource[],
  sources: MergeSource[],
  transforms: MergeTransform[],
  scales: number[],
  settings: MergeSettings,
  common: Uint8Array,
  motion: Uint8Array,
  native: { width: number; height: number },
  output: string,
  checkpoint: () => Promise<void>,
  featherPixels = 0,
) {
  const { device, adapter } = await gpu.mergeDevice(),
    { width, height } = prepared[0],
    referenceIndex = sources.findIndex((s) => s.photo.id === settings.referenceId),
    n = width * height,
    rows = Math.min(1024, height),
    capacity = width * rows,
    resources = new Set<GPUBuffer>(),
    storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    timings = { readingMs: 0, uploadMs: 0, dispatchMs: 0, readbackMs: 0, writingMs: 0 }
  let peakBytes = 0,
    scopes = true
  const allocated = () => [...resources].reduce((sum, b) => sum + b.size, 0)
  const buffer = (size: number, usage = storage) => {
    if (allocated() + size > limit) throw new Error('Merge exceeds the 1 GiB GPU allocation limit.')
    const b = device.createBuffer({ size, usage })
    resources.add(b)
    peakBytes = Math.max(peakBytes, allocated())
    return b
  }
  const destroy = (b: GPUBuffer) => {
    b.destroy()
    resources.delete(b)
  }
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  gpu.releaseFrame()
  try {
    const module = device.createShaderModule({ code: mergeSensorShader }),
      errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
    const pipelines = await Promise.all(
        ['initializeReference', 'accumulateSensor', 'finishSensor'].map((entryPoint) =>
          device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } }),
        ),
      ),
      uniform = buffer(240, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      referenceY = buffer(n * 4),
      sums = buffer(n * 16),
      flags = buffer(n * 4),
      bitsSize = Math.ceil(n / 32) * 4,
      alpha = buffer(bitsSize),
      excluded = buffer(featherPixels ? Math.ceil(n / 4) * 4 : bitsSize),
      lut = buffer(65536),
      offsets = buffer(8192)
    const parameters = new ArrayBuffer(240),
      ints = new Uint32Array(parameters),
      floats = new Float32Array(parameters)
    ints.set([width, height, 0, rows], 36)
    const upload = performance.now(),
      clear = device.createCommandEncoder()
    clear.clearBuffer(sums)
    device.queue.submit([clear.finish()])
    device.queue.writeBuffer(flags, 0, Uint32Array.from(common))
    timings.uploadMs += performance.now() - upload
    const dispatch = (
      which: number,
      bindings: Record<number, GPUBindingResource>,
      indices: number[],
      count: number,
    ) => {
      device.queue.writeBuffer(uniform, 0, new Uint8Array(parameters))
      const pipeline = pipelines[which],
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: indices.map((binding) => ({ binding, resource: bindings[binding] })),
        }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      if (which !== 2) pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16))
      else pass.dispatchWorkgroups(Math.ceil(count / 256))
      pass.end()
      device.queue.submit([encoder.finish()])
    }
    const staging = Buffer.allocUnsafe(capacity * 16)
    let referenceSensor: Awaited<ReturnType<typeof readSensorCache>> | undefined
    // Initialize reference luminance before accumulating in the original source order.
    for (const pass of [-1, ...prepared.map((_, i) => i)]) {
      const initialize = pass === -1,
        s = initialize ? referenceIndex : pass
      await checkpoint()
      const read = performance.now(),
        cache = prepared[s].sensor!,
        source =
          s === referenceIndex && referenceSensor ? referenceSensor : await readSensorCache(cache)
      if (initialize) referenceSensor = source
      timings.readingMs += performance.now() - read
      const upload = performance.now()
      new Uint8Array(parameters).set(
        new Uint8Array(mergePreparationParameters(source.raw, source.correction, cache.gains)),
      )
      ints.set([width, height, 0, height], 36)
      ints.set(
        [0, 0, Number(s !== referenceIndex && settings.deghost), transforms[s].tiles?.columns ?? 0],
        40,
      )
      for (let r = 0; r < 3; r++)
        floats.set(transforms[s].matrix!.slice(r * 3, r * 3 + 3), 44 + r * 4)
      floats[47] = Number(featherPixels > 0)
      floats.set(
        [
          scales[s],
          sources[s].capture.iso,
          sources[referenceIndex].capture.iso,
          settings.deghost ? settings.strength : 0,
        ],
        56,
      )
      device.queue.writeBuffer(alpha, 0, source.alpha)
      device.queue.writeBuffer(lut, 0, source.correction.lut)
      device.queue.writeBuffer(
        offsets,
        0,
        Float32Array.from(transforms[s].tiles?.offsets ?? [0, 0]),
      )
      const hasExclusion =
        settings.deghost &&
        settings.strength > 0 &&
        s !== referenceIndex &&
        (transforms[s].diagnostics?.movingRegions?.length ?? 0) > 0
      if (hasExclusion) {
        const exclusion = sourceExclusionBand(
          transforms[s],
          width,
          height,
          native.width,
          native.height,
          0,
          height,
          featherPixels,
        )
        device.queue.writeBuffer(
          excluded,
          0,
          featherPixels ? packedExclusionConfidence(exclusion) : packedBits(exclusion),
        )
      } else {
        const clear = device.createCommandEncoder()
        clear.clearBuffer(excluded)
        device.queue.submit([clear.finish()])
      }
      timings.uploadMs += performance.now() - upload
      const frame = await gpu.render(source.raw, undefined, undefined, false, false, undefined, {
        reservedBytes: allocated(),
        checkpoint,
        consume: async (linear) => {
          dispatch(
            initialize ? 0 : 1,
            {
              0: { buffer: uniform },
              1: linear.createView(),
              2: { buffer: lut },
              3: { buffer: alpha },
              4: { buffer: referenceY },
              5: { buffer: sums },
              6: { buffer: flags },
              7: { buffer: offsets },
              8: { buffer: excluded },
            },
            initialize ? [0, 1, 2, 3, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7, 8],
            n,
          )
        },
      })
      peakBytes = Math.max(peakBytes, frame.gpuBytes ?? 0)
      timings.uploadMs += frame.timings.uploadMs
      timings.dispatchMs += frame.timings.processingMs
    }
    let referenceReused = true
    try {
      // Both paths belong to this review. Prepared pixels are immutable and readers
      // validate every original checksum; cleanup only unlinks the scratch reference.
      await link(prepared[referenceIndex].path, join(output, 'reference.f32'))
    } catch (error) {
      if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
      await copyFile(
        prepared[referenceIndex].path,
        join(output, 'reference.f32'),
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      )
      noteMergeRead(n * 16)
      referenceReused = false
    }
    for (const b of [referenceY, alpha, excluded, lut, offsets]) destroy(b)
    const ref = buffer(capacity * 16),
      result = buffer(capacity * 16),
      readback = buffer(capacity * 20, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      accum = await open(join(output, 'accumulation.f32'), 'wx')
    try {
      for (let top = 0; top < height; top += rows) {
        await checkpoint()
        const count = Math.min(rows, height - top),
          pixels = width * count,
          read = performance.now(),
          data = await bandData(prepared[referenceIndex], identityTransform(), top, count, staging)
        timings.readingMs += performance.now() - read
        const upload = performance.now()
        device.queue.writeBuffer(ref, 0, data.data)
        ints.set([width, height, top, count], 36)
        dispatch(
          2,
          {
            0: { buffer: uniform },
            5: { buffer: sums },
            6: { buffer: flags },
            9: { buffer: ref },
            10: { buffer: result },
          },
          [0, 5, 6, 9, 10],
          pixels,
        )
        const encoder = device.createCommandEncoder()
        encoder.copyBufferToBuffer(result, 0, readback, 0, pixels * 16)
        encoder.copyBufferToBuffer(flags, top * width * 4, readback, pixels * 16, pixels * 4)
        device.queue.submit([encoder.finish()])
        timings.uploadMs += performance.now() - upload
        const readStart = performance.now()
        await readback.mapAsync(GPUMapMode.READ)
        const bytes = Buffer.from(readback.getMappedRange()),
          mask = new Uint32Array(bytes.buffer, bytes.byteOffset + pixels * 16, pixels)
        timings.readbackMs += performance.now() - readStart
        const write = performance.now()
        await accum.writeFile(bytes.subarray(0, pixels * 16))
        for (let k = 0; k < pixels; k++) motion[top * width + k] ||= Number((mask[k] & 2) !== 0)
        readback.unmap()
        timings.writingMs += performance.now() - write
      }
    } finally {
      await accum.close()
    }
    const oom = await device.popErrorScope(),
      validation = await device.popErrorScope()
    scopes = false
    if (oom || validation) throw new Error((oom ?? validation)!.message)
    return {
      adapter,
      peakBytes,
      kernel: 'sensor-warp' as const,
      referenceReused,
      batches: {
        rows,
        sourceBytes: Math.max(...prepared.map((p) => p.sensor!.sensor.bytes)),
        ...timings,
      },
    }
  } finally {
    gpu.releaseFrame()
    if (scopes) await Promise.allSettled([device.popErrorScope(), device.popErrorScope()])
    for (const b of resources) b.destroy()
  }
}
