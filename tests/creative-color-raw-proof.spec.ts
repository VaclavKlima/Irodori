import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { ahdShader, ahdDisplayShader } from '../src/main/gpu/ahd-shader'
import { RawGpuRenderer, GpuResourceBudgetError } from '../src/main/gpu/raw-renderer'
import type { RawSource } from '../src/main/gpu/raw-source'
import type { CorrectionPlan } from '../src/main/processing/lens-correction'
import { neutralAdjustments } from '../src/shared/adjustments'
import { compileCreativeColor } from '../src/shared/creative-color'
import { packCreativeColor, CREATIVE_COLOR_PARAMETER_BYTES } from '../src/shared/creative-color-gpu'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import { resourcePolicy } from './native-cpu-controller.helpers'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: [number, number, number]
    output: [number, number, number]
    primaries: string
    configuration: number
  }[]
}
const parameters = (index: number) => {
  const c = reference.configurations[index]
  return {
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: structuredClone(c.mixer),
    colorGrading: structuredClone(c.grading),
  }
}
const vectorsFor = (index: number) =>
  reference.gpuVectors.filter(
    (v) => v.primaries === 'srgb' && v.configuration === index && v.input.every((v) => v >= 0),
  )

test('legacy RAW display keeps the original base program and grades normalized proof pixels before its existing quantization', async () => {
  expect(ahdDisplayShader()).toBe(ahdShader)
  expect(createHash('sha256').update(ahdShader).digest('hex')).toBe(
    '7c9710aaed5535881bf4a14ef9501b4252ace8e51fc9af88e6b49fea7e27e3be',
  )
  const gpu = new RawGpuRenderer(),
    owned: (GPUBuffer | GPUTexture)[] = [],
    own = <T extends GPUBuffer | GPUTexture>(value: T) => {
      owned.push(value)
      return value
    }
  try {
    const { device } = await gpu.mergeDevice(),
      vectors = vectorsFor(0),
      width = vectors.length,
      source = own(
        device.createTexture({
          size: [width, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
      buffer = (size: number, usage: GPUBufferUsageFlags) =>
        own(device.createBuffer({ size, usage })),
      uniform = buffer(288, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      output = buffer(width * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      color = buffer(
        CREATIVE_COLOR_PARAMETER_BYTES,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      curve = buffer(65536 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      observed = buffer(width * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      read = buffer(observed.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      proofRead = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      anchor = '  let rgb=vec3u(clamp(adjusted*65535.0,vec3f(0),vec3f(65535)));',
      original = ahdDisplayShader(true)
    expect(original.split(anchor)).toHaveLength(2)
    // Observe the actual production entry before its legacy 16-bit LUT and byte packing.
    // The unmodified host/pipeline path is exercised separately below.
    const shader =
        original.replace(
          anchor,
          '  proofColor[id.x]=vec4f(adjusted/p.adjustments.z,1.);\n' + anchor,
        ) + '\n@group(0) @binding(13) var<storage,read_write> proofColor:array<vec4f>;\n',
      pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'display' },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 8, resource: { buffer: output } },
          { binding: 9, resource: { buffer: curve } },
          { binding: 11, resource: source.createView() },
          { binding: 12, resource: { buffer: color } },
          { binding: 13, resource: { buffer: observed } },
        ],
      }),
      params = new ArrayBuffer(288),
      words = new Uint32Array(params),
      values = new Float32Array(params),
      curveData = Uint32Array.from({ length: 65536 }, (_, i) => {
        const x = i / 65535
        return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
      })
    words.set([width, 1])
    values[42] = 1
    device.queue.writeTexture(
      { texture: source },
      new Float32Array(vectors.flatMap((v) => [...v.input, 1])),
      { bytesPerRow: width * 16 },
      [width, 1],
    )
    device.queue.writeBuffer(curve, 0, curveData)
    let maximumRatio = 0,
      count = 0
    for (let index = 0; index < reference.configurations.length; index++) {
      const config = reference.configurations[index],
        expected = vectorsFor(index)
      values[68] = config.intensity.saturation
      values[69] = config.intensity.vibrance
      device.queue.writeBuffer(uniform, 0, params)
      device.queue.writeBuffer(
        color,
        0,
        packCreativeColor(compileCreativeColor(config.mixer, config.intensity, config.grading)),
      )
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(width / 16), 1)
      pass.end()
      encoder.copyBufferToBuffer(observed, 0, read, 0, read.size)
      encoder.copyBufferToBuffer(output, 0, proofRead, 0, proofRead.size)
      device.queue.submit([encoder.finish()])
      await Promise.all([read.mapAsync(GPUMapMode.READ), proofRead.mapAsync(GPUMapMode.READ)])
      const floats = new Float32Array(read.getMappedRange()),
        pixels = new Uint8Array(proofRead.getMappedRange())
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++) {
          const wanted = expected[x].output[c],
            actual = floats[x * 4 + c]
          assert.ok(Number.isFinite(actual))
          maximumRatio = Math.max(
            maximumRatio,
            Math.abs(actual - wanted) / (2e-6 + 2e-5 * Math.abs(wanted)),
          )
          const slot = Math.trunc(Math.min(65535, Math.max(0, wanted * 65535)))
          expect(Math.abs(pixels[x * 4 + c] - curveData[slot])).toBeLessThanOrEqual(1)
        }
      for (let x = 0; x < width; x++) expect(pixels[x * 4 + 3]).toBe(255)
      read.unmap()
      proofRead.unmap()
      count += width
    }
    expect(count).toBeGreaterThan(900)
    expect(maximumRatio).toBeLessThanOrEqual(1)
  } finally {
    for (const value of owned.reverse()) value.destroy()
    gpu.close()
  }
})

test('the actual legacy RAW host uses one creative display program, retains its source and freezes correction proofs within admitted budgets', async () => {
  const gpu = new RawGpuRenderer()
  try {
    const { device } = await gpu.mergeDevice(),
      compile = device.createShaderModule.bind(device)
    let colorPrograms = 0
    device.createShaderModule = (descriptor) => {
      colorPrograms += Number(descriptor.code.includes('creativeColorData'))
      return compile(descriptor)
    }
    for (const rgb of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 1],
    ]) {
      const width = 16,
        height = 12,
        pixels = Uint16Array.from({ length: width * height }, (_, i) => {
          const x = i % width,
            y = Math.floor(i / width),
            channel = y % 2 ? (x % 2 ? 2 : 1) : x % 2 ? 1 : 0
          return rgb[channel] * 32768
        }),
        raw: RawSource = {
          width,
          height,
          pixels,
          rawWidth: width,
          left: 0,
          top: 0,
          flip: 0,
          cfa: [0, 1, 3, 2],
          black: [0, 0, 0, 0],
          scale: [1, 1, 1, 1],
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        },
        original = Buffer.from(pixels.buffer).toString('hex'),
        neutral = await gpu.render(raw, undefined, parameters(0), true)
      expect(neutral.timings.creativeDisplayPrepareMs).toBeUndefined()
      assert.ok(neutral.working)
      const white = neutral.working.transform.white,
        expected = reference.gpuVectors.find(
          (v) =>
            v.primaries === 'srgb' &&
            v.configuration === 9 &&
            v.input.every((v, c) => v === rgb[c]),
        )!.output,
        p = parameters(9),
        pending = gpu.render(raw, undefined, p, true)
      Object.assign(p.colorGrading.tones.shadows, { hue: 23, saturation: 100 })
      const actual = await pending
      expect(actual.timings.reusedLinear).toBe(1)
      expect(colorPrograms).toBe(1)
      for (let i = 0; i < actual.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const slot = Math.trunc(Math.min(65535, Math.max(0, expected[c] * white * 65535))),
            x = slot / (white * 65535),
            t = neutral.working.transform,
            wanted =
              x >= 1
                ? 255
                : Math.trunc(
                    65536 *
                      (x < t.threshold ? 12.92 * x : x ** (1 / 2.4) * (1 + t.offset) - t.offset),
                  ) >> 8
          expect(Math.abs(actual.data[i + c] - wanted)).toBeLessThanOrEqual(1)
        }
      const correction: CorrectionPlan = {
          width,
          height,
          left: 0,
          top: 0,
          lut: new Float32Array(4096 * 4).fill(1),
          applied: { distortion: false, chromaticAberration: false, vignetting: false },
        },
        corrected = await gpu.render(raw, correction, parameters(9), true)
      expect(corrected.data.equals(actual.data)).toBe(true)
      expect(colorPrograms).toBe(1)
      expect(Buffer.from(pixels.buffer).toString('hex')).toBe(original)
      const limit = width * height * 4 * 6 + pixels.byteLength + width * (256 + 12) * 80,
        policy = resourcePolicy()
      const frozen = { ...policy, vram: { ...policy.vram, effectiveBytes: limit } }
      await expect(
        gpu.render(raw, undefined, parameters(9), false, false, undefined, undefined, undefined, {
          policy: frozen,
          rendererReservation: { ramBytes: 0, vramBytes: 0 },
          baseEstimatedRamBytes: 0,
        }),
      ).rejects.toBeInstanceOf(GpuResourceBudgetError)
    }
  } finally {
    gpu.close()
  }
})
