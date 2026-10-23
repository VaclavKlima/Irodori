/// <reference types="@webgpu/types" />
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { prepareFirstSurfaceOrientationPipeline } from '../src/main/gpu/hdr-first-surface'
import { hdrMipShader, hdrOrientedMipShader } from '../src/renderer/src/preview/hdr-shader'
import {
  independentlyOrientedInput,
  manuallyOrientedThreeByTwo,
  orientationInput,
  orientedPixelOrder,
} from './hdr-first-surface-orientation.helpers'

let retainedGpu: GPU | undefined
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

async function ordinaryMip(device: GPUDevice) {
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba32float' },
      },
    ],
  })
  const pipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code: hdrMipShader }), entryPoint: 'down' },
  })
  return { layout, pipeline }
}

async function compareOrientation(
  device: GPUDevice,
  ordinary: Awaited<ReturnType<typeof ordinaryMip>>,
  oriented: Awaited<ReturnType<typeof prepareFirstSurfaceOrientationPipeline>>,
  width: number,
  height: number,
  flip: number,
) {
  const resources: (GPUBuffer | GPUTexture)[] = []
  const own = <T extends GPUBuffer | GPUTexture>(value: T) => {
    resources.push(value)
    return value
  }
  const input = orientationInput(width, height)
  const control = independentlyOrientedInput(input, width, height, flip)
  const texture = (w: number, h: number, usage: GPUTextureUsageFlags) =>
    own(
      device.createTexture({
        size: [w, h],
        format: 'rgba32float',
        usage,
      }),
    )
  const source = texture(width, height, GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING)
  // The independent control is fully oriented before the unchanged ordinary GPU mip program.
  const reference = texture(
    control.width,
    control.height,
    GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  )
  const uniform = own(
    device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
  )
  const evidence: {
    width: number
    height: number
    level: number
    words: number
    sha256: string
  }[] = []
  try {
    device.queue.writeTexture({ texture: source }, input, { bytesPerRow: width * 16 }, [
      width,
      height,
    ])
    device.queue.writeTexture(
      { texture: reference },
      control.data,
      { bytesPerRow: control.width * 16 },
      [control.width, control.height],
    )
    device.queue.writeBuffer(uniform, 0, new Uint32Array([flip, 0, 0, 0]))
    let actualSource = source,
      referenceSource = reference
    const levels = Math.max(1, Math.floor(Math.log2(Math.max(width, height))))
    for (let level = 1; level <= levels; level++) {
      const w = Math.max(1, control.width >> level),
        h = Math.max(1, control.height >> level)
      const usage =
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      const actual = texture(w, h, usage),
        expected = texture(w, h, usage)
      const encoder = device.createCommandEncoder()
      for (const branch of [
        {
          source: actualSource,
          destination: actual,
          program: level === 1 ? oriented : ordinary,
          fused: level === 1,
        },
        { source: referenceSource, destination: expected, program: ordinary, fused: false },
      ]) {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: branch.source.createView() },
          { binding: 1, resource: branch.destination.createView() },
        ]
        if (branch.fused) entries.push({ binding: 2, resource: { buffer: uniform } })
        const pass = encoder.beginComputePass()
        pass.setPipeline(branch.program.pipeline)
        pass.setBindGroup(0, device.createBindGroup({ layout: branch.program.layout, entries }))
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
        pass.end()
      }
      const rowBytes = Math.ceil((w * 16) / 256) * 256
      const readbacks = [actual, expected].map((image) => {
        const buffer = own(
          device.createBuffer({
            size: rowBytes * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
        )
        encoder.copyTextureToBuffer({ texture: image }, { buffer, bytesPerRow: rowBytes }, [w, h])
        return buffer
      })
      device.queue.submit([encoder.finish()])
      const mapped = await Promise.allSettled(
        readbacks.map((buffer) => buffer.mapAsync(GPUMapMode.READ)),
      )
      const rejected = mapped.find((result) => result.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
      const bodies = readbacks.map((buffer) => {
        const padded = new Uint32Array(buffer.getMappedRange())
        const words = new Uint32Array(w * h * 4)
        for (let y = 0; y < h; y++)
          words.set(padded.subarray((y * rowBytes) / 4, (y * rowBytes) / 4 + w * 4), y * w * 4)
        buffer.unmap()
        return words
      })
      expect(
        bodies[0],
        `${width}x${height}, flip ${flip}, mip ${level}: every Float32 word`,
      ).toEqual(bodies[1])
      evidence.push({
        width: w,
        height: h,
        level,
        words: bodies[0].length,
        sha256: sha(new Uint8Array(bodies[0].buffer)),
      })
      actualSource = actual
      referenceSource = expected
    }
    return {
      width,
      height,
      flip,
      orientedWidth: control.width,
      orientedHeight: control.height,
      mips: evidence,
    }
  } finally {
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    for (const resource of resources.reverse()) {
      if ('mapState' in resource && resource.mapState === 'mapped') resource.unmap()
      resource.destroy()
    }
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('fused first mips preserve every Float32 word for all eight flips, odd edges and alpha-sensitive ordered sums', async ({}, info) => {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter({ powerPreference: 'high-performance' })
  expect(adapter, 'Required hardware GPU is unavailable.').not.toBeNull()
  expect(adapter!.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const results: Awaited<ReturnType<typeof compareOrientation>>[] = []
  let scopes = 0
  try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
      device.pushErrorScope(filter)
      scopes++
    }
    const [ordinary, oriented] = await Promise.all([
      ordinaryMip(device),
      prepareFirstSurfaceOrientationPipeline(device),
    ])
    expect(prepareFirstSurfaceOrientationPipeline(device)).toBe(
      prepareFirstSurfaceOrientationPipeline(device),
    )
    for (let flip = 0; flip < 8; flip++) {
      expect(orientedPixelOrder(3, 2, flip).pixels).toEqual(manuallyOrientedThreeByTwo[flip])
      for (const [width, height] of [
        [3, 5],
        [5, 3],
        [17, 11],
        [8, 6],
        [1, 5],
        [5, 1],
        [1, 1],
      ]) {
        await test.step(`${width}x${height}, flip ${flip}`, async () => {
          results.push(await compareOrientation(device, ordinary, oriented, width, height, flip))
        })
      }
    }
    const errors: (GPUError | null)[] = []
    while (scopes) {
      scopes--
      errors.push(await device.popErrorScope())
    }
    expect(errors).toEqual([null, null, null])
    expect(sha(hdrMipShader)).toBe(
      'ed44a2f14edeeb352613af088e94016f28aff97c793b421a92e4ff1b6215c140',
    )
    await writeFile(
      info.outputPath('orientation-parity.json'),
      JSON.stringify(
        {
          boundary:
            'Synthetic GPU mip math only; no RAW, browser presentation or performance acceptance.',
          ordinaryMipSha256: sha(hdrMipShader),
          orientedMipSha256: sha(hdrOrientedMipShader),
          cases: results.length,
          comparedWords: results
            .flatMap((result) => result.mips)
            .reduce((total, mip) => total + mip.words, 0),
          results,
        },
        null,
        2,
      ),
    )
  } finally {
    while (scopes) {
      scopes--
      await device.popErrorScope().catch(() => null)
    }
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    device.destroy()
  }
})
