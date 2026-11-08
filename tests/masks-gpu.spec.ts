import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { createPointGpu } from '../src/main/gpu/point-renderer'
import { localMasksWgsl, packLocalMasks } from '../src/shared/masks-gpu'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { neutralAdjustments } from '../src/shared/adjustments'
import { neutralMaskEdge, neutralMaskLight, type ResolvedMask } from '../src/shared/masks'
import { brush, referenceCoverage, referenceStack } from './helpers/mask-reference'
import {
  hdrHistogramShaderFor,
  HDR_HISTOGRAM_WORDS,
  HDR_MASK_HISTOGRAM_WORDS,
} from '../src/renderer/src/preview/hdr-histogram'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import { HDR_CONTENT_TARGET, prepareDisplayRendering } from '../src/shared/display-rendering'
import { croppedMaskGeometry } from '../src/shared/mask-geometry'
import { cropGeometry, identityCrop } from '../src/shared/crop'

const mask = (ordinal: number): ResolvedMask => ({
  id: `00000000-0000-0000-0000-${String(ordinal).padStart(12, '0')}`,
  name: `Mask ${ordinal}`,
  enabled: true,
  inverted: false,
  head: null,
  edge: { ...neutralMaskEdge },
  light: { ...neutralMaskLight },
  strokes: [],
})
const cases = () => {
  const upper = mask(1),
    lower = mask(2)
  upper.light = {
    exposureEv: 0.27,
    contrast: 31,
    highlights: -29,
    shadows: 23,
    whites: 17,
    blacks: -11,
  }
  upper.strokes = [
    brush('add', 0.28, 0.7, [
      [0.15, 0.25],
      [0.65, 0.7],
      [0.9, 0.25],
    ]),
    brush('subtract', 0.12, 1, [[0.5, 0.5]]),
  ]
  lower.light = { ...neutralMaskLight, exposureEv: 0.6, contrast: -42 }
  lower.strokes = [brush('add', 0.5, 0, [[0.5, 0.5]])]
  return [upper, lower]
}

test('native GPU brush coverage and sequential six-Light results match independent scalar references', async () => {
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = [],
    colors = [
      [0.03, 0.14, 0.38],
      [-0.03, 0.14, 0.38],
      [0.2, 8, 16],
      [-2, 1, 8],
      [0.001, 0.003, 0.02],
    ]
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      return buffer
    }
    for (const scene of [false, true])
      for (const inverted of [false, true]) {
        const masks = cases()
        masks[0].inverted = inverted
        const points = Array.from({ length: 80 }, (_, i) => ({
            x: ((i % 10) + 0.5) / 10,
            y: (Math.floor(i / 10) + 0.5) / 8,
          })),
          data = packLocalMasks(
            { localMasks: masks, maskGeometry: identityMaskGeometry(1000, 800) },
            { width: 1000, height: 800 },
          ),
          maskBuffer = allocate(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
          input = allocate(points.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
          output = allocate(points.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
          staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        device.queue.writeBuffer(maskBuffer, 0, data)
        device.queue.writeBuffer(
          input,
          0,
          new Float32Array(
            points.flatMap((p, i) => [
              p.x * 1000,
              p.y * 800,
              0,
              0,
              ...colors[i % colors.length],
              1,
            ]),
          ),
        )
        const shader = device.createShaderModule({
            code:
              localMasksWgsl(1) +
              `
struct Case{point:vec4f,rgb:vec4f}
@group(0) @binding(0) var<storage,read> cases:array<Case>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&cases)){return;}let c=cases[id.x];
 output[id.x]=vec4f(applyLocalMasks(c.rgb.xyz,c.point.xy,1.,${scene}),maskCoverage(0u,maskCanonical(c.point.xy)));
}`,
          }),
          pipeline = await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: shader, entryPoint: 'check' },
          }),
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: input } },
              { binding: 1, resource: { buffer: maskBuffer } },
              { binding: 2, resource: { buffer: output } },
            ],
          }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(2)
        pass.end()
        encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        try {
          const actual = new Float32Array(staging.getMappedRange())
          points.forEach((point, i) => {
            const expected = [
              ...referenceStack(
                masks,
                colors[i % colors.length].map(Math.fround),
                point,
                1000,
                800,
                scene,
              ),
              referenceCoverage(masks[0], point.x, point.y, 1000, 800),
            ]
            expected.forEach((value, c) =>
              expect(
                Math.abs(actual[i * 4 + c] - value),
                JSON.stringify({ scene, inverted, i, c, actual: actual[i * 4 + c], value }),
              ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(value)),
            )
          })
        } finally {
          staging.unmap()
        }
      }
  } finally {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})

