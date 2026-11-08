import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCropPreview } from '../src/main/processing/crop-preview'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { identityCrop } from '../src/shared/crop'
import { identityMaskGeometry, maskCanonicalPoint } from '../src/shared/mask-geometry'
import { cropAdmission } from './crop-frame.helpers'

test('raster crop proof and retained linear source carry canonical mask geometry into the render worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-mask-crop-'))
  try {
    const source = new Float32Array(32 * 20 * 4).fill(0.25)
    const path = join(root, 'source.f32'),
      bytes = Buffer.from(source.buffer)
    await writeFile(path, bytes)
    let renders = 0
    const result = await prepareCropPreview(
      root,
      {
        ...cropAdmission(),
        asset: {
          path,
          width: 32,
          height: 20,
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          transform: srgbTransform,
          maskGeometry: identityMaskGeometry(32, 20),
        },
        settings: { ...identityCrop, width: 0.5, height: 0.5 },
        options: {
          metadata: processingMetadata({}, []),
          settings: noLensSettings,
          revision: 4,
          adjustments: structuredClone(neutralAdjustments),
        },
        workingOnly: false,
        backend: 'gpu',
      },
      new AbortController().signal,
      async (options) => {
        renders++
        const working = options.workingAsset!
        expect([working.width, working.height]).toEqual([16, 10])
        const point = maskCanonicalPoint({ x: 0.5, y: 0.5 }, working.maskGeometry!)
        expect(point.x).toBeCloseTo(8.5 / 32, 13)
        expect(point.y).toBeCloseTo(5.5 / 20, 13)
        return {
          width: 16,
          height: 10,
          format: 'rgba8-srgb',
          byteLength: 640,
          sha256: 'a'.repeat(64),
          renderId: 'masked-cropped-proof',
          placeholderBytes: 0,
        }
      },
    )
    expect(renders).toBe(1)
    expect(result.linear?.maskGeometry?.canonicalWidth).toBe(32)
    expect(result.linear?.maskGeometry?.crop?.width).toBe(16)
    expect(result.crop?.source).toEqual({ width: 32, height: 20 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
