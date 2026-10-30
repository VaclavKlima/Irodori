/// <reference types="@webgpu/types" />
import {
  ACES_INTERACTIVE_PREVIEW_VERSION,
  ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
  ACES_HDR_INTERACTIVE_PREVIEW_VERSION,
  type AcesInteractivePreviewPolicy,
} from '../../../shared/aces-preview-wgsl'
import { hdrShader, hdrMipShader, hdrCacheKernel } from './hdr-shader'
import { hdrHistogramShaderFor } from './hdr-histogram'
import { CREATIVE_COLOR_VERSION } from '../../../shared/creative-color'

export interface HdrPipelineProfile {
  readonly interactive: boolean
  readonly creative?: boolean
}
export interface HdrPipelines {
  readonly mipLayout: GPUBindGroupLayout
  readonly mip: GPUComputePipeline
  readonly layout: GPUBindGroupLayout
  readonly presentation: GPURenderPipeline
  readonly histogram: GPUComputePipeline
  readonly cacheLayout: GPUBindGroupLayout
  readonly cache: GPUComputePipeline
  readonly interactive: Readonly<Partial<Record<AcesInteractivePreviewPolicy, GPUComputePipeline>>>
  readonly blit: GPURenderPipeline
}
export interface HdrPipelinePreparation {
  readonly state: 'cold' | 'pending' | 'ready'
  readonly pipelines: Promise<HdrPipelines>
}
interface PipelineEntry {
  pending: Promise<HdrPipelines>
  ready: boolean
}

/** Device-bound programs own no photo resources and have no caller cancellation signal. */
export class HdrPipelineCache {
  private devices = new WeakMap<GPUDevice, Map<string, PipelineEntry>>()
  private lost = new WeakSet<GPUDevice>()
  constructor(
    private compile: (
      device: GPUDevice,
      profile: HdrPipelineProfile,
      base?: HdrPipelines,
    ) => Promise<HdrPipelines> = compileHdrPipelines,
  ) {}

  acquire(device: GPUDevice, profile: HdrPipelineProfile): HdrPipelinePreparation {
    if (this.lost.has(device)) throw new Error('HDR pipeline device was lost.')
    const selected = Object.freeze({
      interactive: profile.interactive,
      ...(profile.creative ? { creative: true } : {}),
    })
    const key = JSON.stringify([
      selected.interactive
        ? [
            ACES_INTERACTIVE_PREVIEW_VERSION,
            ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
            ACES_HDR_INTERACTIVE_PREVIEW_VERSION,
          ]
        : 'reference',
      ...(selected.creative ? [CREATIVE_COLOR_VERSION] : []),
    ])
    let entries = this.devices.get(device)
    if (!entries) {
      entries = new Map()
      this.devices.set(device, entries)
      void device.lost.then(() => {
        this.lost.add(device)
        this.devices.delete(device)
      })
    }
    const variants = entries
    const previous = variants.get(key)
    if (previous)
      return { state: previous.ready ? 'ready' : 'pending', pipelines: previous.pending }
    const entry: PipelineEntry = {
      ready: false,
      pending: Promise.resolve()
        .then(async () => {
          const base = selected.creative
            ? await this.acquire(device, { interactive: selected.interactive }).pipelines
            : undefined
          return this.compile(device, selected, base)
        })
        .then((pipelines) => {
          if (this.lost.has(device)) throw new Error('HDR pipeline device was lost.')
          entry.ready = true
          return pipelines
        }),
    }
    variants.set(key, entry)
    // Compilation can fail while a caller is still uploading. Observe it now,
    // retain that rejection for the caller, and allow a later request to retry.
    void entry.pending.catch(() => {
      if (variants.get(key) === entry) variants.delete(key)
    })
    return { state: 'cold', pipelines: entry.pending }
  }
}

const blitPipelines = new WeakMap<GPUDevice, Promise<GPURenderPipeline>>()
const blitDevices = new WeakSet<GPUDevice>()
const blitLostDevices = new WeakSet<GPUDevice>()

