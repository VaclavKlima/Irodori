import { expect, test } from '@playwright/test'
import { gpuOutput } from '../src/main/merge/gpu-output'
import { ACES_DATA_BYTES } from '../src/shared/aces-data'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

class OutputBuffer {
  readonly data: ArrayBuffer
  pending?: ReturnType<typeof deferred<void>>
  mapped = false
  destroyed = 0
  ranges = 0
  readonly mapRanges: { offset: number; size: number }[] = []
  readonly readRanges: { offset: number; size: number }[] = []
  private views: ArrayBuffer[] = []
  constructor(
    readonly size: number,
    readonly label: string,
  ) {
    this.data = new ArrayBuffer(size)
  }
  mapAsync(_mode: number, offset = 0, size = this.size - offset) {
    if (this.pending || this.mapped || this.destroyed) throw new Error('Invalid map ownership.')
    this.mapRanges.push({ offset, size })
    this.pending = deferred<void>()
    return this.pending.promise
  }
  getMappedRange(offset = 0, size = this.size - offset) {
    if (!this.mapped) throw new Error('Readback is not mapped.')
    const mapped = this.mapRanges.at(-1)!
    if (offset < mapped.offset || offset + size > mapped.offset + mapped.size)
      throw new Error('Readback exceeds the mapped range.')
    this.ranges++
    this.readRanges.push({ offset, size })
    const view = this.data.slice(offset, offset + size)
    this.views.push(view)
    return view
  }
  complete() {
    const pending = this.pending!
    this.pending = undefined
    this.mapped = true
    pending.resolve()
  }
  unmap() {
    this.pending?.reject(new Error('Mapping cancelled.'))
    this.pending = undefined
    this.mapped = false
    // Owned returned bytes must survive invalidation and reuse of this allocation.
    for (const view of this.views) new Uint8Array(view).fill(0xcd)
    this.views = []
    new Uint8Array(this.data).fill(0xcd)
  }
  destroy() {
    if (this.pending || this.mapped) throw new Error('Destroyed a live mapping.')
    this.destroyed++
  }
}

class OutputQuery {
  readonly values = new BigUint64Array([1000000n, 3500000n])
  destroyed = 0
  destroy() {
    this.destroyed++
  }
}

