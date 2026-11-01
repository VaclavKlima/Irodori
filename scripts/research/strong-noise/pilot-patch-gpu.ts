import { RawGpuRenderer } from '../../../src/main/gpu/raw-renderer'
import { DETAIL_NOISE_ESTIMATE_VERSION } from '../../../src/shared/detail-noise-estimate'
import {
  detailLuminance,
  detailSourceBounds,
  validateDetailWindow,
  type DetailRectangle,
  type DetailSize,
  type DetailSourceWindow,
} from '../../../src/shared/spatial-detail'
import type { ResearchNoiseSnapshot } from './gpu'
import { pilotPatchWgsl } from './pilot-patch-wgsl'

export type { ResearchNoiseSnapshot } from './gpu'

/** Whole-image research bound, not a tiled/full-source application capability. */
export const PILOT_PATCH_MAX_EDGE = 256
const PARAMETER_BYTES = 128
const PIXELS = PILOT_PATCH_MAX_EDGE ** 2
const FRAME_BYTES = PIXELS * 16
export const PILOT_PATCH_GPU_BYTES = PARAMETER_BYTES + PIXELS * (16 * 5 + 59 * 4 + 9 * 4 + 8)
/** Fixed GPU allocations, a private upload copy, returned frame and uniform words. */
export const PILOT_PATCH_WORKING_BYTES = PILOT_PATCH_GPU_BYTES + 2 * FRAME_BYTES + PARAMETER_BYTES

export interface PilotPatchJob {
  readonly image: DetailSize
  readonly tile: DetailRectangle
  readonly source: DetailSourceWindow
  /** Frozen original-source variance. This prototype does not estimate on the CPU. */
  readonly estimate: ResearchNoiseSnapshot
  readonly luminance: number
  readonly chroma: number
  readonly admission: { readonly maxGpuBytes: number; readonly maxWorkingBytes: number }
}
export interface PilotPatchGpu {
  readonly adapter: string | undefined
  readonly allocatedBytes: number
  readonly programCount: number
  render(job: PilotPatchJob, signal: AbortSignal): Promise<Float32Array>
  close(): Promise<void>
}
type Renderer = Pick<RawGpuRenderer, 'mergeDevice' | 'close'>

