import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { createMaskBaseAtlas } from '../src/main/gpu/mask-bases'
import { prepareMaskEdgeCoverage } from '../src/main/mask-edges/gpu'
import { localMasksWgsl, packLocalMasks } from '../src/shared/masks-gpu'
import {
  croppedMaskGeometry,
  identityMaskGeometry,
  maskOutputSize,
  type MaskGeometry,
} from '../src/shared/mask-geometry'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import type { ResolvedMask } from '../src/shared/masks'
import { gradientCases, gradientMask } from './helpers/mask-gradients'
import { generatedMask } from './helpers/generated-mask'
import { referenceCoverage } from './helpers/mask-reference'
import { referenceMaskEdges } from './helpers/mask-edge-reference'

async function harness() {
  const owner = new RawGpuRenderer(),
    { device, adapter } = await owner.mergeDevice()
  test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
  const module = device.createShaderModule({
      code:
        localMasksWgsl(1, 3) +
        `
@group(0) @binding(0) var<storage,read> points:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&points)){return;}let p=points[id.x].xy;
 output[id.x]=vec4f(applyLocalMasks(vec3f(.2,.1,.05),p,1.,false),maskCoverage(0u,maskCanonical(p)));
}`,
    }),
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'check' },
    })
  return {
    owner,
    device,
    async read(mask: ResolvedMask, geometry: MaskGeometry, points: { x: number; y: number }[]) {
      const parameters = { localMasks: [mask], maskGeometry: geometry },
        packed = packLocalMasks(parameters, maskOutputSize(geometry), true),
        buffers: GPUBuffer[] = []
      let texture: GPUTexture | undefined
      const allocate = (size: number, usage: number) => {
        const b = device.createBuffer({ size, usage })
        buffers.push(b)
        return b
      }
      try {
        const data = allocate(packed.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
          input = allocate(points.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
          output = allocate(points.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
          staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        device.queue.writeBuffer(data, 0, packed)
        device.queue.writeBuffer(
          input,
          0,
          new Float32Array(points.flatMap((p) => [p.x, p.y, 0, 0])),
        )
        texture = await createMaskBaseAtlas(device, parameters)
        const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: input } },
              { binding: 1, resource: { buffer: data } },
              { binding: 2, resource: { buffer: output } },
              { binding: 3, resource: texture.createView({ dimension: '2d-array' }) },
            ],
          }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(Math.ceil(points.length / 64))
        pass.end()
        encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        try {
          return new Float32Array(staging.getMappedRange()).slice()
        } finally {
          staging.unmap()
        }
      } finally {
        await device.queue.onSubmittedWorkDone()
        texture?.destroy()
        buffers.forEach((b) => b.destroy())
      }
    },
  }
}

function close(actual: number, expected: number, detail: unknown) {
  expect(Math.abs(actual - expected), JSON.stringify(detail)).toBeLessThanOrEqual(
    2e-6 + 2e-5 * Math.abs(expected),
  )
}

test('native WGSL gradients match independent cubic/ellipse references, feather extremes and ordered corrections', async () => {
  const gpu = await harness(),
    geometry = identityMaskGeometry(200, 100),
    points = Array.from({ length: 143 }, (_, i) => ({
      x: ((i % 13) - 0.5) / 11,
      y: (Math.floor(i / 13) - 0.5) / 9,
    }))
  try {
    for (const mask of gradientCases()) {
      const actual = await gpu.read(
        mask,
        geometry,
        points.map((p) => ({ x: p.x * 200, y: p.y * 100 })),
      )
      points.forEach((point, i) => {
        const coverage = referenceCoverage(mask, point.x, point.y, 200, 100)
        close(actual[i * 4 + 3], coverage, {
          gradient: mask.gradient,
          inverted: mask.inverted,
          point,
        })
        for (const [c, input] of [0.2, 0.1, 0.05].entries())
          close(
            actual[i * 4 + c],
            input * (1 - coverage) + input * 2 ** mask.light.exposureEv * coverage,
            { c, point, gradient: mask.gradient },
          )
      })
    }
    expect(gpu.owner.failure).toBeUndefined()
  } finally {
    gpu.owner.close()
  }
})

