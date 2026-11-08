import { expect, test } from '@playwright/test'
import { HdrPresenter } from '../src/renderer/src/preview/hdr-presenter'
import { HdrEditQueue } from '../src/renderer/src/preview/hdr-edit-queue'
import {
  HDR_HISTOGRAM_WORDS,
  HDR_MASK_HISTOGRAM_WORDS,
} from '../src/renderer/src/preview/hdr-histogram'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'

test('a superseded masked histogram failure releases its readback without disabling newer healthy editing', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode')
  Object.defineProperty(globalThis, 'GPUMapMode', { configurable: true, value: { READ: 1 } })
  try {
    for (const change of ['current', 'new-key', 'new-source'] as const) {
      let ready!: () => void,
        release!: () => void,
        unmaps = 0,
        released = 0
      const started = new Promise<void>((resolve) => {
          ready = resolve
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve
        }),
        invalid = new Uint32Array(HDR_MASK_HISTOGRAM_WORDS),
        errors: string[] = [],
        sourceTexture = { createView: () => ({}) },
        readback = {
          mapAsync: async () => {
            ready()
            await gate
          },
          getMappedRange: () => invalid.buffer,
          unmap: () => {
            unmaps++
          },
        },
        controls = { ...neutralAdjustments, exposureEv: 1 },
        presentation = { mode: 'after', parameters: controls, target: SDR_TARGET },
        snapshot = {
          key: 'old-pixels',
          parameters: new Float32Array(48),
          presentation,
          masks: new Float32Array(4),
        },
        queue = new HdrEditQueue<typeof snapshot>(),
        pass = {
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => undefined,
          end: () => undefined,
        },
        device = {
          limits: {
            maxTextureArrayLayers: 256,
            maxStorageBufferBindingSize: 1024 ** 2,
            maxBufferSize: 1024 ** 2,
          },
          queue: { writeBuffer: () => undefined, submit: () => undefined },
          createBindGroup: () => ({}),
          createCommandEncoder: () => ({
            clearBuffer: () => undefined,
            beginComputePass: () => pass,
            copyBufferToBuffer: () => undefined,
            finish: () => ({}),
          }),
        }
      invalid[HDR_HISTOGRAM_WORDS] = 1
      queue.request(snapshot, 'interactive')
      // This harness controls only completion ownership; real shader output is covered by masks-gpu.
      const owner = Object.assign(Object.create(HdrPresenter.prototype), {
        histogramQueue: queue,
        abort: new AbortController(),
        frame: {},
        texture: sourceTexture,
        device,
        canvas: { width: 10, height: 10 },
        mode: 'after',
        target: SDR_TARGET,
        view: { parameters: controls },
        requestedStatisticsKey: snapshot.key,
        latestHistogram: snapshot,
        localHistogramMasks: { size: 16 },
        localHistogramBuffer: {},
        localHistogramReadback: readback,
        localMaskPipelines: { histogram: { getBindGroupLayout: () => ({}) } },
        localMaskPipelinesBases: false,
        presentationMemory: () => ({ accepted: true }),
        publishMemory: () => undefined,
        lost: (reason: string) => errors.push(reason),
        releaseHistogramActivity: () => {
          released++
        },
      }) as {
        runHistogram(): Promise<void>
        view: { parameters: typeof controls }
        requestedStatisticsKey: string
        latestHistogram: typeof snapshot
        texture: unknown
      }
      const work = owner.runHistogram()
      await started
      if (change === 'new-key') {
        owner.latestHistogram = { ...snapshot, key: 'new-healthy-pixels' }
        owner.requestedStatisticsKey = owner.latestHistogram.key
        queue.request(owner.latestHistogram, 'interactive')
        owner.runHistogram = async () => undefined
      } else if (change === 'new-source') {
        owner.texture = {}
        queue.invalidate()
      }
      release()
      await work
      expect(errors.length, change).toBe(change === 'current' ? 1 : 0)
      if (errors.length) expect(errors[0]).toContain('non-finite pixels')
      expect(unmaps).toBe(1)
      expect(released).toBe(change === 'new-key' ? 0 : 1)
      if (change === 'new-key') {
        const healthy = queue.take()
        expect(healthy?.value.key).toBe('new-healthy-pixels')
        queue.finish(healthy!)
      }
      queue.request({ ...snapshot, key: 'next-pixels' }, 'interactive')
      expect(queue.take()?.value.key).toBe('next-pixels')
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'GPUMapMode', previous)
    else Reflect.deleteProperty(globalThis, 'GPUMapMode')
  }
})
