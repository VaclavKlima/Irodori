import { test, expect } from '@playwright/test'
import sharp from 'sharp'
import { jpegIdentity, validatePrimary } from '../src/main/export/jpeg'

test('primary identity checks coding bytes and ICC/EXIF while admitting container metadata', async () => {
  const original = await sharp({
    create: { width: 17, height: 13, channels: 3, background: '#a56d32' },
  })
    .withIccProfile('srgb')
    .withExif({ IFD0: { Artist: 'Fixture' } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer()
  const app = Buffer.from([255, 226, 0, 6, 77, 80, 70, 0])
  const packaged = Buffer.concat([original.subarray(0, 2), app, original.subarray(2)])
  expect(() => validatePrimary(packaged, original)).not.toThrow()
  const adobe = Buffer.from([255, 238, 0, 14, ...Buffer.from('Adobe'), 0, 100, 0, 0, 0, 0, 1])
  expect(() =>
    validatePrimary(
      Buffer.concat([original.subarray(0, 2), adobe, original.subarray(2)]),
      original,
    ),
  ).toThrow()
  expect(jpegIdentity(original)).toMatchObject({ iccCount: 1, exifCount: 1 })
  for (const marker of [
    Buffer.from('ICC_PROFILE\0'),
    Buffer.from('Fixture'),
    Buffer.from([255, 219]),
  ]) {
    const damaged = Buffer.from(packaged)
    const offset = damaged.indexOf(marker)
    expect(offset).toBeGreaterThan(0)
    damaged[offset + marker.length + (marker[0] === 255 ? 3 : 0)] ^= 1
    expect(() => validatePrimary(damaged, original)).toThrow()
  }
  const truncated = original.subarray(0, original.length - 2)
  expect(() => jpegIdentity(truncated)).toThrow()
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([255, 216, 255, 217]),
    Buffer.from([255, 216, 255, 224, 255, 255]),
  ])
    expect(() => jpegIdentity(bytes)).toThrow()
})

test('progressive scan identity and trailing HDR bytes cannot hide changed photographic coding', async () => {
  const original = await sharp({
    create: { width: 31, height: 29, channels: 3, background: '#184db0' },
  })
    .withIccProfile('srgb')
    .jpeg({ quality: 100, progressive: true })
    .toBuffer()
  expect(() => validatePrimary(Buffer.concat([original, original]), original)).not.toThrow()
  const changed = Buffer.from(original)
  const sos = changed.indexOf(Buffer.from([255, 218]))
  const entropy = sos + 2 + changed.readUInt16BE(sos + 2)
  changed[entropy] ^= 1
  expect(() => validatePrimary(changed, original)).toThrow()
})
