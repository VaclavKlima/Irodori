import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { compileToneCurves, curveChannels, identityToneCurves } from '../src/shared/tone-curves'
import { packToneCurves, toneCurvesWgsl } from '../src/shared/tone-curves-gpu'
import reference from './fixtures/tone-curve-reference.json' with { type: 'json' }

test('compensated GPU curves retain independent signed/HDR, steep-segment and Master/RGB tolerances', async () => {
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      return buffer
    }
    const settings = [
      ...reference.curves.map((curve) =>
        compileToneCurves({ ...identityToneCurves, master: curve.points }),
      ),
      ...reference.settings.map((names) =>
        compileToneCurves({
          version: 1,
          ...Object.fromEntries(
            curveChannels.map((channel, i) => [
              channel,
              reference.curves.find((curve) => curve.name === names[i])!.points,
            ]),
          ),
        } as typeof identityToneCurves),
      ),
    ]
    const packed = new Float32Array(settings.flatMap((curves) => [...packToneCurves(curves)])),
      parameters = allocate(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    device.queue.writeBuffer(parameters, 0, packed)
    for (const primaries of ['srgb', 'rec2020'] as const) {
      const cases = [
        ...reference.curves.flatMap((curve, setting) =>
          curve.gpuVectors.map((vector) => ({
            input: [vector.input, 0, 0],
            output: [vector.output, 0, 0],
            base: setting * 200,
            scalar: true,
            identity: curve.points.every((p) => p.input === p.output),
          })),
        ),
        ...reference.colorVectors
          .filter((vector) => vector.primaries === primaries)
          .map((vector) => ({
            ...vector,
            base: (vector.settings + reference.curves.length) * 200,
            scalar: false,
            identity: settings[vector.settings + reference.curves.length].identity,
          })),
      ]
      expect(cases.length).toBeGreaterThan(2000)
      const input = allocate(cases.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        output = allocate(cases.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      device.queue.writeBuffer(
        input,
        0,
        new Float32Array(
          cases.flatMap((v, i) => [...v.input, (i % 4) / 3, v.base, Number(v.scalar), 0, 0]),
        ),
      )
      const module = device.createShaderModule({
        code:
          toneCurvesWgsl(primaries) +
          `
struct CurveCase { pixel:vec4f, control:vec4f }
@group(0) @binding(5) var<storage,read> cases:array<CurveCase>;
@group(0) @binding(6) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn checkCurves(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&cases)) {return;}
  let v=cases[id.x];var rgb=v.pixel.rgb;
  if(v.control.y==1.) {rgb.x=curveValue(curveEvaluate(vec2f(rgb.x,0.),u32(v.control.x)));}
  else {rgb=curveApplyAt(rgb,u32(v.control.x));}
  result[id.x]=vec4f(rgb,v.pixel.a);
}`,
      })
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'checkCurves' },
      })
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 5, resource: { buffer: input } },
          { binding: 6, resource: { buffer: output } },
          { binding: 7, resource: { buffer: parameters } },
        ],
      })
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(cases.length / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        const actual = new Float32Array(staging.getMappedRange())
        let maximumRatio = 0,
          nonfinite = 0,
          alphaMismatch = 0,
          identityMismatch = 0,
          worst: unknown
        for (const [i, vector] of cases.entries()) {
          if (actual[i * 4 + 3] !== Math.fround((i % 4) / 3)) alphaMismatch++
          for (let channel = 0; channel < 3; channel++) {
            const value = actual[i * 4 + channel],
              expected = vector.output[channel]
            if (!Number.isFinite(value)) nonfinite++
            if (vector.identity && value !== Math.fround(vector.input[channel])) identityMismatch++
            const ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
            if (ratio > maximumRatio) {
              maximumRatio = ratio
              worst = { vector, channel, value, expected }
            }
          }
        }
        expect(nonfinite).toBe(0)
        expect(alphaMismatch).toBe(0)
        expect(identityMismatch).toBe(0)
        expect(maximumRatio, JSON.stringify({ primaries, worst })).toBeLessThanOrEqual(1)
      } finally {
        staging.unmap()
      }
    }
  } finally {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})
