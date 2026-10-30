import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  neutralNoiseReduction,
  neutralDetailSharpening,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../src/shared/spatial-detail'
import {
  packDetailTile,
  DETAIL_GPU_PARAMETER_BYTES,
  spatialDetailWgsl,
} from '../src/shared/spatial-detail-wgsl'
import type { DetailReference } from './spatial-detail.helpers'

test('tiny real GPU NLM and protected sharpening agree with every independent Decimal80 case and preserve raw alpha words', async () => {
  const reference = JSON.parse(
      await readFile('tests/fixtures/detail-reference.json', 'utf8'),
    ) as DetailReference,
    gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  let maximum = 0,
    checked = 0,
    worst: unknown
  try {
    const { device } = await gpu.mergeDevice(),
      allocate = (size: number, usage: number) => {
        const b = device.createBuffer({ size, usage })
        buffers.push(b)
        return b
      },
      module = device.createShaderModule({ code: spatialDetailWgsl }),
      pipelines = await Promise.all(
        ['prepareDetailFeatures', 'denoiseDetail', 'sharpenDetail'].map((entryPoint) =>
          device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } }),
        ),
      ),
      uniformNoise = allocate(
        DETAIL_GPU_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      ),
      uniformSharp = allocate(
        DETAIL_GPU_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      ),
      input = allocate(
        9 * 9 * 16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      ),
      features = allocate(9 * 9 * 16, GPUBufferUsage.STORAGE),
      first = allocate(9 * 9 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      second = allocate(9 * 9 * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      staging = allocate(9 * 9 * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      group = (
        pipeline: GPUComputePipeline,
        uniform: GPUBuffer,
        source: GPUBuffer,
        output?: GPUBuffer,
      ) =>
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: source } },
            { binding: 2, resource: { buffer: features } },
            ...(output ? [{ binding: 3, resource: { buffer: output } }] : []),
          ],
        })
    const prepareN = group(pipelines[0], uniformNoise, input),
      renderN = group(pipelines[1], uniformNoise, input, first),
      prepareS = group(pipelines[0], uniformSharp, input),
      renderS = group(pipelines[2], uniformSharp, input, first),
      prepareCombined = group(pipelines[0], uniformSharp, first),
      renderCombined = group(pipelines[2], uniformSharp, first, second),
      image = { width: 9, height: 9 },
      tile = { left: 0, top: 0, ...image }
    for (const scene of reference.scenes) {
      const data = new Float32Array(scene.data.flat()),
        source = { ...tile, data },
        words = new Uint32Array(data.buffer)
      device.queue.writeBuffer(input, 0, data)
      for (const entry of scene.cases) {
        const n = compileNoiseReduction(
            entry.operation === 'noise'
              ? (entry.settings as NoiseReductionSettings)
              : (entry.noise ?? neutralNoiseReduction),
          ),
          s = compileDetailSharpening(
            entry.operation === 'noise'
              ? neutralDetailSharpening
              : (entry.settings as DetailSharpeningSettings),
          ),
          encoder = device.createCommandEncoder(),
          dispatch = (pipeline: GPUComputePipeline, group: GPUBindGroup, noise = false) => {
            const pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, group)
            if (noise) pass.dispatchWorkgroups(2, 2)
            else pass.dispatchWorkgroups(2)
            pass.end()
          }
        let output = first
        if (entry.operation === 'noise' || entry.operation === 'combined') {
          device.queue.writeBuffer(
            uniformNoise,
            0,
            packDetailTile(image, tile, source, n, s, entry.primaries, 'noise'),
          )
          dispatch(pipelines[0], prepareN)
          dispatch(pipelines[1], renderN, true)
        }
        if (entry.operation === 'sharpen' || entry.operation === 'combined') {
          device.queue.writeBuffer(
            uniformSharp,
            0,
            packDetailTile(image, tile, source, n, s, entry.primaries, 'sharpen'),
          )
          const combined = entry.operation === 'combined'
          dispatch(pipelines[0], combined ? prepareCombined : prepareS)
          dispatch(pipelines[2], combined ? renderCombined : renderS)
          if (combined) output = second
        }
        encoder.copyBufferToBuffer(output, 0, staging, 0, 9 * 9 * 16)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        let result: Float32Array, raw: Uint32Array
        try {
          const copy = staging.getMappedRange().slice(0)
          result = new Float32Array(copy)
          raw = new Uint32Array(copy)
        } finally {
          staging.unmap()
        }
        for (const point of entry.points) {
          const index = (point.y * 9 + point.x) * 4
          for (let c = 0; c < 3; c++) {
            const error =
              Math.abs(result[index + c] - point.output[c]) /
              (2e-6 + 2e-5 * Math.abs(point.output[c]))
            if (!Number.isFinite(error) || error > maximum) {
              maximum = error
              worst = {
                scene: scene.name,
                primaries: entry.primaries,
                operation: entry.operation,
                settings: entry.settings,
                point,
                c,
                actual: result[index + c],
              }
            }
          }
          expect(raw[index + 3]).toBe(words[index + 3])
          checked++
        }
      }
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer(input, 0, staging, 0, 9 * 9 * 16)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        expect(new Uint32Array(staging.getMappedRange().slice(0))).toEqual(words)
      } finally {
        staging.unmap()
      }
    }
    expect(checked).toBe(1728)
    expect(maximum, JSON.stringify(worst)).toBeLessThanOrEqual(1)
  } finally {
    if (buffers.length) {
      const { device } = await gpu.mergeDevice()
      await device.queue.onSubmittedWorkDone().catch(() => undefined)
    }
    for (const b of buffers) b.destroy()
    gpu.close()
  }
})
