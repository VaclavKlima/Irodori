import { expect, test } from '@playwright/test'
import { createPointGpu } from '../src/main/gpu/point-renderer'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { outputHdr, SDR_TARGET } from '../src/shared/hdr'
import { renderHdrContent } from '../src/shared/display-rendering'

const values = [0.00001, 0.11, 0.4999, 0.9999, 1.00049, 1.01123, 1.50048, 2.00097, 7.9981, 10]
function fixture() {
  const parent = new Float32Array(
    values.flatMap((v, i) => [v, v * 0.7, v * 0.4, i % 5 === 0 ? 0 : i % 3 === 0 ? 0.5 : 1]),
  )
  const candidate = new Float32Array(
    values.flatMap((v, i) => [v * 0.33, v * 0.9, v * 0.6, parent[i * 4 + 3]]),
  )
  const union = new Float32Array(values.map((_, i) => (i % 3 === 0 ? 0 : i % 3 === 1 ? 0.25 : 1)))
  const primary = new Float32Array(
    values.flatMap((_, i) => [0.12 + i * 0.03, 0.2, 0.3, parent[i * 4 + 3]]),
  )
  const preparedPrimary = new Float32Array(
    values.flatMap((_, i) => [0.5, 0.03 + i * 0.02, 0.14, parent[i * 4 + 3]]),
  )
  return { parent, candidate, union, primary, preparedPrimary }
}
for (const domain of ['scene-linear', 'authored-hdr'] as const)
  for (const packed of [true, false])
    test(`prepared ${domain} ${packed ? 'packed HDR' : 'Float32 HDR'} preserves actual legacy native words and unrounded neutral-union headroom`, async () => {
      const f = fixture(),
        a = { ...neutralAdjustments, exposureEv: 0.27, contrast: 13, saturation: 9 },
        options = { domain, transform: srgbTransform, primary: domain === 'authored-hdr' },
        original = await createPointGpu(
          values.length,
          a,
          undefined,
          true,
          packed,
          64,
          0,
          undefined,
          options,
        )
      let prepared: Awaited<ReturnType<typeof createPointGpu>> | undefined
      try {
        prepared = await createPointGpu(
          values.length,
          a,
          undefined,
          true,
          packed,
          64,
          0,
          undefined,
          { ...options, preparedPoint: true },
        )
        const primary = options.primary
          ? { legacy: f.primary, prepared: f.preparedPrimary, union: f.union }
          : undefined
        const legacy = await original.render(f.parent, 0, options.primary ? f.primary : undefined)
        const zero = await prepared.renderPrepared!(
          f.parent,
          f.candidate,
          new Float32Array(values.length),
          0,
          primary ? { ...primary, union: new Float32Array(values.length) } : undefined,
        )
        expect(zero.data).toEqual(legacy.data)
        if (packed) expect(zero.headroom).toBe(legacy.headroom)
        const active = await prepared.renderPrepared!(f.parent, f.candidate, f.union, 0, primary)
        // The old brightest region is replaced. Metadata must follow the selected
        // unrounded content, rather than either complete input's maximum or half rounding.
        if (domain === 'authored-hdr') expect(active.headroom).toBe(f.candidate[8 * 4 + 1])
        const expected = new Uint32Array(
          legacy.data.buffer,
          legacy.data.byteOffset,
          legacy.data.byteLength / 4,
        )
        const actual = new Uint32Array(
          active.data.buffer,
          active.data.byteOffset,
          active.data.byteLength / 4,
        )
        const floats = new Float32Array(actual.buffer, actual.byteOffset, actual.length)
        const stride = packed ? 3 : 6
        let changes = 0
        for (let i = 0; i < values.length; i++) {
          if (f.union[i] === 0 || f.parent[i * 4 + 3] === 0) {
            for (let c = 0; c < stride; c++)
              expect(actual[i * stride + c]).toBe(expected[i * stride + c])
          } else {
            changes += Number(actual[i * stride] !== expected[i * stride])
            if (!packed) {
              const alpha = f.parent[i * 4 + 3],
                rgb = Array.from(f.candidate.subarray(i * 4, i * 4 + 3)) as [
                  number,
                  number,
                  number,
                ],
                content = domain === 'authored-hdr' ? rgb : renderHdrContent(rgb).rgb,
                sdr =
                  domain === 'authored-hdr'
                    ? Array.from(f.preparedPrimary.subarray(i * 4, i * 4 + 3))
                    : outputHdr(rgb, SDR_TARGET).rgb
              for (let c = 0; c < 3; c++) {
                const value = Math.min(10, Math.max(0, content[c])) * alpha + 1 - alpha
                expect(Math.abs(floats[i * 6 + 3 + c] - value)).toBeLessThanOrEqual(
                  2e-6 + 2e-5 * Math.abs(value),
                )
                expect(
                  Math.abs(
                    floats[i * 6 + c] - (Math.min(1, Math.max(0, sdr[c])) * alpha + 1 - alpha),
                  ),
                ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(sdr[c]))
              }
            }
          }
        }
        expect(changes).toBeGreaterThan(0)
        expect(Number.isFinite(active.headroom)).toBe(true)
        test.info().annotations.push({ type: 'adapter', description: prepared.adapter })
      } finally {
        await prepared?.close()
        await original.close()
      }
    })

