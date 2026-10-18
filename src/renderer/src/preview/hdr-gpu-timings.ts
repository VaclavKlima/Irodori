/// <reference types="@webgpu/types" />

type Stage = 'tile' | 'offscreen' | 'blit'
export interface HdrGpuTimingFrame {
  readonly inputSerial: number
  readonly epoch: number
  readonly sourceIdentity: string
  readonly passes: { stage: Stage; index: number }[]
  droppedPasses: number
}
export interface HdrGpuFrameTimings {
  inputSerial: number
  epoch: number
  sourceIdentity: string
  tileGpuMs: number
  offscreenGpuMs: number
  blitGpuMs: number
  measuredPasses: number
  droppedPasses: number
  complete: number
  imagePresented: number
}

const MAX_PASSES = 128
// Timestamp queries and the two owned buffers each retain eight bytes per query.
export const HDR_GPU_TIMING_BYTES = MAX_PASSES * 2 * 8 * 3

/** Optional observations never wait in the image path or retain more than one readback. */
export class HdrGpuTimings {
  private query?: GPUQuerySet
  private resolve?: GPUBuffer
  private readback?: GPUBuffer
  private active?: HdrGpuTimingFrame
  private disposed = false
  private enabled = false
  readonly ready: Promise<boolean>

  constructor(
    private device: GPUDevice,
    private publish: (result: HdrGpuFrameTimings) => void,
    private failed: (reason: string) => void,
    private capacity = MAX_PASSES,
  ) {
    this.ready = this.isolated(() => {
      this.query = device.createQuerySet({ type: 'timestamp', count: capacity * 2 })
      this.resolve = device.createBuffer({
        size: capacity * 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      })
      this.readback = device.createBuffer({
        size: capacity * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
    }).then(
      () => {
        if (this.disposed) return false
        this.enabled = true
        return true
      },
      (error) => {
        this.disable(error)
        return false
      },
    )
  }

  /** Pop every owned scope synchronously before another image or analysis operation can run. */
  private isolated<T>(operation: () => T): Promise<T> {
    let opened = 0,
      result: T | undefined,
      failure: { error: unknown } | undefined
    try {
      for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
        this.device.pushErrorScope(filter)
        opened++
      }
      result = operation()
    } catch (error) {
      failure = { error }
    }
    const checks: Promise<GPUError | null>[] = []
    while (opened > 0) {
      opened--
      try {
        checks.push(this.device.popErrorScope())
      } catch (error) {
        failure ??= { error }
      }
    }
    return Promise.all(checks).then((errors) => {
      if (failure) throw failure.error
      const error = errors.find((entry) => entry !== null)
      if (error) throw new Error(`${error.constructor.name}: ${error.message}`)
      return result as T
    })
  }

  private disable(error: unknown) {
    if (this.disposed) return
    this.dispose()
    this.failed(String(error))
  }

  begin(inputSerial: number, epoch: number, sourceIdentity: string) {
    if (this.active || this.disposed || !this.enabled) return undefined
    this.active = { inputSerial, epoch, sourceIdentity, passes: [], droppedPasses: 0 }
    return this.active
  }

  writes(frame: HdrGpuTimingFrame | undefined, stage: Stage) {
    if (!frame || frame !== this.active || this.disposed) return undefined
    if (frame.passes.length === this.capacity) {
      frame.droppedPasses++
      return undefined
    }
    const index = frame.passes.length * 2
    frame.passes.push({ stage, index })
    return {
      querySet: this.query!,
      beginningOfPassWriteIndex: index,
      endOfPassWriteIndex: index + 1,
    }
  }

  finish(frame: HdrGpuTimingFrame | undefined, imagePresented: boolean) {
    if (!frame || frame !== this.active || this.disposed) return
    if (!frame.passes.length) {
      this.active = undefined
      return
    }
    void this.isolated(() => {
      const byteLength = frame.passes.length * 16
      const encoder = this.device.createCommandEncoder()
      encoder.resolveQuerySet(this.query!, 0, frame.passes.length * 2, this.resolve!, 0)
      encoder.copyBufferToBuffer(this.resolve!, 0, this.readback!, 0, byteLength)
      this.device.queue.submit([encoder.finish()])
      return byteLength
    }).then(
      (byteLength) => {
        if (!this.disposed) void this.read(frame, byteLength, imagePresented)
      },
      (error) => this.disable(error),
    )
  }

  private async read(frame: HdrGpuTimingFrame, byteLength: number, imagePresented: boolean) {
    let mapped = false
    try {
      const { mapping } = await this.isolated(() => {
        const mapping = this.readback!.mapAsync(GPUMapMode.READ, 0, byteLength)
        // Scope results and mapping can reject independently; own both immediately.
        void mapping.catch(() => undefined)
        return { mapping }
      })
      await mapping
      mapped = true
      if (this.disposed) return
      const values = new BigUint64Array(this.readback!.getMappedRange(0, byteLength))
      const result: HdrGpuFrameTimings = {
        inputSerial: frame.inputSerial,
        epoch: frame.epoch,
        sourceIdentity: frame.sourceIdentity,
        tileGpuMs: 0,
        offscreenGpuMs: 0,
        blitGpuMs: 0,
        measuredPasses: frame.passes.length,
        droppedPasses: frame.droppedPasses,
        complete: Number(!frame.droppedPasses),
        imagePresented: Number(imagePresented),
      }
      for (const { stage, index } of frame.passes) {
        const elapsed = Number(values[index + 1] - values[index]) / 1e6
        if (elapsed < 0 || !Number.isFinite(elapsed)) result.complete = 0
        else result[`${stage}GpuMs`] += elapsed
      }
      this.publish(result)
    } catch (error) {
      this.disable(error)
    } finally {
      if (mapped && !this.disposed) this.readback!.unmap()
      if (this.active === frame) this.active = undefined
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.enabled = false
    this.active = undefined
    this.query?.destroy()
    this.resolve?.destroy()
    this.readback?.destroy()
  }
}
