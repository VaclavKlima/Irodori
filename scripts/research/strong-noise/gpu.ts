import { RawGpuRenderer } from '../../../src/main/gpu/raw-renderer'
import type { ColorPrimaries } from '../../../src/shared/color-model'
import { DETAIL_NOISE_ESTIMATE_VERSION } from '../../../src/shared/detail-noise-estimate'
import {
  detailLuminance,
  detailSourceBounds,
  validateDetailWindow,
  type DetailRectangle,
  type DetailSize,
  type DetailSourceWindow,
} from '../../../src/shared/spatial-detail'
import {
  patchwiseNoiseWgslForChromaSpatialPolicy,
  type ResearchChromaSpatialPolicy,
} from './gpu-wgsl'

export type { ResearchChromaSpatialPolicy } from './gpu-wgsl'

export const PATCHWISE_RESEARCH_HALO = 5
export const PATCHWISE_RESEARCH_EDGE = 256
export const PATCHWISE_RESEARCH_PARAMETER_BYTES = 128
const CENTER_EDGE = PATCHWISE_RESEARCH_EDGE + 2
const WINDOW_EDGE = PATCHWISE_RESEARCH_EDGE + 2 * PATCHWISE_RESEARCH_HALO
const WINDOW_BYTES = WINDOW_EDGE ** 2 * 16
const TILE_BYTES = PATCHWISE_RESEARCH_EDGE ** 2 * 16
export const PATCHWISE_RESEARCH_GPU_BYTES =
  PATCHWISE_RESEARCH_PARAMETER_BYTES + 2 * WINDOW_BYTES + CENTER_EDGE ** 2 * 27 * 4 + 2 * TILE_BYTES
/** GPU allocations plus one private source copy, one returned tile and uniform words. */
export const PATCHWISE_RESEARCH_WORKING_BYTES =
  PATCHWISE_RESEARCH_GPU_BYTES + WINDOW_BYTES + TILE_BYTES + PATCHWISE_RESEARCH_PARAMETER_BYTES

export interface ResearchNoiseSnapshot {
  readonly version: typeof DETAIL_NOISE_ESTIMATE_VERSION
  /** Caller-owned full prepared source or independent numeric reference provenance. */
  readonly source: DetailSize & {
    readonly identity: string
    readonly sha256: string
    readonly primaries: ColorPrimaries
  }
  readonly variance: readonly [number, number, number]
}
export interface PatchwiseResearchJob {
  readonly image: DetailSize
  readonly tile: DetailRectangle
  readonly source: DetailSourceWindow
  readonly estimate: ResearchNoiseSnapshot
  readonly luminance: number
  readonly chroma: number
  readonly chromaSigmaFactor: 0.4 | 0.55
  /** Research-owner allocations only; the caller admits and protects its source separately. */
  readonly admission: { readonly maxGpuBytes: number; readonly maxWorkingBytes: number }
}
export interface PatchwiseResearchGpu {
  readonly chromaSpatialPolicy: ResearchChromaSpatialPolicy
  readonly adapter: string | undefined
  readonly allocatedBytes: number
  readonly programCount: number
  render(job: PatchwiseResearchJob, signal: AbortSignal): Promise<Float32Array>
  close(): Promise<void>
}
type Renderer = Pick<RawGpuRenderer, 'mergeDevice' | 'close'>

