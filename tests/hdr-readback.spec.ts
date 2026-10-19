import { expect, test } from '@playwright/test'
import { copyHdrReadbackStrip } from '../src/main/gpu/hdr-readback'

const canary = 0x4f123456
const rgbWords = [
  0x00000000, 0x80000000, 0x00000001, 0x80000001, 0x3f800001, 0xbf800001, 0x3f7fffff, 0xbf7fffff,
  0x00800000, 0x80800000, 0x4b800001, 0xcb800001, 0x3eaaaaab, 0xbeaaaaab, 0x7f7fffff, 0xff7fffff,
]
const alphaWords = [0x00000000, 0x80000000, 0x3f000001, 0x3f7fffff, 0x3f800000]

function frameWords(width: number, height: number): Uint32Array {
  const words = new Uint32Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      words[pixel * 4 + channel] = rgbWords[(pixel * 3 + channel) % rgbWords.length]
    words[pixel * 4 + 3] = alphaWords[pixel % alphaWords.length]
  }
  return words
}

function destination(length: number) {
  const guard = 9,
    backing = new Uint32Array(guard + length + guard).fill(canary)
  return {
    backing,
    guard,
    values: new Float32Array(backing.buffer, guard * 4, length),
    words: new Uint32Array(backing.buffer, guard * 4, length),
  }
}

function mappedStrip(
  source: Uint32Array,
  width: number,
  top: number,
  count: number,
  rowBytes: number,
) {
  const guard = 7,
    stride = rowBytes / 4,
    backing = new Uint32Array(guard + stride * count + guard).fill(canary),
    words = new Uint32Array(backing.buffer, guard * 4, stride * count)
  for (let row = 0; row < count; row++)
    words.set(source.subarray((top + row) * width * 4, (top + row + 1) * width * 4), row * stride)
  return {
    backing,
    original: backing.slice(),
    values: new Float32Array(backing.buffer, guard * 4, words.length),
  }
}

function expectGuards(target: ReturnType<typeof destination>) {
  const expected = new Uint32Array(target.guard).fill(canary)
  expect(target.backing.subarray(0, target.guard)).toEqual(expected)
  expect(target.backing.subarray(target.guard + target.words.length)).toEqual(expected)
}

// Independently enumerated output rows for the source image [A B C; D E F].
// Pixel labels also retain distinct signed, subnormal, adjacent-ULP and alpha words.
const orientations = [
  { flip: 0, pixels: [0, 1, 2, 3, 4, 5] },
  { flip: 1, pixels: [2, 1, 0, 5, 4, 3] },
  { flip: 2, pixels: [3, 4, 5, 0, 1, 2] },
  { flip: 3, pixels: [5, 4, 3, 2, 1, 0] },
  { flip: 4, pixels: [0, 3, 1, 4, 2, 5] },
  { flip: 5, pixels: [2, 5, 1, 4, 0, 3] },
  { flip: 6, pixels: [3, 0, 4, 1, 5, 2] },
  { flip: 7, pixels: [5, 2, 4, 1, 3, 0] },
]

for (const orientation of orientations)
  test(`HDR readback preserves exact words for flip ${orientation.flip} across padded partial strips and view offsets`, () => {
    const width = 3,
      height = 2,
      source = frameWords(width, height),
      target = destination(source.length)
    for (const top of [0, 1]) {
      const strip = mappedStrip(source, width, top, 1, 256)
      copyHdrReadbackStrip(
        strip.values,
        target.values,
        width,
        height,
        256,
        top,
        1,
        orientation.flip,
      )
      expect(strip.backing).toEqual(strip.original)
      expectGuards(target)
    }
    const expected = Uint32Array.from(
      orientation.pixels.flatMap((pixel) => Array.from(source.subarray(pixel * 4, pixel * 4 + 4))),
    )
    expect(target.words).toEqual(expected)
  })

for (const width of [16, 17])
  test(`unrotated HDR readback copies ${width === 16 ? 'tight' : 'padded'} 64-row strips and the final three rows without touching future rows`, () => {
    const height = 131,
      rowBytes = Math.ceil((width * 16) / 256) * 256,
      source = frameWords(width, height),
      target = destination(source.length)
    for (const top of [0, 64, 128]) {
      const count = Math.min(64, height - top),
        strip = mappedStrip(source, width, top, count, rowBytes)
      copyHdrReadbackStrip(strip.values, target.values, width, height, rowBytes, top, count, 0)
      const completedWords = (top + count) * width * 4
      expect(target.words.subarray(0, completedWords)).toEqual(source.subarray(0, completedWords))
      expect(target.words.subarray(completedWords)).toEqual(
        new Uint32Array(source.length - completedWords).fill(canary),
      )
      expect(strip.backing).toEqual(strip.original)
      expectGuards(target)
    }
  })

for (const rowBytes of [256, 512])
  test(`unrotated HDR readback preserves every Float32 encoding with ${rowBytes}-byte row pitch`, () => {
    // Transport must not perform arithmetic or reinterpret validity; source validation is separate.
    const encodings = [
        ...rgbWords,
        ...alphaWords,
        0x7f800000,
        0xff800000,
        0x7fc01234,
        0xffc05678,
        0x7f801234,
      ],
      width = 16,
      height = 2,
      source = Uint32Array.from(
        { length: width * height * 4 },
        (_, i) => encodings[i % encodings.length],
      ),
      target = destination(source.length),
      strip = mappedStrip(source, width, 0, height, rowBytes)
    copyHdrReadbackStrip(strip.values, target.values, width, height, rowBytes, 0, height, 0)
    expect(target.words).toEqual(source)
    expect(strip.backing).toEqual(strip.original)
    expectGuards(target)
  })
