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
import { fitScale, type View } from '../src/renderer/src/preview/geometry'
import {
  hdrAdjustmentMatrix,
  SDR_TARGET,
  type DisplayTarget,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import {
  ACES_INTERACTIVE_PREVIEW_VERSION,
  acesPreviewWgsl,
  acesSdrPreviewWgsl,
} from '../src/shared/aces-preview-wgsl'
import { acesWgsl } from '../src/shared/aces-wgsl'
import {
  selectInteractivePreviewPolicy,
  type AcesPreviewPolicy,
} from '../src/shared/interactive-preview-policy'
import {
  DISPLAY_RENDERING_VERSION,
  HDR_CONTENT_TARGET,
  REC2020_TO_ACES,
  prepareDisplayRendering,
} from '../src/shared/display-rendering'
import { buildAcesReference, referenceAces } from './aces-reference'
import { referenceAdjust } from './hdr-reference'
import { fromHalf } from './export-reference'
import {
  photographPreviewBudget,
  photographPreviewMetrics,
} from './interactive-preview-quality.helpers'

// Independent isolated proof admission, separate from application resource preferences.
const PHOTOGRAPHIC_PROOF_GPU_BUDGET_BYTES = 2 * 1024 ** 3

const requestedProfile = process.env.LUMA_INTERACTIVE_QUALITY_PROFILE
if (
  requestedProfile !== undefined &&
  ![
    'linux-held-reply-dpr1',
    'linux-accuracy-offenders-dpr2',
    'linux-deer-neutral-fit-dpr2',
  ].includes(requestedProfile)
)
  throw new Error(`Unknown interactive quality profile: ${requestedProfile}`)
const heldReplyReplay = requestedProfile === 'linux-held-reply-dpr1'
const accuracyOffenderReplay = requestedProfile === 'linux-accuracy-offenders-dpr2'
const deerNeutralFitReplay = requestedProfile === 'linux-deer-neutral-fit-dpr2'
const qualityDescription = heldReplyReplay
  ? 'Linux held-reply DPR1 numerical replay retains photographic precision in both SDR gamuts'
  : accuracyOffenderReplay
    ? 'Linux accuracy-offenders DPR2 targeted numerical replay retains photographic precision'
    : deerNeutralFitReplay
      ? 'Linux deer neutral Fit DPR2 numerical replay diagnoses the retained photographic seam'
      : 'Retina Fit and native-detail crops retain photographic precision during interactive preview'
const heldReplyWorkingSha256 = '632578e368f3ed0b538291b9a4082c5b3f4a7362bf6304083b7f723ed7d381a1'
const deerNeutralWorkingSha256 = 'e0f54018ffd6506b1b19eefac33aa8139a2bb5d442bc3669a96dc257a6276856'
const deerNeutralSite = { x: 1203, y: 976 } as const
const siteStageNames = [
  'input-aces',
  'clamped-ap0',
  'input-aab',
  'input-jmh',
  'toned-jmh',
  'gamut-jmh',
  'interval-weight-low-high',
  'native-angle-degrees-actual-hue-gamma',
  'direct-linear-output',
] as const
const heldReplySites = [
  { x: 127, y: 55, channel: 0 },
  { x: 417, y: 110, channel: 0 },
  { x: 325, y: 257, channel: 0 },
  { x: 34, y: 282, channel: 0 },
  { x: 416, y: 362, channel: 2 },
] as const

const sources = [
  {
    name: 'street',
    sourcePath: 'tests/fixtures/sony-zv1.ARW',
    sourceSha256: '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
    coverage: 'Tree foliage, branches, street/cars, shadows and sky gradients.',
  },
  {
    name: 'deer',
    sourcePath: 'tests/fixtures/research-sony/originals/DSC03243.ARW',
    sourceSha256: '93880fc72a77553efd7a4f9b1f6d2462d0175cee94ae37f330903f70f78581ee',
    coverage:
      'Fine deer fur, grass, antlers, roof gradients, shaded building and background people.',
  },
] as const
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
let retainedGpu: GPU | undefined

async function photoProof(
  device: GPUDevice,
  asset: HdrWorkingAsset,
  workingPath: string,
  referenceBinary: string,
  errors: readonly string[],
) {
  const viewport = heldReplyReplay ? { width: 628, height: 518 } : { width: 914, height: 502 },
    dpr = heldReplyReplay ? 1 : 2,
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
    (deerNeutralFitReplay ? 2048 : 0) +
    asset.width * Math.min(64, asset.height) * 16 * 3
  if (ownedGpuBytes > PHOTOGRAPHIC_PROOF_GPU_BUDGET_BYTES)
    throw new Error('Photographic proof exceeds its isolated diagnostic GPU memory budget.')
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
  const siteOutput = deerNeutralFitReplay
    ? buffer(1024, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    : undefined
  const siteReadback = deerNeutralFitReplay
    ? buffer(1024, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    : undefined
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
    const pipelines = new Map<
      AcesPreviewPolicy,
      { pipeline: GPUComputePipeline; kernel: ReturnType<typeof hdrCacheKernel> }
    >()
    for (const policy of [
      'reference',
      selectInteractivePreviewPolicy('f32', 'sdr'),
      selectInteractivePreviewPolicy('f32', 'hdr'),
    ] as const) {
      const kernel = hdrCacheKernel(policy)
      pipelines.set(policy, {
        kernel,
        pipeline: await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
          compute: {
            module: device.createShaderModule({ code: kernel.shader }),
            entryPoint: 'renderTile',
          },
        }),
      })
    }
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
    const sitePipelines = new Map<
      AcesPreviewPolicy,
      { pipeline: GPUComputePipeline; shader: string }
    >()
    if (deerNeutralFitReplay)
      for (const [policy, math] of [
        ['reference', acesWgsl],
        [selectInteractivePreviewPolicy('f32', 'sdr'), acesSdrPreviewWgsl],
        [selectInteractivePreviewPolicy('f32', 'hdr'), acesPreviewWgsl],
      ] as const) {
        const inputMatrix =
          'mat3x3f(' + REC2020_TO_ACES.map((row) => 'vec3f(' + row.join(',') + ')').join(',') + ')'
        const shader = `${hdrShader}
${math}
@group(0) @binding(1) var sourceMip:texture_2d<f32>;
@group(0) @binding(7) var<storage,read_write> site:array<vec4f>;
@compute @workgroup_size(1) fn inspectSite() {
 let position=vec2f(${deerNeutralSite.x}.5,${deerNeutralSite.y}.5);
 let css=position/u.values[1].w;
 let fullSource=(css-u.values[0].xy*.5-u.values[1].xy)/u.values[1].z+u.values[0].zw*.5;
 var point=fullSource;
 if(u.values[1].z<1. || u.values[10].x>0.) {point=fullSource/u.values[0].zw*u.values[8].zw-.5;}
 let base=vec2i(floor(point));let size=vec2i(textureDimensions(cached))-2;
 let tile=clamp(base,vec2i(0),vec2i(u.values[8].zw)-1)/size;
 let layer=lookup[tile.y*i32(u.values[8].x)+tile.x];
 let local=base-tile*size+1;
 let sourceSize=vec2i(textureDimensions(sourceMip));
 site[0]=vec4f(position,css);site[1]=vec4f(fullSource,point);
 site[2]=vec4f(vec2f(base),fract(point));site[3]=vec4f(vec2f(tile),f32(layer),u.values[10].x);
 site[14]=vec4f(vec2f(sourceSize),vec2f(size));
 let offsets=array<vec2i,4>(vec2i(0,0),vec2i(1,0),vec2i(0,1),vec2i(1,1));
 for(var i=0u;i<4u;i++) {
  let pixel=textureLoad(sourceMip,clamp(base+offsets[i],vec2i(0),sourceSize-1),0);
  site[4u+i]=pixel;site[8u+i]=textureLoad(cached,local+offsets[i],layer,0);
  let ap0=${inputMatrix}*pixel.rgb;
  let bounded=clamp_AP0_to_AP1(ap0,0.,aces_ts().forward_limit);
  let aab=RGB_to_Aab(bounded,aces_input_params());let jmh=Aab_to_JMh(aab,aces_input_params());
  let toned=tonemap_and_compress_fwd(jmh);let gamut=gamut_compress_fwd(toned);
  let interval=lookup_hue_interval(toned.z);
  let lo=acesData.values[434+interval-1].x;let hi=acesData.values[434+interval].x;
  let hdp=init_HueDependentGamutParams(toned.z);let angle=atan2(aab.z,aab.y);
  let offset=16u+i*9u;
  site[offset]=vec4f(ap0,pixel.a);site[offset+1u]=vec4f(bounded,pixel.a);
  site[offset+2u]=vec4f(aab,pixel.a);site[offset+3u]=vec4f(jmh,pixel.a);
  site[offset+4u]=vec4f(toned,pixel.a);site[offset+5u]=vec4f(gamut,pixel.a);
  site[offset+6u]=vec4f(f32(interval),interpolation_weight(toned.z,lo,hi),lo,hi);
  site[offset+7u]=vec4f(angle,radians_to_degrees(angle),jmh.z,hdp.gamma_top_inv);
  site[offset+8u]=vec4f(clamp(outputTransform_fwd(${inputMatrix}*pixel.rgb),vec3f(0.),vec3f(u.values[3].z)),pixel.a);
 }
 let pixel=sampleCached(point,false);site[12]=pixel;
 site[13]=vec4f(encoded(mix(vec3f(.00478,.0052,.00563),presentationRgb(pixel.rgb),pixel.a)),1.);
 site[15]=vec4f(quantizeToF16(site[13].rgb),1.);
}`
        sitePipelines.set(policy, {
          shader,
          pipeline: await device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
              module: device.createShaderModule({ code: shader }),
              entryPoint: 'inspectSite',
            },
          }),
        })
      }
    const render = async (
      precision: 'reference' | 'interactive',
      view: View,
      parameters: AdjustmentParameters,
      target: DisplayTarget,
    ) => {
      const arithmeticPolicy =
        precision === 'reference' ? 'reference' : selectInteractivePreviewPolicy('f32', target.mode)
      const compiled = pipelines.get(arithmeticPolicy)!
      const arithmeticShader =
        precision === 'reference'
          ? acesWgsl
          : target.mode === 'sdr'
            ? acesSdrPreviewWgsl
            : acesPreviewWgsl
      const plan = hdrCachePlan(asset, asset, viewport, view, 'after', 0.5, tile)
      plan.variant = `${arithmeticPolicy}:${target.mode}:${target.colorSpace}`
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
      if (heldReplyReplay) {
        values[17] = 0.5
        values[18] = levels
        values[42] = Number(target.headroom !== null)
        values[43] = target.headroom ?? 1
      }
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
        pass.setPipeline(compiled.pipeline)
        pass.setBindGroup(0, cacheGroup)
        pass.dispatchWorkgroups(...compiled.kernel.dispatch(extent, selected.length / 4))
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
      const siteProgram = sitePipelines.get(arithmeticPolicy)
      if (siteProgram && siteOutput && siteReadback) {
        const siteGroup = device.createBindGroup({
          layout: siteProgram.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            {
              binding: 1,
              resource: source.createView({ baseMipLevel: plan.level, mipLevelCount: 1 }),
            },
            { binding: 2, resource: { buffer: lookup } },
            { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
            { binding: 4, resource: { buffer: tables } },
            { binding: 7, resource: { buffer: siteOutput } },
          ],
        })
        const sitePass = encoder.beginComputePass()
        sitePass.setPipeline(siteProgram.pipeline)
        sitePass.setBindGroup(0, siteGroup)
        sitePass.dispatchWorkgroups(1)
        sitePass.end()
        encoder.copyBufferToBuffer(siteOutput, 0, siteReadback, 0, siteOutput.size)
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
      let siteInspection:
        | {
            values: number[]
            sourceRGBA: number[][]
            cachedRGBA: number[][]
            independentRGB: number[][]
            maximumCtlRatio: number
            encodedSurfaceRGBA: number[]
            presentationMatchesSurface: boolean
            coreTraces: Array<{ directMatchesCached: boolean; stages: Record<string, number[]> }>
            shader: string
          }
        | undefined
      if (siteProgram && siteReadback) {
        await siteReadback.mapAsync(GPUMapMode.READ)
        let inspection: Float32Array
        try {
          inspection = new Float32Array(siteReadback.getMappedRange().slice(0))
        } finally {
          siteReadback.unmap()
        }
        const row = (index: number) => Array.from(inspection.subarray(index * 4, index * 4 + 4))
        const sourceRGBA = Array.from({ length: 4 }, (_, index) => row(4 + index))
        const cachedRGBA = Array.from({ length: 4 }, (_, index) => row(8 + index))
        const sameInput = sourceRGBA.map((pixel) => {
          const balanced = wb
            ? [0, 1, 2].map((r) =>
                pixel.slice(0, 3).reduce((sum, value, c) => sum + value * wb[r * 3 + c], 0),
              )
            : pixel.slice(0, 3)
          return referenceAdjust(balanced, parameters)
        })
        const independentRGB = referenceAces(
          referenceBinary,
          sameInput,
          renderingTarget.peak,
          renderingTarget.colorSpace,
        )
        const encodedSurfaceRGBA = Array.from(
          encoded.subarray(
            (deerNeutralSite.y * width + deerNeutralSite.x) * 4,
            (deerNeutralSite.y * width + deerNeutralSite.x) * 4 + 4,
          ),
          fromHalf,
        )
        siteInspection = {
          values: Array.from(inspection),
          sourceRGBA,
          cachedRGBA,
          independentRGB,
          encodedSurfaceRGBA,
          presentationMatchesSurface: row(15).every((value, channel) =>
            Object.is(value, encodedSurfaceRGBA[channel]),
          ),
          maximumCtlRatio: Math.max(
            ...cachedRGBA.flatMap((pixel, index) =>
              pixel
                .slice(0, 3)
                .map(
                  (value, channel) =>
                    Math.abs(value - independentRGB[index][channel]) /
                    (2e-6 + 2e-5 * Math.abs(independentRGB[index][channel])),
                ),
            ),
          ),
          coreTraces: Array.from({ length: 4 }, (_, index) => {
            const stages = Object.fromEntries(
              siteStageNames.map((name, stage) => [name, row(16 + index * 9 + stage)]),
            )
            const direct = stages['direct-linear-output']
            return {
              directMatchesCached: direct.every((value, channel) =>
                Object.is(value, cachedRGBA[index][channel]),
              ),
              stages,
            }
          }),
          shader: siteProgram.shader,
        }
      }
      return {
        arithmeticPolicy,
        arithmeticShaderSha256: digest(Buffer.from(arithmeticShader)),
        tileShaderSha256: digest(Buffer.from(compiled.kernel.shader)),
        encoded,
        photographicAlpha,
        plan,
        uniformSha256: digest(new Uint8Array(values.buffer)),
        uniformValues: heldReplyReplay || deerNeutralFitReplay ? Array.from(values) : undefined,
        siteInspection,
        ...(deerNeutralFitReplay ? { packedTableValues: Array.from(packedTables) } : {}),
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

for (const { name: scene, sourcePath, sourceSha256, coverage } of sources.filter(
  ({ name }) =>
    (!heldReplyReplay || name === 'street') && (!deerNeutralFitReplay || name === 'deer'),
))
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  test(`real Sony ${scene} ${qualityDescription}`, async ({}, info) => {
    test.setTimeout(240000)
    const directory = await mkdtemp(join(tmpdir(), 'luma-interactive-quality-'))
    const engine = new PreviewEngine()
    let device: GPUDevice | undefined, proof: Awaited<ReturnType<typeof photoProof>> | undefined
    const results: unknown[] = []
    const checks: Array<() => void> = []
    const errors: string[] = []
    const fullPairCount = scene === 'street' ? 30 : 36
    const selectedPairCount = heldReplyReplay
      ? 2
      : deerNeutralFitReplay
        ? 2
        : accuracyOffenderReplay
          ? scene === 'street'
            ? 2
            : 1
          : fullPairCount
    const selection = {
      profile: requestedProfile ?? 'default-retina-dpr2',
      selectedPairCount,
      fullPairCount,
      selectedProfilePairCount:
        heldReplyReplay || deerNeutralFitReplay ? 2 : accuracyOffenderReplay ? 3 : 66,
      fullProfilePairCount: 66,
    }
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
      if (heldReplyReplay) expect(asset.sha256).toBe(heldReplyWorkingSha256)
      if (deerNeutralFitReplay) expect(asset.sha256).toBe(deerNeutralWorkingSha256)
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
        ...(heldReplyReplay
          ? []
          : [
              [0.25, 0.25],
              [0.75, 0.25],
              [0.25, 0.75],
              [0.75, 0.75],
            ]
        ).map(([x, y], i) => ({
          name: `native-${i}`,
          view: { fit: false, scale: 1, x: asset.width * (0.5 - x), y: asset.height * (0.5 - y) },
        })),
        ...(!heldReplyReplay && scene === 'deer'
          ? [{ name: 'native-fur', view: { fit: false, scale: 1, x: 0, y: asset.height * 0.1 } }]
          : []),
      ]
      const edits: AdjustmentParameters[] = heldReplyReplay
        ? [
            {
              exposureEv: 1.75,
              contrast: 45,
              highlights: -55,
              shadows: 40,
              whites: 20,
              blacks: -25,
              whiteBalance: { mode: 'custom', kelvin: 4500, tint: 12 },
            },
          ]
        : [
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
        ...(heldReplyReplay
          ? [
              {
                ...SDR_TARGET,
                mode: 'sdr',
                peak: 1,
                colorSpace: 'display-p3',
                headroom: 1,
                generation: 0,
              } satisfies DisplayTarget,
            ]
          : [
              {
                ...SDR_TARGET,
                mode: 'hdr',
                peak: 4,
                colorSpace: 'display-p3',
                headroom: 4,
                generation: 0,
              } satisfies DisplayTarget,
            ]),
      ]
      const selectedPairs = targets
        .flatMap((target) =>
          views.flatMap(({ name, view }) => edits.map((_, edit) => ({ target, name, view, edit }))),
        )
        .filter(({ name, edit }) => !deerNeutralFitReplay || (name === 'fit' && edit === 0))
        .filter(
          ({ target, name, edit }) =>
            !accuracyOffenderReplay ||
            (target.mode === 'hdr' &&
              target.peak === 4 &&
              target.colorSpace === 'display-p3' &&
              edit === 1 &&
              (scene === 'street' ? name === 'fit' || name === 'native-2' : name === 'native-fur')),
        )
      expect(selectedPairs).toHaveLength(selectedPairCount)
      for (const { target, name, view, edit } of selectedPairs) {
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
        const prefix = `${heldReplyReplay ? `numerical-replay-${target.colorSpace}-` : ''}${target.mode}-${name}-edit-${edit}`
        const save = async (suffix: string, data: Uint8Array) => {
          const path = info.outputPath(`${prefix}-${suffix}`)
          await writeFile(path, data)
          return { file: `${prefix}-${suffix}`, bytes: data.byteLength, sha256: digest(data) }
        }
        const evidence = []
        if (deerNeutralFitReplay) {
          if (!reference.siteInspection || !interactive.siteInspection)
            throw new Error('The focused seam replay omitted its exact GPU site inspection.')
          const referenceSite = reference.siteInspection
          const interactiveSite = interactive.siteInspection
          for (const [label, rendered] of [
            ['reference', reference],
            ['interactive', interactive],
          ] as const) {
            evidence.push(
              await save(
                `${label}-uniforms.f32`,
                new Uint8Array(new Float32Array(rendered.uniformValues!).buffer),
              ),
            )
            evidence.push(
              await save(
                `${label}-tables.f32`,
                new Uint8Array(new Float32Array(rendered.packedTableValues!).buffer),
              ),
            )
            evidence.push(
              await save(
                `${label}-site.f32`,
                new Uint8Array(new Float32Array(rendered.siteInspection!.values).buffer),
              ),
            )
            await writeFile(
              info.outputPath(`${prefix}-${label}-site.wgsl`),
              rendered.siteInspection!.shader,
            )
          }
          await writeFile(
            info.outputPath(`${prefix}-site-inspection.json`),
            JSON.stringify(
              {
                profile: requestedProfile,
                evidenceKind: 'partial numerical replay; not physical display acceptance',
                selectedPairs: 2,
                fullProfilePairs: 66,
                site: deerNeutralSite,
                source,
                target,
                renderingTarget: target.mode === 'hdr' ? HDR_CONTENT_TARGET : target,
                view,
                parameters: edits[edit],
                uniforms: reference.uniformValues,
                rowLayout: {
                  0: 'backing pixel center xy and CSS xy',
                  1: 'full source xy and source-mip xy from actual GPU uniforms',
                  2: 'mip base xy and bilinear fractions xy',
                  3: 'cache tile xy, cache layer, mip level',
                  '4..7': 'four contributing source-mip RGBA32Float texels: 00,10,01,11',
                  '8..11': 'four actually sampled cached linear RGBA32Float texels: 00,10,01,11',
                  12: 'actual production sampleCached linear result',
                  13: 'encoded presentation before binary16 store',
                  14: 'source-mip dimensions xy and cache tile dimensions xy',
                  15: 'probe presentation quantized to binary16 for comparison with actual copied surface',
                  '16..51': 'nine diagnostic core stages per contributing texel',
                },
                independentReference:
                  'Fresh unchanged pinned CTL Float64 C++ output from the four exact GPU-derived source texels; same neutral edits and exact rendering target.',
                sourceTexelsIdentical:
                  JSON.stringify(referenceSite.sourceRGBA) ===
                  JSON.stringify(interactiveSite.sourceRGBA),
                coordinatesIdentical:
                  JSON.stringify(referenceSite.values.slice(0, 12)) ===
                  JSON.stringify(interactiveSite.values.slice(0, 12)),
                canonical: {
                  ...referenceSite,
                  shader: undefined,
                  shaderSha256: digest(Buffer.from(referenceSite.shader)),
                },
                interactive: {
                  ...interactiveSite,
                  shader: undefined,
                  shaderSha256: digest(Buffer.from(interactiveSite.shader)),
                },
                traceFidelity:
                  'Core-stage instrumentation is diagnostic; directMatchesCached must hold before attributing a core-stage delta. Actual copied cache texels and fresh independent CTL outputs remain the comparison authority.',
              },
              null,
              2,
            ) + '\n',
          )
        }
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
          ...selection,
          policy: ACES_INTERACTIVE_PREVIEW_VERSION,
          arithmeticPolicy: interactive.arithmeticPolicy,
          canonicalPolicy: DISPLAY_RENDERING_VERSION,
          canonicalArithmeticShaderSha256: reference.arithmeticShaderSha256,
          interactiveArithmeticShaderSha256: interactive.arithmeticShaderSha256,
          canonicalTileShaderSha256: reference.tileShaderSha256,
          interactiveTileShaderSha256: interactive.tileShaderSha256,
          presentationShaderSha256: digest(Buffer.from(hdrShader)),
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
          ...(deerNeutralFitReplay
            ? {
                profile: requestedProfile,
                evidenceKind: 'partial numerical replay; not physical display acceptance',
                uniformValues: reference.uniformValues,
                siteInspectionFile: `${prefix}-site-inspection.json`,
                canonicalSiteCtlRatio: reference.siteInspection!.maximumCtlRatio,
                interactiveSiteCtlRatio: interactive.siteInspection!.maximumCtlRatio,
              }
            : {}),
          ...(heldReplyReplay
            ? {
                profile: requestedProfile,
                evidenceKind: 'numerical replay; not physical display acceptance',
                parametersSha256: digest(Buffer.from(JSON.stringify(edits[edit]))),
                uniformValues: reference.uniformValues,
                interactiveUniformSha256: interactive.uniformSha256,
                interactiveTablesSha256: interactive.tablesSha256,
                interactiveGeometrySha256: interactive.geometrySha256,
                observedSites: heldReplySites.map(({ x, y, channel }) => {
                  const pixel = y * proof!.width + x,
                    offset = pixel * 4 + channel,
                    canonical = fromHalf(reference.encoded[offset]),
                    candidate = fromHalf(interactive.encoded[offset])
                  return {
                    x,
                    y,
                    channel,
                    canonicalHalfBits: reference.encoded[offset],
                    interactiveHalfBits: interactive.encoded[offset],
                    canonicalEncoded: canonical,
                    interactiveEncoded: candidate,
                    encodedDifference: candidate - canonical,
                    canonicalRounded8Bit: Math.max(0, Math.min(255, Math.round(canonical * 255))),
                    interactiveRounded8Bit: Math.max(0, Math.min(255, Math.round(candidate * 255))),
                    canonicalCoverage: reference.photographicAlpha[pixel],
                    interactiveCoverage: interactive.photographicAlpha[pixel],
                  }
                }),
              }
            : {}),
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
          if (deerNeutralFitReplay) {
            expect(reference.siteInspection!.sourceRGBA, prefix).toEqual(
              interactive.siteInspection!.sourceRGBA,
            )
            expect(reference.siteInspection!.values.slice(0, 12), prefix).toEqual(
              interactive.siteInspection!.values.slice(0, 12),
            )
            expect(
              reference.siteInspection!.maximumCtlRatio,
              `${prefix}: exact worst-site CTL`,
            ).toBeLessThanOrEqual(1)
          }
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
          expect(report.encodedRms, prefix).toBeLessThanOrEqual(photographPreviewBudget.encodedRms)
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
      expect(results).toHaveLength(selectedPairCount)
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
            ...selection,
            measuredPairCount: results.length,
            ...(heldReplyReplay || accuracyOffenderReplay || deerNeutralFitReplay
              ? {
                  evidenceKind: 'numerical replay; not physical display acceptance',
                }
              : {}),
            source,
            backend: 'native Dawn via webgpu; actual production tile shader and final sampler',
            adapter: proofAdapter,
            deviceLimits: proofDeviceLimits,
            originalHashAfter: after,
            originalUnchanged: after === sourceSha256,
            budget: photographPreviewBudget,
            ownedGpuBytes: proof?.ownedGpuBytes,
            nativeInitializationStagingEstimateBytes:
              proof?.nativeInitializationStagingEstimateBytes,
            physicalVram: 'unmeasured; owned logical bytes exclude native driver/uploader pools',
            results,
            errors,
            visualReview:
              'unreviewed; numerical evidence does not prove invisibility to a human observer',
            pngLimitation:
              'PNG proofs clamp extended encoded values to SDR; original rgba16float surfaces and Float32 differences retain HDR values.',
            fixtureCoverage: heldReplyReplay
              ? `${coverage} Exact held-reply Fit geometry and edits; this numerical replay does not exercise Chromium composition or physical display output.`
              : accuracyOffenderReplay
                ? `${coverage} Exact prior HDR/P3 edit-1 ${scene === 'street' ? 'Fit and native-2' : 'native-fur'} offenders at unchanged DPR2 geometry; this targeted numerical replay does not establish full photographic or physical display acceptance.`
                : deerNeutralFitReplay
                  ? `${coverage} Only deer neutral Fit in SDR/sRGB and HDR/P3: two of 66 full-profile pairs. Exact retained worst site (1203,976), source mip, bilinear contributors and fresh same-input independent CTL are numerical diagnostics; no full photographic or physical display acceptance.`
                  : `${coverage} Full Fit and native-detail regions; assistant image inspection is separate from human Retina/HDR acceptance.`,
          },
          null,
          2,
        ),
      )
      expect(after).toBe(sourceSha256)
    }
  })