test('production point renderer preserves mask locations across strip boundaries and raster/authored-HDR/scene domains', async () => {
  const width = 8,
    height = 130,
    local = mask(1)
  local.light.exposureEv = 1
  local.strokes = [brush('add', 0.45, 0.5, [[0.5, 0.86]])]
  const adjustments = {
      ...neutralAdjustments,
      localMasks: [local],
      maskGeometry: identityMaskGeometry(width, height),
    },
    input = new Float32Array(width * height * 4).fill(0.12)
  for (let i = 3; i < input.length; i += 4) input[i] = 0.5
  for (const domain of ['raster', 'authored-hdr', 'scene-linear'] as const) {
    const whole = await createPointGpu(
        width * height,
        adjustments,
        undefined,
        false,
        true,
        64,
        0,
        undefined,
        { domain, preserveAlpha: true },
      ),
      strips = await createPointGpu(
        width * 64,
        adjustments,
        undefined,
        false,
        true,
        64,
        0,
        undefined,
        { domain, preserveAlpha: true },
      )
    try {
      const expected = (await whole.render(input)).data,
        actual = Buffer.alloc(expected.byteLength)
      for (let top = 0; top < height; top += 64) {
        const chunk = await strips.render(
          input.subarray(top * width * 4, (top + 64) * width * 4),
          top * width,
        )
        chunk.data.copy(actual, top * width * 4)
      }
      expect(actual.equals(expected), domain).toBe(true)
      for (let i = 3; i < actual.length; i += 4) expect(actual[i]).toBe(128)
      expect(actual[(112 * width + 4) * 4]).toBeGreaterThan(actual[(3 * width + 4) * 4])
    } finally {
      await whole.close()
      await strips.close()
    }
  }
})

test('combined numerical overflow is refused before clamps or JPEG output can conceal it', async () => {
  const local = mask(1)
  local.light.exposureEv = 5
  local.strokes = [brush('add', 0.5, 0, [[0.5, 0.5]])]
  const geometry = identityMaskGeometry(1, 1)
  expect(() =>
    packLocalMasks(
      {
        localMasks: Array.from({ length: 32 }, (_, i) => ({ ...local, id: mask(i + 1).id })),
        maskGeometry: geometry,
      },
      { width: 1, height: 1 },
    ),
  ).toThrow(/numerical range/)
  for (const domain of ['raster', 'authored-hdr', 'scene-linear'] as const) {
    const gpu = await createPointGpu(
      1,
      { ...neutralAdjustments, localMasks: [local], maskGeometry: geometry },
      undefined,
      false,
      true,
      64,
      0,
      undefined,
      { domain, preserveAlpha: true },
    )
    try {
      await expect(gpu.render(new Float32Array([3e38, 3e38, 3e38, 1]))).rejects.toThrow(
        /non-finite pixels/,
      )
    } finally {
      await gpu.close()
    }
  }
})

