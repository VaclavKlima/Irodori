import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { createMaskBaseAtlas } from '../src/main/gpu/mask-bases'
import { prepareMaskEdgeCoverage } from '../src/main/mask-edges/gpu'
import { activeNativeMaskEdges } from '../src/main/mask-edges/native'
import {
  localMasksWgsl,
  packLocalMasks,
  maskBaseAtlasPlan,
  maskCoverageNodes,
  mapMaskCoverage,
  coveragePixelData,
} from '../src/shared/masks-gpu'
import {
  identityMaskGeometry,
  maskOutputSize,
  type MaskGeometry,
} from '../src/shared/mask-geometry'
import { type ResolvedMask } from '../src/shared/masks'
import {
  compoundLeaf as leaf,
  compoundOperand as operand,
  compoundOracle as oracle,
} from './helpers/mask-compound'
import { referenceMaskEdges } from './helpers/mask-edge-reference'
import { generatedMask } from './helpers/generated-mask'
import { brush, referenceCoverage } from './helpers/mask-reference'
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

test('WGSL compound postfix matches ordered soft math, nested grouping, disabled operands, result corrections and inversion', async () => {
  const gpu = await harness(),
    geometry = identityMaskGeometry(200, 100)
  try {
    const nested = {
      ...leaf(0.3),
      operands: [operand(leaf(-0.2), 'add'), operand(leaf(0.1), 'intersect')],
    }
    const masks: ResolvedMask[] = [
      {
        ...leaf(0.1),
        operands: [operand(leaf(0.2), 'subtract'), operand(leaf(-0.1), 'intersect')],
      },
      { ...leaf(0.1), operands: [operand({ ...nested, inverted: true }, 'subtract')] },
      {
        ...leaf(0.1),
        operands: [operand(nested, 'intersect'), { ...operand(leaf(0.3), 'add'), enabled: false }],
        resultStrokes: [
          brush('add', 0.1, 0, [[0.6, 0.4]]),
          brush('subtract', 0.05, 0, [[0.2, 0.4]]),
        ],
        inverted: true,
      },
    ]
    const points = Array.from({ length: 117 }, (_, i) => ({
      x: ((i % 13) + 0.5) / 13,
      y: (Math.floor(i / 13) + 0.5) / 9,
    }))
    for (const mask of masks) {
      const actual = await gpu.read(
        mask,
        geometry,
        points.map((p) => ({ x: p.x * 200, y: p.y * 100 })),
      )
      points.forEach((p, i) => {
        const expected = oracle(mask, p.x, p.y)
        close(actual[i * 4 + 3], expected, { p, mask })
        // Corrections are applied once to the root, never once per copied operand.
        close(actual[i * 4], 0.2 * (1 - expected) + 0.2 * 2 ** mask.light.exposureEv * expected, {
          p,
        })
      })
    }
  } finally {
    gpu.owner.close()
  }
})

test('prepared child and parent coverage replace entire analytic subtrees, without repeating child geometry, inversion or corrections', async () => {
  const gpu = await harness(),
    width = 200,
    height = 100,
    geometry = identityMaskGeometry(width, height)
  try {
    const child = {
      ...leaf(0.2),
      inverted: true,
      edge: { featherPx: 1.5, shiftPx: -1 },
      operands: [operand(leaf(0.4), 'subtract')],
    }
    const bytes = await prepareMaskEdgeCoverage(
      gpu.device,
      child,
      width,
      height,
      new AbortController().signal,
    )
    const reference = referenceMaskEdges(child, width, height, undefined, (x, y) =>
      oracle(child, x, y),
    )
    expect(
      Math.max(...bytes.map((value, i) => Math.abs(value - reference[i]))),
    ).toBeLessThanOrEqual(1)
    const prepared = {
      ...generatedMask(width, height, (x, y) => bytes[y * width + x]),
      key: 'a'.repeat(64),
    }
    const mask = {
      ...leaf(0.1),
      operands: [operand({ ...child, preparedCoverage: prepared }, 'subtract')],
    }
    const points = Array.from({ length: 30 }, (_, i) => ({
      x: ((i * 7) % width) + 0.5,
      y: ((i * 11) % height) + 0.5,
    }))
    const actual = await gpu.read(mask, geometry, points)
    points.forEach((p, i) =>
      close(
        actual[i * 4 + 3],
        referenceCoverage(leaf(0.1), p.x / width, p.y / height, width, height) *
          (1 - bytes[Math.floor(p.y) * width + Math.floor(p.x)] / 255),
        { p },
      ),
    )
    const final: ResolvedMask = { ...mask, edge: { featherPx: 2, shiftPx: 1 } }
    const complete = await prepareMaskEdgeCoverage(
      gpu.device,
      final,
      width,
      height,
      new AbortController().signal,
    )
    const beforeEdges = (x: number, y: number) =>
      referenceCoverage(leaf(0.1), x, y, width, height) *
      (1 -
        bytes[
          Math.min(height - 1, Math.floor(y * height)) * width +
            Math.min(width - 1, Math.floor(x * width))
        ] /
          255)
    const completeReference = referenceMaskEdges(final, width, height, undefined, beforeEdges)
    expect(
      Math.max(...complete.map((value, i) => Math.abs(value - completeReference[i]))),
    ).toBeLessThanOrEqual(1)
    final.preparedCoverage = {
      ...generatedMask(width, height, (x, y) => complete[y * width + x]),
      key: 'b'.repeat(64),
    }
    const sampled = await gpu.read(final, geometry, points)
    points.forEach((p, i) =>
      close(sampled[i * 4 + 3], complete[Math.floor(p.y) * width + Math.floor(p.x)] / 255, { p }),
    )
    expect(maskBaseAtlasPlan({ localMasks: [final] }, true).bases).toHaveLength(1)
  } finally {
    gpu.owner.close()
  }
})