/** Restored cached surfaces and ordinary loads share the same immutable blit program. */
export function presentationBlit(device: GPUDevice): Promise<GPURenderPipeline> {
  if (blitLostDevices.has(device)) throw new Error('HDR blit device was lost.')
  let pending = blitPipelines.get(device)
  if (!pending) {
    pending = Promise.resolve()
      .then(() => {
        const module = device.createShaderModule({
          code: `
        @group(0) @binding(0) var image:texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
          let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
        }
        @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f { return textureLoad(image,vec2i(p.xy),0); }
      `,
        })
        return device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        })
      })
      .then((pipeline) => {
        if (blitLostDevices.has(device)) throw new Error('HDR blit device was lost.')
        return pipeline
      })
    blitPipelines.set(device, pending)
    const compiled = pending
    void pending.catch(() => {
      if (blitPipelines.get(device) === compiled) blitPipelines.delete(device)
    })
    if (!blitDevices.has(device)) {
      blitDevices.add(device)
      void device.lost.then(() => {
        blitLostDevices.add(device)
        blitPipelines.delete(device)
      })
    }
  }
  return pending
}

async function compileHdrPipelines(
  device: GPUDevice,
  profile: HdrPipelineProfile,
  base?: HdrPipelines,
) {
  const mipLayout =
    base?.mipLayout ??
    device.createBindGroupLayout({
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
      ],
    })
  const layout =
    base?.layout ??
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
      ],
    })
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
      ...(profile.creative
        ? [
            {
              binding: 12,
              visibility: GPUShaderStage.COMPUTE,
              buffer: { type: 'read-only-storage' as const },
            },
          ]
        : []),
    ],
  })
  // Queue every independent compiler before awaiting any result. Promise.all
  // observes each rejection, including a synchronous shader/layout failure.
  const mip = base
    ? Promise.resolve(base.mip)
    : Promise.resolve().then(() =>
        device.createComputePipelineAsync({
          label: 'Irodori HDR source mip',
          layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
          compute: {
            module: device.createShaderModule({ code: hdrMipShader }),
            entryPoint: 'down',
          },
        }),
      )
  const presentation = base
    ? Promise.resolve(base.presentation)
    : Promise.resolve().then(() => {
        const module = device.createShaderModule({ code: hdrShader })
        return device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        })
      })
  const histogram = Promise.resolve().then(() =>
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: hdrHistogramShaderFor(profile.creative) }),
        entryPoint: 'sampleHistogram',
      },
    }),
  )
  const cache = Promise.resolve().then(() =>
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
      compute: {
        module: device.createShaderModule({
          code: hdrCacheKernel('reference', profile.creative).shader,
        }),
        entryPoint: 'renderTile',
      },
    }),
  )
  const policies: AcesInteractivePreviewPolicy[] = profile.interactive
    ? [ACES_HDR_INTERACTIVE_PREVIEW_VERSION, ACES_SDR_INTERACTIVE_PREVIEW_VERSION]
    : []
  const interactive = policies.map((policy) =>
    Promise.resolve().then(() =>
      device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [cacheLayout] }),
        compute: {
          module: device.createShaderModule({
            code: hdrCacheKernel(policy, profile.creative).shader,
          }),
          entryPoint: 'renderTile',
        },
      }),
    ),
  )
  const [
    mipProgram,
    presentationProgram,
    histogramProgram,
    cacheProgram,
    blit,
    interactivePrograms,
  ] = await Promise.all([
    mip,
    presentation,
    histogram,
    cache,
    presentationBlit(device),
    Promise.all(interactive),
  ] as const)
  return Object.freeze({
    mipLayout,
    mip: mipProgram,
    layout,
    presentation: presentationProgram,
    histogram: histogramProgram,
    cacheLayout,
    cache: cacheProgram,
    blit,
    interactive: Object.freeze(
      Object.fromEntries(policies.map((policy, i) => [policy, interactivePrograms[i]])),
    ),
  }) satisfies HdrPipelines
}

const pipelineCache = new HdrPipelineCache()
export const prepareHdrPipelines = (device: GPUDevice, profile: HdrPipelineProfile) =>
  pipelineCache.acquire(device, profile)
