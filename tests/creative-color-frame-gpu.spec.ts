import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { RawGpuRenderer, type FirstSurfaceBorrow } from '../src/main/gpu/raw-renderer'
import { renderFirstSurface } from '../src/main/gpu/hdr-first-surface'
import { neutralAdjustments } from '../src/shared/adjustments'
import { packAces, ACES_DATA_BYTES } from '../src/shared/aces-data'
import { prepareDisplayRendering } from '../src/shared/display-rendering'
import { SDR_TARGET } from '../src/shared/hdr'
import { compileCreativeColor } from '../src/shared/creative-color'
import { packCreativeColor, CREATIVE_COLOR_PARAMETER_BYTES } from '../src/shared/creative-color-gpu'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import {
  HDR_FIRST_SURFACE_VERSION,
  hdrFirstSurfaceOrientation,
  type HdrFirstSurfaceRenderRequest,
} from '../src/shared/hdr-first-surface'
import { DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } from '../src/shared/resource-policy'
import { prepareHdrPipelines } from '../src/renderer/src/preview/hdr-pipelines'
import { hdrCacheKernel } from '../src/renderer/src/preview/hdr-shader'
import { HDR_HISTOGRAM_WORDS } from '../src/renderer/src/preview/hdr-histogram'
import { buildAcesReference, referenceAces } from './aces-reference'

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
const vectorsFor = (index: number) =>
  reference.gpuVectors.filter((v) => v.primaries === 'rec2020' && v.configuration === index)
const settings = (index: number) => {
  const c = reference.configurations[index]
  return {
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: structuredClone(c.mixer),
    colorGrading: structuredClone(c.grading),
  }
}
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
const half = (word: number) => {
  const exponent = (word >>> 10) & 31,
    fraction = word & 1023
  return (
    (word & 32768 ? -1 : 1) *
    (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24)
  )
}
const halfNeighbors = (value: number) => {
  const step = 2 ** (Math.max(-14, Math.floor(Math.log2(Math.max(value, 2 ** -24)))) - 10)
  return [Math.floor(value / step) * step, Math.ceil(value / step) * step]
}

