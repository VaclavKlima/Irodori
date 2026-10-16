import {
  HdrRenderCache,
  hdrCachePlan,
  type HdrCachePlan,
} from '../../../src/renderer/src/preview/hdr-render-cache'
import {
  hdrCacheShader,
  hdrMipShader,
  hdrShader,
} from '../../../src/renderer/src/preview/hdr-shader'
import {
  hdrHistogramShader,
  HDR_HISTOGRAM_WORDS,
} from '../../../src/renderer/src/preview/hdr-histogram'
import { packAces } from '../../../src/shared/aces-data'
import { prepareDisplayRendering } from '../../../src/shared/display-rendering'
import type { View } from '../../../src/renderer/src/preview/geometry'

export interface TileInput {
  width: number
  height: number
  data: Float32Array
}
export interface TileRequest {
  viewport: { width: number; height: number }
  view: View
  dpr: number
  parameters: number[]
  identity: string
  quality: 'normal' | 'draft'
  batchSize: number
  waitAfterBatch: boolean
  histogram: boolean
  cold?: boolean
}
/** Shared by native Dawn and a test-only foreground Electron canvas. */
export async function createTileStudy(
  device: GPUDevice,
  input: TileInput,
  canvas?: HTMLCanvasElement,
) {
  const buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = []
  let context: GPUCanvasContext | null | undefined
  let surface: GPUTexture | undefined
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const b = device.createBuffer({ size, usage })
    buffers.push(b)
    return b
  }
  const texture = (width: number, height: number, layers = 1) => {
    const t = device.createTexture({
      size: [width, height, layers],
      format: 'rgba32float',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    })
    textures.push(t)
    return t
  }
  try {
    const source = texture(input.width, input.height),
      levels = [source]
    const uploadAt = performance.now()
    const stripRows = Math.max(1, Math.floor((8 * 1024 ** 2) / (input.width * 16)))
    for (let y = 0; y < input.height; y += stripRows) {
      const rows = Math.min(stripRows, input.height - y)
      device.queue.writeTexture(
        { texture: source, origin: [0, y] },
        // Keep the host transfer allocation bounded and independently owned.
        input.data.slice(y * input.width * 4, (y + rows) * input.width * 4),
        { bytesPerRow: input.width * 16 },
        [input.width, rows],
      )
      await device.queue.onSubmittedWorkDone()
    }
    const mip = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: hdrMipShader }), entryPoint: 'down' },
    })
    let width = input.width,
      height = input.height
    while (width > 1 || height > 1) {
      width = Math.max(1, width >> 1)
      height = Math.max(1, height >> 1)
      const output = texture(width, height),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(mip)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: mip.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: levels.at(-1)!.createView() },
            { binding: 1, resource: output.createView() },
          ],
        }),
      )
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      pass.end()
      device.queue.submit([encoder.finish()])
      levels.push(output)
    }
    await device.queue.onSubmittedWorkDone()
    const uploadAndMipsMs = performance.now() - uploadAt
    const tile = 64,
      extent = tile + 2,
      capacity = 256,
      cache = new HdrRenderCache(capacity)
    const cached = texture(extent, extent, capacity)
    const uniform = buffer(176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const tablesData = packAces(
      prepareDisplayRendering({ mode: 'hdr', peak: 10, colorSpace: 'rec2020' }),
    )
    const tables = buffer(tablesData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const jobs = buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const lookup = buffer(
      Math.ceil(input.width / tile) * Math.ceil(input.height / tile) * 8,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    )
    const histogram = buffer(
      HDR_HISTOGRAM_WORDS * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    )
    const histogramReadback = buffer(
      histogram.size,
      GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    )
    device.queue.writeBuffer(tables, 0, tablesData)
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba32float',
            viewDimension: '2d-array',
          },
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    })
    const rendering = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: hdrCacheShader }),
        entryPoint: 'renderTile',
      },
    })
    const groups = levels.map((level) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: level.createView() },
          { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
          { binding: 4, resource: { buffer: tables } },
          { binding: 5, resource: { buffer: jobs } },
        ],
      }),
    )
    const histogramLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    })
    const histogramPipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [histogramLayout] }),
      compute: {
        module: device.createShaderModule({ code: hdrHistogramShader }),
        entryPoint: 'sampleHistogram',
      },
    })
    const histogramGroup = device.createBindGroup({
      layout: histogramLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: source.createView() },
        { binding: 4, resource: { buffer: tables } },
        { binding: 6, resource: { buffer: histogram } },
      ],
    })
    const samplingLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
      ],
    })
    const presentationGroup = device.createBindGroup({
      layout: samplingLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: lookup } },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
      ],
    })
    context = canvas?.getContext('webgpu')
    let presentation: GPURenderPipeline | undefined
    if (context) {
      const format = 'rgba16float'
      context.configure({
        device,
        format,
        alphaMode: 'opaque',
        colorSpace: 'display-p3',
        toneMapping: { mode: 'extended' },
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      })
      if (context.getConfiguration()?.format !== format)
        throw new Error('Research HDR canvas configuration unavailable.')
      presentation = await device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [samplingLayout] }),
        vertex: { module: device.createShaderModule({ code: hdrShader }), entryPoint: 'vs' },
        fragment: {
          module: device.createShaderModule({ code: hdrShader }),
          entryPoint: 'fs',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      })
    }
    let lastPlan: HdrCachePlan | undefined
    function values(request: TileRequest, plan: HdrCachePlan) {
      const p = new Float32Array(44)
      p.set([
        request.viewport.width,
        request.viewport.height,
        input.width,
        input.height,
        request.view.x,
        request.view.y,
        request.view.scale,
        request.dpr,
      ])
      p.set(request.parameters.slice(8), 8)
      p[14] = 10
      p[37] = 10
      p[38] = 2
      p[39] = 1
      p.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
      p[36] = Math.min(request.quality === 'draft' ? 8192 : 65536, input.width * input.height)
      p[40] = Number(plan.level > 0)
      return p
    }
    async function render(request: TileRequest, stillCurrent: () => boolean = () => true) {
      const at = performance.now()
      if (canvas) {
        const width = Math.round(request.viewport.width * request.dpr),
          height = Math.round(request.viewport.height * request.dpr)
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        if (!surface || surface.width !== width || surface.height !== height) {
          surface?.destroy()
          surface = device.createTexture({
            size: [width, height],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          })
        }
      }
      const invalidateAt = performance.now()
      if (request.cold) cache.reset()
      cache.setEdits(request.identity)
      const invalidationMs = performance.now() - invalidateAt
      const visible =
        Math.min(input.width, request.viewport.width / request.view.scale) *
        Math.min(input.height, request.viewport.height / request.view.scale)
      const draftLevel = Math.max(0, Math.ceil(Math.log2(Math.max(1, visible / 8192)) / 2))
      const normalPlan = hdrCachePlan(
        input,
        input,
        request.viewport,
        request.view,
        'after',
        0.5,
        tile,
      )
      const plan =
        request.quality === 'normal'
          ? normalPlan
          : hdrCachePlan(
              input,
              input,
              request.viewport,
              request.view,
              'after',
              0.5,
              tile,
              draftLevel,
            )
      lastPlan = plan
      device.queue.writeBuffer(uniform, 0, values(request, plan))
      let histogramSubmissionMs = 0
      if (request.histogram) {
        const hAt = performance.now(),
          encoder = device.createCommandEncoder()
        encoder.clearBuffer(histogram)
        const pass = encoder.beginComputePass()
        pass.setPipeline(histogramPipeline)
        pass.setBindGroup(0, histogramGroup)
        pass.dispatchWorkgroups(
          Math.ceil(
            Math.min(request.quality === 'draft' ? 8192 : 65536, input.width * input.height) / 64,
          ),
        )
        pass.end()
        device.queue.submit([encoder.finish()])
        histogramSubmissionMs = performance.now() - hAt
      }
      let batchWaitMs = 0,
        submissionMs = 0,
        renderedTiles = 0,
        submissions = 0,
        drawCount = 0
      let clear = true
      // The owned surface survives batch awaits; a swap-chain texture does not.
      const target = surface?.createView()
      for (const batch of cache.batches(plan, false)) {
        device.queue.writeBuffer(lookup, 0, batch.lookup)
        renderedTiles += batch.renderedTiles
        for (let start = 0; start < batch.jobs.length; start += request.batchSize * 4) {
          const submitAt = performance.now(),
            chunk = batch.jobs.subarray(start, start + request.batchSize * 4)
          device.queue.writeBuffer(jobs, 0, chunk)
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(rendering)
          pass.setBindGroup(0, groups[plan.level])
          pass.dispatchWorkgroups(Math.ceil(extent / 8), Math.ceil(extent / 8), chunk.length / 4)
          pass.end()
          device.queue.submit([encoder.finish()])
          submissions++
          submissionMs += performance.now() - submitAt
          if (request.waitAfterBatch) {
            const waitAt = performance.now()
            await device.queue.onSubmittedWorkDone()
            batchWaitMs += performance.now() - waitAt
          }
          if (!stillCurrent()) {
            await device.queue.onSubmittedWorkDone()
            cache.reset()
            return {
              cancelled: true as const,
              totalMs: performance.now() - at,
              renderedTiles,
              submissions,
            }
          }
        }
        if (target && presentation) {
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: target,
                  clearValue: { r: 0.059, g: 0.063, b: 0.067, a: 1 },
                  loadOp: clear ? 'clear' : 'load',
                  storeOp: 'store',
                },
              ],
            })
          pass.setPipeline(presentation)
          pass.setBindGroup(0, presentationGroup)
          pass.draw(3)
          pass.end()
          device.queue.submit([encoder.finish()])
          clear = false
          drawCount++
        }
      }
      if (context && surface) {
        const encoder = device.createCommandEncoder()
        encoder.copyTextureToTexture(
          { texture: surface },
          { texture: context.getCurrentTexture() },
          [surface.width, surface.height],
        )
        device.queue.submit([encoder.finish()])
      }
      const fenceAt = performance.now()
      let histogramMapMs = 0,
        histogramCount: number | null = null
      if (request.histogram) {
        const encoder = device.createCommandEncoder()
        encoder.copyBufferToBuffer(histogram, 0, histogramReadback, 0, histogram.size)
        device.queue.submit([encoder.finish()])
        const mapAt = performance.now()
        await histogramReadback.mapAsync(GPUMapMode.READ)
        histogramMapMs = performance.now() - mapAt
        histogramCount = new Uint32Array(histogramReadback.getMappedRange())[1792]
        histogramReadback.unmap()
      } else await device.queue.onSubmittedWorkDone()
      return {
        cancelled: false as const,
        totalMs: performance.now() - at,
        invalidationMs,
        submissionMs,
        batchWaitMs,
        completionFenceMs: performance.now() - fenceAt,
        histogramSubmissionMs,
        histogramMapMs,
        histogramCount,
        renderedTiles,
        submissions,
        drawCount,
        level: plan.level,
        normalLevel: normalPlan.level,
        evaluatedTexels: renderedTiles * extent ** 2,
        quality: plan.level === normalPlan.level ? 'normal' : 'draft',
        retainedSharp: renderedTiles === 0 && plan.level === normalPlan.level,
      }
    }
    async function readProof() {
      const plan = lastPlan
      if (!plan || plan.tiles.length > capacity)
        throw new Error('Read proof needs a complete resident single-batch frame.')
      const output = buffer(
        input.width * input.height * 16,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      )
      const readback = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: `${hdrShader}
@group(0) @binding(6) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(8,8) fn proof(@builtin(global_invocation_id) p:vec3u) {
  let size=vec2u(u.values[0].zw);
  if(any(p.xy>=size)) { return; }
  var point=vec2f(p.xy);
  if(u.values[10].x>0.) { point=(point+.5)/vec2f(size)*u.values[8].zw-.5; }
  result[p.y*size.x+p.x]=sampleCached(point,false);
}`,
          }),
          entryPoint: 'proof',
        },
      })
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: lookup } },
          { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
          { binding: 6, resource: { buffer: output } },
        ],
      })
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(input.width / 8), Math.ceil(input.height / 8))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      const result = new Float32Array(readback.getMappedRange().slice(0))
      readback.unmap()
      return result
    }
    return {
      render,
      readProof,
      uploadAndMipsMs,
      get allocatedGpuBytes() {
        return (
          textures.reduce((sum, t) => sum + t.width * t.height * t.depthOrArrayLayers * 16, 0) +
          buffers.reduce((sum, b) => sum + b.size, 0) +
          (surface ? surface.width * surface.height * 8 : 0)
        )
      },
      destroy() {
        context?.unconfigure()
        surface?.destroy()
        buffers.forEach((b) => b.destroy())
        textures.forEach((t) => t.destroy())
      },
    }
  } catch (error) {
    context?.unconfigure()
    surface?.destroy()
    buffers.forEach((b) => b.destroy())
    textures.forEach((t) => t.destroy())
    throw error
  }
}
