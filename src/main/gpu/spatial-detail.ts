import { RawGpuRenderer } from './raw-renderer'
import {
  detailMemoryPlan,
  DETAIL_GPU_BYTES,
  DETAIL_WINDOW_BYTES,
  DETAIL_STAGE_BYTES,
  DETAIL_TILE_BYTES,
  DETAIL_PARAMETER_BYTES,
  type DetailAdmission,
} from '../../shared/detail-resources'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  spatialDetailTile,
  spatialDetailSourceBounds,
  detailSourceBounds,
  validateDetailWindow,
  detailLuminance,
  NOISE_HALO,
  type DetailSize,
  type DetailRectangle,
  type DetailSourceWindow,
  type NoiseReductionSettings,
  type DetailSharpeningSettings,
} from '../../shared/spatial-detail'
import {
  packDetailTile,
  packResidentDetailTile,
  spatialDetailWgsl,
} from '../../shared/spatial-detail-wgsl'
import type { ColorPrimaries } from '../../shared/color-model'

export interface DetailGpuJob {
  readonly image: DetailSize
  readonly tile: DetailRectangle
  readonly source: DetailSourceWindow
  readonly noiseReduction: NoiseReductionSettings
  readonly detailSharpening: DetailSharpeningSettings
  readonly primaries: ColorPrimaries
  readonly admission: DetailAdmission
}
export interface SpatialDetailGpu {
  readonly adapter: string | undefined
  readonly bytes: number
  readonly allocatedBytes: number
  readonly programCount: number
  readonly precisionRecoveryTiles: number
  render(job: DetailGpuJob, signal: AbortSignal): Promise<Float32Array>
  close(): Promise<void>
}
type Renderer = Pick<RawGpuRenderer, 'mergeDevice' | 'close'>