function validate(job: PatchwiseResearchJob): void {
  const { image, tile, source, estimate, admission } = job
  if (
    tile.width > PATCHWISE_RESEARCH_EDGE ||
    tile.height > PATCHWISE_RESEARCH_EDGE ||
    source.width > WINDOW_EDGE ||
    source.height > WINDOW_EDGE ||
    ![job.luminance, job.chroma].every((v) => Number.isInteger(v) && v >= 0 && v <= 100) ||
    ![0.4, 0.55].includes(job.chromaSigmaFactor)
  )
    throw new Error('Invalid patchwise research tile or controls.')
  validateDetailWindow(image, tile, source, PATCHWISE_RESEARCH_HALO)
  detailLuminance(estimate.source.primaries)
  if (
    estimate.version !== DETAIL_NOISE_ESTIMATE_VERSION ||
    estimate.source.width !== image.width ||
    estimate.source.height !== image.height ||
    !/^[a-f0-9]{64}$/.test(estimate.source.identity) ||
    !/^[a-f0-9]{64}$/.test(estimate.source.sha256) ||
    estimate.variance.length !== 3 ||
    !estimate.variance.every((v) => Number.isFinite(v) && v >= 0) ||
    !Number.isFinite(Math.fround(2 * estimate.variance[0])) ||
    !Number.isFinite(Math.fround(2 * (estimate.variance[1] + estimate.variance[2])))
  )
    throw new Error('Invalid frozen full-source research estimate.')
  if (
    ![admission.maxGpuBytes, admission.maxWorkingBytes].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new Error('Invalid patchwise research admission.')
}

export function packPatchwiseResearch(job: PatchwiseResearchJob): ArrayBuffer {
  validate(job)
  const parameters = new ArrayBuffer(PATCHWISE_RESEARCH_PARAMETER_BYTES),
    integers = new Uint32Array(parameters),
    floats = new Float32Array(parameters),
    centers = detailSourceBounds(job.image, job.tile, 1),
    { variance } = job.estimate,
    maximum = Math.sqrt(0.024 ** 2 + job.chromaSigmaFactor ** 2 * (variance[1] + variance[2])),
    hl = 0.024 * (job.luminance / 100) ** 2,
    hc = maximum * (job.chroma / 100) ** 2
  integers.set([job.image.width, job.image.height, 0, 0])
  for (const [index, rect] of [job.source, centers, job.tile].entries())
    integers.set([rect.left, rect.top, rect.width, rect.height], (index + 1) * 4)
  floats.set([Number(hl > 0), Number(hc > 0), hl ? 1 / hl ** 2 : 0, hc ? 1 / hc ** 2 : 0], 16)
  floats.set(
    [
      variance[0],
      variance[1] + variance[2],
      Math.min(1, (job.luminance / 50) ** 2),
      Math.min(1, (job.chroma / 50) ** 2),
    ],
    20,
  )
  const coefficients = detailLuminance(job.estimate.source.primaries)
  for (let c = 0; c < 3; c++) {
    floats[24 + 2 * c] = coefficients[c]
    floats[25 + 2 * c] = coefficients[c] - floats[24 + 2 * c]
  }
  return parameters
}

/**
 * Unenabled, noise-only research owner. No public edit/version selects this code.
 * Alpha below 2^-20 requires the future equivalent Float64 recovery; refuse it
 * explicitly here rather than treating a hardware-underflow result as equivalent.
 */
export function createPatchwiseResearchGpu(
  makeRenderer: () => Renderer = () => new RawGpuRenderer(),
  options: { readonly chromaSpatialPolicy?: ResearchChromaSpatialPolicy } = {},
): PatchwiseResearchGpu {
  if (process.versions.electron)
    throw new Error('Patchwise research requires an isolated Node process.')
  const chromaSpatialPolicy =
      options.chromaSpatialPolicy === undefined
        ? 'gaussian-search-v1'
        : options.chromaSpatialPolicy,
    shader = patchwiseNoiseWgslForChromaSpatialPolicy(chromaSpatialPolicy),
    buffers: GPUBuffer[] = [],
    programs = new Map<string, Promise<GPUComputePipeline>>()
  let renderer: Renderer | undefined,
    device: GPUDevice | undefined,
    adapter: string | undefined,
    module: GPUShaderModule | undefined,
    initializing: Promise<void> | undefined,
    pending: Promise<Float32Array> | undefined,
    closing: Promise<void> | undefined,
    disposed = false,
    faulted = false,
    uniform: GPUBuffer,
    input: GPUBuffer,
    features: GPUBuffer,
    estimates: GPUBuffer,
    output: GPUBuffer,
    staging: GPUBuffer
  const initialize = (signal: AbortSignal) =>
    (initializing ??= (async () => {
      renderer = makeRenderer()
      const context = await renderer.mergeDevice()
      device = context.device
      adapter = context.adapter
      signal.throwIfAborted()
      const allocate = (size: number, usage: number) => {
        if (
          size > device!.limits.maxBufferSize ||
          ((usage & GPUBufferUsage.STORAGE) !== 0 &&
            size > device!.limits.maxStorageBufferBindingSize)
        )
          throw new Error('Patchwise research exceeds the GPU buffer limit.')
        const result = device!.createBuffer({ size, usage })
        buffers.push(result)
        return result
      }
      uniform = allocate(
        PATCHWISE_RESEARCH_PARAMETER_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      )
      input = allocate(WINDOW_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      features = allocate(WINDOW_BYTES, GPUBufferUsage.STORAGE)
      estimates = allocate(CENTER_EDGE ** 2 * 27 * 4, GPUBufferUsage.STORAGE)
      output = allocate(TILE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      staging = allocate(TILE_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    })())
  const program = (entryPoint: string) => {
    let p = programs.get(entryPoint)
    if (!p) {
      module ??= device!.createShaderModule({ code: shader })
      p = device!.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })
      programs.set(entryPoint, p)
    }
    return p
  }
  return {
    get chromaSpatialPolicy() {
      return chromaSpatialPolicy
    },
    get adapter() {
      return adapter
    },
    get allocatedBytes() {
      return buffers.reduce((sum, b) => sum + b.size, 0)
    },
    get programCount() {
      return programs.size
    },
    render(job, signal) {
      if (disposed || faulted || pending)
        return Promise.reject(new Error('The patchwise research GPU is unavailable or busy.'))
      const work = (async () => {
        signal.throwIfAborted()
        validate(job)
        const active = job.luminance > 0 || job.chroma > 0,
          gpuBytes = active || buffers.length > 0 ? PATCHWISE_RESEARCH_GPU_BYTES : 0,
          workingBytes = gpuBytes
            ? PATCHWISE_RESEARCH_WORKING_BYTES
            : job.tile.width * job.tile.height * 16
        if (job.admission.maxGpuBytes < gpuBytes || job.admission.maxWorkingBytes < workingBytes)
          throw new Error('Patchwise research exceeds its admitted numeric storage.')
        if (!active) {
          const result = new Float32Array(job.tile.width * job.tile.height * 4),
            words = new Uint32Array(result.buffer),
            sourceWords = new Uint32Array(
              job.source.data.buffer,
              job.source.data.byteOffset,
              job.source.data.length,
            )
          for (let y = 0; y < job.tile.height; y++) {
            const offset =
              ((job.tile.top + y - job.source.top) * job.source.width +
                job.tile.left -
                job.source.left) *
              4
            words.set(
              sourceWords.subarray(offset, offset + job.tile.width * 4),
              y * job.tile.width * 4,
            )
          }
          return result
        }
        for (let i = 3; i < job.source.data.length; i += 4)
          if (job.source.data[i] > 0 && job.source.data[i] < 2 ** -20)
            throw new Error(
              'Tiny positive alpha requires unimplemented patchwise Float64 recovery.',
            )
        const parameters = packPatchwiseResearch(job),
          image = { ...job.image },
          tile = { ...job.tile },
          source = { ...job.source, data: new Float32Array(job.source.data) },
          centers = detailSourceBounds(image, tile, 1)
        try {
          await initialize(signal)
          signal.throwIfAborted()
          const prepare = await program('preparePatchwiseFeatures'),
            estimate = await program('estimatePatchwiseCenters'),
            gather = await program('gatherPatchwiseOutput')
          signal.throwIfAborted()
          const dev = device!,
            encoder = dev.createCommandEncoder(),
            group = (pipeline: GPUComputePipeline, entries: [number, GPUBuffer][]) =>
              dev.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
              }),
            dispatch = (
              pipeline: GPUComputePipeline,
              bind: GPUBindGroup,
              x: number,
              y?: number,
            ) => {
              const pass = encoder.beginComputePass()
              pass.setPipeline(pipeline)
              pass.setBindGroup(0, bind)
              pass.dispatchWorkgroups(x, y)
              pass.end()
            }
          dev.pushErrorScope('validation')
          let result: Float32Array | undefined,
            commandFailed = false,
            commandError: unknown
          try {
            dev.queue.writeBuffer(uniform, 0, parameters)
            dev.queue.writeBuffer(input, 0, source.data)
            dispatch(
              prepare,
              group(prepare, [
                [0, uniform],
                [1, input],
                [2, features],
              ]),
              Math.ceil((source.width * source.height) / 64),
            )
            dispatch(
              estimate,
              group(estimate, [
                [0, uniform],
                [2, features],
                [3, estimates],
              ]),
              Math.ceil(centers.width / 8),
              Math.ceil(centers.height / 8),
            )
            dispatch(
              gather,
              group(gather, [
                [0, uniform],
                [1, input],
                [2, features],
                [3, estimates],
                [4, output],
              ]),
              Math.ceil((tile.width * tile.height) / 64),
            )
            const bytes = tile.width * tile.height * 16
            encoder.copyBufferToBuffer(output, 0, staging, 0, bytes)
            dev.queue.submit([encoder.finish()])
            await staging.mapAsync(GPUMapMode.READ, 0, bytes)
            try {
              signal.throwIfAborted()
              result = new Float32Array(staging.getMappedRange(0, bytes).slice(0))
            } finally {
              staging.unmap()
            }
          } catch (error) {
            commandFailed = true
            commandError = error
          }
          const validationError = await dev.popErrorScope()
          if (commandFailed) throw commandError
          if (validationError)
            throw new Error('Patchwise GPU validation failed: ' + validationError.message)
          if (!result) throw new Error('Patchwise GPU returned no pixels.')
          const actualWords = new Uint32Array(result.buffer),
            sourceWords = new Uint32Array(source.data.buffer)
          for (let y = 0; y < tile.height; y++)
            for (let x = 0; x < tile.width; x++) {
              const i = (y * tile.width + x) * 4,
                at = ((tile.top + y - source.top) * source.width + tile.left + x - source.left) * 4
              if (actualWords[i + 3] !== sourceWords[at + 3])
                throw new Error('Patchwise GPU changed source alpha.')
              for (let c = 0; c < 3; c++)
                if (!Number.isFinite(result[i + c]))
                  throw new Error('Patchwise GPU produced nonfinite RGB.')
              if (source.data[at + 3] === 0)
                for (let c = 0; c < 3; c++)
                  if (actualWords[i + c] !== sourceWords[at + c])
                    throw new Error('Patchwise GPU changed transparent RGB.')
            }
          signal.throwIfAborted()
          return result
        } catch (error) {
          faulted = true
          throw error
        }
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
        await initializing?.catch(() => undefined)
        await device?.queue.onSubmittedWorkDone().catch(() => undefined)
        for (const buffer of buffers) buffer.destroy()
        buffers.length = 0
        programs.clear()
        renderer?.close()
      })()
      return closing
    },
  }
}
