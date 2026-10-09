import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { renderHdr } from '../src/main/processing/hdr-processing'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { unavailableProfile } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { expect, test } from '@playwright/test'
import {
  hdrHistogramShader,
  HDR_HISTOGRAM_WORDS,
  readHdrHistogram,
} from '../src/renderer/src/preview/hdr-histogram'
import { hdrShader } from '../src/renderer/src/preview/hdr-shader'
import { packAces, ACES_DATA_BYTES } from '../src/shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'
import {
  SDR_TARGET,
  HDR_SOURCE_VERSION,
  adjustHdr,
  outputHdr,
  encodeHdr,
  type HdrWorkingAsset,
} from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'

let retainedGpu: GPU | undefined
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('photo-wide GPU content bins stay fixed across headroom, gamut and SDR proofs with distinct warning counts', async ({}) => {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'Hardware GPU required.').toBe(false)
  const device = await adapter!.requestDevice()
  const input = new Float32Array([
    0, 0, 0, 1, 0.18, 0.18, 0.18, 1, 3, 3, 3, 1, 64, 64, 64, 0.5, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1,
    1, 4, 4, 4, 0,
  ])
  const count = input.length / 4
  const asset = { source: { normalization: { sourceSaturation: null } } } as HdrWorkingAsset
  const texture = device.createTexture({
    size: [count, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const tables = device.createBuffer({
    size: ACES_DATA_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  const histogram = device.createBuffer({
    size: HDR_HISTOGRAM_WORDS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  })
  const readback = device.createBuffer({
    size: histogram.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ code: hdrHistogramShader }),
      entryPoint: 'sampleHistogram',
    },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 4, resource: { buffer: tables } },
      { binding: 6, resource: { buffer: histogram } },
    ],
  })
  device.queue.writeTexture({ texture }, input, { bytesPerRow: count * 16 }, [count, 1])
  device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)))
  let previous: number[][] | undefined
  try {
    for (const mode of ['hdr', 'sdr'] as const)
      for (const colorSpace of ['srgb', 'display-p3'] as const)
        for (const headroom of [null, 1, 2, 4, 16]) {
          const target = {
            ...SDR_TARGET,
            mode,
            colorSpace,
            headroom,
            peak: mode === 'hdr' ? (headroom ?? 1) : 1,
          }
          const values = new Float32Array(44)
          values[14] = 10
          values[36] = count
          values[37] = target.peak
          values[38] = colorSpace === 'srgb' ? 1 : 2
          values[42] = Number(headroom !== null)
          values[43] = headroom ?? 1
          device.queue.writeBuffer(uniform, 0, values)
          const encoder = device.createCommandEncoder()
          encoder.clearBuffer(histogram)
          const pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(1)
          pass.end()
          encoder.copyBufferToBuffer(histogram, 0, readback, 0, histogram.size)
          device.queue.submit([encoder.finish()])
          await readback.mapAsync(GPUMapMode.READ)
          const actual = readHdrHistogram(
            new Uint32Array(readback.getMappedRange()),
            target,
            asset,
            7,
          )
          readback.unmap()
          const expected = hdrStatistics('content-hdr', target, asset, false)
          analyzeHdr(input, neutralAdjustments, asset, target, expected)
          expect(actual.rgbHistogram!.rgb).toEqual(expected.rgbHistogram!.rgb)
          expect(actual.bins).toEqual(expected.bins)
          expect(actual.exceedingHeadroom).toBe(expected.exceedingHeadroom)
          expect(actual.outputClipped).toBe(expected.outputClipped)
          expect(actual.gamutLimited).toBe(expected.gamutLimited)
          expect(actual.visiblePixels).toBe(7)
          if (previous) expect(actual.rgbHistogram!.rgb).toEqual(previous)
          previous = actual.rgbHistogram!.rgb
        }
  } finally {
    for (const resource of [texture, uniform, tables, histogram, readback]) resource.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('GPU presentation converts primaries, clips channels and encodes once against independent matrix arithmetic', async ({}) => {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter).toBe(false)
  const device = await adapter!.requestDevice()
  const input = [
    [3, 0, 0, 1],
    [4, 4, 4, 1],
    [10, 0.02, 4, 0.5],
    [-0.01, 0.2, 0.3, 1],
  ]
  const texture = device.createTexture({
    size: [4, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const output = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const module = device.createShaderModule({
    code:
      hdrShader +
      `
    @group(0) @binding(1) var source:texture_2d<f32>;
    @group(0) @binding(7) var<storage,read_write> result:array<vec4f>;
    @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) p:vec3u) {
      let pixel=textureLoad(source,vec2i(p.xy),0); let rgb=presentationRgb(pixel.rgb);
      result[p.x]=vec4f(select(rgb,encoded(rgb),u.values[3].w>0.),pixel.a);
    }`,
  })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'check' },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 7, resource: { buffer: output } },
    ],
  })
  device.queue.writeTexture(
    { texture },
    new Float32Array(input.flat()),
    { bytesPerRow: 64 },
    [4, 1],
  )
  try {
    // Independently specified D65 Rec.2020 -> canvas matrices (CSS Color 4).
    for (const [space, matrix] of [
      [
        1,
        [
          1.6604910021084345, -0.5876411387885495, -0.0728498633198849, -0.1245504745215907,
          1.1328998971259603, -0.0083494226043695, -0.0181507633549053, -0.1005788980080074,
          1.1187296613629127,
        ],
      ],
      [
        2,
        [
          1.343578252584332, -0.282179670526758, -0.061398582057574, -0.06529745278943,
          1.075787915848575, -0.010490463059145, 0.002821787261, -0.019598494524, 1.016776707263,
        ],
      ],
    ] as const)
      for (const peak of [1, 2, 4, 16])
        for (const encode of [false, true]) {
          const values = new Float32Array(44)
          values[15] = Number(encode)
          values[37] = peak
          values[38] = space
          values[39] = 1
          device.queue.writeBuffer(uniform, 0, values)
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, group)
          pass.dispatchWorkgroups(4)
          pass.end()
          encoder.copyBufferToBuffer(output, 0, readback, 0, 64)
          device.queue.submit([encoder.finish()])
          await readback.mapAsync(GPUMapMode.READ)
          const actual = new Float32Array(readback.getMappedRange())
          for (let i = 0; i < 4; i++)
            for (let c = 0; c < 3; c++) {
              const linear = Math.max(
                0,
                Math.min(
                  peak,
                  input[i]
                    .slice(0, 3)
                    .reduce((s, v, j) => s + Math.fround(v) * matrix[c * 3 + j], 0),
                ),
              )
              const expected = encode
                ? linear <= 0.0031308
                  ? 12.92 * linear
                  : 1.055 * linear ** (1 / 2.4) - 0.055
                : linear
              expect(
                Math.abs(actual[i * 4 + c] - expected) / (2e-6 + 2e-5 * Math.abs(expected)),
              ).toBeLessThanOrEqual(1)
            }
          readback.unmap()
        }
  } finally {
    for (const resource of [texture, uniform, output, readback]) resource.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})