/** One admitted, reusable native-pixel tile owner; neutral jobs do not initialize a device. */
export function createSpatialDetailGpu(
  makeRenderer: () => Renderer = () => new RawGpuRenderer(),
): SpatialDetailGpu {
  if (process.versions.electron)
    throw new Error('Detail processing requires the isolated Node worker.')
  const buffers: GPUBuffer[] = []
  let renderer: Renderer | undefined,
    device: GPUDevice | undefined,
    adapter: string | undefined,
    disposed = false,
    pending: Promise<Float32Array> | undefined,
    initializing: Promise<void> | undefined,
    closing: Promise<void> | undefined,
    recoveries = 0,
    input: GPUBuffer,
    features: GPUBuffer,
    intermediate: GPUBuffer,
    output: GPUBuffer,
    staging: GPUBuffer,
    uniformN: GPUBuffer,
    uniformS: GPUBuffer,
    module: GPUShaderModule | undefined
  const programs = new Map<string, Promise<GPUComputePipeline>>()
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
          throw new Error('Detail tile exceeds the GPU allocation limit.')
        const b = device!.createBuffer({ size, usage })
        buffers.push(b)
        return b
      }
      uniformN = allocate(DETAIL_PARAMETER_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
      uniformS = allocate(DETAIL_PARAMETER_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
      input = allocate(DETAIL_WINDOW_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      features = allocate(DETAIL_WINDOW_BYTES, GPUBufferUsage.STORAGE)
      intermediate = allocate(DETAIL_STAGE_BYTES, GPUBufferUsage.STORAGE)
      output = allocate(DETAIL_TILE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      staging = allocate(DETAIL_TILE_BYTES, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    })())
  const program = (name: string) => {
    let p = programs.get(name)
    if (!p) {
      module ??= device!.createShaderModule({ code: spatialDetailWgsl })
      p = device!.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: name },
      })
      programs.set(name, p)
    }
    return p
  }
  const release = async () => {
    await device?.queue.onSubmittedWorkDone().catch(() => undefined)
    for (const buffer of buffers) buffer.destroy()
    buffers.length = 0
    programs.clear()
    renderer?.close()
  }
  return {
    get adapter() {
      return adapter
    },
    bytes: DETAIL_GPU_BYTES,
    get allocatedBytes() {
      return buffers.reduce((s, b) => s + b.size, 0)
    },
    get programCount() {
      return programs.size
    },
    get precisionRecoveryTiles() {
      return recoveries
    },
    render(job, signal) {
      if (disposed || pending)
        return Promise.reject(new Error('The detail GPU owner is unavailable or busy.'))
      const work = (async () => {
        signal.throwIfAborted()
        const image = { ...job.image },
          tile = { ...job.tile },
          noise = compileNoiseReduction(job.noiseReduction),
          sharp = compileDetailSharpening(job.detailSharpening),
          primaries = job.primaries,
          admission = structuredClone(job.admission),
          active = noise.active || sharp.active,
          memory = detailMemoryPlan(admission, active || buffers.length > 0)
        spatialDetailSourceBounds(image, tile, noise, sharp)
        detailLuminance(primaries)
        validateDetailWindow(
          image,
          tile,
          job.source,
          (noise.active ? NOISE_HALO : 0) + (sharp.active ? sharp.support : 0),
        )
        if (!memory.cpuAccepted)
          throw new Error('Detail processing exceeds the frozen managed image budgets.')
        if (buffers.length > 0 && !memory.gpuAccepted)
          throw new Error(
            'The retained detail GPU buffers exceed the frozen managed image budgets.',
          )
        if (!active) return spatialDetailTile(image, tile, job.source, noise, sharp, primaries)
        const source = {
          left: job.source.left,
          top: job.source.top,
          width: job.source.width,
          height: job.source.height,
          data: new Float32Array(job.source.data),
        }
        // Tiny coverage products can underflow on the GPU. Use the same Float64
        // operator, retaining exact alpha and RGB rather than omitting the edit.
        let lowAlpha = false
        for (let i = 3; i < source.data.length; i += 4)
          if (source.data[i] > 0 && source.data[i] < 2 ** -20) {
            lowAlpha = true
            break
          }
        if (lowAlpha) {
          const recovered = spatialDetailTile(image, tile, source, noise, sharp, primaries)
          recoveries++
          return recovered
        }
        if (!memory.gpuAccepted)
          throw new Error('Detail GPU processing exceeds the frozen managed image budgets.')
        await initialize(signal)
        signal.throwIfAborted()
        const prepare = await program('prepareDetailFeatures'),
          n = noise.active ? await program('denoiseDetail') : undefined,
          s = sharp.active ? await program('sharpenDetail') : undefined
        signal.throwIfAborted()
        const dev = device!,
          encoder = dev.createCommandEncoder(),
          group = (p: GPUComputePipeline, u: GPUBuffer, src: GPUBuffer, dst?: GPUBuffer) =>
            dev.createBindGroup({
              layout: p.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: { buffer: u } },
                { binding: 1, resource: { buffer: src } },
                { binding: 2, resource: { buffer: features } },
                ...(dst ? [{ binding: 3, resource: { buffer: dst } }] : []),
              ],
            }),
          dispatch = (
            p: GPUComputePipeline,
            g: GPUBindGroup,
            w: number,
            h: number,
            kind: 'prepare' | 'noise' | 'sharpen',
          ) => {
            const pass = encoder.beginComputePass()
            pass.setPipeline(p)
            pass.setBindGroup(0, g)
            if (kind === 'noise') pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
            else pass.dispatchWorkgroups(Math.ceil((w * h) / 64))
            pass.end()
          }
        dev.queue.writeBuffer(input, 0, source.data)
        let sharpLayout: DetailRectangle = source,
          sharpInput = input
        if (n) {
          const padded = s ? detailSourceBounds(image, tile, sharp.support) : tile,
            parameters = packDetailTile(image, padded, source, noise, sharp, primaries, 'noise'),
            destination = s ? intermediate : output
          dev.queue.writeBuffer(uniformN, 0, parameters)
          dispatch(prepare, group(prepare, uniformN, input), source.width, source.height, 'prepare')
          dispatch(n, group(n, uniformN, input, destination), padded.width, padded.height, 'noise')
          if (s) {
            sharpLayout = padded
            sharpInput = intermediate
          }
        }
        if (s) {
          const parameters = packResidentDetailTile(
            image,
            tile,
            sharpLayout,
            noise,
            sharp,
            primaries,
            'sharpen',
          )
          dev.queue.writeBuffer(uniformS, 0, parameters)
          dispatch(
            prepare,
            group(prepare, uniformS, sharpInput),
            sharpLayout.width,
            sharpLayout.height,
            'prepare',
          )
          dispatch(s, group(s, uniformS, sharpInput, output), tile.width, tile.height, 'sharpen')
        }
        encoder.copyBufferToBuffer(output, 0, staging, 0, tile.width * tile.height * 16)
        dev.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ, 0, tile.width * tile.height * 16)
        let result: Float32Array
        try {
          signal.throwIfAborted()
          result = new Float32Array(
            staging.getMappedRange(0, tile.width * tile.height * 16).slice(0),
          )
        } finally {
          staging.unmap()
        }
        let finite = true
        const actualWords = new Uint32Array(result.buffer),
          sourceWords = new Uint32Array(source.data.buffer)
        for (let y = 0; y < tile.height; y++)
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4,
              at = ((tile.top + y - source.top) * source.width + tile.left + x - source.left) * 4
            if (actualWords[i + 3] !== sourceWords[at + 3])
              throw new Error('The GPU detail result changed source alpha.')
            for (let c = 0; c < 3; c++) if (!Number.isFinite(result[i + c])) finite = false
          }
        if (!finite) {
          result = spatialDetailTile(image, tile, source, noise, sharp, primaries)
          recoveries++
        }
        signal.throwIfAborted()
        return result
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
        await release()
      })()
      return closing
    },
  }
}