/** Models ownership and queue order only; the native GPU suite checks pixel mathematics. */
class OutputDevice {
  readonly buffers: OutputBuffer[] = []
  readonly queries: OutputQuery[] = []
  readonly features = new Set<GPUFeatureName>()
  readonly lost = deferred<GPUDeviceLostInfo>()
  readonly limits = {
    maxStorageBufferBindingSize: 1024 ** 3,
    maxBufferSize: 1024 ** 3,
    maxComputeWorkgroupsPerDimension: 65535,
  }
  readonly submissions: (() => void)[][] = []
  readonly scopes: GPUErrorFilter[] = []
  readonly queue = {
    writeBuffer: (buffer: OutputBuffer, offset: number, data: ArrayBufferView) => {
      new Uint8Array(buffer.data).set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        offset,
      )
    },
    submit: (commands: (() => void)[][]) => {
      this.submissions.push(...commands)
      if (this.submissionError) this.scopeError = this.submissionError
    },
    onSubmittedWorkDone: () => this.closeGate?.promise ?? Promise.resolve(),
  }
  closeGate?: ReturnType<typeof deferred<void>>
  failBuffer = 0
  failQuery = 0
  submissionError?: string
  private scopeError?: string
  private executed = 0
  createBuffer({ size, label = '' }: GPUBufferDescriptor) {
    if (this.failBuffer === this.buffers.length + 1) throw new Error('Buffer allocation failed.')
    const buffer = new OutputBuffer(Number(size), label)
    this.buffers.push(buffer)
    return buffer
  }
  createQuerySet() {
    if (this.failQuery === this.queries.length + 1) throw new Error('Query allocation failed.')
    const query = new OutputQuery()
    this.queries.push(query)
    return query
  }
  pushErrorScope(filter: GPUErrorFilter) {
    this.scopes.push(filter)
  }
  popErrorScope() {
    if (!this.scopes.pop()) throw new Error('Unowned scope.')
    const message = this.scopeError
    this.scopeError = undefined
    return Promise.resolve(message ? ({ message } as GPUError) : null)
  }
  createShaderModule() {
    return { getCompilationInfo: async () => ({ messages: [] }) }
  }
  async createComputePipelineAsync() {
    return { getBindGroupLayout: () => ({}) }
  }
  createBindGroup({ entries }: GPUBindGroupDescriptor) {
    return new Map(
      Array.from(entries, (entry) => [
        entry.binding,
        (entry.resource as GPUBufferBinding).buffer as unknown as OutputBuffer,
      ]),
    )
  }
  createCommandEncoder() {
    const commands: (() => void)[] = []
    return {
      beginComputePass: () => {
        let group!: Map<number, OutputBuffer>
        return {
          setPipeline() {},
          setBindGroup: (_index: number, value: Map<number, OutputBuffer>) => {
            group = value
          },
          dispatchWorkgroups: () => {
            commands.push(() => {
              const count = new Float32Array(group.get(0)!.data)[0],
                source = new Float32Array(group.get(2)!.data),
                output = new Uint8Array(group.get(3)!.data)
              for (let i = 0; i < count * 4; i++) output[i] = Math.round(source[i] * 16)
            })
          },
          end() {},
        }
      },
      copyBufferToBuffer: (
        source: OutputBuffer,
        sourceOffset: number,
        target: OutputBuffer,
        targetOffset: number,
        bytes: number,
      ) => {
        commands.push(() => {
          new Uint8Array(target.data).set(
            new Uint8Array(source.data, sourceOffset, bytes),
            targetOffset,
          )
        })
      },
      resolveQuerySet: (
        query: OutputQuery,
        _first: number,
        _count: number,
        target: OutputBuffer,
      ) => {
        commands.push(() => new BigUint64Array(target.data).set(query.values))
      },
      finish: () => commands,
    }
  }
  staging(slot: number) {
    return this.buffers.find((buffer) => buffer.label === `Luma merge output slot ${slot} staging`)!
  }
  complete(slot: number) {
    // GPU commands remain ordered even when host map callbacks are delivered later.
    while (this.executed < this.submissions.length)
      for (const command of this.submissions[this.executed++]) command()
    this.staging(slot).complete()
  }
}

function renderer(device: OutputDevice) {
  // Keep prototype methods and the independently controlled device-loss promise.
  return {
    mergeDevice: async () => ({
      device: new Proxy(device, {
        get(target, key) {
          if (key === 'lost') return target.lost.promise
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as unknown as GPUDevice,
      adapter: 'ownership fixture',
    }),
  }
}

async function gpuGlobals(work: () => Promise<void>) {
  const globals = {
      GPUBufferUsage: {
        MAP_READ: 1,
        COPY_SRC: 4,
        COPY_DST: 8,
        UNIFORM: 64,
        STORAGE: 128,
        QUERY_RESOLVE: 512,
      },
      GPUMapMode: { READ: 1 },
    },
    previous = Object.keys(globals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    )
  try {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    await work()
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
  }
}

const pixels = () => new Float32Array([1, 2, 3, 1, 4, 5, 6, 0])
const expected = (values: Float32Array) =>
  Buffer.from(Array.from(values, (value) => Math.round(value * 16)))

test('two output slots retain independent uploads and owned bytes until explicit consumption', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice(),
      converter = await gpuOutput(renderer(device), 8, { slots: 2 }),
      first = pixels(),
      second = pixels().subarray(0, 4),
      firstExpected = Buffer.concat([expected(first), expected(second)]),
      a = converter.submit(first, second),
      b = converter.submit(second)
    try {
      expect(device.scopes).toHaveLength(0)
      first.fill(99)
      second.fill(98)
      expect(() => converter.submit(pixels())).toThrow('occupied')
      device.complete(1)
      const bytesB = await b.result
      expect(bytesB).toEqual(firstExpected.subarray(8))
      expect(() => converter.submit(pixels())).toThrow('occupied')
      device.complete(0)
      const bytesA = await a.result
      expect(bytesA).toEqual(firstExpected)
      a.release()
      const c = converter.submit(pixels())
      a.release()
      expect(() => converter.submit(pixels())).toThrow('occupied')
      c.release()
      expect(() => converter.submit(pixels())).toThrow('occupied')
      device.complete(0)
      expect(await c.result).toEqual(expected(pixels()))
      expect(bytesA).toEqual(firstExpected)
      expect(bytesB).toEqual(firstExpected.subarray(8))
      b.release()
      expect(converter.timings).toMatchObject({
        slots: 2,
        pendingPeak: 2,
        batches: 3,
        pairedBatches: 1,
        images: 4,
      })
      expect(device.staging(0).ranges).toBe(2)
      expect(device.staging(1).ranges).toBe(1)
      expect(device.staging(0).mapRanges).toEqual([
        { offset: 0, size: 12 },
        { offset: 0, size: 8 },
      ])
      expect(device.staging(1).mapRanges).toEqual([{ offset: 0, size: 4 }])
      expect(device.staging(0).readRanges).toEqual(device.staging(0).mapRanges)
    } finally {
      await converter.close()
    }
    expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
  })
})