test('gradient coverage remains source-registered through lens crop, every flip and quarter/straighten rotation', async () => {
  const gpu = await harness(),
    mask = gradientMask({
      kind: 'radial',
      center: { x: 0.43, y: 0.57 },
      radiusX: 0.3,
      radiusY: 0.2,
      rotation: 31,
      feather: 50,
    })
  try {
    for (let flip = 0; flip < 8; flip++)
      for (const quarterTurns of [0, 1, 2, 3] as const) {
        const sourceWidth = 200,
          sourceHeight = 100,
          canonicalWidth = flip & 4 ? sourceHeight : sourceWidth,
          canonicalHeight = flip & 4 ? sourceWidth : sourceHeight,
          correction = {
            width: 180,
            height: 90,
            left: 10,
            top: 5,
            distortion: Array(4096).fill(0.8),
          },
          crop = cropGeometry(
            { width: flip & 4 ? 90 : 180, height: flip & 4 ? 180 : 90 },
            { ...identityCrop, quarterTurns, angle: 12, width: 0.6, height: 0.5 },
          ),
          geometry = croppedMaskGeometry(
            {
              version: 1,
              sourceWidth,
              sourceHeight,
              canonicalWidth,
              canonicalHeight,
              flip,
              correction,
            },
            crop,
          ),
          points = Array.from({ length: 40 }, (_, i) => ({
            x: (((i % 8) + 0.5) * crop.width) / 8,
            y: ((Math.floor(i / 8) + 0.5) * crop.height) / 5,
          })),
          actual = await gpu.read(mask, geometry, points)
        points.forEach((p, i) => {
          const m = crop.outputToSource
          let x = m[0] * p.x + m[1] * p.y + m[4],
            y = m[2] * p.x + m[3] * p.y + m[5]
          if (flip & 4) [x, y] = [y, x]
          if (flip & 1) x = 180 - x
          if (flip & 2) y = 90 - y
          x = 100 + (x + 10 - 100) * 0.8
          y = 50 + (y + 5 - 50) * 0.8
          if (flip & 1) x = sourceWidth - x
          if (flip & 2) y = sourceHeight - y
          if (flip & 4) [x, y] = [y, x]
          close(
            actual[i * 4 + 3],
            referenceCoverage(
              mask,
              x / canonicalWidth,
              y / canonicalHeight,
              canonicalWidth,
              canonicalHeight,
            ),
            { flip, quarterTurns, p },
          )
        })
      }
  } finally {
    gpu.owner.close()
  }
})

test('final edge coverage filters the complete gradient once and replaces the analytic base', async () => {
  const gpu = await harness(),
    width = 35,
    height = 137,
    geometry = identityMaskGeometry(width, height)
  try {
    for (const base of gradientCases().filter((_, i) => i === 1 || i === 8 || i === 20)) {
      const mask: ResolvedMask = { ...base, edge: { featherPx: 2.5, shiftPx: -2 } },
        actual = await prepareMaskEdgeCoverage(
          gpu.device,
          mask,
          width,
          height,
          new AbortController().signal,
        ),
        expected = referenceMaskEdges(mask, width, height)
      expect(actual.length).toBe(expected.length)
      expect(
        Math.max(...actual.map((value, i) => Math.abs(value - expected[i]))),
      ).toBeLessThanOrEqual(1)
      mask.preparedCoverage = {
        ...generatedMask(width, height, (x, y) => actual[y * width + x]),
        key: 'a'.repeat(64),
      }
      const points = Array.from({ length: 12 }, (_, i) => ({
          x: ((i * 3) % width) + 0.5,
          y: ((i * 11) % height) + 0.5,
        })),
        sampled = await gpu.read(mask, geometry, points)
      points.forEach((p, i) =>
        close(sampled[i * 4 + 3], actual[Math.floor(p.y) * width + Math.floor(p.x)] / 255, {
          point: p,
          gradient: mask.gradient,
        }),
      )
    }
  } finally {
    gpu.owner.close()
  }
})
