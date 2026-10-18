/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { test, expect } from '@playwright/test'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createExportGpu, exportShader } from '../src/main/export/gpu'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { exportRenditions } from '../src/main/export/renditions'
import { defaultExportOptions } from '../src/shared/export'
import { neutralAdjustments } from '../src/shared/adjustments'
import { adjustHdr, outputHdr, contentHdr, SDR_TARGET } from '../src/shared/hdr'
import { syntheticExportSource } from './export.helpers'
import { fromHalf } from './export-reference'
import { buildAcesReference, referenceAces } from './aces-reference'
import { acesRegressionInputs } from './aces-regression-inputs'
import reference from './fixtures/aces-reference.json' with { type: 'json' }
import { exportPrecisionData } from '../src/main/export/precision-wgsl'

test('range-reduced logarithms and exponentials retain compensated precision across bin boundaries', async () => {
  const gpu = new RawGpuRenderer(),
    resources: GPUBuffer[] = []
  const pairs: number[][] = []
  for (let i = 0; i < 2048; i++) {
    const e = -40 + (80 * i) / 2047
    const value = 2 ** (-90 + (180 * i) / 2047) * (1 + ((i % 32) + 0.5) / 32)
    pairs.push([e, value])
  }
  for (let i = -64; i <= 64; i++) {
    pairs.push([(i * Math.LN2) / 32 + 1e-7, 1 + (i + 32.5) / 64])
    pairs.push([(i * Math.LN2) / 32 - 1e-7, 1 + 2 ** -25 * i])
  }
  for (let i = 0; i <= 256; i++) {
    pairs.push([(i * Math.LN2) / 256 + 1e-7, 1 + i / 256 + 1e-7])
    pairs.push([(i * Math.LN2) / 256 - 1e-7, 1 + i / 256 - 1e-7])
  }
  const data = new Float32Array(
    pairs.flatMap(([e, value]) => [
      Math.fround(e),
      e - Math.fround(e),
      Math.fround(value),
      value - Math.fround(value),
    ]),
  )
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      resources.push(buffer)
      return buffer
    }
    const input = allocate(data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const output = allocate(4 + pairs.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const math = allocate(
      exportPrecisionData.byteLength,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    )
    device.queue.writeBuffer(math, 0, exportPrecisionData)
    const staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    const module = device.createShaderModule({
      code:
        exportShader(false, false) +
        `
@compute @workgroup_size(64) fn checkMath(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=${pairs.length}u) {return;}
 let p=input[id.x]; let e=dsExp(p.xy); let l=dsLog(p.zw);
 result.values[id.x*4u]=bitcast<u32>(e.x); result.values[id.x*4u+1u]=bitcast<u32>(e.y);
 result.values[id.x*4u+2u]=bitcast<u32>(l.x); result.values[id.x*4u+3u]=bitcast<u32>(l.y);
}`,
    })
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'checkMath' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: input } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: math } },
      ],
    })
    device.queue.writeBuffer(input, 0, data)
    const command = device.createCommandEncoder(),
      pass = command.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(pairs.length / 64))
    pass.end()
    command.copyBufferToBuffer(output, 0, staging, 0, output.size)
    device.queue.submit([command.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    try {
      const actual = new Float32Array(staging.getMappedRange(), 4, pairs.length * 4)
      for (let i = 0; i < pairs.length; i++) {
        const expectedExp = Math.exp(data[i * 4] + data[i * 4 + 1])
        const expectedLog = Math.log(data[i * 4 + 2] + data[i * 4 + 3])
        expect(
          Math.abs(actual[i * 4] + actual[i * 4 + 1] - expectedExp) / expectedExp,
          `exp ${i}`,
        ).toBeLessThanOrEqual(2e-13)
        expect(
          Math.abs(actual[i * 4 + 2] + actual[i * 4 + 3] - expectedLog),
          `log ${i}`,
        ).toBeLessThanOrEqual(2e-13 * Math.max(1, Math.abs(expectedLog)))
      }
    } finally {
      staging.unmap()
    }
  } finally {
    for (const buffer of resources) buffer.destroy()
    gpu.close()
  }
})

test('both export renditions agree with independent Float64 CTL at retained full-precision tolerances', async ({}, info) => {
  const directory = info.outputPath('ctl')
  await mkdir(directory)
  const binary = buildAcesReference(directory)
  const input = new Float32Array(
    [...reference.inputs, ...acesRegressionInputs].flatMap((v) => [...v, 1]),
  )
  const actualInput = Array.from({ length: input.length / 4 }, (_, i) =>
    Array.from(input.subarray(i * 4, i * 4 + 3)),
  )
  const gpu = await createExportGpu(actualInput.length, neutralAdjustments, undefined, true, false)
  try {
    const rendered = await gpu.render(input)
    const values = new Float32Array(
      rendered.data.buffer,
      rendered.data.byteOffset,
      rendered.data.byteLength / 4,
    )
    for (const [offset, peak, space] of [
      [0, 1, 'srgb'],
      [3, 10, 'rec2020'],
    ] as const) {
      const expected = referenceAces(binary, actualInput, peak, space)
      for (let i = 0; i < actualInput.length; i++)
        for (let c = 0; c < 3; c++) {
          const target = Math.max(0, Math.min(peak, expected[i][c]))
          expect(
            Math.abs(values[i * 6 + offset + c] - target),
            `pixel ${i}/${c}, peak ${peak}`,
          ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(target))
        }
    }
  } finally {
    gpu.close()
  }
})

