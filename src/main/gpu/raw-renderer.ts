import { whiteBalanceMatrix, identityMatrix } from '../../shared/white-balance'
import { SRGB_TO_2020 } from '../../shared/hdr'
import {
  neutralAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../shared/adjustments'
// AHD Lab conversion adapted from LibRaw 0.22.1 under CDDL-1.0. See third_party/libraw.
import { lensShader } from './lens-shader'
import type { CorrectionPlan } from '../processing/lens-correction'
import { ahdShader } from './ahd-shader'
import { displayCurve, displayTransform, type RawSource } from './raw-source'
import { frameByteLength } from '../../shared/preview-frame'
import { mergePrepareShader } from './merge-prepare-shader'
import { mergePreparationParameters } from './merge-parameters'
import { sensorBlendParameters } from './sensor-blend'

export const GPU_RENDER_ID = 'bayer-ahd-srgb-gpu-2'
export interface GpuFrame {
  mergeReduced?: Float32Array
  gpuBytes?: number
  hdrPrepared?: boolean
  working?: WorkingFrame
  data: Buffer
  width: number
  height: number
  adapter: string
  timings: Record<string, number>
}
export interface GpuMergePreparation {
  gains: number[]
  reviewWidth: number
  reviewHeight: number
  checkpoint: () => Promise<void>
  // The buffer is borrowed until the returned promise settles; retained data must be copied.
  strip: (top: number, bytes: Buffer) => Promise<void>
}
export interface GpuCameraConsumer {
  reservedBytes: number
  checkpoint: () => Promise<void>
  consume: (linear: GPUTexture, device: GPUDevice) => Promise<void>
}

/** Native Dawn only lives in the bundled Node worker, never Electron's address space. */
export class RawGpuRenderer {
  private gpu?: GPU
  private device?: GPUDevice
  private unavailable?: string
  private pipelines = new Map<string, GPUComputePipeline>()
  private linear?: GPUTexture
  private cameraSource?: RawSource
  private adapter = ''
  private histogram?: Uint32Array
  private correctedMode = false

  get failure(): string | undefined {
    return this.unavailable
  }

  private async initialize(): Promise<GPUDevice> {
    if (this.unavailable) throw new Error(this.unavailable)
    if (this.device) return this.device
    const { create, globals } = await import('webgpu')
    Object.assign(globalThis, globals)
    this.gpu = create([])
    const adapter = await this.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (
      !adapter ||
      adapter.info.isFallbackAdapter ||
      /llvmpipe|swiftshader|software/i.test(adapter.info.device)
    )
      throw new Error('No hardware GPU adapter is available.')
    this.adapter = `${adapter.info.vendor} ${adapter.info.device} (${adapter.info.description})`
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: Math.min(1024 ** 3, adapter.limits.maxBufferSize),
        maxStorageBufferBindingSize: Math.min(
          1024 ** 3,
          adapter.limits.maxStorageBufferBindingSize,
        ),
      },
    })
    this.device = device
    void device.lost.then((info) => {
      if (this.device !== device) return
      this.unavailable = `GPU device lost: ${info.message}`
      this.close()
    })
    const module = device.createShaderModule({ code: ahdShader, label: 'Luma AHD' })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join('\n'))
    for (const name of [
      'interpolateGreen',
      'interpolateColor',
      'buildHomogeneity',
      'combine',
      'display',
    ])
      this.pipelines.set(
        name,
        await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: name },
          label: name,
        }),
      )
    const lensModule = device.createShaderModule({
      code: lensShader,
      label: 'Luma lens correction',
    })
    this.pipelines.set(
      'correct',
      await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: lensModule, entryPoint: 'correct' },
      }),
    )
    return device
  }

  async mergeDevice(): Promise<{ device: GPUDevice; adapter: string }> {
    const device = await this.initialize()
    return { device, adapter: this.adapter }
  }

  releaseFrame(): void {
    this.linear?.destroy()
    this.linear = undefined
    this.cameraSource = undefined
  }
  close(): void {
    this.releaseFrame()
    const device = this.device
    this.device = undefined
    this.pipelines.clear()
    device?.destroy()
    this.gpu = undefined
  }

  async render(
    source: RawSource,
    correction?: CorrectionPlan,
    adjustments: AdjustmentParameters = neutralAdjustments,
    exportLinear = false,
    cameraOnly = false,
    merge?: GpuMergePreparation,
    consumer?: GpuCameraConsumer,
  ): Promise<GpuFrame> {
    const start = performance.now()
    const device = await this.initialize().catch((error) => {
      this.unavailable = error instanceof Error ? error.message : String(error)
      this.close()
      throw error
    })
    const timings: Record<string, number> = { initializeMs: performance.now() - start }
    const { width, height } = source
    const bytes = frameByteLength(width, height)
    const rows = consumer ? 128 : 256,
      stripePixels = width * (rows + 12)
    const estimatedBytes = consumer
      ? bytes * 4 + source.pixels.byteLength + stripePixels * 80 + 623072 + consumer.reservedBytes
      : Math.max(
          bytes * 6 + source.pixels.byteLength + stripePixels * 80,
          correction ? bytes * 9 + source.pixels.byteLength : 0,
          exportLinear ? bytes * 12 + height * 256 : 0,
        )
    if (
      estimatedBytes > 1024 ** 3 ||
      bytes * 4 > device.limits.maxBufferSize ||
      Math.max(width, height) > device.limits.maxTextureDimension2D ||
      Math.max(bytes, source.pixels.byteLength, stripePixels * 32) >
        device.limits.maxStorageBufferBindingSize
    )
      throw new Error('This photo exceeds the GPU processing memory limit.')
    const reuse =
      this.cameraSource === source && !!this.linear && this.correctedMode === !!correction
    if (!reuse) this.releaseFrame()
    const resources: GPUBuffer[] = []
    const makeBuffer = (size: number, usage: number, data?: ArrayBufferView<ArrayBuffer>) => {
      const buffer = device.createBuffer({ size: Math.ceil(size / 4) * 4, usage })
      resources.push(buffer)
      if (data) device.queue.writeBuffer(buffer, 0, data)
      return buffer
    }
    device.pushErrorScope('validation')
    device.pushErrorScope('out-of-memory')
    try {
      const upload = performance.now()
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      const uniform = makeBuffer(272, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
      const raw = makeBuffer(source.pixels.byteLength, storage, source.pixels)
      const green = makeBuffer(stripePixels * 8, storage)
      const rgb = makeBuffer(stripePixels * 32, storage)
      const lab = makeBuffer(stripePixels * 32, storage)
      const homo = makeBuffer(stripePixels * 8, storage)
      const histogram = makeBuffer(3 * 8192 * 4, storage | GPUBufferUsage.COPY_SRC)
      const output = makeBuffer(consumer ? 4 : bytes, storage | GPUBufferUsage.COPY_SRC)
      const curve = makeBuffer(65536 * 4, storage)
      const cbrt = new Float32Array(65536)
      for (let i = 0; i < cbrt.length; i++) {
        const r = Math.fround(i / 65535)
        cbrt[i] =
          r > Math.fround(0.008856)
            ? Math.pow(r, Math.fround(1 / 3))
            : Math.fround(Math.fround(Math.fround(7.787) * r) + Math.fround(16 / 116))
      }
      const labCurve = makeBuffer(cbrt.byteLength, storage, cbrt)
      const linear =
        this.linear ??
        device.createTexture({
          size: [width, height],
          format: 'rgba32float',
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        })
      this.linear = linear
      const bindings: GPUBindingResource[] = [uniform, raw, green, rgb, lab, homo].map(
        (buffer) => ({ buffer }),
      )
      bindings.push(
        linear.createView(),
        { buffer: histogram },
        { buffer: output },
        { buffer: curve },
        { buffer: labCurve },
        linear.createView(),
      )
      const names: [string, number[]][] = [
        ['interpolateGreen', [0, 1, 2]],
        ['interpolateColor', [0, 1, 2, 3, 4, 10]],
        ['buildHomogeneity', [0, 4, 5]],
        ['combine', [0, 1, 3, 5, 6, 7]],
        ['display', [0, 8, 9, 11]],
      ]
      const groups = new Map(
        names.map(([name, indices]) => [
          name,
          device.createBindGroup({
            layout: this.pipelines.get(name)!.getBindGroupLayout(0),
            entries: indices.map((binding) => ({ binding, resource: bindings[binding] })),
          }),
        ]),
      )
      const params = new ArrayBuffer(272)
      const ints = new Uint32Array(params),
        floats = new Float32Array(params)
      ints.set([width, height, source.rawWidth, source.flip, source.left, source.top, 0, rows])
      floats.set(source.black, 8)
      floats.set(source.scale, 12)
      floats.set(source.matrix, 16)
      const xyz = [
        0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227,
      ]
      const d65 = [0.950456, 1, 1.088754]
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (let k = 0; k < 3; k++)
            sum = Math.fround(
              sum + Math.fround((xyz[r * 3 + k] * source.matrix[k * 4 + c]) / d65[r]),
            )
          floats[28 + r * 4 + c] = sum
        }
      floats[31] = correction || cameraOnly || merge || consumer ? 1 : 0
      floats[35] = source.normalization?.restoreGain ?? 1
      floats[39] = Number(!!source.normalization)
      // Reference demosaics, merge preparation and camera consumers remain unclipped.
      const blend =
        correction && !cameraOnly && !merge && !consumer
          ? sensorBlendParameters(source.normalization)
          : null
      if (blend) {
        floats.set([...blend.saturation, blend.clip, ...blend.white, 1], 60)
      }
      floats[40] = adjustments.exposureEv
      floats[41] = adjustments.contrast
      floats[43] = adjustments.highlights
      floats[44] = adjustments.shadows
      floats[45] = adjustments.whites
      floats[46] = adjustments.blacks
      const wb = whiteBalanceMatrix(adjustments.whiteBalance, source.whiteBalance)
      floats[47] = Number(!!wb)
      for (let r = 0; r < 3; r++)
        floats.set((wb ?? identityMatrix).slice(r * 3, r * 3 + 3), 48 + r * 4)
      const dispatch = (encoder: GPUCommandEncoder, name: string, dispatchRows: number) => {
        const pass = encoder.beginComputePass({ label: name })
        pass.setPipeline(this.pipelines.get(name)!)
        pass.setBindGroup(0, groups.get(name)!)
        pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(dispatchRows / 16))
        pass.end()
      }
      timings.uploadMs = performance.now() - upload
      const processing = performance.now()
      device.queue.writeBuffer(uniform, 0, params)
      for (let top = 0; !reuse && top < height; top += rows) {
        if (consumer) await consumer.checkpoint()
        const count = Math.min(rows, height - top)
        ints[6] = top
        ints[7] = count
        device.queue.writeBuffer(uniform, 0, params)
        const encoder = device.createCommandEncoder()
        for (const name of ['interpolateGreen', 'interpolateColor', 'buildHomogeneity'])
          dispatch(encoder, name, count + 12)
        dispatch(encoder, 'combine', count)
        device.queue.submit([encoder.finish()])
      }
      const readBuffer = async (buffer: GPUBuffer, length: number) => {
        const staging = makeBuffer(length, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        const encoder = device.createCommandEncoder()
        encoder.copyBufferToBuffer(buffer, 0, staging, 0, length)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        const copy = staging.getMappedRange().slice(0)
        staging.unmap()
        staging.destroy()
        return copy
      }
      this.cameraSource = source
      this.correctedMode = !!correction
      if (consumer) {
        await device.queue.onSubmittedWorkDone()
        // The consumer reserves its live allocations in the shared 1 GiB budget.
        for (const resource of resources) resource.destroy()
        await consumer.checkpoint()
        await consumer.consume(linear, device)
        await device.queue.onSubmittedWorkDone()
        const oom = await device.popErrorScope(),
          validation = await device.popErrorScope()
        if (oom || validation) throw new Error((oom ?? validation)!.message)
        timings.processingMs = performance.now() - processing
        this.releaseFrame()
        return {
          data: Buffer.alloc(0),
          width,
          height,
          adapter: this.adapter,
          timings,
          gpuBytes: estimatedBytes,
        }
      }
      if (merge && correction && source.normalization?.sourceSaturation) {
        await device.queue.onSubmittedWorkDone()
        for (const resource of [green, rgb, lab, homo, labCurve, output, curve, histogram])
          resource.destroy()
        const nativeWidth = source.flip & 4 ? correction.height : correction.width,
          nativeHeight = source.flip & 4 ? correction.width : correction.height
        const prepared = device.createTexture({
          size: [nativeWidth, nativeHeight],
          format: 'rgba32float',
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        })
        try {
          if (!this.pipelines.has('merge-prepare')) {
            const module = device.createShaderModule({ code: mergePrepareShader })
            const errors = (await module.getCompilationInfo()).messages.filter(
              (m) => m.type === 'error',
            )
            if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
            for (const name of ['saturation', 'prepare', 'reduce'])
              this.pipelines.set(
                `merge-${name}`,
                await device.createComputePipelineAsync({
                  layout: 'auto',
                  compute: { module, entryPoint: name },
                }),
              )
          }
          const parameters = mergePreparationParameters(
            source,
            correction,
            merge.gains,
            merge.reviewWidth,
            merge.reviewHeight,
          )
          const uniform = makeBuffer(
              144,
              GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
              new Uint8Array(parameters),
            ),
            saturation = makeBuffer(width * height * 4, storage),
            lut = makeBuffer(correction.lut.byteLength, storage, correction.lut),
            reduced = makeBuffer(
              merge.reviewWidth * merge.reviewHeight * 32,
              storage | GPUBufferUsage.COPY_SRC,
            )
          const bindings: Record<number, GPUBindingResource> = {
            0: { buffer: uniform },
            1: { buffer: raw },
            2: { buffer: saturation },
            3: linear.createView(),
            4: prepared.createView(),
            5: { buffer: lut },
            6: prepared.createView(),
            7: { buffer: reduced },
          }
          for (const [name, indices, w, h] of [
            ['saturation', [0, 1, 2], width, height],
            ['prepare', [0, 2, 3, 4, 5], nativeWidth, nativeHeight],
            ['reduce', [0, 6, 7], merge.reviewWidth, merge.reviewHeight],
          ] as const) {
            const pipeline = this.pipelines.get(`merge-${name}`)!,
              group = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: indices.map((binding) => ({ binding, resource: bindings[binding] })),
              }),
              encoder = device.createCommandEncoder(),
              pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, group)
            pass.dispatchWorkgroups(
              Math.ceil(w / (name === 'reduce' ? 8 : 16)),
              Math.ceil(h / (name === 'reduce' ? 8 : 16)),
            )
            pass.end()
            device.queue.submit([encoder.finish()])
          }
          const mergeReduced = new Float32Array(await readBuffer(reduced, reduced.size))
          this.releaseFrame()
          const rowBytes = Math.ceil((nativeWidth * 16) / 256) * 256
          const staging = makeBuffer(
            rowBytes * 256,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          )
          const bytes = Buffer.allocUnsafe(nativeWidth * 256 * 16)
          for (let top = 0; top < nativeHeight; top += 256) {
            await merge.checkpoint()
            const count = Math.min(256, nativeHeight - top),
              encoder = device.createCommandEncoder()
            encoder.copyTextureToBuffer(
              { texture: prepared, origin: [0, top] },
              { buffer: staging, bytesPerRow: rowBytes },
              [nativeWidth, count],
            )
            device.queue.submit([encoder.finish()])
            await staging.mapAsync(GPUMapMode.READ)
            const mapped = Buffer.from(staging.getMappedRange())
            for (let row = 0; row < count; row++)
              mapped.copy(
                bytes,
                row * nativeWidth * 16,
                row * rowBytes,
                row * rowBytes + nativeWidth * 16,
              )
            await merge.strip(top, bytes.subarray(0, nativeWidth * count * 16))
            staging.unmap()
          }
          const oom = await device.popErrorScope(),
            validation = await device.popErrorScope()
          if (oom || validation) throw new Error((oom ?? validation)!.message)
          timings.processingMs = performance.now() - processing
          return {
            data: Buffer.alloc(0),
            width: nativeWidth,
            height: nativeHeight,
            adapter: this.adapter,
            timings,
            mergeReduced,
            gpuBytes: Math.max(
              estimatedBytes,
              width * height * 20 +
                nativeWidth * nativeHeight * 16 +
                raw.size +
                rowBytes * 256 +
                reduced.size +
                uniform.size +
                lut.size,
            ),
          }
        } finally {
          prepared.destroy()
        }
      }
      if (cameraOnly) {
        await device.queue.onSubmittedWorkDone()
        for (const resource of resources) resource.destroy()
        if (width * height * 16 + source.pixels.byteLength > 384 * 1024 ** 2)
          throw new Error('This RAW exceeds the retained CPU memory limit.')
        const pixels = new Float32Array(width * height * 4)
        const rowBytes = Math.ceil((width * 16) / 256) * 256
        for (let y = 0; y < height; y += 64) {
          const count = Math.min(64, height - y)
          const staging = makeBuffer(
            rowBytes * count,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          )
          const copy = device.createCommandEncoder()
          copy.copyTextureToBuffer(
            { texture: linear, origin: [0, y] },
            { buffer: staging, bytesPerRow: rowBytes },
            [width, count],
          )
          device.queue.submit([copy.finish()])
          await staging.mapAsync(GPUMapMode.READ)
          const values = new Float32Array(staging.getMappedRange())
          for (let row = 0; row < count; row++)
            pixels.set(
              values.subarray((row * rowBytes) / 4, (row * rowBytes) / 4 + width * 4),
              (y + row) * width * 4,
            )
          staging.unmap()
          staging.destroy()
        }
        this.releaseFrame()
        const oom = await device.popErrorScope(),
          validation = await device.popErrorScope()
        if (oom || validation) throw new Error((oom ?? validation)!.message)
        return {
          data: Buffer.alloc(0),
          width,
          height,
          adapter: this.adapter,
          timings,
          working: {
            data: pixels,
            width,
            height,
            transform: { white: 1, threshold: 0.0031308, offset: 0.055, quantize: false },
          },
        }
      }
      let corrected: GPUTexture | undefined
      if (source.normalization) source.normalization.referenceWhite = 1
      if (correction) {
        const correctionStart = performance.now()
        // Demosaic resources are no longer needed before allocating the second float texture.
        await device.queue.onSubmittedWorkDone()
        for (const resource of [raw, green, rgb, lab, homo, labCurve]) resource.destroy()
        this.cameraSource = source
        corrected = device.createTexture({
          size: [correction.width, correction.height],
          format: 'rgba32float',
          usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
        })
        const lensParams = new ArrayBuffer(80)
        new Uint32Array(lensParams).set([
          width,
          height,
          correction.width,
          correction.height,
          correction.left,
          correction.top,
          Number(!!source.normalization),
          0,
        ])
        new Float32Array(lensParams).set(source.matrix, 8)
        if (source.normalization) {
          const gain = source.normalization.restoreGain / source.normalization.referenceWhite
          const matrix = [0, 1, 2].flatMap((r) =>
            [0, 1, 2, 3].map(
              (c) =>
                (SRGB_TO_2020[r * 3] * source.matrix[c] +
                  SRGB_TO_2020[r * 3 + 1] * source.matrix[4 + c] +
                  SRGB_TO_2020[r * 3 + 2] * source.matrix[8 + c]) *
                gain,
            ),
          )
          new Float32Array(lensParams).set(matrix, 8)
        }
        const lensUniform = makeBuffer(
          80,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          new Uint8Array(lensParams),
        )
        const lut = makeBuffer(correction.lut.byteLength, storage, correction.lut)
        device.queue.writeBuffer(histogram, 0, new Uint32Array(3 * 8192))
        const pipeline = this.pipelines.get('correct')!
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: lensUniform } },
            { binding: 1, resource: linear.createView() },
            { binding: 2, resource: corrected.createView() },
            { binding: 3, resource: { buffer: lut } },
            { binding: 4, resource: { buffer: histogram } },
          ],
        })
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(Math.ceil(correction.width / 16), Math.ceil(correction.height / 16))
        pass.end()
        device.queue.submit([encoder.finish()])
        ints[0] = correction.width
        ints[1] = correction.height
        device.queue.writeBuffer(uniform, 0, params)
        groups.set(
          'display',
          device.createBindGroup({
            layout: this.pipelines.get('display')!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 8, resource: { buffer: output } },
              { binding: 9, resource: { buffer: curve } },
              { binding: 11, resource: corrected.createView() },
            ],
          }),
        )
        await device.queue.onSubmittedWorkDone()
        timings.correctionMs = performance.now() - correctionStart
      }
      const outWidth = correction?.width ?? width,
        outHeight = correction?.height ?? height
      const histogramData = source.normalization
        ? new Uint32Array(0)
        : reuse && !correction && this.histogram
          ? this.histogram
          : new Uint32Array(await readBuffer(histogram, 3 * 8192 * 4))
      this.histogram = histogramData
      timings.reusedLinear = Number(reuse)
      timings.processingMs = performance.now() - processing
      const display = performance.now()
      let data = Buffer.alloc(0)
      if (!source.normalization) {
        floats[42] = displayTransform(histogramData, outWidth * outHeight).white
        device.queue.writeBuffer(uniform, 0, params)
        device.queue.writeBuffer(curve, 0, displayCurve(histogramData, outWidth * outHeight))
        const encoder = device.createCommandEncoder()
        dispatch(encoder, 'display', height)
        device.queue.submit([encoder.finish()])
        data = Buffer.from(await readBuffer(output, outWidth * outHeight * 4))
      }
      let working: WorkingFrame | undefined
      if (exportLinear) {
        for (const resource of [output, curve, histogram, uniform]) resource.destroy()
        const rowBytes = Math.ceil((outWidth * 16) / 256) * 256
        if (source.normalization) {
          const orientedWidth = source.flip & 4 ? outHeight : outWidth
          const pixels = new Float32Array(outWidth * outHeight * 4)
          for (let top = 0; top < outHeight; top += 64) {
            const count = Math.min(64, outHeight - top)
            const staging = makeBuffer(
              rowBytes * count,
              GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            )
            const copy = device.createCommandEncoder()
            copy.copyTextureToBuffer(
              { texture: corrected ?? linear, origin: [0, top] },
              { buffer: staging, bytesPerRow: rowBytes },
              [outWidth, count],
            )
            device.queue.submit([copy.finish()])
            await staging.mapAsync(GPUMapMode.READ)
            const values = new Float32Array(staging.getMappedRange())
            for (let row = 0; row < count; row++)
              for (let x = 0; x < outWidth; x++) {
                const y = top + row
                let dx = source.flip & 1 ? outWidth - 1 - x : x,
                  dy = source.flip & 2 ? outHeight - 1 - y : y
                if (source.flip & 4) [dx, dy] = [dy, dx]
                const from = (row * rowBytes) / 4 + x * 4,
                  to = (dy * orientedWidth + dx) * 4
                for (let c = 0; c < 4; c++) pixels[to + c] = values[from + c]
              }
            staging.unmap()
            staging.destroy()
          }
          working = {
            data: pixels,
            width: orientedWidth,
            height: source.flip & 4 ? outWidth : outHeight,
            transform: { white: 1, threshold: 0.0031308, offset: 0.055, quantize: false },
          }
        } else {
          const staging = makeBuffer(
            rowBytes * outHeight,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          )
          const copy = device.createCommandEncoder()
          copy.copyTextureToBuffer(
            { texture: corrected ?? linear },
            { buffer: staging, bytesPerRow: rowBytes },
            [outWidth, outHeight],
          )
          device.queue.submit([copy.finish()])
          await staging.mapAsync(GPUMapMode.READ)
          const sourcePixels = new Float32Array(staging.getMappedRange())
          const orientedWidth = source.flip & 4 ? outHeight : outWidth
          const pixels = new Float32Array(outWidth * outHeight * 4)
          for (let y = 0; y < outHeight; y++)
            for (let x = 0; x < outWidth; x++) {
              let dx = source.flip & 1 ? outWidth - 1 - x : x,
                dy = source.flip & 2 ? outHeight - 1 - y : y
              if (source.flip & 4) [dx, dy] = [dy, dx]
              const from = (y * rowBytes) / 4 + x * 4,
                to = (dy * orientedWidth + dx) * 4
              for (let c = 0; c < 4; c++) pixels[to + c] = sourcePixels[from + c]
            }
          staging.unmap()
          staging.destroy()
          working = {
            data: pixels,
            width: orientedWidth,
            height: source.flip & 4 ? outWidth : outHeight,
            transform: {
              ...displayTransform(histogramData, outWidth * outHeight),
              whiteBalance: source.whiteBalance,
            },
          }
        }
      }
      corrected?.destroy()
      timings.displayReadbackMs = performance.now() - display
      const oom = await device.popErrorScope(),
        validation = await device.popErrorScope()
      if (oom || validation) throw new Error((oom ?? validation)!.message)
      return {
        hdrPrepared: !!source.normalization && !!correction,
        working,
        data,
        width: source.flip & 4 ? outHeight : outWidth,
        height: source.flip & 4 ? outWidth : outHeight,
        adapter: this.adapter,
        timings,
      }
    } catch (error) {
      this.releaseFrame()
      // A device error disables this worker's GPU path; the caller regenerates on CPU.
      this.unavailable = error instanceof Error ? error.message : String(error)
      this.close()
      throw error
    } finally {
      for (const resource of resources) resource.destroy()
    }
  }
}
