import { expect, test } from '@playwright/test'
import { copyIntegerCropStrip } from '../src/main/processing/crop'
import { cropGeometry, fitCrop, identityCrop, rotateCrop } from '../src/shared/crop'

test('integer crop strips preserve every Float32 bit through rotations, alpha and strip seams', () => {
  let checked = 0
  for (const size of [
    { width: 7, height: 5 },
    { width: 8, height: 6 },
    { width: 11, height: 131 },
  ]) {
    const input = new Float32Array(size.width * size.height * 4)
    for (let i = 0; i < input.length / 4; i++)
      input.set([-i / 7, i % 3 ? i / 13 : -0, 16 + i, (i % 5) / 4], i * 4)
    const original = new Uint8Array(input.buffer.slice(0))
    for (const initial of [
      identityCrop,
      {
        ...identityCrop,
        width: (size.width - 2) / size.width,
        height: (size.height - 2) / size.height,
      },
    ]) {
      let crop = initial,
        grid = Array.from({ length: size.height }, (_, y) =>
          Array.from({ length: size.width }, (_, x) => y * size.width + x),
        )
      for (let turn = 0; turn < 4; turn++) {
        const geometry = cropGeometry(size, crop),
          left = Math.round(crop.centerX * grid[0].length - geometry.width / 2),
          top = Math.round(crop.centerY * grid.length - geometry.height / 2),
          expected = new Float32Array(geometry.width * geometry.height * 4),
          expectedBits = new Uint32Array(expected.buffer),
          sourceBits = new Uint32Array(input.buffer)
        for (let y = 0; y < geometry.height; y++)
          for (let x = 0; x < geometry.width; x++) {
            const index = grid[top + y][left + x]
            expectedBits.set(
              sourceBits.subarray(index * 4, index * 4 + 4),
              (y * geometry.width + x) * 4,
            )
          }
        for (const stripRows of [1, 3, 64]) {
          const output = new Float32Array(expected.length)
          new Uint32Array(output.buffer).fill(0x7fc00000)
          let copied = 0
          for (let y = 0; y < size.height; y += stripRows)
            copied += copyIntegerCropStrip(
              input.subarray(
                y * size.width * 4,
                Math.min(size.height, y + stripRows) * size.width * 4,
              ),
              y,
              geometry,
              output,
            )
          expect(copied).toBe(geometry.width * geometry.height)
          expect(
            Buffer.from(output.buffer).equals(Buffer.from(expected.buffer)),
            JSON.stringify({ size, turn, stripRows, crop }),
          ).toBe(true)
          checked++
        }
        crop = rotateCrop(crop, 1)
        grid = Array.from({ length: grid[0].length }, (_, y) =>
          Array.from({ length: grid.length }, (_, x) => grid[grid.length - 1 - x][y]),
        )
      }
    }
    expect(new Uint8Array(input.buffer)).toEqual(original)
  }
  expect(checked).toBe(72)
})

test('integer-copy processing rejects fractional/filter requests and invalid buffers before touching the destination', () => {
  const source = { width: 7, height: 5 },
    data = new Float32Array(7 * 5 * 4),
    geometry = cropGeometry(source, identityCrop),
    destination = new Float32Array(data.length).fill(0.75),
    before = destination.slice()
  for (const crop of [
    fitCrop(source, { ...identityCrop, angle: 12.34 }),
    { ...identityCrop, width: 0.5, height: 0.5 },
  ]) {
    const filtered = cropGeometry(source, crop),
      filteredDestination = new Float32Array(filtered.width * filtered.height * 4).fill(0.75)
    expect(() => copyIntegerCropStrip(data, 0, filtered, filteredDestination)).toThrow(
      'Invalid integer-crop',
    )
    expect([...filteredDestination]).toEqual(new Array(filteredDestination.length).fill(0.75))
  }
  expect(() => copyIntegerCropStrip(data, -1, geometry, destination)).toThrow(
    'Invalid integer-crop',
  )
  expect(() => copyIntegerCropStrip(data, 1, geometry, destination)).toThrow('Invalid integer-crop')
  expect(() => copyIntegerCropStrip(data.subarray(1), 0, geometry, destination)).toThrow(
    'Invalid integer-crop',
  )
  expect(() => copyIntegerCropStrip(data, 0, geometry, destination.subarray(1))).toThrow(
    'Invalid integer-crop',
  )
  expect(() => copyIntegerCropStrip(data, 0, geometry, data)).toThrow('Invalid integer-crop')
  expect(destination).toEqual(before)
  const narrow = cropGeometry(source, { ...identityCrop, width: 3 / 7, height: 1 / 5 }),
    untouched = new Float32Array(narrow.width * narrow.height * 4).fill(0.5)
  expect(copyIntegerCropStrip(data.subarray(0, 7 * 4), 0, narrow, untouched)).toBe(0)
  expect([...untouched]).toEqual(new Array(untouched.length).fill(0.5))
})
