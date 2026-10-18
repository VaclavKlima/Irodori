import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { acesWgsl } from '../src/shared/aces-wgsl'
import { ACES_INTERACTIVE_PREVIEW_VERSION, acesPreviewWgsl } from '../src/shared/aces-preview-wgsl'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import {
  DISPLAY_RENDERING_VERSION,
  prepareDisplayRendering,
  REC2020_TO_ACES,
  type RenderingTarget,
} from '../src/shared/display-rendering'
import { neutralAdjustments } from '../src/shared/adjustments'
import { acesRegressionInputs } from './aces-regression-inputs'
import { buildAcesReference, referenceAces } from './aces-reference'
import { referenceAdjust } from './hdr-reference'
import { fromHalf } from './export-reference'

// Conservative experiment budgets, separate from the unchanged exact CTL bound.
// A metric pass does not certify invisibility on a physical Retina/HDR display.
const previewBudget = {
  maximumEncodedError: 1 / 1024,
  p99EncodedError: 1 / 2048,
  encodedRms: 1 / 8192,
  maximumSdrDeltaEOK: 0.002,
  maximumGradientDifference: 1 / 1024,
  maximumEdgeEnergyRelativeDifference: 0.005,
}

const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const background = [0.00478, 0.0052, 0.00563]

// Independent D65 RGB/XYZ/Oklab conversions from CSS Color 4, sections 19/20.
// https://www.w3.org/TR/css-color-4/#color-conversion-code
// HDR values normalized by target peak are diagnostic, not an HDR JND model.
function oklab(rgb: readonly number[], space: RenderingTarget['colorSpace'], peak = 1) {
  const matrix =
    space === 'srgb'
      ? [
          [506752 / 1228815, 87881 / 245763, 12673 / 70218],
          [87098 / 409605, 175762 / 245763, 12673 / 175545],
          [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
        ]
      : space === 'display-p3'
        ? [
            [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
            [35783 / 156275, 247089 / 357200, 198249 / 2500400],
            [0, 32229 / 714400, 5220557 / 5000800],
          ]
        : [
            [63426534 / 99577255, 20160776 / 139408157, 47086771 / 278816314],
            [26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157],
            [0, 19567812 / 697040785, 295819943 / 278816314],
          ]
  const multiply = (m: number[][], v: readonly number[]) =>
    m.map((row) => row.reduce((sum, x, c) => sum + x * v[c], 0))
  const xyz = multiply(
    matrix,
    rgb.map((v) => v / peak),
  )
  const cone = multiply(
    [
      [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
      [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
      [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
    ],
    xyz,
  ).map(Math.cbrt)
  return multiply(
    [
      [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
      [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
      [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
    ],
    cone,
  )
}

let retainedGpu: GPU | undefined

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('interactive Float32 ACES retains source detail within an explicit preview-only display budget', async ({}, info) => {
  const directory = info.outputPath('reference')
  await mkdir(directory, { recursive: true })
  const binary = buildAcesReference(directory)
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))

  const seeds = [
    ...acesRegressionInputs,
    ...[-32, -2, -0.1, 0, 1e-8, 0.0031308, 0.18, 1, 4, 16, 64, 100].map((v) => [v, v, v]),
    [-2, 4, 1],
    [16, -0.1, 4],
    [0, 16, 0],
    [4, 0, 0],
  ]
  const gradientStart = seeds.length
  for (let i = 0; i < 1024; i++) seeds.push([i / 128, i / 192, i / 256])
  for (let i = 0; i < 256; i++) {
    const v = 2 ** (-18 + (i * 24) / 255)
    seeds.push([v, v, v], [v, v / 1000, -v / 100], [-v / 100, v, v / 1000])
  }
  const input = seeds.flatMap((rgb) =>
    [-100, 0, 100].map((v) =>
      referenceAdjust(rgb, {
        ...neutralAdjustments,
        exposureEv: v / 20,
        contrast: v,
        highlights: -v,
        shadows: v,
        whites: -v,
        blacks: v,
      }).map(Math.fround),
    ),
  )
  const alpha = input.map((_, i) =>
    i >= gradientStart * 3 && i < (gradientStart + 1024) * 3 ? 1 : [0, 0.25, 0.5, 1][i % 4],
  )
  const width = 256,
    height = Math.ceil(input.length / width),
    bytesPerRow = width * 8
  const buffers: GPUBuffer[] = []
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage })
    buffers.push(result)
    return result
  }
  const source = buffer(input.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const output = buffer(source.size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  const readback = buffer(source.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  const displayReadback = buffer(
    bytesPerRow * height,
    GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  )
  const uniform = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const tables = buffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const display = device.createTexture({
    size: [width, height],
    format: 'rgba16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  })
  device.queue.writeBuffer(
    source,
    0,
    new Float32Array(input.flatMap((rgb, i) => [...rgb, alpha[i]])),
  )
  const matrix =
    'mat3x3f(' + REC2020_TO_ACES.map((row) => `vec3f(${row.join(',')})`).join(',') + ')'
  const kernel = (math: string) => `${math}
struct Scope { count:u32, peak:f32 }
@group(0) @binding(0) var<storage,read> input:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
@group(0) @binding(2) var display:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var<uniform> scope:Scope;
fn encode(v:vec3f)->vec3f {
  return select(1.055*pow(v,vec3f(1./2.4))-.055,12.92*v,v<=vec3f(.0031308));
}
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) p:vec3u) {
  if(p.x>=scope.count) {return;}
  let pixel=input[p.x];
  let rgb=clamp(outputTransform_fwd(${matrix}*pixel.rgb),vec3f(0.),vec3f(scope.peak));
  result[p.x]=vec4f(rgb,pixel.a);
  textureStore(display,vec2i(i32(p.x%256u),i32(p.x/256u)),vec4f(encode(mix(vec3f(.00478,.0052,.00563),rgb,pixel.a)),pixel.a));
}`
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float' },
      },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  })
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: source } },
      { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: display.createView() },
      { binding: 3, resource: { buffer: uniform } },
      { binding: 4, resource: { buffer: tables } },
    ],
  })
  const measurements: unknown[] = []
  const checks: Array<() => void> = []
  try {
    const pipelines = []
    for (const math of [acesWgsl, acesPreviewWgsl])
      pipelines.push(
        await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: {
            module: device.createShaderModule({ code: kernel(math) }),
            entryPoint: 'check',
          },
        }),
      )
    const run = async (pipeline: GPUComputePipeline) => {
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(input.length / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size)
      encoder.copyTextureToBuffer({ texture: display }, { buffer: displayReadback, bytesPerRow }, [
        width,
        height,
      ])
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      let linear: Float32Array
      try {
        linear = new Float32Array(readback.getMappedRange().slice(0))
      } finally {
        readback.unmap()
      }
      await displayReadback.mapAsync(GPUMapMode.READ)
      try {
        return {
          linear,
          encoded: Array.from(new Uint16Array(displayReadback.getMappedRange()), fromHalf),
        }
      } finally {
        displayReadback.unmap()
      }
    }
    const targets: RenderingTarget[] = [
      { mode: 'sdr', peak: 1, colorSpace: 'srgb' },
      { mode: 'sdr', peak: 1, colorSpace: 'display-p3' },
      { mode: 'hdr', peak: 4, colorSpace: 'display-p3' },
      { mode: 'hdr', peak: 10, colorSpace: 'rec2020' },
    ]
    for (const target of targets) {
      device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(target)))
      const scope = new ArrayBuffer(16)
      new Uint32Array(scope)[0] = input.length
      new Float32Array(scope)[1] = target.peak
      device.queue.writeBuffer(uniform, 0, scope)
      const independent = referenceAces(binary, input, target.peak, target.colorSpace)
      const exact = await run(pipelines[0]),
        candidate = await run(pipelines[1])
      let maximumExactRatio = 0,
        maximumCandidateRatio = 0,
        maximumDeltaEOK = 0,
        maximumGradientDifference = 0,
        largestEncodedError = -1,
        baselineEdges = 0,
        candidateEdges = 0
      let nonfiniteValues = 0,
        alphaMismatches = 0,
        unclippedValues = 0
      let worst: unknown
      const encodedErrors: number[] = []
      for (let i = 0; i < input.length; i++) {
        const baselineRgb: number[] = [],
          candidateRgb: number[] = []
        for (let c = 0; c < 4; c++) {
          nonfiniteValues += Number(!Number.isFinite(candidate.linear[i * 4 + c]))
          nonfiniteValues += Number(!Number.isFinite(candidate.encoded[i * 4 + c]))
          if (c === 3) {
            alphaMismatches += Number(candidate.linear[i * 4 + c] !== alpha[i])
            alphaMismatches += Number(candidate.encoded[i * 4 + c] !== alpha[i])
            continue
          }
          unclippedValues += Number(
            candidate.linear[i * 4 + c] < 0 || candidate.linear[i * 4 + c] > target.peak,
          )
          const reference = independent[i][c]
          const tolerance = 2e-6 + 2e-5 * Math.abs(reference)
          maximumExactRatio = Math.max(
            maximumExactRatio,
            Math.abs(exact.linear[i * 4 + c] - reference) / tolerance,
          )
          maximumCandidateRatio = Math.max(
            maximumCandidateRatio,
            Math.abs(candidate.linear[i * 4 + c] - reference) / tolerance,
          )
          const difference = Math.abs(candidate.encoded[i * 4 + c] - exact.encoded[i * 4 + c])
          encodedErrors.push(difference)
          if (difference > largestEncodedError) {
            largestEncodedError = difference
            worst = {
              target,
              i,
              c,
              source: input[i],
              reference,
              exact: exact.linear[i * 4 + c],
              candidate: candidate.linear[i * 4 + c],
              encodedDifference: difference,
            }
          }
          baselineRgb.push(decode(exact.encoded[i * 4 + c]))
          candidateRgb.push(decode(candidate.encoded[i * 4 + c]))
          // The neutral-edit member of each consecutive chromatic-ramp sample.
          if (i >= (gradientStart + 1) * 3 && i < (gradientStart + 1024) * 3 && i % 3 === 1) {
            const before = (i - 3) * 4 + c
            const a = candidate.encoded[i * 4 + c] - candidate.encoded[before]
            const b = exact.encoded[i * 4 + c] - exact.encoded[before]
            maximumGradientDifference = Math.max(maximumGradientDifference, Math.abs(a - b))
            baselineEdges += Math.abs(b)
            candidateEdges += Math.abs(a)
          }
          // Independently encode the CTL boundary for diagnostic comparison only;
          // final acceptance compares the two actual Dawn rgba16float surfaces.
          nonfiniteValues += Number(
            !Number.isFinite(encode(background[c] * (1 - alpha[i]) + reference * alpha[i])),
          )
        }
        const a = oklab(baselineRgb, target.colorSpace, target.peak)
        const b = oklab(candidateRgb, target.colorSpace, target.peak)
        maximumDeltaEOK = Math.max(maximumDeltaEOK, Math.hypot(...a.map((v, c) => v - b[c])))
      }
      encodedErrors.sort((a, b) => a - b)
      const maximumEncodedError = encodedErrors.at(-1)!
      const p99EncodedError = encodedErrors[Math.ceil(encodedErrors.length * 0.99) - 1]
      const encodedRms = Math.sqrt(
        encodedErrors.reduce((sum, v) => sum + v * v, 0) / encodedErrors.length,
      )
      const edgeEnergyRelativeDifference = Math.abs(candidateEdges / baselineEdges - 1)
      measurements.push({
        target,
        samples: input.length,
        maximumExactRatio,
        maximumCandidateRatio,
        maximumEncodedError,
        p99EncodedError,
        encodedRms,
        maximumDeltaEOK,
        maximumGradientDifference,
        edgeEnergyRelativeDifference,
        nonfiniteValues,
        alphaMismatches,
        unclippedValues,
        worst,
      })
      checks.push(() => {
        // Exact correctness remains independent from the explicitly approximate path.
        expect(nonfiniteValues).toBe(0)
        expect(alphaMismatches).toBe(0)
        expect(unclippedValues).toBe(0)
        expect(maximumExactRatio, JSON.stringify({ target, worst })).toBeLessThanOrEqual(1)
        expect(maximumEncodedError, JSON.stringify(worst)).toBeLessThanOrEqual(
          previewBudget.maximumEncodedError,
        )
        expect(p99EncodedError).toBeLessThanOrEqual(previewBudget.p99EncodedError)
        expect(encodedRms).toBeLessThanOrEqual(previewBudget.encodedRms)
        expect(maximumGradientDifference).toBeLessThanOrEqual(
          previewBudget.maximumGradientDifference,
        )
        expect(edgeEnergyRelativeDifference).toBeLessThanOrEqual(
          previewBudget.maximumEdgeEnergyRelativeDifference,
        )
        if (target.mode === 'sdr')
          expect(maximumDeltaEOK).toBeLessThanOrEqual(previewBudget.maximumSdrDeltaEOK)
      })
    }
    expect(errors).toEqual([])
    for (const check of checks) check()
  } finally {
    await writeFile(
      info.outputPath('interactive-preview-conformance.json'),
      JSON.stringify(
        {
          policy: ACES_INTERACTIVE_PREVIEW_VERSION,
          canonicalPolicy: DISPLAY_RENDERING_VERSION,
          canonicalShaderSha256: createHash('sha256').update(acesWgsl).digest('hex'),
          previewShaderSha256: createHash('sha256').update(acesPreviewWgsl).digest('hex'),
          adapter: adapter!.info,
          budget: previewBudget,
          visualReview: 'unreviewed; synthetic numerical evidence does not prove imperceptibility',
          hdrDeltaEOK: 'peak-normalized diagnostic only; not an HDR JND model',
          measurements,
          errors,
        },
        null,
        2,
      ),
    )
    for (const value of buffers) value.destroy()
    display.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})