test('sequential compatibility keeps malformed or oversized input outside the active slot', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice(),
      converter = await gpuOutput(renderer(device), 2)
    try {
      expect(converter.timings.timestampStatus).toBe('disabled')
      expect(() => converter.submit(new Float32Array(3))).toThrow('complete RGBA')
      expect(() => converter.submit(pixels(), new Float32Array(0))).toThrow('complete RGBA')
      expect(() => converter.submit(pixels(), pixels())).toThrow('exceeds its allocation')
      const result = converter.convert(pixels())
      await expect(converter.convert(pixels())).rejects.toThrow('occupied')
      device.complete(0)
      expect(await result).toEqual(expected(pixels()))
      expect(converter.timings.pendingPeak).toBe(1)
    } finally {
      await converter.close()
    }
    expect(() => converter.submit(pixels())).toThrow('closed')
  })
})

test('an output failure rejects both retained strips and drains mapping before resource destruction', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice(),
      converter = await gpuOutput(renderer(device), 2, { slots: 2 }),
      a = converter.submit(pixels()),
      b = converter.submit(pixels())
    device.staging(0).pending!.reject(new Error('Injected readback failure.'))
    await expect(a.result).rejects.toThrow('Injected readback failure')
    await expect(b.result).rejects.toThrow()
    expect(() => converter.submit(pixels())).toThrow('Injected readback failure')
    await converter.close()
    a.release()
    b.release()
    expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
    expect(device.buffers.every((buffer) => !buffer.pending && !buffer.mapped)).toBe(true)
  })
})

test('cancellation stops admission and awaits the GPU queue before idempotent close destroys resources', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice(),
      controller = new AbortController(),
      converter = await gpuOutput(renderer(device), 2, { slots: 2, signal: controller.signal }),
      a = converter.submit(pixels()),
      b = converter.submit(pixels())
    device.closeGate = deferred<void>()
    controller.abort(new Error('Cancelled merge.'))
    const closing = converter.close()
    await expect(a.result).rejects.toThrow()
    await expect(b.result).rejects.toThrow()
    expect(() => converter.submit(pixels())).toThrow('Cancelled merge')
    expect(device.buffers.every((buffer) => buffer.destroyed === 0)).toBe(true)
    device.closeGate.resolve()
    await closing
    await converter.close()
    expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
  })
})

