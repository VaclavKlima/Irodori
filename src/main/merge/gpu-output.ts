import { displayRenderingWgsl } from '../../shared/display-rendering-wgsl'
import { prepareDisplayRendering } from '../../shared/display-rendering'
import { packAces, ACES_DATA_BYTES } from '../../shared/aces-data'
import { SDR_TARGET } from '../../shared/hdr'
import type { RawGpuRenderer } from '../gpu/raw-renderer'

export interface GpuOutputOptions {
  slots?: 1 | 2
  timestamps?: boolean
  signal?: AbortSignal
}

export interface GpuOutputTicket {
  /** An owned RGBA8 copy, independent of the mapped GPU allocation. */
  readonly result: Promise<Buffer>
  /** Release only after consuming the result or completing CPU fallback. */
  release(): void
}

interface Slot {
  uniform: GPUBuffer
  input: GPUBuffer
  output: GPUBuffer
  staging: GPUBuffer
  group?: GPUBindGroup
  values: Float32Array<ArrayBuffer>
  query?: GPUQuerySet
  resolve?: GPUBuffer
  held: boolean
  released: boolean
  settled: boolean
  mapping: boolean
  map?: Promise<void>
  checks?: Promise<void>
  task?: Promise<Buffer>
}

type TimestampStatus = 'disabled' | 'unavailable' | 'available' | 'error'

/** All scope ownership ends synchronously, before another submission can start. */
function scoped<T>(device: GPUDevice, operation: () => T) {
  let opened = 0,
    value!: T,
    failure: { error: unknown } | undefined
  try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
      device.pushErrorScope(filter)
      opened++
    }
    value = operation()
  } catch (error) {
    failure = { error }
  }
  const checks: Promise<GPUError | null>[] = []
  while (opened) {
    opened--
    try {
      checks.push(device.popErrorScope())
    } catch (error) {
      failure ??= { error }
    }
  }
  const checked = Promise.all(checks).then((errors) => {
    const error = errors.find((entry) => entry !== null)
    if (error) throw new Error(`${error.constructor.name}: ${error.message}`)
  })
  // A queued result may be awaited only after the following strip is prepared.
  void checked.catch(() => undefined)
  if (failure) throw failure.error
  return { value, checked }
}

