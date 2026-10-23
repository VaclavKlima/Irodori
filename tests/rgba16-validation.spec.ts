import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { assertOpaqueFiniteRgba16LE } from '../src/shared/rgba16-validation'

type Bytes = Uint8Array<ArrayBuffer>
const validPixel = [0x3800, 0xbc00, 0x4000, 0x3c00]
const view = (bytes: Bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
function write(bytes: Bytes, words: readonly number[]) {
  const data = view(bytes)
  for (let index = 0; index < words.length; index++) data.setUint16(index * 2, words[index], true)
  return bytes
}
const body = (words: readonly number[]) => write(new Uint8Array(words.length * 2), words)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Independent IEEE binary16 decoding, without the production exponent mask or typed-word path. */
function halfNumber(word: number) {
  const sign = word >= 32768 ? -1 : 1,
    magnitude = word % 32768,
    exponent = Math.floor(magnitude / 1024),
    fraction = magnitude % 1024
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN
  if (exponent === 0) return sign * (fraction / 1024) * 2 ** -14
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}
function reference(bytes: Bytes) {
  if (!bytes.byteLength || bytes.byteLength % 8 !== 0) return false
  const data = view(bytes)
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    for (let channel = 0; channel < 3; channel++)
      if (!Number.isFinite(halfNumber(data.getUint16(offset + channel * 2, true)))) return false
    if (halfNumber(data.getUint16(offset + 6, true)) !== 1) return false
  }
  return true
}
function accepts(bytes: Bytes) {
  try {
    assertOpaqueFiniteRgba16LE(bytes)
    return true
  } catch {
    return false
  }
}

for (const channel of [0, 1, 2])
  test(`all 65536 binary16 words in RGB channel ${channel} agree with independent LE decoding`, () => {
    const aligned = body(validPixel),
      unaligned = write(new Uint8Array(new ArrayBuffer(10), 1, 8), validPixel),
      alignedView = view(aligned),
      unalignedView = view(unaligned),
      layouts = [
        ['aligned', aligned],
        ['unaligned', unaligned],
      ] as const
    let finite = 0
    for (let word = 0; word < 65536; word++) {
      alignedView.setUint16(channel * 2, word, true)
      unalignedView.setUint16(channel * 2, word, true)
      const expected = reference(aligned)
      if (expected) finite++
      for (const [layout, bytes] of layouts)
        if (accepts(bytes) !== expected)
          throw new Error(`${layout} RGB channel ${channel} disagrees at 0x${word.toString(16)}`)
    }
    expect(finite).toBe(63488)
  })

test('opaque alpha requires the exact positive-one half word in aligned and unaligned views', () => {
  for (const byteOffset of [0, 1]) {
    const bytes = write(new Uint8Array(new ArrayBuffer(byteOffset + 8), byteOffset, 8), validPixel)
    const data = view(bytes)
    // Neighbors, signed zeros/one, subnormals, finite extremes, infinities and signed NaNs.
    for (const alpha of [
      0, 0x8000, 1, 0x8001, 0x3800, 0x3bff, 0x3c00, 0x3c01, 0xbc00, 0x7bff, 0xfbff, 0x7c00, 0xfc00,
      0x7c01, 0x7e00, 0xfc01, 0xfe00, 0xffff,
    ]) {
      data.setUint16(6, alpha, true)
      expect(reference(bytes), `reference alpha 0x${alpha.toString(16)}`).toBe(alpha === 0x3c00)
      expect(accepts(bytes), `offset ${byteOffset}, alpha 0x${alpha.toString(16)}`).toBe(
        alpha === 0x3c00,
      )
    }
  }
})

test('RGB extremes and every final-pixel channel are checked without rewriting bytes', () => {
  const finiteWords = [
    0, 0x8000, 1, 0x8001, 0x03ff, 0x83ff, 0x0400, 0x8400, 0x3c00, 0xbc00, 0x4000, 0xc000, 0x7bff,
    0xfbff,
  ]
  for (const byteOffset of [0, 1]) {
    const words = finiteWords.flatMap((word) => [word, word, word, 0x3c00]),
      bytes = write(
        new Uint8Array(
          new ArrayBuffer(byteOffset + words.length * 2),
          byteOffset,
          words.length * 2,
        ),
        words,
      ),
      before = Uint8Array.from(bytes),
      sha256 = digest(bytes)
    expect(reference(bytes)).toBe(true)
    expect(() => assertOpaqueFiniteRgba16LE(bytes)).not.toThrow()
    expect(bytes).toEqual(before)
    expect(digest(bytes)).toBe(sha256)
    const last = bytes.byteLength - 8
    for (let channel = 0; channel < 4; channel++) {
      const data = view(bytes),
        original = data.getUint16(last + channel * 2, true)
      for (const invalid of channel === 3
        ? [0x3bff, 0x3c01, 0x7e00]
        : [0x7c00, 0xfc00, 0x7c01, 0x7e00, 0xfc01, 0xfe00]) {
        data.setUint16(last + channel * 2, invalid, true)
        const damagedSha256 = digest(bytes)
        expect(reference(bytes)).toBe(false)
        expect(() => assertOpaqueFiniteRgba16LE(bytes)).toThrow('invalid Float16 pixels')
        expect(digest(bytes)).toBe(damagedSha256)
      }
      data.setUint16(last + channel * 2, original, true)
    }
    expect(digest(bytes)).toBe(sha256)
  }
})

test('nonzero aligned and odd Buffer subviews ignore poison outside their exact byte range', () => {
  for (const byteOffset of [1, 2, 3, 8, 9, 10]) {
    const backing = Buffer.allocUnsafe(64).fill(0xff),
      bytes = backing.subarray(byteOffset, byteOffset + 16)
    write(bytes, [...validPixel, ...validPixel])
    const before = Buffer.from(backing),
      sha256 = digest(backing)
    expect(reference(bytes)).toBe(true)
    expect(reference(backing)).toBe(false)
    expect(() => assertOpaqueFiniteRgba16LE(bytes)).not.toThrow()
    expect(backing).toEqual(before)
    expect(digest(backing)).toBe(sha256)
  }
})

test('empty, partial-pixel, detached and shared-backed views cannot be accepted', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 14, 15, 17]) {
    const bytes = new Uint8Array(length)
    expect(reference(bytes)).toBe(false)
    expect(() => assertOpaqueFiniteRgba16LE(bytes)).toThrow(TypeError)
  }
  const detached = body(validPixel)
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  expect(() => assertOpaqueFiniteRgba16LE(detached)).toThrow(TypeError)
  const shared = write(new Uint8Array(8), validPixel),
    sharedBacking = new Uint8Array(new SharedArrayBuffer(8))
  sharedBacking.set(shared)
  expect(() => assertOpaqueFiniteRgba16LE(sharedBacking as unknown as Bytes)).toThrow(TypeError)
})