test('actual canonical and interactive HDR cache programs reuse the source and retain independent grading and Before pixels', async () => {
  const gpu = new RawGpuRenderer(),
    resources: (GPUBuffer | GPUTexture)[] = [],
    own = <T extends GPUBuffer | GPUTexture>(v: T) => {
      resources.push(v)
      return v
    }
  try {
    const { device } = await gpu.mergeDevice(),
      base = await prepareHdrPipelines(device, { interactive: true }).pipelines,
      programs = await prepareHdrPipelines(device, { interactive: true, creative: true }).pipelines
    for (const key of ['mip', 'mipLayout', 'layout', 'presentation', 'blit'] as const)
      expect(programs[key]).toBe(base[key])
    expect(programs.cache).not.toBe(base.cache)
    const vectors = vectorsFor(0),
      width = vectors.length,
      extent = 130,
      source = own(
        device.createTexture({
          size: [width, 1],
          format: 'rgba32float',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
        }),
      ),
      cached = own(
        device.createTexture({
          size: [extent, extent, 2],
          format: 'rgba32float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
      ),
      buffer = (size: number, usage: GPUBufferUsageFlags) =>
        own(device.createBuffer({ size, usage })),
      uniform = buffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      tables = buffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      jobs = buffer(32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      color = buffer(
        CREATIVE_COLOR_PARAMETER_BYTES,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      rowBytes = Math.ceil((extent * 16) / 256) * 256,
      staging = buffer(rowBytes * extent * 2, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      values = new Float32Array(48),
      input = new Float32Array(vectors.flatMap((v, i) => [...v.input, (i % 4) / 3]))
    values[31] = 1 // Authored scene-linear content avoids a second display rendering.
    device.queue.writeTexture({ texture: source }, input, { bytesPerRow: width * 16 }, [width, 1])
    device.queue.writeBuffer(
      tables,
      0,
      packAces(prepareDisplayRendering({ mode: 'hdr', peak: 10, colorSpace: 'rec2020' })),
    )
    device.queue.writeBuffer(jobs, 0, new Uint32Array([0, 0, 0, 0, 0, 0, 1, 1]))
    const group = device.createBindGroup({
      layout: programs.cacheLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: source.createView() },
        { binding: 3, resource: cached.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: { buffer: tables } },
        { binding: 5, resource: { buffer: jobs } },
        { binding: 12, resource: { buffer: color } },
      ],
    })
    let maximumRatio = 0,
      worst: unknown,
      count = 0
    for (const [index, c] of reference.configurations.entries()) {
      values[44] = c.intensity.saturation
      values[45] = c.intensity.vibrance
      device.queue.writeBuffer(uniform, 0, values)
      device.queue.writeBuffer(
        color,
        0,
        packCreativeColor(compileCreativeColor(c.mixer, c.intensity, c.grading)),
      )
      const expected = vectorsFor(index)
      for (const pipeline of [programs.cache, ...Object.values(programs.interactive)]) {
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(...hdrCacheKernel().dispatch(extent, 2))
        pass.end()
        encoder.copyTextureToBuffer(
          { texture: cached },
          { buffer: staging, bytesPerRow: rowBytes, rowsPerImage: extent },
          [extent, extent, 2],
        )
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        const output = new DataView(staging.getMappedRange())
        for (let layer = 0; layer < 2; layer++)
          for (let x = 0; x < width; x++) {
            const offset = layer * rowBytes * extent + rowBytes + (x + 1) * 16
            for (let channel = 0; channel < 3; channel++) {
              const wanted = Math.max(
                  0,
                  layer ? expected[x].input[channel] : expected[x].output[channel],
                ),
                actual = output.getFloat32(offset + channel * 4, true),
                ratio = Math.abs(actual - wanted) / (2e-6 + 2e-5 * Math.abs(wanted))
              assert.ok(Number.isFinite(actual))
              if (ratio > maximumRatio) {
                maximumRatio = ratio
                worst = { index, layer, x, channel, actual, wanted, input: expected[x].input }
              }
            }
            expect(output.getFloat32(offset + 12, true)).toBe(input[x * 4 + 3])
          }
        staging.unmap()
        count += width
      }
    }
    expect(count).toBe(1260 * 3)
    expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)

    // The histogram uses its own color packet; subsequent preview writes cannot relabel it.
    const histColor = buffer(
        CREATIVE_COLOR_PARAMETER_BYTES,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      ),
      histogram = buffer(HDR_HISTOGRAM_WORDS * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      histRead = buffer(histogram.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      c = reference.configurations[9]
    device.queue.writeBuffer(
      histColor,
      0,
      packCreativeColor(compileCreativeColor(c.mixer, c.intensity, c.grading)),
    )
    const histogramGroup = device.createBindGroup({
      layout: programs.histogram.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: source.createView() },
        { binding: 4, resource: { buffer: tables } },
        { binding: 6, resource: { buffer: histogram } },
        { binding: 12, resource: { buffer: histColor } },
      ],
    })
    values[36] = width
    values[37] = 10
    device.queue.writeBuffer(uniform, 0, values)
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(programs.histogram)
    pass.setBindGroup(0, histogramGroup)
    pass.dispatchWorkgroups(Math.ceil(width / 64))
    pass.end()
    encoder.copyBufferToBuffer(histogram, 0, histRead, 0, histogram.size)
    device.queue.submit([encoder.finish()])
    await histRead.mapAsync(GPUMapMode.READ)
    const actual = new Uint32Array(histRead.getMappedRange()),
      expected = new Uint32Array(HDR_HISTOGRAM_WORDS)
    for (const [i, v] of vectorsFor(9).entries()) {
      if (input[i * 4 + 3] === 0) continue
      const rgb = v.output.map((v) => Math.max(0, v))
      for (let channel = 0; channel < 3; channel++) {
        const value = rgb[channel],
          bin =
            value > 1
              ? 256 + Math.min(255, Math.floor(Math.log2(value) * 64))
              : Math.round(Math.min(1, encode(value)) * 255)
        expected[256 + channel * 512 + bin]++
      }
      expected[1792]++
    }
    expect([...actual.subarray(256, 1793)]).toEqual([...expected.subarray(256, 1793)])
    histRead.unmap()
  } finally {
    for (const resource of resources.reverse()) resource.destroy()
    gpu.close()
  }
})

test('actual first HDR surfaces grade independent source pixels, freeze caller settings and charge bounded color resources', async () => {
  const gpu = new RawGpuRenderer()
  let source: GPUTexture | undefined
  try {
    const directory = test.info().outputPath('ctl')
    await mkdir(directory)
    const binary = buildAcesReference(directory),
      { device, adapter } = await gpu.mergeDevice(),
      vectors = vectorsFor(0),
      width = vectors.length
    source = device.createTexture({
      size: [width, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    device.queue.writeTexture(
      { texture: source },
      new Float32Array(vectors.flatMap((v) => [...v.input, 1])),
      { bytesPerRow: width * 16 },
      [width, 1],
    )
    const borrow: FirstSurfaceBorrow = {
        device,
        texture: source,
        width,
        height: 1,
        flip: 0,
        baseEstimatedGpuBytes: width * 16,
        baseEstimatedRamBytes: width * 16,
        adapterTextureArrayLayers: device.limits.maxTextureArrayLayers,
        adapter,
        correctedFenceSinceRenderStartMs: 0,
        correctedCheckedSinceRenderStartMs: 0,
      },
      request = (index: number): HdrFirstSurfaceRenderRequest => ({
        version: HDR_FIRST_SURFACE_VERSION,
        generation: 1,
        settingsRevision: 1,
        parameters: settings(index),
        target: { ...SDR_TARGET, generation: 1 },
        viewport: { width, height: 1 },
        dpr: 1,
        view: { fit: true, scale: 1, x: 0, y: 0 },
        comparison: 'after',
        split: 0.5,
        hdrRanges: false,
        kernel: 'linear64',
        rendererReservation: { ramBytes: 0, vramBytes: 0 },
        originalSha256: 'a'.repeat(64),
        parentWorkingKey: 'b'.repeat(64),
        image: { width, height: 1 },
        sourceIdentity: { orientation: hdrFirstSurfaceOrientation({ width, height: 1 }, 0, 0) },
        policy: resolveResourcePolicy(
          DEFAULT_RESOURCE_SETTINGS,
          {
            ram: { totalBytes: 4 * 1024 ** 3, availableBytes: 3 * 1024 ** 3 },
            gpu: { status: 'unknown', reason: 'adapter-unverified' },
          },
          1,
        ),
      }),
      signal = new AbortController().signal,
      neutral = await renderFirstSurface(borrow, request(0), signal)
    assert.equal(neutral.status, 'ready')
    for (const index of [1, 6, 9]) {
      const input = request(index),
        pending = renderFirstSurface(borrow, input, signal)
      Object.assign(input.parameters.colorGrading!.tones.shadows, { hue: 23, saturation: 100 })
      const actual = await pending
      assert.equal(actual.status, 'ready')
      expect(actual.ownedBytes.vramBytes).toBe(
        neutral.ownedBytes.vramBytes + CREATIVE_COLOR_PARAMETER_BYTES,
      )
      expect(actual.ownedBytes.ramBytes).toBe(
        neutral.ownedBytes.ramBytes + CREATIVE_COLOR_PARAMETER_BYTES * 3,
      )
      expect(actual.identity.parameters).toEqual(settings(index))
      expect(actual.programHashes.tiles).toBe(
        createHash('sha256').update(hdrCacheKernel('reference', true).shader).digest('hex'),
      )
      const expected = referenceAces(
        binary,
        vectorsFor(index).map((v) => v.output),
        1,
        'srgb',
      )
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          const wanted = encode(expected[x][c]),
            value = half(actual.bytes.readUInt16LE(x * 8 + c * 2)),
            bound = 2e-6 + 2e-5 * Math.abs(wanted),
            // WGSL conversion may select either adjacent binary16 value; it does not
            // promise nearest rounding. Keep that format conversion separate from
            // the unchanged Float32 color limit checked before presentation above.
            low = halfNeighbors(Math.max(0, wanted - bound))[0],
            high = halfNeighbors(wanted + bound)[1],
            evidence = JSON.stringify({ index, x, c, value, wanted, low, high })
          expect(value, evidence).toBeGreaterThanOrEqual(low)
          expect(value, evidence).toBeLessThanOrEqual(high)
        }
        expect(actual.bytes.readUInt16LE(x * 8 + 6)).toBe(0x3c00)
      }
    }
    const unlimited = request(9),
      limited = {
        ...unlimited,
        policy: {
          ...unlimited.policy,
          ram: { ...unlimited.policy.ram, effectiveBytes: neutral.peakBytes.ramBytes },
          vram: { ...unlimited.policy.vram, effectiveBytes: neutral.peakBytes.vramBytes },
        },
      }
    expect(await renderFirstSurface(borrow, limited, signal)).toMatchObject({
      status: 'declined',
      reason: 'memory-limit',
    })
    const abort = new AbortController()
    abort.abort(new Error('Cancelled small first surface.'))
    await expect(renderFirstSurface(borrow, request(9), abort.signal)).rejects.toThrow(
      'Cancelled small first surface',
    )
  } finally {
    source?.destroy()
    gpu.close()
  }
})