test('masked GPU HDR histogram samples the whole cropped native image with ordered local Light and rejects invalid results', async () => {
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  let texture: GPUTexture | undefined
  try {
    const { device } = await gpu.mergeDevice(),
      width = 512,
      height = 24,
      count = 257,
      allocate = (size: number, usage: number) => {
        const buffer = device.createBuffer({ size, usage })
        buffers.push(buffer)
        return buffer
      },
      masks = cases(),
      geometry = croppedMaskGeometry(
        identityMaskGeometry(1024, 48),
        cropGeometry({ width: 1024, height: 48 }, { ...identityCrop, width: 0.5, height: 0.5 }),
      ),
      packed = packLocalMasks({ localMasks: masks, maskGeometry: geometry }, { width, height }),
      maskBuffer = allocate(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      uniform = allocate(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      tables = allocate(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      histogram = allocate(
        HDR_MASK_HISTOGRAM_WORDS * 4,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      ),
      readback = allocate(histogram.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      colors = [
        [0.04, 0.17, 0.38],
        [0.09, 0.21, 0.72],
        [1.3, 2.7, 4.1],
        [-0.02, 0.12, 0.55],
      ],
      pixels = new Float32Array(width * height * 4),
      parameters = new Float32Array(48)
    for (let i = 0; i < width * height; i++)
      pixels.set(
        [...colors[(i * 7 + Math.floor(i / width)) % colors.length], i % 13 ? 1 : 0],
        i * 4,
      )
    texture = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * 16 }, [width, height])
    device.queue.writeBuffer(maskBuffer, 0, packed)
    device.queue.writeBuffer(tables, 0, packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)))
    parameters[14] = 10
    parameters[31] = 1
    parameters[36] = count
    parameters[37] = 10
    parameters[38] = 1
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: hdrHistogramShaderFor(false, false, true) }),
          entryPoint: 'sampleHistogram',
        },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 4, resource: { buffer: tables } },
          { binding: 6, resource: { buffer: histogram } },
          { binding: 16, resource: { buffer: maskBuffer } },
        ],
      })
    const run = async () => {
      device.queue.writeBuffer(uniform, 0, parameters)
      const encoder = device.createCommandEncoder()
      encoder.clearBuffer(histogram)
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(count / 64))
      pass.end()
      encoder.copyBufferToBuffer(histogram, 0, readback, 0, histogram.size)
      device.queue.submit([encoder.finish()])
      await readback.mapAsync(GPUMapMode.READ)
      try {
        return new Uint32Array(readback.getMappedRange()).slice()
      } finally {
        readback.unmap()
      }
    }
    let edited: Uint32Array | undefined
    for (const before of [false, true]) {
      parameters[16] = Number(before)
      const actual = await run(),
        expected = new Uint32Array(HDR_MASK_HISTOGRAM_WORDS)
      for (let i = 0; i < count; i++) {
        const index = Math.floor(((i + 0.5) * width * height) / count)
        if (!pixels[index * 4 + 3]) continue
        const input = [...pixels.subarray(index * 4, index * 4 + 3)],
          point = {
            x: (256 + (index % width) + 0.5) / 1024,
            y: (12 + Math.floor(index / width) + 0.5) / 48,
          },
          rgb = (before ? input : referenceStack(masks, input, point, 1024, 48, true)).map(
            (value) => Math.max(0, value),
          )
        for (let channel = 0; channel < 3; channel++) {
          const value = rgb[channel],
            encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055,
            bin =
              value > 1
                ? 256 + Math.min(255, Math.floor(Math.log2(value) * 64))
                : Math.round(Math.max(0, Math.min(1, encoded)) * 255)
          expected[256 + channel * 512 + bin]++
        }
        expected[1792]++
      }
      expect([...actual.subarray(256, 1793)]).toEqual([...expected.subarray(256, 1793)])
      expect(actual[HDR_HISTOGRAM_WORDS]).toBe(0)
      if (before)
        expect([...actual.subarray(256, 1792)]).not.toEqual([...edited!.subarray(256, 1792)])
      else edited = actual
    }
    for (let i = 0; i < pixels.length; i += 4) pixels.set([3e38, 3e38, 3e38, 1], i)
    parameters[16] = 0
    device.queue.writeTexture({ texture }, pixels, { bytesPerRow: width * 16 }, [width, height])
    expect((await run())[HDR_HISTOGRAM_WORDS]).toBe(1)
  } finally {
    texture?.destroy()
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})