function validate(job: PilotPatchJob): void {
  const { image, tile, source, estimate, admission } = job
  if (
    image.width > PILOT_PATCH_MAX_EDGE ||
    image.height > PILOT_PATCH_MAX_EDGE ||
    tile.left !== 0 ||
    tile.top !== 0 ||
    tile.width !== image.width ||
    tile.height !== image.height ||
    source.left !== 0 ||
    source.top !== 0 ||
    source.width !== image.width ||
    source.height !== image.height
  )
    throw new Error('Pilot-patch GPU supports whole images only, up to 256 pixels per edge.')
  // Reuse the production geometry/window contract. A complete image contains
  // every globally clamped dependency; partial windows are deliberately refused.
  // The shared validator's halo range belongs to the shipped v1 operator.
  // Whole-image equality above already supplies C16's radius-26 dependency;
  // use zero halo here without weakening any window or byte-count validation.
  const required = detailSourceBounds(image, tile, 0)
  if (required.width !== source.width || required.height !== source.height)
    throw new Error('Incomplete pilot-patch source bounds.')
  validateDetailWindow(image, tile, source, 0)
  if (![job.luminance, job.chroma].every((v) => Number.isInteger(v) && v >= 0 && v <= 100))
    throw new Error('Pilot-patch controls must be integers in 0..100.')
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
    throw new Error('Invalid frozen full-source pilot-patch estimate.')
  if (
    ![admission.maxGpuBytes, admission.maxWorkingBytes].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new Error('Invalid pilot-patch resource admission.')
}

/** CPU work here only packs controls/coefficient words; all image arithmetic is WGSL. */
function pack(job: PilotPatchJob): ArrayBuffer {
  const result = new ArrayBuffer(PARAMETER_BYTES),
    integers = new Uint32Array(result),
    floats = new Float32Array(result),
    variance = job.estimate.variance,
    maximum2 = 0.024 ** 2 + 0.4 ** 2 * (variance[1] + variance[2]),
    hl = 0.024 * (job.luminance / 100) ** 2,
    hc2 = maximum2 * (job.chroma / 100) ** 4
  integers.set([job.image.width, job.image.height, 0, job.image.height])
  floats.set([job.luminance, job.chroma, hl ? 1 / hl ** 2 : 0, hc2 ? 1 / hc2 : 0], 4)
  floats.set(
    [
      variance[0],
      variance[1] + variance[2],
      Math.min(1, (job.luminance / 50) ** 2),
      Math.min(1, (job.chroma / 50) ** 2),
    ],
    8,
  )
  const coefficients = detailLuminance(job.estimate.source.primaries)
  for (let c = 0; c < 3; c++) {
    floats[12 + 2 * c] = coefficients[c]
    floats[13 + 2 * c] = coefficients[c] - floats[12 + 2 * c]
  }
  floats[18] = 1 / maximum2
  for (let i = 4; i < floats.length; i++)
    if (!Number.isFinite(floats[i]))
      throw new Error('Pilot-patch parameters exceed the supported finite GPU precision domain.')
  return result
}

/**
 * Disabled GPU-only C16 prototype. No application edit/version selects this.
 * Original-source MAD estimation, partial tiles, full-size preparation and
 * sharpening are outside this bounded owner. There is no CPU precision repair.
 * Active alpha in (0,2^-20) is explicitly unsupported rather than underflowed.
 */
export function createPilotPatchGpu(
  makeRenderer: () => Renderer = () => new RawGpuRenderer(),
): PilotPatchGpu {
  if (process.versions.electron)
    throw new Error('Pilot-patch GPU requires an isolated Node process.')
  const buffers: GPUBuffer[] = [],
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
    pilot: GPUBuffer,
    userL: GPUBuffer,
    guide: GPUBuffer,
    finalC: GPUBuffer,
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
          throw new Error('Pilot-patch allocation exceeds the adapter buffer limits.')
        const buffer = device!.createBuffer({ size, usage })
        buffers.push(buffer)
        return buffer
      }
      uniform = allocate(PARAMETER_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
      input = allocate(FRAME_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      features = allocate(FRAME_BYTES, GPUBufferUsage.STORAGE)
      pilot = allocate(PIXELS * 59 * 4, GPUBufferUsage.STORAGE)
      userL = allocate(PIXELS * 9 * 4, GPUBufferUsage.STORAGE)
      guide = allocate(FRAME_BYTES, GPUBufferUsage.STORAGE)
      finalC = allocate(PIXELS * 8, GPUBufferUsage.STORAGE)
      output = allocate(FRAME_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      staging = allocate(FRAME_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    })())
  const program = (entryPoint: string) => {
    let result = programs.get(entryPoint)
    if (!result) {
      result = (async () => {
        module ??= device!.createShaderModule({ code: pilotPatchWgsl })
        const errors = (await module.getCompilationInfo()).messages.filter(
          (message) => message.type === 'error',
        )
        if (errors.length)
          throw new Error(
            'Pilot-patch shader compilation failed: ' +
              errors
                .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
                .join('; '),
          )
        return device!.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint },
        })
      })()
      programs.set(entryPoint, result)
    }
    return result
  }
  return {
    get adapter() {
      return adapter
    },
    get allocatedBytes() {
      return buffers.reduce((sum, buffer) => sum + buffer.size, 0)
    },
    get programCount() {
      return programs.size
    },
    render(job, signal) {
      if (disposed || faulted || pending)
        return Promise.reject(new Error('The pilot-patch GPU is unavailable or busy.'))
      const work = (async () => {
        signal.throwIfAborted()
        validate(job)
        const active = job.luminance > 0 || job.chroma > 0,
          gpuBytes = active || buffers.length > 0 ? PILOT_PATCH_GPU_BYTES : 0,
          workingBytes = gpuBytes ? PILOT_PATCH_WORKING_BYTES : job.source.data.byteLength
        if (job.admission.maxGpuBytes < gpuBytes || job.admission.maxWorkingBytes < workingBytes)
          throw new Error('Pilot-patch GPU exceeds its admitted numeric storage.')
        if (!active) {
          // Byte copying is the identity operation, not an image-processing backend.
          return new Float32Array(
            job.source.data.buffer.slice(
              job.source.data.byteOffset,
              job.source.data.byteOffset + job.source.data.byteLength,
            ),
          )
        }
        for (let i = 3; i < job.source.data.length; i += 4)
          if (job.source.data[i] > 0 && job.source.data[i] < 2 ** -20)
            throw new Error(
              'Tiny positive alpha is unsupported by the pilot-patch GPU precision domain.',
            )
        const parameters = pack(job),
          source = new Float32Array(job.source.data),
          width = job.image.width,
          height = job.image.height,
          chroma = job.chroma,
          bytes = source.byteLength
        try {
          await initialize(signal)
          signal.throwIfAborted()
          const dev = device!
          dev.pushErrorScope('validation')
          let result: Float32Array | undefined,
            commandFailed = false,
            commandError: unknown
          try {
            dev.queue.writeBuffer(input, 0, source)
            const dispatch = async (entryPoint: string, entries: [number, GPUBuffer][]) => {
              signal.throwIfAborted()
              const pipeline = await program(entryPoint),
                group = dev.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
                }),
                words = new Uint32Array(parameters)
              // A fence after each row bounds in-flight heavy work and gives
              // cancellation a chance before the next submission. No tile cache.
              for (let row = 0; row < height; row++) {
                signal.throwIfAborted()
                words[2] = row
                words[3] = 1
                dev.queue.writeBuffer(uniform, 0, parameters)
                const encoder = dev.createCommandEncoder(),
                  pass = encoder.beginComputePass()
                pass.setPipeline(pipeline)
                pass.setBindGroup(0, group)
                pass.dispatchWorkgroups(Math.ceil(width / 64))
                pass.end()
                dev.queue.submit([encoder.finish()])
                await dev.queue.onSubmittedWorkDone()
              }
              signal.throwIfAborted()
            }
            await dispatch('prepareFeatures', [
              [0, uniform],
              [1, input],
              [2, features],
            ])
            await dispatch('estimateLuminance', [
              [0, uniform],
              [2, features],
              [3, pilot],
              [4, userL],
            ])
            if (chroma > 0) {
              await dispatch('estimatePilotChroma', [
                [0, uniform],
                [2, features],
                [3, pilot],
              ])
              await dispatch('publishGuide', [
                [0, uniform],
                [2, features],
                [3, pilot],
                [4, userL],
                [5, guide],
              ])
              await dispatch('estimateFinalChroma', [
                [0, uniform],
                [2, features],
                [5, guide],
                [6, finalC],
              ])
            }
            await dispatch('composeOutput', [
              [0, uniform],
              [1, input],
              [2, features],
              [3, pilot],
              [4, userL],
              [6, finalC],
              [7, output],
            ])
            signal.throwIfAborted()
            const encoder = dev.createCommandEncoder()
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
          const validation = await dev.popErrorScope()
          if (commandFailed) throw commandError
          if (validation)
            throw new Error('Pilot-patch GPU validation failed: ' + validation.message)
          if (!result) throw new Error('Pilot-patch GPU returned no output.')
          const actual = new Uint32Array(result.buffer),
            original = new Uint32Array(source.buffer)
          for (let i = 0; i < result.length; i += 4) {
            if (actual[i + 3] !== original[i + 3])
              throw new Error('Pilot-patch GPU changed source alpha.')
            for (let c = 0; c < 3; c++) {
              if (!Number.isFinite(result[i + c]))
                throw new Error(
                  'Pilot-patch GPU output exceeds its supported finite precision domain.',
                )
              if (source[i + 3] === 0 && actual[i + c] !== original[i + c])
                throw new Error('Pilot-patch GPU changed hidden RGB words.')
            }
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
