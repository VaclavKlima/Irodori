import { expect, test } from '@playwright/test'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import {
  cropTileSourceBounds,
  resampleCropTile,
  type CropRectangle,
} from '../src/shared/crop-filter'
import {
  CROP_GPU_PARAMETER_BYTES,
  cropFilteringWgsl,
  packCropTile,
} from '../src/shared/crop-filter-wgsl'
import reference from './fixtures/crop-filter-reference.json' with { type: 'json' }
import { createCropGpu } from '../src/main/gpu/crop'
import { CROP_COMPUTE_BYTES } from '../src/shared/crop-resources'

test('actual GPU crop filtering matches independent Decimal80 and composed large-coordinate CPU references', async () => {
  const gpu = new RawGpuRenderer(),
    buffers: GPUBuffer[] = []
  try {
    const { device } = await gpu.mergeDevice()
    const allocate = (size: number, usage: number) => {
      const buffer = device.createBuffer({ size, usage })
      buffers.push(buffer)
      return buffer
    }
    const dispatch = async (
      code: string,
      entry: string,
      parameters: Float32Array<ArrayBuffer>,
      input: Float32Array<ArrayBuffer>,
      count: number,
      cases?: Float32Array<ArrayBuffer>,
    ) => {
      const uniform = allocate(
          CROP_GPU_PARAMETER_BYTES,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        ),
        source = allocate(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        output = allocate(count * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        staging = allocate(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
      device.queue.writeBuffer(uniform, 0, parameters)
      device.queue.writeBuffer(source, 0, input)
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: output } },
      ]
      if (cases) {
        const table = allocate(cases.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        device.queue.writeBuffer(table, 0, cases)
        entries.push({ binding: 3, resource: { buffer: table } })
      }
      const module = device.createShaderModule({ code }),
        pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: entry },
        }),
        group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(count / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      const result = new Float32Array(staging.getMappedRange().slice(0))
      staging.unmap()
      return result
    }
    const vectors = reference.scenes.flatMap((scene, index) =>
        scene.vectors.map((vector) => ({ ...vector, scene: scene.name, base: index * 81 })),
      ),
      cases = new Float32Array(
        vectors.flatMap((v) => {
          const x = Math.fround(v.x),
            y = Math.fround(v.y)
          return [
            x,
            Math.fround(v.x - x),
            y,
            Math.fround(v.y - y),
            v.base,
            Number(Number.isInteger(v.x) && Number.isInteger(v.y)),
            0,
            0,
          ]
        }),
      ),
      identity = cropGeometry({ width: 9, height: 9 }, identityCrop),
      dummy = {
        left: 0,
        top: 0,
        width: 9,
        height: 9,
        data: new Float32Array(reference.scenes[0].data.flat()),
      },
      output = await dispatch(
        cropFilteringWgsl +
          `
struct WarpCase { position:vec4f, control:vec4f }
@group(0) @binding(3) var<storage,read> warpCases:array<WarpCase>;
@compute @workgroup_size(64) fn checkPixels(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&warpCases)) {return;}
  let v=warpCases[id.x];
  cropOutput[id.x]=warpReconstruct(v.position.xy,v.position.zw,u32(v.control.x),v.control.y==1.);
}`,
        'checkPixels',
        packCropTile(identity, { left: 0, top: 0, width: 1, height: 1 }, dummy),
        new Float32Array(reference.scenes.flatMap((scene) => scene.data.flat())),
        vectors.length,
        cases,
      )
    let maximumRatio = 0,
      nonfinite = 0,
      worst: unknown
    const compare = (actual: Float32Array, expected: readonly number[], description: unknown) => {
      for (let i = 0; i < expected.length; i++) {
        if (!Number.isFinite(actual[i])) nonfinite++
        const ratio = Math.abs(actual[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i]))
        if (ratio > maximumRatio) {
          maximumRatio = ratio
          worst = { description, i, value: actual[i], expected: expected[i] }
        }
      }
    }
    for (const [i, vector] of vectors.entries()) {
      compare(output.subarray(i * 4, i * 4 + 4), vector.output, vector)
      if (Number.isInteger(vector.x) && Number.isInteger(vector.y)) {
        const expected = new Float32Array(vector.output)
        expect(new Uint32Array(output.buffer, i * 16, 4)).toEqual(new Uint32Array(expected.buffer))
      }
    }

    // A large source descriptor uses only its small requested native window, not a giant image.
    for (const size of [
      { width: 31, height: 27 },
      { width: 32768, height: 32768 },
    ])
      for (const quarterTurns of [0, 1, 2, 3] as const)
        for (const angle of [0, 12.34]) {
          const settings = fitCrop(size, {
              ...identityCrop,
              quarterTurns,
              angle,
              centerX: 0.51,
              centerY: 0.47,
              width: 7 / size.width,
              height: 5 / size.height,
            }),
            geometry = cropGeometry(size, settings),
            tile: CropRectangle = {
              left: 0,
              top: 0,
              width: geometry.width,
              height: geometry.height,
            },
            bounds = cropTileSourceBounds(geometry, tile),
            data = new Float32Array(bounds.width * bounds.height * 4)
          for (let y = 0; y < bounds.height; y++)
            for (let x = 0; x < bounds.width; x++) {
              const xx = x + bounds.left,
                yy = y + bounds.top
              data.set(
                [
                  ((xx * 13 + yy * 3) % 37) / 9 - 1,
                  ((xx * 3 + yy * 17) % 29) / 7 - 0.5,
                  16 + ((xx + yy) % 11),
                  1,
                ],
                (y * bounds.width + x) * 4,
              )
            }
          const source = { ...bounds, data },
            expected = resampleCropTile(
              geometry,
              tile,
              source,
              new Float64Array(tile.width * tile.height * 4),
            ),
            actual = await dispatch(
              cropFilteringWgsl,
              'warpCrop',
              packCropTile(geometry, tile, source),
              data,
              tile.width * tile.height,
            )
          compare(actual, [...expected], { size, settings })
        }
    expect(nonfinite).toBe(0)
    expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
  } finally {
    for (const buffer of buffers) buffer.destroy()
    gpu.close()
  }
})

