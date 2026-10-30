/// <reference types="@webgpu/types" />
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { packAces, ACES_DATA_BYTES } from '../../shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../../shared/display-rendering'
import { hdrAdjustmentMatrix } from '../../shared/hdr'
import { identityMatrix, validateWhiteBalanceProfile } from '../../shared/white-balance'
import { RESOURCE_POLICY_VERSION } from '../../shared/resource-policy'
import { assertOpaqueFiniteRgba16LE } from '../../shared/rgba16-validation'
import {
  hdrFirstSurfaceSnapshot,
  hdrFirstSurfaceImage,
  validateHdrFirstSurfaceOrientation,
  validateHdrFirstSurfaceRequest,
  type HdrFirstSurfaceRenderRequest,
  type HdrFirstSurfaceIdentity,
  type HdrFirstSurfaceManagedBytes,
} from '../../shared/hdr-first-surface'
import { fitScale } from '../../renderer/src/preview/geometry'
import {
  HdrRenderCache,
  HDR_CACHE_MAX_TILES,
  hdrCachePlan,
  hdrCacheTileSize,
} from '../../renderer/src/preview/hdr-render-cache'
import {
  hdrCacheKernel,
  hdrMipShader,
  hdrOrientedMipShader,
  hdrShader,
} from '../../renderer/src/preview/hdr-shader'
import { prepareHdrPipelines } from '../../renderer/src/preview/hdr-pipelines'
import { prepareCreativeColor, creativeColorActive } from '../../shared/creative-color'
import { packCreativeColor, CREATIVE_COLOR_PARAMETER_BYTES } from '../../shared/creative-color-gpu'
import {
  FirstSurfaceConsumerError,
  FirstSurfaceGpuError,
  type FirstSurfaceBorrow,
} from './raw-renderer'

export interface FirstSurfaceReady {
  readonly status: 'ready'
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly sha256: string
  readonly identity: Readonly<HdrFirstSurfaceIdentity>
  readonly identitySha256: string
  readonly timings: Readonly<Record<string, number>>
  /** Peak temporary native owners, excluding borrowed source and Chromium. */
  readonly ownedBytes: Readonly<HdrFirstSurfaceManagedBytes>
  /** Complete admitted phase, including native source and first Chromium display. */
  readonly peakBytes: Readonly<HdrFirstSurfaceManagedBytes>
  readonly owners: Readonly<Record<string, Readonly<HdrFirstSurfaceManagedBytes>>>
  readonly programHashes: Readonly<Record<string, string>>
}
export interface FirstSurfaceDeclined {
  readonly status: 'declined'
  readonly reason:
    'unsupported-view' | 'source-mismatch' | 'invalid-request' | 'device-limit' | 'memory-limit'
  readonly message: string
  readonly peakBytes?: Readonly<HdrFirstSurfaceManagedBytes>
}
export type FirstSurfaceResult = FirstSurfaceReady | FirstSurfaceDeclined

export interface FirstSurfaceOrientationPipeline {
  readonly layout: GPUBindGroupLayout
  readonly pipeline: GPUComputePipeline
}
const orientationPipelines = new WeakMap<GPUDevice, Promise<FirstSurfaceOrientationPipeline>>()
const orientationLostDevices = new WeakSet<GPUDevice>()