test('device loss and scoped GPU errors settle retained results without publishing bytes', async () => {
  await gpuGlobals(async () => {
    for (const mode of ['device-loss', 'validation'] as const) {
      const device = new OutputDevice(),
        converter = await gpuOutput(renderer(device), 2, { slots: 2 })
      if (mode === 'validation') device.submissionError = 'Injected output validation failure.'
      const a = converter.submit(pixels()),
        b = converter.submit(pixels())
      if (mode === 'device-loss')
        device.lost.resolve({ message: 'Injected loss.', reason: 'unknown' } as GPUDeviceLostInfo)
      await expect(a.result).rejects.toThrow(
        mode === 'device-loss' ? 'device lost' : 'validation failure',
      )
      await expect(b.result).rejects.toThrow()
      await converter.close()
      expect(converter.timings.batches).toBe(0)
      expect(device.scopes).toHaveLength(0)
      expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
    }
  })
})

test('optional device timestamps measure compute separately using one mapped range per slot', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice()
    device.features.add('timestamp-query')
    const converter = await gpuOutput(renderer(device), 3, { slots: 2, timestamps: true }),
      a = converter.submit(pixels()),
      b = converter.submit(pixels().subarray(0, 4))
    try {
      device.complete(0)
      device.complete(1)
      expect(await a.result).toEqual(expected(pixels()))
      expect(await b.result).toEqual(expected(pixels()).subarray(0, 4))
      a.release()
      b.release()
      expect(converter.timings).toMatchObject({
        timestampStatus: 'available',
        gpuMs: 5,
        gpuBatches: 2,
        timestampErrors: 0,
      })
      expect(converter.peakBytes).toBe(ACES_DATA_BYTES + 2 * (176 + 3 * 20 + 32 + 32))
      expect(device.staging(0).ranges).toBe(1)
      expect(device.staging(1).ranges).toBe(1)
      expect(device.staging(0).mapRanges).toEqual([{ offset: 0, size: 32 }])
    } finally {
      await converter.close()
    }
    expect(device.queries.every((query) => query.destroyed === 1)).toBe(true)
  })
})

test('optional timestamp allocation failure preserves image conversion and cleans partial diagnostics', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice()
    device.features.add('timestamp-query')
    device.failQuery = 2
    const converter = await gpuOutput(renderer(device), 2, { slots: 2, timestamps: true })
    try {
      expect(converter.timings).toMatchObject({
        timestampStatus: 'error',
        timestampErrors: 1,
        gpuBatches: 0,
      })
      expect(device.queries[0].destroyed).toBe(1)
      const result = converter.convert(pixels())
      device.complete(0)
      expect(await result).toEqual(expected(pixels()))
    } finally {
      await converter.close()
    }
    expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
    expect(device.queries.every((query) => query.destroyed === 1)).toBe(true)
    const unsupported = new OutputDevice(),
      fallback = await gpuOutput(renderer(unsupported), 2, { timestamps: true })
    expect(fallback.timings.timestampStatus).toBe('unavailable')
    await fallback.close()
  })
})

test('capacity and device bounds reject before allocation and partial setup always releases resources', async () => {
  await gpuGlobals(async () => {
    const device = new OutputDevice()
    for (const capacity of [0, -1, 1.5, Number.NaN])
      await expect(gpuOutput(renderer(device), capacity)).rejects.toThrow('positive integer')
    await expect(gpuOutput(renderer(device), 2 ** 26, { slots: 2 })).rejects.toThrow('1 GiB')
    device.limits.maxStorageBufferBindingSize = 8
    await expect(gpuOutput(renderer(device), 2)).rejects.toThrow('device limits')
    expect(device.buffers).toHaveLength(0)
    device.limits.maxStorageBufferBindingSize = 1024 ** 3
    device.failBuffer = 3
    await expect(gpuOutput(renderer(device), 2, { slots: 2 })).rejects.toThrow(
      'Buffer allocation failed',
    )
    expect(device.buffers).toHaveLength(2)
    expect(device.buffers.every((buffer) => buffer.destroyed === 1)).toBe(true)
    expect(device.scopes).toHaveLength(0)
  })
})
