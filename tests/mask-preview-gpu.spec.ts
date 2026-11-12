import { test, expect } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { RawGpuRenderer } from '../src/main/gpu/raw-renderer'
import { MaskEdgeProcess } from '../src/main/mask-edges/process'
import { renderMaskPreviewGpu } from '../src/main/mask-edges/preview-gpu'
import { identityMaskGeometry, maskCanonicalPoint } from '../src/shared/mask-geometry'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { gradientMask } from './helpers/mask-gradients'
import { referenceCoverage } from './helpers/mask-reference'
import { generatedMask } from './helpers/generated-mask'
import { neutralMaskLight } from '../src/shared/masks'
import { sha } from './export.helpers'

test('analytic coverage follows cropped lens/flip mapping and region pixel centers without an R8 pre-bake', async () => {
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    const mask = gradientMask({
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radiusX: 0.29,
      radiusY: 0.31,
      rotation: 17,
      feather: 0,
    })
    mask.enabled = false
    mask.light = { ...neutralMaskLight }
    const geometry = {
      ...identityMaskGeometry(80, 60),
      flip: 3,
      correction: {
        width: 76,
        height: 56,
        left: 2,
        top: 2,
        distortion: Array.from({ length: 4096 }, (_, i) => 1 + (i / 4095) * 0.04),
      },
      crop: cropGeometry(
        { width: 76, height: 56 },
        { ...identityCrop, width: 0.8, height: 0.8, angle: 7 },
      ),
    }
    const grid = { width: geometry.crop.width, height: geometry.crop.height }
    const bounds = { x: 2, y: 3, width: grid.width - 4, height: grid.height - 6 }
    const width = 37,
      height = 21
    const result = await renderMaskPreviewGpu(
      device,
      { mask, geometry, grid, bounds, width, height, coverage: true },
      new AbortController().signal,
    )
    expect(result.overlay).toBeUndefined()
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const point = maskCanonicalPoint(
          {
            x: bounds.x + ((x + 0.5) * bounds.width) / width,
            y: bounds.y + ((y + 0.5) * bounds.height) / height,
          },
          geometry,
        )
        const expected = Math.round(referenceCoverage(mask, point.x, point.y, 80, 60) * 255)
        expect(result.coverage![(y * width + x) * 4]).toBe(expected)
      }
    expect(owner.failure).toBeUndefined()
  } finally {
    owner.close()
  }
})

test('prepared range/edges and compound inversion share coverage, disabled operands are ignored, orange overlay is SDR', async () => {
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    const width = 17,
      height = 133,
      mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
    mask.gradient = undefined
    mask.range = { version: 1, kind: 'luminance', lower: 25, upper: 75, softness: 0 }
    mask.preparedRangeBase = { ...generatedMask(width, height, () => 128), key: 'a'.repeat(64) }
    mask.inverted = true
    const child = { ...mask }
    mask.operands = [
      {
        ...child,
        id: '00000000-0000-0000-0000-000000000002',
        enabled: false,
        operator: 'subtract',
        range: undefined,
        preparedRangeBase: undefined,
        inverted: true,
      },
    ]
    const photo = Buffer.alloc(width * height * 4)
    for (let i = 0; i < photo.length; i += 4) photo.set([64, 96, 128, 255], i)
    const input = {
      mask,
      geometry: identityMaskGeometry(width, height),
      grid: { width, height },
      bounds: { x: 0, y: 0, width, height },
      width,
      height,
      coverage: true,
      photo,
    }
    const result = await renderMaskPreviewGpu(device, input, new AbortController().signal)
    for (let i = 0; i < width * height; i++) {
      expect(result.coverage![i * 4]).toBe(127)
      const amount = (127 / 255) * 0.38
      for (const [channel, tint] of [
        [0, 0.96],
        [1, 0.3],
        [2, 0.16],
      ])
        expect(
          Math.abs(
            result.overlay![i * 4 + channel] -
              Math.round(photo[i * 4 + channel] * (1 - amount) + 255 * tint * amount),
          ),
        ).toBeLessThanOrEqual(1)
    }
    mask.edge = { featherPx: 2, shiftPx: 1 }
    mask.preparedCoverage = { ...generatedMask(width, height, () => 64), key: 'b'.repeat(64) }
    const edged = await renderMaskPreviewGpu(
      device,
      { ...input, photo: undefined },
      new AbortController().signal,
    )
    expect(edged.coverage![0]).toBe(64)
  } finally {
    owner.close()
  }
})