test('streamed native GPU SDR proofs match CPU rendering with exact alpha and preserve working bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-gpu-proof-')),
    gpu = new RawGpuRenderer()
  const width = 29,
    height = 130,
    pixels = new Float32Array(width * height * 4)
  const patches = [
    [-0.1, 0.4, 2, 1],
    [0.18, 0.18, 0.18, 0.7],
    [64, 2, 1, 0.25],
    [0, 1, 0, 0],
  ]
  for (let i = 0; i < pixels.length; i += 4) pixels.set(patches[(i / 4) % patches.length], i)
  const bytes = Buffer.from(pixels.buffer),
    hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const asset: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength: bytes.length,
    sha256: hash(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, i) => {
      const strip = bytes.subarray(
        i * 64 * width * 16,
        Math.min(bytes.length, (i + 1) * 64 * width * 16),
      )
      return { sha256: hash(strip), byteLength: strip.length }
    }),
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      decoder: 'synthetic',
      cameraProfile: 'synthetic',
      orientation: 'applied-once',
      normalization: {
        black: [64, 64, 64, 64],
        gains: [1, 1, 1, 1],
        maximum: 65535,
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
    },
  }
  const source = join(root, 'working.f32'),
    output = join(root, 'proof')
  const parameters = {
    ...neutralAdjustments,
    exposureEv: 2,
    contrast: 25,
    highlights: -50,
    shadows: 75,
    whites: -25,
    blacks: 20,
  }
  try {
    await writeFile(source, bytes)
    await mkdir(output)
    const result = await renderHdr(
      source,
      output,
      {
        metadata: { version: 3, lensProfile: unavailableProfile },
        settings: noLensSettings,
        revision: 3,
        processing: 'hdr-v1',
        adjustments: parameters,
        workingAsset: {
          path: source,
          width,
          height,
          byteLength: bytes.length,
          sha256: asset.sha256,
          transform: { white: 1, threshold: 0.0031308, offset: 0.055, quantize: false },
          hdr: asset,
        },
      },
      gpu,
      'gpu',
    )
    expect(result.diagnostics?.fallback).toBeUndefined()
    const actual = await readFile(join(output, 'full.rgba'))
    expect(hash(actual)).toBe(result.sha256)
    for (let i = 0; i < pixels.length; i += 4) {
      const rendered = outputHdr(
        adjustHdr([pixels[i], pixels[i + 1], pixels[i + 2]], parameters),
        SDR_TARGET,
      )
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs(actual[i + c] - Math.round(encodeHdr(rendered.rgb[c]) * 255)),
        ).toBeLessThanOrEqual(1)
      expect(actual[i + 3]).toBe(Math.round(pixels[i + 3] * 255))
    }
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    gpu.close()
    await rm(root, { recursive: true, force: true })
  }
})