test('the reusable native GPU owner drains work and repairs low-coverage classification with canonical coordinates', async () => {
  const owner = await createCropGpu(),
    size = { width: 9, height: 9 },
    identity = cropGeometry(size, identityCrop),
    tile = { left: 0, top: 0, width: 3, height: 3 },
    data = new Float32Array(9 * 9 * 4)
  for (let i = 0; i < data.length; i += 4) data.set([4, -0, 16, 1], i)
  const source = { ...size, left: 0, top: 0, data }
  try {
    expect(owner.bytes).toBe(CROP_COMPUTE_BYTES)
    const first = owner.render(identity, tile, source, new AbortController().signal)
    await expect(
      owner.render(identity, tile, source, new AbortController().signal),
    ).rejects.toThrow('busy')
    const copied = await first,
      expected = resampleCropTile(identity, tile, source)
    expect(new Uint32Array(copied.buffer, copied.byteOffset, copied.length)).toEqual(
      new Uint32Array(expected.buffer, expected.byteOffset, expected.length),
    )
    await expect(
      owner.render(
        identity,
        tile,
        source,
        AbortSignal.abort(new Error('Cancelled crop dispatch.')),
      ),
    ).rejects.toThrow('Cancelled crop')
    for (const angle of [-12.34, 12.34])
      for (const fraction of [2 ** -20 - 2 ** -38, 2 ** -20, 2 ** -20 + 2 ** -38]) {
        const geometry = cropGeometry(
            { width: 32768, height: 32768 },
            {
              ...identityCrop,
              angle,
              width: 1 / 32768,
              height: 1 / 32768,
              centerX: (23499 + 0.5 + fraction) / 32768,
              centerY: (21000 + 0.5 + 0.37) / 32768,
            },
          ),
          pointTile = { left: 0, top: 0, width: 1, height: 1 },
          bounds = cropTileSourceBounds(geometry, pointTile),
          pixels = new Float32Array(bounds.width * bounds.height * 4)
        for (let y = 0; y < bounds.height; y++)
          for (let x = 0; x < bounds.width; x++)
            pixels.set([8, 0.4, -1, x + bounds.left >= 23500 ? 1 : 0], (y * bounds.width + x) * 4)
        const window = { ...bounds, data: pixels },
          actual = await owner.render(geometry, pointTile, window, new AbortController().signal),
          canonical = resampleCropTile(geometry, pointTile, window)
        expect(new Uint32Array(actual.buffer, actual.byteOffset, actual.length)).toEqual(
          new Uint32Array(canonical.buffer, canonical.byteOffset, canonical.length),
        )
      }
    expect(owner.precisionRecoveryTiles).toBe(6)
  } finally {
    await owner.close()
  }
  await expect(owner.render(identity, tile, source, new AbortController().signal)).rejects.toThrow(
    'unavailable',
  )
})
