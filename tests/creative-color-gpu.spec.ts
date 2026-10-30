import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { acesWgsl } from '../src/shared/aces-wgsl'
import { compileCreativeColor } from '../src/shared/creative-color'
import {
  creativeColorWgsl,
  packCreativeColor,
  CREATIVE_COLOR_PARAMETER_VECTORS,
  CREATIVE_COLOR_PARAMETER_BYTES,
} from '../src/shared/creative-color-gpu'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import type { ColorPrimaries, ColorTriple } from '../src/shared/color-model'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: ColorTriple
    output: ColorTriple
    primaries: ColorPrimaries
    configuration: number
    selection: { first: number; second: number; blend: number; protection: number }
  }[]
}

test('small native GPU mixer/grading kernels meet fixed independent signed/HDR color and selection limits', async () => {
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = [],
    metrics: {
      primaries: ColorPrimaries
      count: number
      maximumRatio: number
      selectionRatio: number
    }[] = []
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      return buffer
    }
    const compiled = reference.configurations.map((v) =>
        compileCreativeColor(v.mixer, v.intensity, v.grading),
      ),
      packed = new Float32Array(compiled.flatMap((v) => [...packCreativeColor(v)])),
      parameters = allocate(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    expect(packed.byteLength).toBe(reference.configurations.length * CREATIVE_COLOR_PARAMETER_BYTES)
    device.queue.writeBuffer(parameters, 0, packed)
    for (const primaries of ['srgb', 'rec2020'] as const) {
      const vectors = reference.gpuVectors.filter((v) => v.primaries === primaries),
        input = allocate(vectors.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        output = allocate(vectors.length * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      expect(vectors).toHaveLength(1260)
      for (const vector of vectors)
        for (const value of vector.input) assert.equal(value, Math.fround(value))
      device.queue.writeBuffer(
        input,
        0,
        new Float32Array(
          vectors.flatMap((v, i) => [
            ...v.input,
            (i % 4) / 3,
            v.configuration * CREATIVE_COLOR_PARAMETER_VECTORS,
            0,
            0,
            0,
          ]),
        ),
      )
      const module = device.createShaderModule({
        code:
          (primaries === 'rec2020' ? acesWgsl : '') +
          creativeColorWgsl(primaries, 8, primaries === 'rec2020' ? 'acesPow' : 'pow') +
          `
struct CreativeCase { pixel:vec4f, control:vec4f }
struct CreativeResult { pixel:vec4f, selection:vec4f, oldIntensity:vec4f }
@group(0) @binding(5) var<storage,read> cases:array<CreativeCase>;
@group(0) @binding(6) var<storage,read_write> results:array<CreativeResult>;
@compute @workgroup_size(64) fn checkCreative(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&cases)) {return;}
  let v=cases[id.x];let base=u32(v.control.x);
  results[id.x]=CreativeResult(vec4f(creativeColorApplyAt(v.pixel.rgb,base),v.pixel.a),ccSelection(v.pixel.rgb),vec4f(applyColorIntensity(v.pixel.rgb,creativeColorData[base].xy),v.pixel.a));
}`,
      })
      const pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'checkCreative' },
        }),
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 5, resource: { buffer: input } },
            { binding: 6, resource: { buffer: output } },
            { binding: 8, resource: { buffer: parameters } },
          ],
        }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(vectors.length / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        const actual = new Float32Array(staging.getMappedRange())
        let maximumRatio = 0,
          selectionRatio = 0,
          worst: unknown,
          worstSelection: unknown
        for (const [i, v] of vectors.entries()) {
          const at = i * 12,
            selected = v.selection,
            first = actual[at + 4],
            second = actual[at + 5],
            blend = actual[at + 6],
            protection = actual[at + 7]
          assert.equal(actual[at + 3], Math.fround((i % 4) / 3))
          assert.ok(Number.isInteger(first) && first >= 0 && first < 8)
          assert.equal(second, (first + 1) % 8)
          for (let c = 0; c < 3; c++) {
            const value = actual[at + c],
              expected = v.output[c],
              ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            assert.ok(Number.isFinite(value))
            if (
              !compiled[v.configuration].mixer.active &&
              !compiled[v.configuration].grading.active
            )
              assert.equal(value, actual[at + 8 + c])
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = { v, c, value, expected }
            }
          }
          const actualWeights = Array.from({ length: 8 }, (_, j) =>
              j === first ? 1 - blend : j === second ? blend : 0,
            ),
            expectedWeights = Array.from({ length: 8 }, (_, j) =>
              j === selected.first
                ? 1 - selected.blend
                : j === selected.second
                  ? selected.blend
                  : 0,
            )
          for (let j = 0; j < 9; j++) {
            const value = j < 8 ? actualWeights[j] : protection,
              expected = j < 8 ? expectedWeights[j] : selected.protection,
              ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            assert.ok(Number.isFinite(value))
            if (ratio > selectionRatio) {
              selectionRatio = ratio
              worstSelection = { v, j, value, expected }
            }
          }
        }
        expect(
          maximumRatio,
          JSON.stringify({ primaries, worst, selectionRatio, worstSelection }),
        ).toBeLessThanOrEqual(1)
        expect(selectionRatio, JSON.stringify({ primaries, worstSelection })).toBeLessThanOrEqual(1)
        metrics.push({ primaries, count: vectors.length, maximumRatio, selectionRatio })
      } finally {
        staging.unmap()
      }
    }
    await test.info().attach('creative-color-agreement.json', {
      body: Buffer.from(JSON.stringify({ bound: '2e-6 + 2e-5*abs(reference)', metrics }, null, 2)),
      contentType: 'application/json',
    })
  } finally {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})