test('nested analytic geometry needs no native coverage atlas, identities include nested operators and reject resource excess', () => {
  const root = { ...leaf(0.1), operands: [operand(leaf(0.3), 'subtract')] }
  expect(maskBaseAtlasPlan({ localMasks: [root] }).bases).toEqual([])
  const identity = JSON.stringify(coveragePixelData(root))
  expect(
    JSON.stringify(
      coveragePixelData({ ...root, operands: [{ ...root.operands[0], operator: 'intersect' }] }),
    ),
  ).not.toBe(identity)
  expect(
    JSON.stringify(
      coveragePixelData({ ...root, name: 'Renamed', light: { ...root.light, exposureEv: 2 } }),
    ),
  ).toBe(identity)
  const cleared = mapMaskCoverage(root, (node) => ({ ...node, edge: { featherPx: 0, shiftPx: 0 } }))
  expect(maskCoverageNodes(cleared)).toHaveLength(2)
  const cached = {
    ...root,
    edge: { featherPx: 1, shiftPx: 0 },
    operands: [{ ...root.operands[0], edge: { featherPx: 3, shiftPx: 1 } }],
    preparedCoverage: { ...generatedMask(200, 100, () => 128), key: 'c'.repeat(64) },
  }
  expect(activeNativeMaskEdges({ localMasks: [cached] }).map((node) => node.id)).toEqual([
    cached.id,
  ])
  let deep = leaf(0.1)
  for (let i = 0; i < 8; i++) deep = { ...leaf(0.1), operands: [operand(deep, 'add')] }
  expect(() => packLocalMasks({ localMasks: [deep] }, { width: 200, height: 100 })).toThrow('depth')
  expect(() =>
    packLocalMasks(
      {
        localMasks: [
          { ...root, operands: Array.from({ length: 32 }, () => operand(leaf(0.1), 'add')) },
        ],
      },
      { width: 200, height: 100 },
    ),
  ).toThrow('node')
  const roots = Array.from({ length: 9 }, () => ({
    ...root,
    id: randomUUID(),
    operands: Array.from({ length: 28 }, () => operand(leaf(0.1), 'add')),
  }))
  expect(() => packLocalMasks({ localMasks: roots }, { width: 200, height: 100 })).toThrow('256')
})

test('final destination edges can spread completed coverage into a previously protected hard boundary', async () => {
  const gpu = await harness(),
    width = 200,
    height = 100
  try {
    const mask: ResolvedMask = {
      ...leaf(0.1),
      gradient: {
        kind: 'radial',
        center: { x: 0.5, y: 0.5 },
        radiusX: 0.35,
        radiusY: 0.4,
        rotation: 0,
        feather: 0,
      },
      operands: [
        operand(
          {
            ...leaf(0.1),
            gradient: {
              kind: 'radial',
              center: { x: 0.5, y: 0.5 },
              radiusX: 0.08,
              radiusY: 0.08,
              rotation: 0,
              feather: 0,
            },
          },
          'subtract',
        ),
      ],
      edge: { featherPx: 2, shiftPx: 2 },
    }
    const pixels = await prepareMaskEdgeCoverage(
      gpu.device,
      mask,
      width,
      height,
      new AbortController().signal,
    )
    const expected = referenceMaskEdges(mask, width, height, undefined, (x, y) =>
      oracle(mask, x, y),
    )
    expect(
      Math.max(...pixels.map((value, i) => Math.abs(value - expected[i]))),
    ).toBeLessThanOrEqual(1)
    expect(oracle(mask, 114.5 / width, 50.5 / height)).toBe(0)
    expect(pixels[50 * width + 114]).toBeGreaterThan(0)
  } finally {
    gpu.owner.close()
  }
})
