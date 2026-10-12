import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { RawGpuRenderer } from '../gpu/raw-renderer'
import { mergeAccumulationShader } from '../gpu/merge-accumulation-shader'
import { bandData, bandBounds } from './sampling'
import { identityTransform } from './alignment'
import { sourceExclusionBand } from './exclusions'
import type { PreparedSource } from './prepare'
import type { MergeSettings, MergeSource, MergeTransform } from '../../shared/merge'
import { accumulateSensorGpu, supportsSensorAccumulation } from './gpu-sensor-accumulation'

/** Tiled Float32 accumulation. The independent CPU engine remains the fallback/reference. */
export async function accumulateGpu(
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
    resources: GPUBuffer[] = []
  if (supportsSensorAccumulation(device, prepared, featherPixels))
    return accumulateSensorGpu(
      gpu,
      prepared,
      sources,
      transforms,
      scales,
      settings,
      common,
      motion,
      native,
      output,
      checkpoint,
      featherPixels,
    )
  const timings = { readingMs: 0, uploadMs: 0, dispatchMs: 0, readbackMs: 0, writingMs: 0 }
  const buffer = (size: number, usage: number) => {
    if (resources.reduce((n, b) => n + b.size, 0) + size > 1024 ** 3)
      throw new Error('Merge exceeds the 1 GiB GPU allocation limit.')
    const b = device.createBuffer({ size, usage })
    resources.push(b)
    return b
  }
  const maximumSourceBytes = (rows: number) => {
    let bytes = 0
    for (let top = 0; top < height; top += rows)
      for (let s = 0; s < prepared.length; s++)
        bytes = Math.max(
          bytes,
          bandBounds(prepared[s], transforms[s], top, Math.min(rows, height - top)).rows *
            width *
            16,
        )
    return bytes
  }
  // Larger bounded batches reduce repeated strip reads and GPU submissions.
  // Retain the small batch on devices with lower binding or buffer limits.
  const rows =
      [1024, 512, 256].find((rows) => {
        const n = width * Math.min(rows, height),
          source = Math.max(maximumSourceBytes(rows), n * 16)
        return (
          source <= device.limits.maxStorageBufferBindingSize &&
          n * 16 <= device.limits.maxStorageBufferBindingSize &&
          n * 36 <= device.limits.maxBufferSize &&
          n * 96 + source + 32 * 32 * 8 + 96 <= 1024 ** 3
        )
      }) ?? 256,
    capacity = width * Math.min(rows, height),
    storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  let scopes = true
  try {
    const module = device.createShaderModule({ code: mergeAccumulationShader }),
      errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
    const uniform = buffer(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      ref = buffer(capacity * 16, storage),
      sum = buffer(capacity * 16, storage),
      mask = buffer(capacity * 4, storage),
      covered = buffer(capacity * 4, storage),
      result = buffer(capacity * 16, storage),
      readback = buffer(capacity * 36, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      offsets = buffer(32 * 32 * 8, storage)
    const excluded = buffer(capacity * 4, storage),
      emptyExclusion = new Uint32Array(capacity)
    let exclusionIsEmpty = true
    const pipelines = await Promise.all(
      ['referencePixels', 'accumulate', 'finish'].map((name) =>
        device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: name },
        }),
      ),
    )
    const sourceBytes = maximumSourceBytes(rows)
    const sourceBuffer = buffer(Math.max(sourceBytes, capacity * 16), storage),
      peakBytes = resources.reduce((n, b) => n + b.size, 0),
      sourceStaging = Buffer.allocUnsafe(sourceBuffer.size)
    const accum = await open(join(output, 'accumulation.f32'), 'wx')
    let reference: Awaited<ReturnType<typeof open>> | undefined
    try {
      reference = await open(join(output, 'reference.f32'), 'wx')
      for (let top = 0; top < height; top += rows) {
        await checkpoint()
        const clearStart = performance.now()
        const count = Math.min(rows, height - top),
          n = width * count,
          parameters = new ArrayBuffer(96),
          ints = new Uint32Array(parameters),
          floats = new Float32Array(parameters)
        ints.set([width, height, top, count])
        const clear = device.createCommandEncoder()
        clear.clearBuffer(sum, 0, n * 16)
        clear.clearBuffer(mask, 0, n * 4)
        device.queue.submit([clear.finish()])
        device.queue.writeBuffer(
          covered,
          0,
          Uint32Array.from(common.subarray(top * width, (top + count) * width)),
        )
        timings.uploadMs += performance.now() - clearStart
        const dispatch = async (which: number, index: number) => {
          await checkpoint()
          const readStart = performance.now()
          const data = await bandData(
            prepared[index],
            which === 0 ? identityTransform() : transforms[index],
            top,
            count,
            sourceStaging,
          )
          timings.readingMs += performance.now() - readStart
          const uploadStart = performance.now()
          if (data.data.byteLength > sourceBuffer.size)
            throw new Error('Source band exceeds its allocation.')
          device.queue.writeBuffer(sourceBuffer, 0, data.data)
          const hasExclusion =
            which === 1 &&
            index !== referenceIndex &&
            settings.deghost &&
            settings.strength > 0 &&
            (transforms[index].diagnostics?.movingRegions?.length ?? 0) > 0
          if (hasExclusion) {
            device.queue.writeBuffer(
              excluded,
              0,
              Uint32Array.from(
                sourceExclusionBand(
                  transforms[index],
                  width,
                  height,
                  native.width,
                  native.height,
                  top,
                  count,
                  featherPixels,
                ),
              ),
            )
          } else if (!exclusionIsEmpty) {
            device.queue.writeBuffer(excluded, 0, emptyExclusion, 0, n)
          }
          exclusionIsEmpty = !hasExclusion
          ints.set(
            [
              data.first,
              data.rows,
              Number(index !== referenceIndex && settings.deghost),
              transforms[index].tiles?.columns ?? 0,
            ],
            4,
          )
          device.queue.writeBuffer(
            offsets,
            0,
            Float32Array.from(transforms[index].tiles?.offsets ?? [0, 0]),
          )
          const matrix = transforms[index].matrix!
          for (let r = 0; r < 3; r++) floats.set(matrix.slice(r * 3, r * 3 + 3), 8 + r * 4)
          floats[11] = Number(featherPixels > 0)
          floats.set(
            [
              scales[index],
              sources[index].capture.iso,
              sources[referenceIndex].capture.iso,
              settings.deghost ? settings.strength : 0,
            ],
            20,
          )
          device.queue.writeBuffer(uniform, 0, new Uint8Array(parameters))
          timings.uploadMs += performance.now() - uploadStart
          const dispatchStart = performance.now()
          const bindings: Record<number, GPUBindingResource> = {
              0: { buffer: uniform },
              1: { buffer: sourceBuffer },
              2: { buffer: ref },
              3: { buffer: sum },
              4: { buffer: mask },
              5: { buffer: covered },
              6: { buffer: result },
              7: { buffer: offsets },
              8: { buffer: excluded },
            },
            indices = which === 0 ? [0, 1, 2] : [0, 1, 2, 3, 4, 5, 7, 8],
            pipeline = pipelines[which],
            group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: indices.map((binding) => ({ binding, resource: bindings[binding] })),
            }),
            encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(Math.ceil(n / 256))
          pass.end()
          device.queue.submit([encoder.finish()])
          timings.dispatchMs += performance.now() - dispatchStart
        }
        await dispatch(0, referenceIndex)
        for (let s = 0; s < sources.length; s++) await dispatch(1, s)
        const pipeline = pipelines[2],
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 2, resource: { buffer: ref } },
              { binding: 3, resource: { buffer: sum } },
              { binding: 5, resource: { buffer: covered } },
              { binding: 6, resource: { buffer: result } },
            ],
          }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(Math.ceil(n / 256))
        pass.end()
        encoder.copyBufferToBuffer(result, 0, readback, 0, n * 16)
        encoder.copyBufferToBuffer(ref, 0, readback, n * 16, n * 16)
        encoder.copyBufferToBuffer(mask, 0, readback, n * 32, n * 4)
        device.queue.submit([encoder.finish()])
        const readbackStart = performance.now()
        await readback.mapAsync(GPUMapMode.READ)
        const bytes = Buffer.from(readback.getMappedRange()),
          masks = new Uint32Array(bytes.buffer, bytes.byteOffset + n * 32, n)
        timings.readbackMs += performance.now() - readbackStart
        const writeStart = performance.now()
        await accum.writeFile(bytes.subarray(0, n * 16))
        await reference.writeFile(bytes.subarray(n * 16, n * 32))
        for (let i = 0; i < n; i++) motion[top * width + i] ||= Number(masks[i] > 0)
        readback.unmap()
        timings.writingMs += performance.now() - writeStart
      }
      const oom = await device.popErrorScope(),
        validation = await device.popErrorScope()
      scopes = false
      if (oom || validation) throw new Error((oom ?? validation)!.message)
      return {
        adapter,
        peakBytes,
        kernel: 'prepared-bands' as const,
        referenceReused: false,
        batches: { rows, sourceBytes, ...timings },
      }
    } finally {
      await accum.close()
      await reference?.close()
    }
  } finally {
    if (scopes) await Promise.allSettled([device.popErrorScope(), device.popErrorScope()])
    for (const b of resources) b.destroy()
  }
}