test('GPU export retains white balance, extreme combined edits, alpha and round-to-even HDR packing', async () => {
  const a = {
    ...neutralAdjustments,
    exposureEv: 0.75,
    contrast: 85,
    highlights: -80,
    shadows: 90,
    whites: -70,
    blacks: 20,
  }
  const wb = [1.1, -0.02, 0.01, 0.01, 0.93, 0, -0.01, 0.01, 1.2]
  const pixels = Array.from({ length: 513 }, (_, i) => [
    i / 32 - 0.1,
    i / 73,
    i / 128,
    [0, 0.25, 1][i % 3],
  ])
  const input = new Float32Array(pixels.flat())
  const gpu = await createExportGpu(pixels.length, a, wb, true, false)
  const packed = await createExportGpu(pixels.length, a, wb, true, true)
  try {
    const rendered = await gpu.render(input)
    const floats = new Float32Array(
      rendered.data.buffer,
      rendered.data.byteOffset,
      rendered.data.byteLength / 4,
    )
    const codes = await packed.render(input)
    const words = new Uint32Array(
      codes.data.buffer,
      codes.data.byteOffset,
      codes.data.byteLength / 4,
    )
    let peak = 1.01
    for (let i = 0; i < pixels.length; i++) {
      const p = Array.from(input.subarray(i * 4, i * 4 + 4)),
        adjusted = adjustHdr(p.slice(0, 3) as [number, number, number], a, wb)
      const sdr = outputHdr(adjusted, SDR_TARGET).rgb,
        hdr = contentHdr(adjusted).rgb
      for (let c = 0; c < 3; c++) {
        for (const [offset, reference] of [
          [0, sdr],
          [3, hdr],
        ] as const) {
          const target = reference[c] * p[3] + 1 - p[3]
          expect(Math.abs(floats[i * 6 + offset + c] - target)).toBeLessThanOrEqual(
            2e-6 + 2e-5 * Math.abs(target),
          )
        }
        const half = c < 2 ? (words[i * 3 + 1] >>> (c * 16)) & 65535 : words[i * 3 + 2] & 65535
        expect(Math.abs(fromHalf(half) - floats[i * 6 + 3 + c])).toBeLessThanOrEqual(0.004)
        peak = Math.max(peak, floats[i * 6 + 3 + c])
      }
      expect(words[i * 3 + 2] >>> 16).toBe(0x3c00)
    }
    expect(codes.headroom).toBeCloseTo(peak, 5)
    await expect(gpu.render(new Float32Array((pixels.length + 1) * 4))).rejects.toThrow(
      'tile length',
    )
  } finally {
    gpu.close()
    packed.close()
  }
})

test('native-size streaming avoids scratch renditions and a failed second tile rerenders the complete frozen source', async ({}, info) => {
  const directory = info.outputPath('stream')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 17, 129, (x, y) => [x / 16, y / 32, 0.1])
  const job = { source, options: defaultExportOptions, directory, hdr: true }
  const expected = await exportRenditions(job)
  expect(expected.diagnostics.renderer).toBe('gpu')
  await expect(access(join(directory, 'rendition.f32'))).rejects.toThrow()
  const sdr = await exportRenditions({ ...job, hdr: false })
  expect(sdr.diagnostics.renderer).toBe('gpu')
  expect(sdr.half).toBeUndefined()
  for (let i = 0; i < expected.rgb.length; i++)
    expect(Math.abs(expected.rgb[i] - sdr.rgb[i])).toBeLessThanOrEqual(1)
  let calls = 0,
    closed = false
  const recovered = await exportRenditions(job, async (...args) => {
    const real = await createExportGpu(...args)
    return {
      ...real,
      render: async (pixels) => {
        if (++calls === 2) throw new Error('Injected device loss')
        return real.render(pixels)
      },
      close: () => {
        closed = true
        real.close()
      },
    }
  })
  expect(calls).toBe(2)
  expect(closed).toBe(true)
  expect(recovered.diagnostics).toMatchObject({
    renderer: 'cpu',
    rendererFallback: 'Injected device loss',
  })
  for (let i = 0; i < expected.rgb.length; i++)
    expect(Math.abs(expected.rgb[i] - recovered.rgb[i])).toBeLessThanOrEqual(1)
  for (let i = 0; i < expected.half!.length; i++)
    expect(
      Math.abs(fromHalf(expected.half![i]) - fromHalf(recovered.half![i])),
    ).toBeLessThanOrEqual(0.004)
  const damaged = await readFile(source.path)
  damaged[damaged.length - 1] ^= 1
  await writeFile(source.path, damaged)
  await expect(exportRenditions(job)).rejects.toThrow('Damaged HDR')
})

test('a staged HDR failure drains early JPEG work before complete CPU recovery', async ({}, info) => {
  const directory = info.outputPath('staged-failure')
  await mkdir(directory)
  const source = await syntheticExportSource(directory, 17, 67, (x, y) => [x / 8, y / 20, 0.1])
  let earlyStarted = false,
    earlyFinished = false
  const recovered = await exportRenditions(
    { source, directory, options: defaultExportOptions, hdr: true },
    async (...args) => {
      const gpu = await createExportGpu(...args)
      expect(gpu.hdrDeferred).toBe(true)
      return {
        ...gpu,
        finishHdr: async () => {
          throw new Error('Injected HDR stage loss')
        },
      }
    },
    async () => {
      earlyStarted = true
      await new Promise<void>((accept) => setTimeout(accept, 50))
      earlyFinished = true
      return Buffer.from('discarded JPEG work')
    },
  )
  expect(earlyStarted).toBe(true)
  expect(earlyFinished).toBe(true)
  expect(recovered.earlyPrimary).toBeUndefined()
  expect(recovered.diagnostics).toMatchObject({
    renderer: 'cpu',
    rendererFallback: 'Injected HDR stage loss',
  })
  expect(recovered.rgb.some((value) => value > 0)).toBe(true)
})
