import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { readHdrStrips } from '../src/main/processing/hdr-processing'
import { hdrCacheKernel, hdrMipShader, hdrShader } from '../src/renderer/src/preview/hdr-shader'
import { hdrCachePlan, HdrRenderCache } from '../src/renderer/src/preview/hdr-render-cache'
import { HDR_PRESENTATION_BUDGET } from '../src/renderer/src/preview/hdr-memory'
import { fitScale, type View } from '../src/renderer/src/preview/geometry'
import {
  hdrAdjustmentMatrix,
  SDR_TARGET,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import { ACES_INTERACTIVE_PREVIEW_VERSION } from '../src/shared/aces-preview-wgsl'
import {
  DISPLAY_RENDERING_VERSION,
  HDR_CONTENT_TARGET,
  prepareDisplayRendering,
} from '../src/shared/display-rendering'
import { buildAcesReference, referenceAces } from './aces-reference'
import { referenceAdjust } from './hdr-reference'
import { fromHalf } from './export-reference'
import {
  photographPreviewBudget,
  photographPreviewMetrics,
} from './interactive-preview-quality.helpers'

const sourcePath = 'tests/fixtures/sony-zv1.ARW'
const sourceSha256 = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let retainedGpu: GPU | undefined

async function photoProof(
  device: GPUDevice,
  asset: HdrWorkingAsset,
  workingPath: string,
  referenceBinary: string,
  errors: readonly string[],
) {
  const viewport = { width: 914, height: 502 },
    dpr = 2,
    width = viewport.width * dpr,
    height = viewport.height * dpr,
    tile = 64,
    extent = tile + 2,
    capacity = 512,
    levels = Math.floor(Math.log2(Math.max(asset.width, asset.height))) + 1
  const rowBytes = Math.ceil((width * 8) / 256) * 256
  const pixelCount = width * height
  const buffers: GPUBuffer[] = []
  const textures: GPUTexture[] = []
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    buffers.push(value)
    return value
  }
  const texture = (descriptor: GPUTextureDescriptor) => {
    const value = device.createTexture(descriptor)
    textures.push(value)
    return value
  }
  let sourceTextureBytes = 0
  for (let level = 0; level < levels; level++)
    sourceTextureBytes +=
      Math.max(1, asset.width >> level) * Math.max(1, asset.height >> level) * 16
  const ownedGpuBytes =
    sourceTextureBytes +
    extent * extent * capacity * 16 +
    width * height * 8 +
    rowBytes * height +
    pixelCount * 4 * 2 +
    Math.ceil(asset.width / tile) * Math.ceil(asset.height / tile) * 8 +
    capacity * 16 +
    ACES_DATA_BYTES +
    176 +
    16 * 512 +
    asset.width * Math.min(64, asset.height) * 16 * 3
  if (ownedGpuBytes > HDR_PRESENTATION_BUDGET)
    throw new Error('Photographic proof exceeds the existing presentation memory budget.')
  const source = texture({
    size: [asset.width, asset.height],
    mipLevelCount: levels,
    format: 'rgba32float',
    usage:
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING,
  })
  const assertGpuValid = () => {
    if (errors.length) throw new Error(`Photographic GPU proof failed: ${errors[0]}`)
  }
  // Finish native initialization before allocating the tile/surface resources.
  // Strips bound owned transport, but Dawn may require a full-image staging
  // allocation internally. Match production device limits; this is not VRAM telemetry.
  try {
    let row = 0,
      submitted = 0
    for await (const strip of readHdrStrips(workingPath, asset)) {
      device.queue.writeTexture(
        { texture: source, origin: [0, row] },
        strip,
        { bytesPerRow: asset.width * 16 },
        [asset.width, strip.length / (asset.width * 4)],
      )
      row += strip.length / (asset.width * 4)
      if (++submitted % 3 === 0) {
        device.queue.submit([])
        await device.queue.onSubmittedWorkDone()
        assertGpuValid()
      }
    }
    device.queue.submit([])
    await device.queue.onSubmittedWorkDone()
    assertGpuValid()
  } catch (error) {
    source.destroy()
    throw error
  }
  const cached = texture({
    size: [extent, extent, capacity],
    format: 'rgba32float',
    usage:
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  })
  const surface = texture({
    size: [width, height],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  const uniform = buffer(176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const tables = buffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const lookup = buffer(
    Math.ceil(asset.width / tile) * Math.ceil(asset.height / tile) * 8,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  )
  const jobs = buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const coverage = buffer(pixelCount * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  const coverageReadback = buffer(coverage.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  const surfaceReadback = buffer(
    rowBytes * height,
    GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  )
  const holdoutReadback = buffer(16 * 512, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  const destroy = () => {
    for (const value of buffers) value.destroy()
    for (const value of textures) value.destroy()
  }
  try {
    const mip = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: hdrMipShader }), entryPoint: 'down' },
    })
    const mipEncoder = device.createCommandEncoder()
    for (let level = 1; level < levels; level++) {
      const group = device.createBindGroup({
        layout: mip.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: source.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
          },
          { binding: 1, resource: source.createView({ baseMipLevel: level, mipLevelCount: 1 }) },
        ],
      })
      const pass = mipEncoder.beginComputePass()
      pass.setPipeline(mip)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(
        Math.ceil(Math.max(1, asset.width >> level) / 8),
        Math.ceil(Math.max(1, asset.height >> level) / 8),
      )
      pass.end()
    }
    device.queue.submit([mipEncoder.finish()])
    await device.queue.onSubmittedWorkDone()
    assertGpuValid()
    const cacheLayout = device.createBindGroupLayout({
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
    const pipelines = new Map<'reference' | 'interactive', GPUComputePipeline>()
    for (const precision of ['reference', 'interactive'] as const)
      pipelines.set(
        precision,
        await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
          compute: {
            module: device.createShaderModule({
              code: hdrCacheKernel('linear64', precision).shader,
            }),
            entryPoint: 'renderTile',
          },
        }),
      )
    const presentationLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    })
    const presentationModule = device.createShaderModule({ code: hdrShader })
    const presentationPipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [presentationLayout] }),
      vertex: { module: presentationModule, entryPoint: 'vs' },
      fragment: {
        module: presentationModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float' }],
      },
    })
    const coveragePipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [presentationLayout] }),
      compute: {
        module: device.createShaderModule({
          code: `${hdrShader}
@group(0) @binding(6) var<storage,read_write> coverage:array<f32>;
@compute @workgroup_size(8,8) fn inspectCoverage(@builtin(global_invocation_id) p:vec3u) {
  let size=vec2u(u.values[0].xy*u.values[1].w);
  if(any(p.xy>=size)) {return;}
  let css=(vec2f(p.xy)+.5)/u.values[1].w;
  let source=(css-u.values[0].xy*.5-u.values[1].xy)/u.values[1].z+u.values[0].zw*.5;
  let i=p.y*size.x+p.x;
  if(any(source<vec2f(0.)) || any(source>=u.values[0].zw)) {coverage[i]=-1.;return;}
  var point=source;
  if(u.values[1].z<1. || u.values[10].x>0.) {point=source/u.values[0].zw*u.values[8].zw-.5;}
  coverage[i]=sampleCached(point,false).a;
}`,
        }),
        entryPoint: 'inspectCoverage',
      },
    })
    const presentationGroup = device.createBindGroup({
      layout: presentationLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: lookup } },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 6, resource: { buffer: coverage } },
      ],
    })
    const render = async (
      precision: 'reference' | 'interactive',
      view: View,
      parameters: AdjustmentParameters,
      target: DisplayTarget,
    ) => {
      const plan = hdrCachePlan(asset, asset, viewport, view, 'after', 0.5, tile)
      plan.variant = `${precision}:${target.mode}:${target.colorSpace}`
      if (plan.tiles.length > capacity)
        throw new Error(
          'Photographic proof must retain every required tile for independent inspection.',
        )
      const cache = new HdrRenderCache(capacity)
      const values = new Float32Array(44)
      values.set([
        viewport.width,
        viewport.height,
        asset.width,
        asset.height,
        view.x,
        view.y,
        view.scale,
        dpr,
      ])
      values.set(
        [
          parameters.exposureEv,
          parameters.contrast,
          parameters.highlights,
          parameters.shadows,
          parameters.whites,
          parameters.blacks,
          target.mode === 'hdr' ? 10 : 1,
        ],
        8,
      )
      const wb = hdrAdjustmentMatrix(parameters, asset.whiteBalance)
      values[19] = Number(!!wb)
      if (wb) for (let r = 0; r < 3; r++) values.set(wb.slice(r * 3, r * 3 + 3), 20 + r * 4)
      values.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
      values[37] = target.peak
      values[38] = target.colorSpace === 'display-p3' ? 2 : 1
      values[39] = Number(target.mode === 'hdr')
      values[40] = plan.level
      device.queue.writeBuffer(uniform, 0, values)
      const renderingTarget = target.mode === 'hdr' ? HDR_CONTENT_TARGET : target
      const packedTables = packAces(prepareDisplayRendering(renderingTarget))
      device.queue.writeBuffer(tables, 0, packedTables)
      const cacheGroup = device.createBindGroup({
        layout: cacheLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          {
            binding: 1,
            resource: source.createView({ baseMipLevel: plan.level, mipLevelCount: 1 }),
          },
          { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
          { binding: 4, resource: { buffer: tables } },
          { binding: 5, resource: { buffer: jobs } },
        ],
      })
      const neutral =
        !wb &&
        [
          parameters.exposureEv,
          parameters.contrast,
          parameters.highlights,
          parameters.shadows,
          parameters.whites,
          parameters.blacks,
        ].every((v) => v === 0)
      const batch = [...cache.batches(plan, neutral)][0]
      device.queue.writeBuffer(lookup, 0, batch.lookup)
      for (let first = 0; first < batch.jobs.length; first += 32 * 4) {
        const selected = batch.jobs.subarray(first, first + 32 * 4)
        device.queue.writeBuffer(jobs, 0, selected)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipelines.get(precision)!)
        pass.setBindGroup(0, cacheGroup)
        pass.dispatchWorkgroups(
          ...hdrCacheKernel('linear64', precision).dispatch(extent, selected.length / 4),
        )
        pass.end()
        device.queue.submit([encoder.finish()])
        await device.queue.onSubmittedWorkDone()
        assertGpuValid()
      }
      const selectedTiles = Array.from(
        { length: Math.min(16, plan.tiles.length) },
        (_, i) => plan.tiles[Math.floor((i * plan.tiles.length) / Math.min(16, plan.tiles.length))],
      )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: surface.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0.059, 0.063, 0.067, 1],
          },
        ],
      })
      pass.setPipeline(presentationPipeline)
      pass.setBindGroup(0, presentationGroup)
      pass.draw(3)
      pass.end()
      const coveragePass = encoder.beginComputePass()
      coveragePass.setPipeline(coveragePipeline)
      coveragePass.setBindGroup(0, presentationGroup)
      coveragePass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
      coveragePass.end()
      encoder.copyBufferToBuffer(coverage, 0, coverageReadback, 0, coverage.size)
      encoder.copyTextureToBuffer(
        { texture: surface },
        { buffer: surfaceReadback, bytesPerRow: rowBytes },
        [width, height],
      )
      for (let i = 0; i < selectedTiles.length; i++) {
        const value = selectedTiles[i]
        const slot = batch.lookup[value.y * plan.columns + value.x]
        const sx = Math.min(plan.width - 1, value.x * tile + tile / 2),
          sy = Math.min(plan.height - 1, value.y * tile + tile / 2)
        encoder.copyTextureToBuffer(
          { texture: source, mipLevel: plan.level, origin: [sx, sy] },
          { buffer: holdoutReadback, offset: i * 512, bytesPerRow: 256 },
          [1, 1],
        )
        encoder.copyTextureToBuffer(
          { texture: cached, origin: [sx - value.x * tile + 1, sy - value.y * tile + 1, slot] },
          { buffer: holdoutReadback, offset: i * 512 + 256, bytesPerRow: 256 },
          [1, 1],
        )
      }
      device.queue.submit([encoder.finish()])
      await surfaceReadback.mapAsync(GPUMapMode.READ)
      const encoded = new Uint16Array(pixelCount * 4)
      try {
        assertGpuValid()
        const raw = new Uint16Array(surfaceReadback.getMappedRange())
        for (let y = 0; y < height; y++)
          encoded.set(
            raw.subarray((y * rowBytes) / 2, (y * rowBytes) / 2 + width * 4),
            y * width * 4,
          )
      } finally {
        surfaceReadback.unmap()
      }
      await coverageReadback.mapAsync(GPUMapMode.READ)
      let photographicAlpha: Float32Array
      try {
        photographicAlpha = new Float32Array(coverageReadback.getMappedRange().slice(0))
      } finally {
        coverageReadback.unmap()
      }
      await holdoutReadback.mapAsync(GPUMapMode.READ)
      let holdouts: Float32Array
      try {
        holdouts = new Float32Array(holdoutReadback.getMappedRange().slice(0))
      } finally {
        holdoutReadback.unmap()
      }
      const adjusted = selectedTiles.map((_, i) => {
        const pixel = Array.from(holdouts.subarray(i * 128, i * 128 + 3))
        const balanced = wb
          ? [0, 1, 2].map((r) => pixel.reduce((sum, v, c) => sum + v * wb[r * 3 + c], 0))
          : pixel
        return referenceAdjust(balanced, parameters)
      })
      const expected = referenceAces(
        referenceBinary,
        adjusted,
        renderingTarget.peak,
        renderingTarget.colorSpace,
      )
      let maximumCtlRatio = 0,
        alphaMismatches = 0
      for (let i = 0; i < expected.length; i++) {
        alphaMismatches += Number(holdouts[i * 128 + 3] !== holdouts[i * 128 + 64 + 3])
        for (let c = 0; c < 3; c++)
          maximumCtlRatio = Math.max(
            maximumCtlRatio,
            Math.abs(holdouts[i * 128 + 64 + c] - expected[i][c]) /
              (2e-6 + 2e-5 * Math.abs(expected[i][c])),
          )
      }
      return {
        encoded,
        photographicAlpha,
        plan,
        uniformSha256: digest(new Uint8Array(values.buffer)),
        tablesSha256: digest(new Uint8Array(packedTables.buffer)),
        geometrySha256: digest(Buffer.from(JSON.stringify({ ...plan, variant: undefined }))),
        holdout: {
          count: expected.length,
          maximumCtlRatio,
          alphaMismatches,
          expected,
          observed: selectedTiles.map((_, i) =>
            Array.from(holdouts.subarray(i * 128 + 64, i * 128 + 68)),
          ),
        },
      }
    }
    return {
      viewport,
      dpr,
      width,
      height,
      render,
      ownedGpuBytes,
      nativeInitializationStagingEstimateBytes: asset.byteLength,
      destroy,
    }
  } catch (error) {
    destroy()
    throw error
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('real Sony Retina Fit and native-detail crops retain photographic precision during interactive preview', async ({}, info) => {
  test.setTimeout(240000)
  const directory = await mkdtemp(join(tmpdir(), 'luma-interactive-quality-'))
  const engine = new PreviewEngine()
  let device: GPUDevice | undefined, proof: Awaited<ReturnType<typeof photoProof>> | undefined
  const results: unknown[] = []
  const checks: Array<() => void> = []
  const errors: string[] = []
  let source: unknown, proofAdapter: unknown, proofDeviceLimits: unknown
  try {
    expect(digest(await readFile(sourcePath))).toBe(sourceSha256)
    const metadata = await engine.inspect(sourcePath)
    const prepared = await engine.renderFull(sourcePath, directory, undefined, {
      metadata,
      settings: { distortion: true, vignetting: true, chromaticAberration: true },
      revision: 0,
      processing: 'hdr-v1',
      adjustments: neutralAdjustments,
      workingOnly: true,
    })
    await engine.close()
    const asset = prepared.linear?.hdr
    if (!asset) throw new Error('Real RAW preparation omitted its validated HDR working asset.')
    source = {
      fixture: sourcePath,
      originalSha256: sourceSha256,
      width: asset.width,
      height: asset.height,
      workingSha256: asset.sha256,
      corrections: prepared.appliedCorrections,
      diagnostics: prepared.diagnostics,
    }
    const referenceDirectory = info.outputPath('reference')
    await mkdir(referenceDirectory, { recursive: true })
    const binary = buildAcesReference(referenceDirectory)
    const { create, globals } = await import('webgpu')
    Object.assign(globalThis, globals)
    retainedGpu = create([])
    const adapter = await retainedGpu.requestAdapter()
    expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
    proofAdapter = {
      vendor: adapter!.info.vendor,
      architecture: adapter!.info.architecture,
      device: adapter!.info.device,
      description: adapter!.info.description,
      isFallbackAdapter: adapter!.info.isFallbackAdapter,
    }
    device = await adapter!.requestDevice({
      requiredLimits: {
        maxTextureArrayLayers: 512,
        maxBufferSize: Math.min(512 * 1024 ** 2, adapter!.limits.maxBufferSize),
      },
    })
    proofDeviceLimits = {
      maxBufferSize: device.limits.maxBufferSize,
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
    }
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
    proof = await photoProof(device, asset, join(directory, 'linear.f32'), binary, errors)
    const views: Array<{ name: string; view: View }> = [
      { name: 'fit', view: { fit: true, scale: fitScale(asset, proof.viewport), x: 0, y: 0 } },
      ...[
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ].map(([x, y], i) => ({
        name: `native-${i}`,
        view: { fit: false, scale: 1, x: asset.width * (0.5 - x), y: asset.height * (0.5 - y) },
      })),
    ]
    const edits: AdjustmentParameters[] = [
      neutralAdjustments,
      {
        ...neutralAdjustments,
        exposureEv: 3.5,
        contrast: 70,
        highlights: -80,
        shadows: 75,
        whites: 40,
        blacks: -55,
        whiteBalance: { mode: 'custom', kelvin: 3500, tint: -20 },
      },
      {
        ...neutralAdjustments,
        exposureEv: -3,
        contrast: -60,
        highlights: 85,
        shadows: -70,
        whites: -50,
        blacks: 55,
        whiteBalance: { mode: 'custom', kelvin: 9000, tint: 35 },
      },
    ]
    const targets: DisplayTarget[] = [
      { ...SDR_TARGET, mode: 'sdr', peak: 1, colorSpace: 'srgb', headroom: 1, generation: 0 },
      { ...SDR_TARGET, mode: 'hdr', peak: 4, colorSpace: 'display-p3', headroom: 4, generation: 0 },
    ]
    for (const target of targets)
      for (const { name, view } of views)
        for (let edit = 0; edit < edits.length; edit++) {
          const reference = await proof.render('reference', view, edits[edit], target)
          const interactive = await proof.render('interactive', view, edits[edit], target)
          const comparison = photographPreviewMetrics(
            reference.encoded,
            interactive.encoded,
            reference.photographicAlpha,
            proof.width,
            proof.height,
            target.peak,
            target.colorSpace,
          )
          const prefix = `${target.mode}-${name}-edit-${edit}`
          const save = async (suffix: string, data: Uint8Array) => {
            const path = info.outputPath(`${prefix}-${suffix}`)
            await writeFile(path, data)
            return { file: `${prefix}-${suffix}`, bytes: data.byteLength, sha256: digest(data) }
          }
          const evidence = []
          for (const [label, half] of [
            ['reference', reference.encoded],
            ['interactive', interactive.encoded],
          ] as const) {
            evidence.push(await save(`${label}.rgba16f`, new Uint8Array(half.buffer)))
            const bytes = Buffer.alloc(half.length)
            for (let i = 0; i < half.length; i++)
              bytes[i] =
                i % 4 === 3 ? 255 : Math.max(0, Math.min(255, Math.round(fromHalf(half[i]) * 255)))
            await sharp(bytes, { raw: { width: proof.width, height: proof.height, channels: 4 } })
              .withIccProfile(target.colorSpace === 'display-p3' ? 'p3' : 'srgb')
              .png()
              .toFile(info.outputPath(`${prefix}-${label}.png`))
          }
          evidence.push(
            await save('difference.rgb32f', new Uint8Array(comparison.differences.buffer)),
          )
          evidence.push(await save('classification.u8', comparison.flags))
          evidence.push(
            await save('coverage.f32', new Uint8Array(reference.photographicAlpha.buffer)),
          )
          const differencePng = Buffer.alloc(comparison.flags.length * 4)
          for (let i = 0; i < comparison.flags.length; i++) {
            for (let c = 0; c < 3; c++)
              differencePng[i * 4 + c] = Math.min(
                255,
                Math.round(Math.abs(comparison.differences[i * 3 + c]) * 128 * 255),
              )
            differencePng[i * 4 + 3] = 255
          }
          await sharp(differencePng, {
            raw: { width: proof.width, height: proof.height, channels: 4 },
          })
            .png()
            .toFile(info.outputPath(`${prefix}-difference-x128.png`))
          const alphaEqual =
            digest(new Uint8Array(reference.photographicAlpha.buffer)) ===
            digest(new Uint8Array(interactive.photographicAlpha.buffer))
          const inputsEqual =
            reference.uniformSha256 === interactive.uniformSha256 &&
            reference.tablesSha256 === interactive.tablesSha256 &&
            reference.geometrySha256 === interactive.geometrySha256
          const record = {
            prefix,
            target,
            view,
            parameters: edits[edit],
            sourceMip: reference.plan.level,
            tileCount: reference.plan.tiles.length,
            dimensions: { width: proof.width, height: proof.height },
            dpr: proof.dpr,
            canonical: reference.holdout,
            interactive: interactive.holdout,
            uniformSha256: reference.uniformSha256,
            tablesSha256: reference.tablesSha256,
            geometrySha256: reference.geometrySha256,
            inputsEqual,
            alphaEqual,
            metrics: comparison.report,
            evidence,
          }
          results.push(record)
          await writeFile(info.outputPath(`${prefix}.json`), JSON.stringify(record, null, 2))
          const report = comparison.report,
            canonicalAlphaMismatches = reference.holdout.alphaMismatches,
            interactiveAlphaMismatches = interactive.holdout.alphaMismatches,
            canonicalCtlRatio = reference.holdout.maximumCtlRatio
          checks.push(() => {
            expect(alphaEqual, prefix).toBe(true)
            expect(inputsEqual, prefix).toBe(true)
            expect(canonicalAlphaMismatches, prefix).toBe(0)
            expect(interactiveAlphaMismatches, prefix).toBe(0)
            expect(canonicalCtlRatio, prefix).toBeLessThanOrEqual(1)
            expect(report.nonfinite, prefix).toBe(0)
            expect(report.displayAlphaMismatches, prefix).toBe(0)
            expect(report.maximumEncodedError, prefix).toBeLessThanOrEqual(
              photographPreviewBudget.maximumEncodedError,
            )
            expect(report.p99EncodedErrorUpperBound, prefix).toBeLessThanOrEqual(
              photographPreviewBudget.p99EncodedError,
            )
            expect(report.encodedRms, prefix).toBeLessThanOrEqual(
              photographPreviewBudget.encodedRms,
            )
            expect(report.maximumGradientDifference, prefix).toBeLessThanOrEqual(
              photographPreviewBudget.maximumGradientDifference,
            )
            expect(report.edgeEnergyRelativeDifference, prefix).toBeLessThanOrEqual(
              photographPreviewBudget.maximumEdgeEnergyRelativeDifference,
            )
            expect(report.meanLuminanceSsim, prefix).toBeGreaterThanOrEqual(
              photographPreviewBudget.minimumLuminanceSsim,
            )
            for (const classified of Object.values(report.classes))
              if (classified.samples) {
                expect(classified.p99EncodedErrorUpperBound, prefix).toBeLessThanOrEqual(
                  photographPreviewBudget.p99EncodedError,
                )
                expect(classified.encodedRms, prefix).toBeLessThanOrEqual(
                  photographPreviewBudget.encodedRms,
                )
              }
          })
        }
    expect(errors).toEqual([])
    for (const check of checks) check()
  } finally {
    await engine.close()
    proof?.destroy()
    device?.destroy()
    retainedGpu = undefined
    await rm(directory, { recursive: true, force: true })
    const after = digest(await readFile(sourcePath))
    await writeFile(
      info.outputPath('interactive-photographic-quality.json'),
      JSON.stringify(
        {
          policy: ACES_INTERACTIVE_PREVIEW_VERSION,
          canonicalPolicy: DISPLAY_RENDERING_VERSION,
          source,
          backend: 'native Dawn via webgpu; actual production tile shader and final sampler',
          adapter: proofAdapter,
          deviceLimits: proofDeviceLimits,
          originalHashAfter: after,
          originalUnchanged: after === sourceSha256,
          budget: photographPreviewBudget,
          ownedGpuBytes: proof?.ownedGpuBytes,
          nativeInitializationStagingEstimateBytes: proof?.nativeInitializationStagingEstimateBytes,
          physicalVram: 'unmeasured; owned logical bytes exclude native driver/uploader pools',
          results,
          errors,
          visualReview:
            'unreviewed; numerical evidence does not prove invisibility to a human observer',
          pngLimitation:
            'PNG proofs clamp extended encoded values to SDR; original rgba16float surfaces and Float32 differences retain HDR values.',
          fixtureCoverage:
            'One real Sony photograph containing tree foliage, branches, street/cars, shadows and sky gradients, shown at full Fit and four native-detail regions. Hair remains uncovered; assistant image inspection is separate from human Retina/HDR acceptance.',
        },
        null,
        2,
      ),
    )
    expect(after).toBe(sourceSha256)
  }
})