/** The same Float32 SDR conversion as HDR presentation, with one or two bounded slots. */
export async function gpuOutput(
  gpu: Pick<RawGpuRenderer, 'mergeDevice'>,
  capacity: number,
  options: GpuOutputOptions = {},
) {
  const start = performance.now(),
    slotsCount = options.slots ?? 1
  if (!Number.isSafeInteger(capacity) || capacity <= 0)
    throw new Error('Output capacity must be a positive integer.')
  if (slotsCount !== 1 && slotsCount !== 2) throw new Error('Output requires one or two slots.')
  options.signal?.throwIfAborted()
  const { device } = await gpu.mergeDevice()
  options.signal?.throwIfAborted()
  const timestamps = !!options.timestamps && device.features.has('timestamp-query'),
    timestampOffset = Math.ceil((capacity * 4) / 8) * 8,
    stagingBytes = timestamps ? timestampOffset + 16 : capacity * 4,
    requiredBytes = ACES_DATA_BYTES + slotsCount * (176 + capacity * 20 + stagingBytes),
    resources: { resource: GPUBuffer | GPUQuerySet; bytes: number }[] = [],
    slots: Slot[] = []
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes + (timestamps ? slotsCount * 32 : 0) > 1024 ** 3
  )
    throw new Error('Merge exceeds the 1 GiB GPU allocation limit.')
  if (
    capacity * 16 > device.limits.maxStorageBufferBindingSize ||
    ACES_DATA_BYTES > device.limits.maxStorageBufferBindingSize ||
    Math.max(capacity * 16, stagingBytes, ACES_DATA_BYTES) > device.limits.maxBufferSize ||
    Math.ceil(capacity / 256) > device.limits.maxComputeWorkgroupsPerDimension
  )
    throw new Error('Output tile exceeds GPU device limits.')
  const timings = {
    setupMs: 0,
    uploadMs: 0,
    dispatchMs: 0,
    // Completion/map wait includes GPU execution and host scheduling; gpuMs is device time.
    readbackMs: 0,
    copyingMs: 0,
    batches: 0,
    pairedBatches: 0,
    images: 0,
    slots: slotsCount,
    pendingPeak: 0,
    timestampStatus: (!options.timestamps
      ? 'disabled'
      : timestamps
        ? 'available'
        : 'unavailable') as TimestampStatus,
    gpuMs: 0,
    gpuBatches: 0,
    timestampErrors: 0,
  }
  let allocatedBytes = 0,
    peakBytes = 0,
    stopped: { error: unknown } | undefined,
    closing: Promise<void> | undefined
  const own = <T extends GPUBuffer | GPUQuerySet>(resource: T, bytes: number) => {
    resources.push({ resource, bytes })
    allocatedBytes += bytes
    peakBytes = Math.max(peakBytes, allocatedBytes)
    return resource
  }
  const buffer = (size: number, usage: number, label: string) =>
    own(device.createBuffer({ size, usage, label }), size)
  const destroyFrom = (first = 0) => {
    for (const { resource, bytes } of resources.splice(first)) {
      resource.destroy()
      allocatedBytes -= bytes
    }
  }
  const unmap = (slot: Slot) => {
    if (!slot.mapping) return
    slot.mapping = false
    slot.staging.unmap()
  }
  const stop = (error: unknown) => {
    stopped ??= { error }
    // unmap cancels pending mapping without destroying a resource still in use.
    for (const slot of slots) unmap(slot)
    return stopped.error
  }
  const throwIfStopped = () => {
    if (stopped) throw stopped.error
  }
  const abort = () => void close(options.signal!.reason).catch(() => undefined)
  const close = (reason: unknown = new Error('GPU output is closed.')): Promise<void> => {
    if (closing) return closing
    options.signal?.removeEventListener('abort', abort)
    stop(reason)
    closing = (async () => {
      await Promise.allSettled(slots.flatMap((slot) => [slot.task, slot.map, slot.checks]))
      // A cancelled map can reject before its submitted commands finish.
      // Drain the queue as well before destroying any owned GPU allocation.
      await device.queue.onSubmittedWorkDone().catch(() => undefined)
      destroyFrom()
    })()
    return closing
  }
  try {
    const setup = scoped(device, () => {
      const tables = buffer(
        ACES_DATA_BYTES,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        'Luma merge output tables',
      )
      device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(SDR_TARGET)))
      for (let i = 0; i < slotsCount; i++) {
        const label = `Luma merge output slot ${i}`,
          uniform = buffer(
            176,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            `${label} uniform`,
          ),
          input = buffer(
            capacity * 16,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            `${label} input`,
          ),
          output = buffer(
            capacity * 4,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            `${label} output`,
          ),
          staging = buffer(
            stagingBytes,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            `${label} staging`,
          ),
          values = new Float32Array(44)
        values[14] = 1
        device.queue.writeBuffer(uniform, 0, values)
        slots.push({
          uniform,
          input,
          output,
          staging,
          values,
          held: false,
          released: false,
          settled: true,
          mapping: false,
        })
      }
      return {
        tables,
        module: device.createShaderModule({
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
        }),
      }
    })
    await setup.checked
    options.signal?.throwIfAborted()
    const { tables, module } = setup.value,
      errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
    options.signal?.throwIfAborted()
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'convert' },
    })
    options.signal?.throwIfAborted()
    const groups = scoped(device, () => {
      for (const slot of slots)
        slot.group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: slot.uniform } },
            { binding: 2, resource: { buffer: slot.input } },
            { binding: 3, resource: { buffer: slot.output } },
            { binding: 4, resource: { buffer: tables } },
          ],
        })
    })
    await groups.checked
    if (timestamps) {
      const first = resources.length
      try {
        const queries = scoped(device, () => {
          for (const slot of slots) {
            slot.query = own(device.createQuerySet({ type: 'timestamp', count: 2 }), 16)
            slot.resolve = buffer(
              16,
              GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              'Luma merge output timestamp resolve',
            )
          }
        })
        await queries.checked
      } catch {
        destroyFrom(first)
        for (const slot of slots) {
          slot.query = undefined
          slot.resolve = undefined
        }
        timings.timestampStatus = 'error'
        timings.timestampErrors++
      }
    }
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', abort, { once: true })
    void device.lost.then((info) => {
      if (!stopped) stop(new Error(`GPU output device lost: ${info.message}`))
    })
    timings.setupMs = performance.now() - start
    const submit = (
      pixels: Float32Array<ArrayBuffer>,
      following?: Float32Array<ArrayBuffer>,
    ): GpuOutputTicket => {
      throwIfStopped()
      const count = (pixels.length + (following?.length ?? 0)) / 4
      if (
        pixels.length % 4 ||
        !pixels.length ||
        (following && (!following.length || following.length % 4))
      )
        throw new Error('Output input must contain complete RGBA pixels.')
      if (count > capacity) throw new Error('Output tile exceeds its allocation.')
      const slot = slots.find((entry) => !entry.held)
      if (!slot) throw new Error('All GPU output slots are occupied.')
      slot.held = true
      slot.released = false
      slot.settled = false
      timings.pendingPeak = Math.max(
        timings.pendingPeak,
        slots.filter((entry) => entry.held).length,
      )
      let released = false
      const release = () => {
        if (released) return
        released = true
        slot.released = true
        if (slot.settled) slot.held = false
      }
      try {
        const upload = performance.now()
        const submitted = scoped(device, () => {
          slot.values[0] = count
          // writeBuffer copies both borrowed views synchronously. The caller retains
          // immutable linear strips until release so CPU fallback can replay them.
          device.queue.writeBuffer(slot.uniform, 0, slot.values)
          device.queue.writeBuffer(slot.input, 0, pixels)
          if (following) device.queue.writeBuffer(slot.input, pixels.byteLength, following)
          timings.uploadMs += performance.now() - upload
          const dispatch = performance.now(),
            measured = timings.timestampStatus === 'available',
            encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass({
              timestampWrites: measured
                ? { querySet: slot.query!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
                : undefined,
            })
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, slot.group!)
          pass.dispatchWorkgroups(Math.ceil(count / 256))
          pass.end()
          encoder.copyBufferToBuffer(slot.output, 0, slot.staging, 0, count * 4)
          if (measured) {
            encoder.resolveQuerySet(slot.query!, 0, 2, slot.resolve!, 0)
            encoder.copyBufferToBuffer(slot.resolve!, 0, slot.staging, timestampOffset, 16)
          }
          device.queue.submit([encoder.finish()])
          timings.dispatchMs += performance.now() - dispatch
          const readback = performance.now(),
            readbackBytes = measured ? timestampOffset + 16 : count * 4
          slot.mapping = true
          slot.map = slot.staging.mapAsync(GPUMapMode.READ, 0, readbackBytes).then(() => {
            timings.readbackMs += performance.now() - readback
          })
          void slot.map.catch(() => undefined)
          return { measured, readbackBytes }
        })
        slot.checks = submitted.checked
        const task = (async () => {
          try {
            await Promise.all([slot.map, slot.checks])
            throwIfStopped()
            const copying = performance.now(),
              mapped = slot.staging.getMappedRange(0, submitted.value.readbackBytes),
              bytes = Buffer.from(new Uint8Array(mapped, 0, count * 4))
            if (submitted.value.measured) {
              const values = new BigUint64Array(mapped, timestampOffset, 2),
                elapsed = Number(values[1] - values[0]) / 1e6
              if (elapsed < 0 || !Number.isFinite(elapsed)) {
                timings.timestampStatus = 'error'
                timings.timestampErrors++
              } else {
                timings.gpuMs += elapsed
                timings.gpuBatches++
              }
            }
            timings.copyingMs += performance.now() - copying
            timings.batches++
            timings.images += following ? 2 : 1
            timings.pairedBatches += Number(!!following)
            return bytes
          } catch (error) {
            throw stop(error)
          } finally {
            unmap(slot)
            slot.settled = true
            if (slot.released) slot.held = false
          }
        })()
        slot.task = task
        void task.catch(() => undefined)
        return { result: task, release }
      } catch (error) {
        stop(error)
        slot.settled = true
        release()
        throw error
      }
    }
    return {
      peakBytes,
      capacity,
      timings,
      submit,
      async convert(pixels: Float32Array<ArrayBuffer>, following?: Float32Array<ArrayBuffer>) {
        const ticket = submit(pixels, following)
        try {
          return await ticket.result
        } finally {
          ticket.release()
        }
      },
      close,
    }
  } catch (error) {
    await close(error)
    throw error
  }
}