test('owned worker publishes lossless matched PNGs and validates actual decoded SDR input dimensions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-mask-preview-gpu-'))
  const runtime = new MaskEdgeProcess({ workerPath: resolve('out/main/mask-edge-worker.js') })
  try {
    const width = 11,
      height = 7,
      photoPath = join(directory, 'photo.png')
    await sharp({ create: { width, height, channels: 3, background: '#406080' } })
      .png()
      .toFile(photoPath)
    const mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
    const request = {
      mask,
      width,
      height,
      key: 'worker-preview',
      outputPath: join(directory, 'preview'),
      inspection: {
        geometry: identityMaskGeometry(width, height),
        grid: { width, height },
        bounds: { x: 0, y: 0, width, height },
        view: 'pair' as const,
        photoPath,
      },
    }
    const result = await runtime.preview(request, new AbortController().signal)
    if (result.adapter)
      test.info().annotations.push({ type: 'gpu-adapter', description: result.adapter })
    expect(result.members.map((member) => member.label)).toEqual(['coverage', 'overlay'])
    for (const member of result.members) {
      const bytes = await readFile(member.path)
      expect(sha(bytes)).toBe(member.hash)
      expect(bytes.byteLength).toBe(member.encodedBytes)
      expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width, height })
      const decoder = member.label === 'coverage' ? sharp(bytes).toColourspace('b-w') : sharp(bytes)
      const decoded = await decoder.raw().toBuffer({ resolveWithObject: true })
      expect(decoded.info).toMatchObject({ width, height })
      expect(decoded.info.channels).toBe(member.label === 'coverage' ? 1 : 3)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const amount = referenceCoverage(
            mask,
            (x + 0.5) / width,
            (y + 0.5) / height,
            width,
            height,
          )
          if (member.label === 'coverage')
            expect(
              Math.abs(decoded.data[y * width + x] - Math.round(amount * 255)),
            ).toBeLessThanOrEqual(1)
          else
            for (const [channel, original, orange] of [
              [0, 64, 0.96],
              [1, 96, 0.3],
              [2, 128, 0.16],
            ])
              expect(
                Math.abs(
                  decoded.data[(y * width + x) * 3 + channel] -
                    Math.round(original * (1 - amount * 0.38) + 255 * orange * amount * 0.38),
                ),
              ).toBeLessThanOrEqual(1)
        }
    }
    await writeFile(
      photoPath,
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000000' } })
        .png()
        .toBuffer(),
    )
    await expect(
      runtime.preview(
        { ...request, outputPath: join(directory, 'invalid') },
        new AbortController().signal,
      ),
    ).rejects.toThrow('dimensions changed')
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid geometry and cancellation refuse inspection before GPU submission', async () => {
  const owner = new RawGpuRenderer()
  try {
    const { device, adapter } = await owner.mergeDevice()
    test.info().annotations.push({ type: 'gpu-adapter', description: adapter })
    const mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
    const invalid = { ...identityMaskGeometry(8, 6), canonicalWidth: 7 }
    await expect(
      renderMaskPreviewGpu(
        device,
        {
          mask,
          geometry: invalid,
          grid: { width: 8, height: 6 },
          bounds: { x: 0, y: 0, width: 8, height: 6 },
          width: 8,
          height: 6,
          coverage: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('source geometry')
    const cancelled = new AbortController()
    cancelled.abort(new Error('GPU request cancelled'))
    await expect(
      renderMaskPreviewGpu(
        device,
        {
          mask,
          geometry: identityMaskGeometry(8, 6),
          grid: { width: 8, height: 6 },
          bounds: { x: 0, y: 0, width: 8, height: 6 },
          width: 8,
          height: 6,
          coverage: true,
        },
        cancelled.signal,
      ),
    ).rejects.toThrow('GPU request cancelled')
    expect(owner.failure).toBeUndefined()
  } finally {
    owner.close()
  }
})
