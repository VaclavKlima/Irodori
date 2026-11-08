import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { inspectionContext } from '../src/main/agent/inspection-source'
import { proofFixture } from './export-proof.helpers'
import { sha } from './export.helpers'

// Independent direct 2D reference: no production row, coefficient or GPU helpers.
function referenceResize(
  rgb: Buffer,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
) {
  const linear = Array.from(rgb, (value) => {
    const encoded = value / 255
    return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4
  })
  const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
  const support = (length: number, target: number, index: number) => {
    const center = ((index + 0.5) * length) / target - 0.5,
      scale = Math.max(1, length / target),
      taps: { index: number; weight: number }[] = []
    for (
      let source = Math.ceil(center - 3 * scale);
      source <= Math.floor(center + 3 * scale);
      source++
    ) {
      const distance = (source - center) / scale
      if (Math.abs(distance) < 3)
        taps.push({
          index: Math.max(0, Math.min(length - 1, source)),
          weight: sinc(distance) * sinc(distance / 3),
        })
    }
    return taps
  }
  const output = Buffer.alloc(outWidth * outHeight * 3)
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++) {
      const xx = support(width, outWidth, x),
        yy = support(height, outHeight, y)
      for (let c = 0; c < 3; c++) {
        let value = 0,
          total = 0
        for (const sx of xx)
          for (const sy of yy) {
            const weight = sx.weight * sy.weight
            value += linear[(sy.index * width + sx.index) * 3 + c] * weight
            total += weight
          }
        const channel = Math.max(0, Math.min(1, value / total))
        output[(y * outWidth + x) * 3 + c] = Math.round(
          (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055) * 255,
        )
      }
    }
  return output
}

test('decoded proof regions resize with the common GPU backend and retain their export-native mapping', async () => {
  const f = await proofFixture({
    render: async (job) => {
      const geometry = { width: 17, height: 11 },
        pixels = Buffer.alloc(17 * 11 * 3)
      for (let y = 0; y < 11; y++)
        for (let x = 0; x < 17; x++)
          for (let c = 0; c < 3; c++)
            pixels[(y * 17 + x) * 3 + c] = (x * 17 + y * 11 + c * 60) % 256
      const path = join(job.directory, 'output.jpg')
      await sharp(pixels, { raw: { ...geometry, channels: 3 } })
        .withIccProfile('srgb')
        .jpeg({ quality: job.options.quality, chromaSubsampling: '4:4:4' })
        .toFile(path)
      return { path, geometry, sourceGeometry: geometry, sha256: sha(await readFile(path)) }
    },
  })
  try {
    const request = f.request(),
      source = f.library.exports.acquireProofSource(request.preparationId, request.photoId),
      context = inspectionContext(source.source, { width: 17, height: 11 })
    source.release()
    const region = {
        units: 'pixels' as const,
        gridIdentity: context.gridIdentity,
        x: 2,
        y: 2,
        width: 12,
        height: 8,
      },
      native = await f.proofs.inspect(request, {
        region,
        resolutionPercent: 100,
        encoding: { format: 'png' },
      }),
      reduced = await f.proofs.inspect(
        { ...request, token: crypto.randomUUID() },
        { region, resolutionPercent: 50, encoding: { format: 'png' } },
      )
    expect(reduced.members[0]).toMatchObject({
      width: 6,
      height: 4,
      native: 'export-native',
      photoBounds: { x: 2, y: 2, width: 12, height: 8 },
    })
    const nativeRgb = await sharp(Buffer.from(native.members[0].data, 'base64'))
        .removeAlpha()
        .raw()
        .toBuffer(),
      expected = referenceResize(nativeRgb, 12, 8, 6, 4),
      actual = await sharp(Buffer.from(reduced.members[0].data, 'base64'))
        .removeAlpha()
        .raw()
        .toBuffer()
    let maximum = 0
    for (let i = 0; i < actual.length; i++)
      maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]))
    expect(maximum).toBeLessThanOrEqual(3)
    expect(f.proofs.bytes).toBe(0)
  } finally {
    await f.close()
  }
})
