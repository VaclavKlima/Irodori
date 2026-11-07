import { RawGpuRenderer } from './raw-renderer'
import { EXPORT_GPU_LIMIT_BYTES } from '../../shared/export-resources'
import {
  RESIZE_GPU_PARAMETER_BYTES,
  snapshotResizeGpuPlan,
  type ResizeGpuPlan,
} from '../../shared/export-resize-gpu'
import { exportResizeWgsl } from '../../shared/export-resize-wgsl'

type Renderer = Pick<RawGpuRenderer, 'mergeDevice' | 'close'>
export interface ResizeGpu {
  readonly adapter: string | undefined
  readonly bytes: number
  readonly allocatedBytes: number
  readonly peakCachedRows: number
  run(
    readRow: (index: number, signal: AbortSignal) => Promise<Float32Array>,
    onRow: (data: Float32Array, y: number) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>
  close(): Promise<void>
}

/** Bounded separable Lanczos3; only file I/O, coefficients and cache indices run on the host. */
export function createResizeGpu(
  plan: ResizeGpuPlan,
  maxGpuBytes = EXPORT_GPU_LIMIT_BYTES,
  makeRenderer: () => Renderer = () => new RawGpuRenderer(),
): ResizeGpu {
  if (process.versions.electron)
    throw new Error('GPU export resize requires the isolated Node worker.')
  const frozen = snapshotResizeGpuPlan(plan)
  if (
    !Number.isSafeInteger(maxGpuBytes) ||
    maxGpuBytes < 0 ||
    frozen.gpuBytes > Math.min(maxGpuBytes, EXPORT_GPU_LIMIT_BYTES)
  )
    throw new Error('GPU export resize exceeds the admitted GPU storage budget.')
  const buffers: GPUBuffer[] = []
  let renderer: Renderer | undefined,
    device: GPUDevice | undefined,
    adapter: string | undefined,
    pending: Promise<void> | undefined,
    closing: Promise<void> | undefined,
    initializing: Promise<void> | undefined,
    disposed = false,
    peakCachedRows = 0,
    uniform: GPUBuffer,
    input: GPUBuffer,
    cache: GPUBuffer,
    output: GPUBuffer,
    staging: GPUBuffer,
    horizontalTable: GPUBuffer,
    verticalTable: GPUBuffer,
    rowMap: GPUBuffer,
    horizontal: GPUComputePipeline,
    vertical: GPUComputePipeline,
    group: GPUBindGroup
  const initialize = (signal: AbortSignal) =>
    (initializing ??= (async () => {
      renderer = makeRenderer()
      const context = await renderer.mergeDevice()
      device = context.device
      adapter = context.adapter
      signal.throwIfAborted()
      if (
        device.limits.maxStorageBuffersPerShaderStage < 6 ||
        device.limits.maxComputeWorkgroupSizeX < 64 ||
        device.limits.maxComputeInvocationsPerWorkgroup < 64 ||
        Math.ceil((frozen.outWidth * frozen.channels) / 64) >
          device.limits.maxComputeWorkgroupsPerDimension
      )
        throw new Error('The GPU export resize exceeds the adapter compute limits.')
      const allocate = (size: number, usage: number) => {
        if (
          size > device!.limits.maxBufferSize ||
          ((usage & GPUBufferUsage.STORAGE) !== 0 &&
            size > device!.limits.maxStorageBufferBindingSize) ||
          ((usage & GPUBufferUsage.UNIFORM) !== 0 &&
            size > device!.limits.maxUniformBufferBindingSize)
        )
          throw new Error('The GPU export resize exceeds the adapter allocation limits.')
        const buffer = device!.createBuffer({ size, usage })
        buffers.push(buffer)
        return buffer
      }
      uniform = allocate(
        RESIZE_GPU_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      )
      input = allocate(frozen.inputRowBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      cache = allocate(frozen.horizontalCacheBytes, GPUBufferUsage.STORAGE)
      output = allocate(frozen.outputRowBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      staging = allocate(frozen.outputRowBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      horizontalTable = allocate(
        frozen.horizontalTaps.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      )
      verticalTable = allocate(
        frozen.verticalTaps.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      )
      rowMap = allocate(frozen.rowMapBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      const layout = device.createBindGroupLayout({
          entries: Array.from({ length: 7 }, (_, binding) => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: {
              type:
                binding === 0
                  ? ('uniform' as const)
                  : [1, 4, 5, 6].includes(binding)
                    ? ('read-only-storage' as const)
                    : ('storage' as const),
            },
          })),
        }),
        pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        module = device.createShaderModule({ code: exportResizeWgsl })
      const programs = await Promise.all(
        ['resizeHorizontal', 'resizeVertical'].map((entryPoint) =>
          device!.createComputePipelineAsync({
            layout: pipelineLayout,
            compute: { module, entryPoint },
          }),
        ),
      )
      horizontal = programs[0]
      vertical = programs[1]
      signal.throwIfAborted()
      group = device.createBindGroup({
        layout,
        entries: [uniform, input, cache, output, horizontalTable, verticalTable, rowMap].map(
          (buffer, binding) => ({ binding, resource: { buffer } }),
        ),
      })
      device.queue.writeBuffer(horizontalTable, 0, frozen.horizontalTaps)
      device.queue.writeBuffer(verticalTable, 0, frozen.verticalTaps)
    })())
  const parameters = (slot: number, y: number) =>
    new Uint32Array([
      frozen.width,
      frozen.outWidth,
      frozen.channels,
      slot,
      y,
      Number(frozen.width === frozen.outWidth),
      Number(frozen.height === frozen.outHeight),
      0,
    ])
  const dispatch = (pipeline: GPUComputePipeline, readback: boolean) => {
    const encoder = device!.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil((frozen.outWidth * frozen.channels) / 64))
    pass.end()
    if (readback) encoder.copyBufferToBuffer(output, 0, staging, 0, frozen.outputRowBytes)
    device!.queue.submit([encoder.finish()])
  }
  return {
    get adapter() {
      return adapter
    },
    bytes: frozen.gpuBytes,
    get allocatedBytes() {
      return buffers.reduce((sum, buffer) => sum + buffer.size, 0)
    },
    get peakCachedRows() {
      return peakCachedRows
    },
    run(readRow, onRow, signal) {
      if (disposed || pending)
        return Promise.reject(new Error('The GPU export resize owner is unavailable or busy.'))
      const work = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        const read = async (index: number) => {
          const value = await readRow(index, signal)
          signal.throwIfAborted()
          if (
            !(value instanceof Float32Array) ||
            !(value.buffer instanceof ArrayBuffer) ||
            value.byteLength !== frozen.inputRowBytes
          )
            throw new Error('Invalid GPU export resize source row.')
          for (const scalar of value)
            if (!Number.isFinite(scalar))
              throw new Error('Non-finite GPU export resize source row.')
          return new Float32Array(value)
        }
        if (frozen.identity) {
          for (let y = 0; y < frozen.height; y++) {
            signal.throwIfAborted()
            const row = await read(y)
            await onRow(row, y)
            signal.throwIfAborted()
          }
          return
        }
        const rows = new Map<number, number>(),
          free = Array.from({ length: frozen.maxRows }, (_, i) => i),
          slots = new Uint32Array(frozen.maxRows)
        for (let y = 0; y < frozen.outHeight; y++) {
          signal.throwIfAborted()
          const start = frozen.verticalTaps[y * 2],
            count = frozen.verticalTaps[y * 2 + 1],
            needed = new Set<number>()
          for (let j = 0; j < count; j++) needed.add(frozen.verticalTaps[start + j * 4])
          // The preceding output map has fenced all uses before any slot is recycled.
          for (const [index, slot] of rows)
            if (!needed.has(index)) {
              rows.delete(index)
              free.push(slot)
            }
          for (let j = 0; j < count; j++) {
            const index = frozen.verticalTaps[start + j * 4]
            let slot = rows.get(index)
            if (slot === undefined) {
              slot = free.pop()
              if (slot === undefined)
                throw new Error('The GPU export resize row cache exceeded its bound.')
              const row = await read(index)
              await initialize(signal)
              signal.throwIfAborted()
              device!.queue.writeBuffer(input, 0, row)
              device!.queue.writeBuffer(uniform, 0, parameters(slot, y))
              dispatch(horizontal, false)
              // Bound queue-owned upload copies even for an extreme one-pixel reduction.
              await device!.queue.onSubmittedWorkDone()
              signal.throwIfAborted()
              rows.set(index, slot)
              peakCachedRows = Math.max(peakCachedRows, rows.size)
            }
            slots[j] = slot
          }
          device!.queue.writeBuffer(rowMap, 0, slots)
          device!.queue.writeBuffer(uniform, 0, parameters(0, y))
          dispatch(vertical, true)
          await staging.mapAsync(GPUMapMode.READ, 0, frozen.outputRowBytes)
          let result: Float32Array
          try {
            signal.throwIfAborted()
            result = new Float32Array(staging.getMappedRange(0, frozen.outputRowBytes).slice(0))
          } finally {
            staging.unmap()
          }
          for (const scalar of result)
            if (!Number.isFinite(scalar))
              throw new Error('The GPU export resize returned non-finite output.')
          await onRow(result, y)
          signal.throwIfAborted()
        }
      })
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
        await initializing?.catch(() => undefined)
        await device?.queue.onSubmittedWorkDone().catch(() => undefined)
        for (const buffer of buffers) buffer.destroy()
        buffers.length = 0
        renderer?.close()
      })()
      return closing
    },
  }
}