/** One immutable, uniform-driven program per owned device; callers may share its prewarm. */
export function prepareFirstSurfaceOrientationPipeline(
  device: GPUDevice,
): Promise<FirstSurfaceOrientationPipeline> {
  if (orientationLostDevices.has(device))
    throw new Error('First surface orientation device was lost.')
  const previous = orientationPipelines.get(device)
  if (previous) return previous
  const pending = Promise.resolve().then(async () => {
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    })
    const pipeline = await device.createComputePipelineAsync({
      label: 'Irodori first oriented source mip',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: {
        module: device.createShaderModule({ code: hdrOrientedMipShader }),
        entryPoint: 'down',
      },
    })
    if (orientationLostDevices.has(device))
      throw new Error('First surface orientation device was lost.')
    return { layout, pipeline }
  })
  orientationPipelines.set(device, pending)
  void pending.catch(() => {
    if (orientationPipelines.get(device) === pending) orientationPipelines.delete(device)
  })
  void device.lost.then(() => {
    orientationLostDevices.add(device)
    orientationPipelines.delete(device)
  })
  return pending
}

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function checked(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid first surface ${name}.`)
  return value
}
function sum(values: readonly number[]) {
  return checked(
    values.reduce((a, b) => checked(a + b, 'owner sum'), 0),
    'owner sum',
  )
}
const bytes = (ramBytes: number, vramBytes: number): Readonly<HdrFirstSurfaceManagedBytes> =>
  Object.freeze({
    ramBytes: checked(ramBytes, 'RAM owner'),
    vramBytes: checked(vramBytes, 'GPU owner'),
  })
const add = (...owners: readonly HdrFirstSurfaceManagedBytes[]) =>
  bytes(sum(owners.map((owner) => owner.ramBytes)), sum(owners.map((owner) => owner.vramBytes)))

/** Produce an exact normal viewport from the corrected RAW texture. The caller
 * retains that borrowed texture until this promise and every submitted use drain.
 * This first production seam declines non-Fit, level-zero rotation, comparison and ranges
 * requests explicitly; ordinary full preparation continues for those cases.
 */
export async function renderFirstSurface(
  borrow: FirstSurfaceBorrow,
  input: Readonly<HdrFirstSurfaceRenderRequest>,
  signal: AbortSignal,
): Promise<FirstSurfaceResult> {
  const started = performance.now()
  if (signal.aborted) throw new FirstSurfaceConsumerError(signal.reason)
  let request: HdrFirstSurfaceRenderRequest
  let wb: number[] | null
  try {
    request = structuredClone(input)
    validateHdrFirstSurfaceRequest(hdrFirstSurfaceSnapshot(request))
    if (
      !/^[a-f0-9]{64}$/.test(request.originalSha256) ||
      !/^[a-f0-9]{64}$/.test(request.parentWorkingKey) ||
      !Number.isSafeInteger(request.image.width) ||
      request.image.width < 1 ||
      !Number.isSafeInteger(request.image.height) ||
      request.image.height < 1 ||
      !request.sourceIdentity ||
      typeof request.sourceIdentity !== 'object' ||
      Array.isArray(request.sourceIdentity) ||
      !Object.keys(request.sourceIdentity).length ||
      request.policy.version !== RESOURCE_POLICY_VERSION ||
      request.policy.scope !== 'managed-image-resources' ||
      !Number.isSafeInteger(request.policy.revision) ||
      request.policy.revision < 0
    )
      throw new Error('Malformed first surface request.')
    if (request.whiteBalance) validateWhiteBalanceProfile(request.whiteBalance)
    wb = hdrAdjustmentMatrix(request.parameters, request.whiteBalance)
    checked(request.policy.ram.effectiveBytes, 'RAM limit')
    checked(request.policy.vram.effectiveBytes, 'GPU limit')
    checked(request.rendererReservation.ramBytes, 'renderer RAM reservation')
    checked(request.rendererReservation.vramBytes, 'renderer GPU reservation')
    checked(borrow.baseEstimatedRamBytes, 'native RAM reservation')
    checked(borrow.baseEstimatedGpuBytes, 'native GPU reservation')
    JSON.stringify(request.sourceIdentity)
  } catch (error) {
    return { status: 'declined', reason: 'invalid-request', message: String(error) }
  }
  if (
    !request.view.fit ||
    request.view.x !== 0 ||
    request.view.y !== 0 ||
    request.comparison !== 'after' ||
    request.hdrRanges !== false
  )
    return {
      status: 'declined',
      reason: 'unsupported-view',
      message: 'First surface currently requires centered Fit/After without ranges.',
    }
  let orientedImage: { readonly width: number; readonly height: number }
  try {
    orientedImage = hdrFirstSurfaceImage(borrow, borrow.flip)
  } catch (error) {
    return { status: 'declined', reason: 'source-mismatch', message: String(error) }
  }
  if (request.image.width !== orientedImage.width || request.image.height !== orientedImage.height)
    return {
      status: 'declined',
      reason: 'source-mismatch',
      message: 'First surface dimensions do not match the borrowed corrected source.',
    }
  const { device } = borrow
  const colour = prepareCreativeColor(request.parameters),
    creative = creativeColorActive(colour),
    colourBytes = creative ? CREATIVE_COLOR_PARAMETER_BYTES : 0
  const image = request.image
  const view = Object.freeze({ fit: true, scale: fitScale(image, request.viewport), x: 0, y: 0 })
  const canvasWidth = Math.max(1, Math.round(request.viewport.width * request.dpr))
  const canvasHeight = Math.max(1, Math.round(request.viewport.height * request.dpr))
  if (
    !Number.isSafeInteger(canvasWidth) ||
    !Number.isSafeInteger(canvasHeight) ||
    canvasWidth > device.limits.maxTextureDimension2D ||
    canvasHeight > device.limits.maxTextureDimension2D ||
    !Number.isFinite(view.scale) ||
    view.scale <= 0 ||
    !Number.isSafeInteger(canvasWidth * canvasHeight * 8)
  )
    return {
      status: 'declined',
      reason: 'device-limit',
      message: 'First surface extent exceeds the actual adapter limits.',
    }
  const surfaceBytes = checked(canvasWidth * canvasHeight * 8, 'surface bytes')
  const tileSize = hdrCacheTileSize(image.width, image.height)
  const plan = hdrCachePlan(image, image, request.viewport, view, 'after', 0.5, tileSize)
  if (borrow.flip !== 0 && plan.level === 0)
    return {
      status: 'declined',
      reason: 'unsupported-view',
      message: 'An oriented first surface requires at least one normal source mip.',
    }
  try {
    const orientation = request.sourceIdentity.orientation
    validateHdrFirstSurfaceOrientation(orientation, image, request.viewport)
    if (
      orientation.decoderFlip !== borrow.flip ||
      orientation.corrected.width !== borrow.width ||
      orientation.corrected.height !== borrow.height ||
      orientation.selectedLevel !== plan.level
    )
      throw new Error('First surface orientation does not match the borrowed corrected source.')
  } catch (error) {
    return { status: 'declined', reason: 'source-mismatch', message: String(error) }
  }
  plan.variant = request.target.mode === 'hdr' ? 'content-hdr' : `sdr-${request.target.colorSpace}`
  const capacityLimit = Math.max(
    1,
    Math.min(HDR_CACHE_MAX_TILES, device.limits.maxTextureArrayLayers, plan.tiles.length),
  )
  const paddedRowBytes = Math.ceil((canvasWidth * 8) / 256) * 256
  const stagingBytes = checked(paddedRowBytes * canvasHeight, 'padded readback')
  const mipOwners: { width: number; height: number; bytes: number }[] = []
  for (let level = 1; level <= plan.level; level++) {
    const width = Math.max(1, image.width >> level),
      height = Math.max(1, image.height >> level)
    mipOwners.push({ width, height, bytes: checked(width * height * 16, 'mip bytes') })
  }
  const tileBytes = checked((tileSize + 2) ** 2 * 16, 'tile slot storage')
  const fixedOwners = {
    mips: sum(mipOwners.map((owner) => owner.bytes)),
    surface: surfaceBytes,
    staging: stagingBytes,
    uniform: 192,
    lookup: checked(plan.columns * plan.rows * 8, 'lookup bytes'),
    tables: ACES_DATA_BYTES,
    orientation: borrow.flip === 0 ? 0 : 16,
    ...(creative ? { creative: colourBytes } : {}),
  }
  const fixedGpuBytes = sum(Object.values(fixedOwners))
  const fixedHostBytes = sum([
    stagingBytes,
    surfaceBytes * 2,
    ACES_DATA_BYTES * 5 + 192 * 3 + fixedOwners.lookup * 4,
    checked(plan.tiles.length * 256, 'tile metadata allowance'),
    fixedOwners.orientation * 2,
    colourBytes * 3,
  ])
  const sharedOwners = Object.freeze({
    nativeSource: bytes(borrow.baseEstimatedRamBytes, borrow.baseEstimatedGpuBytes),
    rendererReserved: bytes(
      request.rendererReservation.ramBytes,
      request.rendererReservation.vramBytes,
    ),
    // Receiver body, digest clone, queued upload copy and bounded stream/write allowance.
    chromiumHalfUpload: bytes(surfaceBytes * 4, surfaceBytes),
    // Conservative native canvas swapchain/backing allowance, separate from old caches.
    chromiumCanvas: bytes(canvasWidth * canvasHeight * 32, canvasWidth * canvasHeight * 32),
  })
  let fixedPeak: Readonly<HdrFirstSurfaceManagedBytes>
  try {
    fixedPeak = add(bytes(fixedHostBytes, fixedGpuBytes), ...Object.values(sharedOwners))
  } catch {
    return {
      status: 'declined',
      reason: 'memory-limit',
      message: 'First surface owner sum exceeds the safe byte range.',
    }
  }
  // Every extra slot owns a GPU tile/job and the existing four-copy host job allowance.
  // Tight budgets retain bounded streaming instead of declining a previously fitting batch.
  const capacity = Math.max(
    1,
    Math.min(
      capacityLimit,
      Math.floor((request.policy.ram.effectiveBytes - fixedPeak.ramBytes) / (16 * 4)),
      Math.floor((request.policy.vram.effectiveBytes - fixedPeak.vramBytes) / (tileBytes + 16)),
    ),
  )
  const owners = {
    ...fixedOwners,
    tiles: checked(tileBytes * capacity, 'tile storage'),
    jobs: checked(capacity * 16, 'job bytes'),
  }
  const gpuBytes = sum(Object.values(owners))
  const hostBytes = sum([fixedHostBytes, owners.jobs * 4])
  const ownedBytes = bytes(hostBytes, gpuBytes)
  const memoryOwners = Object.freeze({
    ...sharedOwners,
    nativeFirstSurface: ownedBytes,
  })
  let peakBytes: Readonly<HdrFirstSurfaceManagedBytes>
  try {
    peakBytes = add(...Object.values(memoryOwners))
  } catch {
    return {
      status: 'declined',
      reason: 'memory-limit',
      message: 'First surface owner sum exceeds the safe byte range.',
    }
  }
  if (
    peakBytes.ramBytes > request.policy.ram.effectiveBytes ||
    peakBytes.vramBytes > request.policy.vram.effectiveBytes
  )
    return {
      status: 'declined',
      reason: 'memory-limit',
      message: 'First surface overlap exceeds the frozen managed image budgets.',
      peakBytes,
    }
  for (const size of [stagingBytes, owners.jobs, owners.lookup, ACES_DATA_BYTES, 192])
    if (size > device.limits.maxBufferSize)
      return {
        status: 'declined',
        reason: 'device-limit',
        message: 'First surface buffer exceeds the actual adapter limit.',
      }
  for (const size of [owners.jobs, owners.lookup, ACES_DATA_BYTES])
    if (size > device.limits.maxStorageBufferBindingSize)
      return {
        status: 'declined',
        reason: 'device-limit',
        message: 'First surface storage binding exceeds the actual adapter limit.',
      }
  const resources: (GPUBuffer | GPUTexture)[] = []
  const own = <T extends GPUBuffer | GPUTexture>(resource: T) => {
    resources.push(resource)
    return resource
  }
  const buffer = (size: number, usage: GPUBufferUsageFlags, label: string) =>
    own(device.createBuffer({ size, usage, label }))
  const scopes: Promise<GPUError | null>[] = []
  let openScopes = 0,
    mapped = false
  let staging: GPUBuffer | undefined
  const timings: Record<string, number> = {
    planningMs: performance.now() - started,
    adapterTextureArrayLayers: borrow.adapterTextureArrayLayers,
    deviceTextureArrayLayers: device.limits.maxTextureArrayLayers,
    sourceTileCount: plan.tiles.length,
    tileCapacity: capacity,
    peakRamBytes: peakBytes.ramBytes,
    peakGpuBytes: peakBytes.vramBytes,
  }
  const cleanup = async () => {
    // A rejected map/aborted request does not prove submitted reads have ended.
    while (openScopes) {
      openScopes--
      scopes.push(device.popErrorScope())
    }
    const settled = await Promise.allSettled(scopes)
    let cleanupFailure: unknown
    for (const entry of settled) {
      if (entry.status === 'rejected') cleanupFailure ??= entry.reason
      else if (entry.value) cleanupFailure ??= entry.value
    }
    try {
      await device.queue.onSubmittedWorkDone()
    } catch (error) {
      cleanupFailure ??= error
    }
    if (mapped || staging?.mapState === 'mapped') staging?.unmap()
    for (const resource of resources.reverse()) resource.destroy()
    if (cleanupFailure) throw new FirstSurfaceGpuError(cleanupFailure)
  }
  try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
      device.pushErrorScope(filter)
      openScopes++
    }
    const compilation = performance.now()
    const prepared = prepareHdrPipelines(device, {
      interactive: false,
      ...(creative ? { creative: true } : {}),
    })
    const [programs, orientedProgram] = await Promise.all([
      prepared.pipelines,
      borrow.flip === 0 ? undefined : prepareFirstSurfaceOrientationPipeline(device),
    ])
    timings.pipelineCacheReady = Number(prepared.state === 'ready')
    timings.pipelineMs = performance.now() - compilation
    signal.throwIfAborted()
    const tablesAt = performance.now()
    const packed = packAces(
      prepareDisplayRendering(
        request.target.mode === 'hdr'
          ? HDR_CONTENT_TARGET
          : { mode: 'sdr', peak: 1, colorSpace: request.target.colorSpace },
      ),
    )
    timings.tablesMs = performance.now() - tablesAt
    signal.throwIfAborted()
    const uniform = buffer(
      192,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      'first viewport params',
    )
    const lookup = buffer(
      owners.lookup,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'first viewport lookup',
    )
    const jobs = buffer(
      owners.jobs,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'first viewport jobs',
    )
    const tables = buffer(
      ACES_DATA_BYTES,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      'first viewport ACES',
    )
    const orientationUniform = orientedProgram
      ? buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'first viewport orientation')
      : undefined
    const colourBuffer = creative
      ? buffer(
          colourBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          'first viewport creative color',
        )
      : undefined
    if (colourBuffer) device.queue.writeBuffer(colourBuffer, 0, packCreativeColor(colour!))
    if (orientationUniform)
      device.queue.writeBuffer(orientationUniform, 0, new Uint32Array([borrow.flip, 0, 0, 0]))
    const cached = own(
      device.createTexture({
        size: [tileSize + 2, tileSize + 2, capacity],
        format: 'rgba32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        label: 'first viewport reference tiles',
      }),
    )
    timings.allocatedTileLayers = cached.depthOrArrayLayers
    timings.allocatedTileBytes = checked(
      cached.width * cached.height * cached.depthOrArrayLayers * 16,
      'allocated tile storage',
    )
    const surface = own(
      device.createTexture({
        size: [canvasWidth, canvasHeight],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        label: 'first viewport exact viewport half surface',
      }),
    )
    staging = buffer(
      stagingBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      'first viewport half readback',
    )
    const mipAt = performance.now()
    let selected = borrow.texture
    for (const [index, extent] of mipOwners.entries()) {
      signal.throwIfAborted()
      const destination = own(
        device.createTexture({
          size: [extent.width, extent.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
          label: 'first viewport exact source mip',
        }),
      )
      const orientation = index === 0 ? orientedProgram : undefined
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: selected.createView() },
        { binding: 1, resource: destination.createView() },
      ]
      if (orientation) entries.push({ binding: 2, resource: { buffer: orientationUniform! } })
      const group = device.createBindGroup({
        layout: orientation?.layout ?? programs.mipLayout,
        entries,
      })
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(orientation?.pipeline ?? programs.mip)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(extent.width / 8), Math.ceil(extent.height / 8))
      pass.end()
      device.queue.submit([encoder.finish()])
      selected = destination
    }
    // Same uniform slots and selected-mip dimensions as settled HdrPresenter.render.
    const values = new Float32Array(48)
    values.set([
      request.viewport.width,
      request.viewport.height,
      image.width,
      image.height,
      0,
      0,
      view.scale,
      request.dpr,
      request.parameters.exposureEv,
      request.parameters.contrast,
      request.parameters.highlights,
      request.parameters.shadows,
      request.parameters.whites,
      request.parameters.blacks,
      request.target.mode === 'hdr' ? 10 : 1,
      0,
      0,
      0.5,
      Math.floor(Math.log2(Math.max(image.width, image.height))) + 1,
      0,
    ])
    values[19] = Number(!!wb)
    for (let row = 0; row < 3; row++)
      values.set((wb ?? identityMatrix).slice(row * 3, row * 3 + 3), 20 + row * 4)
    values[31] = 0 // This candidate is verified sensor-derived RAW, never authored HDR JPEG.
    values.set([plan.columns, plan.columns * plan.rows, plan.width, plan.height], 32)
    values[37] = request.target.peak
    values[38] = request.target.colorSpace === 'display-p3' ? 2 : 1
    values[39] = Number(request.target.mode === 'hdr')
    values[40] = plan.level
    values[42] = Number(request.target.headroom !== null)
    values[43] = request.target.headroom ?? 1
    values[44] = request.parameters.saturation
    values[45] = request.parameters.vibrance
    device.queue.writeBuffer(uniform, 0, values)
    device.queue.writeBuffer(tables, 0, packed)
    const cacheGroup = device.createBindGroup({
      layout: programs.cacheLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: selected.createView() },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: { buffer: tables } },
        { binding: 5, resource: { buffer: jobs } },
        ...(colourBuffer ? [{ binding: 12, resource: { buffer: colourBuffer } }] : []),
      ],
    })
    const presentationGroup = device.createBindGroup({
      layout: programs.layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: lookup } },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
      ],
    })
    timings.mipSubmissionAndBindingMs = performance.now() - mipAt
    const renderAt = performance.now(),
      cache = new HdrRenderCache(capacity)
    cache.setEdits(JSON.stringify(request.parameters))
    const neutral =
      !wb &&
      !creative &&
      [
        request.parameters.exposureEv,
        request.parameters.contrast,
        request.parameters.highlights,
        request.parameters.shadows,
        request.parameters.whites,
        request.parameters.blacks,
        request.parameters.saturation,
        request.parameters.vibrance,
      ].every((value) => value === 0)
    const kernel = hdrCacheKernel('reference', creative)
    let first = true,
      batches = 0
    for (const batch of cache.batches(plan, neutral)) {
      signal.throwIfAborted()
      device.queue.writeBuffer(lookup, 0, batch.lookup)
      if (batch.jobs.length) device.queue.writeBuffer(jobs, 0, batch.jobs)
      const encoder = device.createCommandEncoder()
      if (batch.jobs.length) {
        const pass = encoder.beginComputePass()
        pass.setPipeline(programs.cache)
        pass.setBindGroup(0, cacheGroup)
        pass.dispatchWorkgroups(...kernel.dispatch(tileSize + 2, batch.jobs.length / 4))
        pass.end()
      }
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: surface.createView(),
            loadOp: first ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: [0.059, 0.063, 0.067, 1],
          },
        ],
      })
      pass.setPipeline(programs.presentation)
      pass.setBindGroup(0, presentationGroup)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
      first = false
      batches++
      await device.queue.onSubmittedWorkDone()
      signal.throwIfAborted()
    }
    timings.renderAndFenceMs = performance.now() - renderAt
    timings.batches = batches
    const copyAt = performance.now(),
      encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer(
      { texture: surface },
      { buffer: staging, bytesPerRow: paddedRowBytes },
      [canvasWidth, canvasHeight],
    )
    device.queue.submit([encoder.finish()])
    const mapAt = performance.now()
    await staging.mapAsync(GPUMapMode.READ)
    mapped = true
    timings.mapMs = performance.now() - mapAt
    signal.throwIfAborted()
    const copy = performance.now(),
      body = Buffer.allocUnsafe(surfaceBytes)
    const mappedBody = new Uint8Array(staging.getMappedRange())
    for (let row = 0; row < canvasHeight; row++)
      body.set(
        mappedBody.subarray(row * paddedRowBytes, row * paddedRowBytes + canvasWidth * 8),
        row * canvasWidth * 8,
      )
    assertOpaqueFiniteRgba16LE(body)
    staging.unmap()
    mapped = false
    timings.copyAndValidateMs = performance.now() - copy
    timings.copySubmissionThroughValidationMs = performance.now() - copyAt
    while (openScopes) {
      openScopes--
      scopes.push(device.popErrorScope())
    }
    const errors = await Promise.all(scopes)
    const failure = errors.find((entry) => entry !== null)
    if (failure) throw new Error(`${failure.constructor.name}: ${failure.message}`)
    signal.throwIfAborted()
    const hashing = performance.now(),
      sha256 = hash(body)
    timings.bodyHashMs = performance.now() - hashing
    const identity: Readonly<HdrFirstSurfaceIdentity> = Object.freeze({
      version: request.version,
      generation: request.generation,
      settingsRevision: request.settingsRevision,
      parameters: request.parameters,
      target: request.target,
      viewport: request.viewport,
      dpr: request.dpr,
      view,
      comparison: request.comparison,
      split: request.split,
      hdrRanges: request.hdrRanges,
      kernel: request.kernel,
      originalSha256: request.originalSha256,
      parentWorkingKey: request.parentWorkingKey,
      image,
      whiteBalance: request.whiteBalance,
      sourceIdentity: request.sourceIdentity,
    })
    const identitySha256 = hash(JSON.stringify(identity))
    timings.correctedCallbackToValidatedHashedBodyMs = performance.now() - started
    return {
      status: 'ready',
      bytes: body,
      width: canvasWidth,
      height: canvasHeight,
      byteLength: surfaceBytes,
      sha256,
      identity,
      identitySha256,
      timings,
      ownedBytes,
      peakBytes,
      owners: memoryOwners,
      programHashes: {
        mip: hash(hdrMipShader),
        orientedMip: hash(hdrOrientedMipShader),
        tiles: hash(kernel.shader),
        presentation: hash(hdrShader),
        tables: hash(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)),
      },
    }
  } catch (error) {
    if (error instanceof FirstSurfaceGpuError) throw error
    if (signal.aborted) throw new FirstSurfaceConsumerError(signal.reason ?? error)
    throw new FirstSurfaceGpuError(error)
  } finally {
    await cleanup()
  }
}