for (const authored of [false, true])
  test(`prepared browser HDR ${authored ? 'authored' : 'scene'} cache preserves actual legacy words, Before and zero-union histogram`, async () => {
    const { RawGpuRenderer } = await import('../src/main/gpu/raw-renderer')
    const { prepareHdrPipelines } = await import('../src/renderer/src/preview/hdr-pipelines')
    const { packAces } = await import('../src/shared/aces-data')
    const { prepareDisplayRendering, HDR_CONTENT_TARGET } =
      await import('../src/shared/display-rendering')
    const { HDR_HISTOGRAM_WORDS } = await import('../src/renderer/src/preview/hdr-histogram')
    const raw = new RawGpuRenderer(),
      resources: GPUBuffer[] = [],
      textures: GPUTexture[] = []
    try {
      const { device, adapter } = await raw.mergeDevice(),
        width = 4,
        height = 2,
        extent = [6, 4, 1] as const,
        programs = await prepareHdrPipelines(device, { interactive: true, prepared: true })
          .pipelines,
        base = await prepareHdrPipelines(device, { interactive: true }).pipelines,
        parent = new Float32Array([
          0.1, 0.2, 0.3, 1, 0.2, 0.3, 0.4, 1, 0.3, 0.4, 0.5, 0, 0.4, 0.5, 0.6, 0.5, 0.5, 0.6, 0.7,
          1, 0.6, 0.7, 0.8, 1, 0.7, 0.8, 0.9, 1, 0.8, 0.9, 1, 1,
        ]),
        candidate = new Float32Array(parent.map((v, i) => (i % 4 === 3 ? v : v * 0.4))),
        union = new Float32Array([0, 0.25, 1, 1, 0, 2 ** -149, 1, 0]),
        buffer = (size: number, usage: number) => {
          const b = device.createBuffer({ size, usage })
          resources.push(b)
          return b
        },
        texture = (format: GPUTextureFormat, size: readonly [number, number, number]) => {
          const t = device.createTexture({
            format,
            size: [...size],
            usage:
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.STORAGE_BINDING |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.COPY_SRC,
          })
          textures.push(t)
          return t
        },
        source = texture('rgba32float', [width, height, 1]),
        prepared = texture('rgba32float', [width, height, 1]),
        coverage = texture('r32float', [width, height, 1]),
        cached = texture('rgba32float', extent),
        uniform = buffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        jobs = buffer(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        tableData = packAces(prepareDisplayRendering(HDR_CONTENT_TARGET)),
        table = buffer(tableData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        status = buffer(
          4,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        ),
        values = new Float32Array(48)
      values.set([width, height, width, height])
      values[8] = 0.27
      values[14] = 10
      values[31] = Number(authored)
      values[36] = width * height
      values[37] = 10
      device.queue.writeBuffer(uniform, 0, values)
      device.queue.writeBuffer(jobs, 0, new Uint32Array([0, 0, 0, 0]))
      device.queue.writeBuffer(table, 0, tableData)
      device.queue.writeTexture({ texture: source }, parent, { bytesPerRow: width * 16 }, [
        width,
        height,
      ])
      device.queue.writeTexture({ texture: prepared }, candidate, { bytesPerRow: width * 16 }, [
        width,
        height,
      ])
      device.queue.writeTexture({ texture: coverage }, union, { bytesPerRow: width * 4 }, [
        width,
        height,
      ])
      const legacyGroup = device.createBindGroup({
        layout: programs.cacheLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: source.createView() },
          { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
          { binding: 4, resource: { buffer: table } },
          { binding: 5, resource: { buffer: jobs } },
        ],
      })
      const overlay = device.createBindGroup({
        layout: programs.preparedCache!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: prepared.createView() },
          { binding: 2, resource: coverage.createView() },
          { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
          { binding: 4, resource: { buffer: table } },
          { binding: 5, resource: { buffer: jobs } },
          { binding: 6, resource: source.createView() },
          { binding: 7, resource: { buffer: status } },
        ],
      })
      const readCache = async () => {
        const staging = buffer(256 * extent[1], GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
          encoder = device.createCommandEncoder()
        encoder.copyTextureToBuffer(
          { texture: cached },
          { buffer: staging, bytesPerRow: 256 },
          extent,
        )
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        try {
          const bytes = new Uint32Array(staging.getMappedRange()),
            out = new Uint32Array(extent[0] * extent[1] * 4)
          for (let row = 0; row < extent[1]; row++)
            out.set(bytes.subarray(row * 64, row * 64 + extent[0] * 4), row * extent[0] * 4)
          return out
        } finally {
          staging.unmap()
        }
      }
      const draw = async (overlayEnabled: boolean, before = false) => {
        device.queue.writeBuffer(jobs, 0, new Uint32Array([0, 0, 0, Number(before)]))
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(programs.cache)
        pass.setBindGroup(0, legacyGroup)
        pass.dispatchWorkgroups(1, 1, 1)
        pass.end()
        if (overlayEnabled) {
          const next = encoder.beginComputePass()
          next.setPipeline(programs.preparedCache!)
          next.setBindGroup(0, overlay)
          next.dispatchWorkgroups(1, 1, 1)
          next.end()
        }
        device.queue.submit([encoder.finish()])
        return readCache()
      }
      const legacy = await draw(false),
        selected = await draw(true)
      let changes = 0
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const index = y * width + x,
            slot = ((y + 1) * extent[0] + x + 1) * 4
          if (union[index] === 0 || parent[index * 4 + 3] === 0) {
            for (let c = 0; c < 4; c++) expect(selected[slot + c]).toBe(legacy[slot + c])
          } else {
            expect(selected[slot]).not.toBe(legacy[slot])
            changes += Number(selected[slot] !== legacy[slot])
            expect(selected[slot + 3]).toBe(legacy[slot + 3])
          }
        }
      expect(changes).toBeGreaterThan(0)
      expect(await draw(true, true)).toEqual(await draw(false, true))
      device.queue.writeTexture(
        { texture: coverage },
        new Float32Array(width * height),
        { bytesPerRow: width * 4 },
        [width, height],
      )
      const histogram = async (program: GPUComputePipeline, withPrepared: boolean) => {
        const output = buffer(
            HDR_HISTOGRAM_WORDS * 4,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          ),
          readback = buffer(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
          group = device.createBindGroup({
            layout: program.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: source.createView() },
              { binding: 4, resource: { buffer: table } },
              { binding: 6, resource: { buffer: output } },
              ...(withPrepared
                ? [
                    { binding: 7, resource: prepared.createView() },
                    { binding: 8, resource: coverage.createView() },
                  ]
                : []),
            ],
          }),
          encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(program)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(1)
        pass.end()
        encoder.copyBufferToBuffer(output, 0, readback, 0, output.size)
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        try {
          return new Uint32Array(readback.getMappedRange()).slice()
        } finally {
          readback.unmap()
        }
      }
      expect(await histogram(programs.histogram, true)).toEqual(
        await histogram(base.histogram, false),
      )
      if (!authored) {
        const { preparedMaskUnionMipShader } =
          await import('../src/renderer/src/preview/prepared-mask-upload')
        const input = texture('r32float', [2, 2, 1]),
          output = texture('r32float', [1, 1, 1]),
          pipeline = await device.createComputePipelineAsync({
            layout: 'auto',
            compute: {
              module: device.createShaderModule({ code: preparedMaskUnionMipShader }),
              entryPoint: 'down',
            },
          }),
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: input.createView() },
              { binding: 1, resource: output.createView() },
            ],
          }),
          readback = buffer(256, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        device.queue.writeTexture(
          { texture: input },
          new Float32Array([-0, 2 ** -149, 0, 0]),
          { bytesPerRow: 8 },
          [2, 2],
        )
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(1)
        pass.end()
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: readback, bytesPerRow: 256 },
          [1, 1],
        )
        device.queue.submit([encoder.finish()])
        await readback.mapAsync(GPUMapMode.READ)
        try {
          expect(new Uint32Array(readback.getMappedRange())[0]).toBe(1)
        } finally {
          readback.unmap()
        }
      }
      test.info().annotations.push({ type: 'adapter', description: adapter })
    } finally {
      for (const b of resources) b.destroy()
      for (const t of textures) t.destroy()
      raw.close()
    }
  })
