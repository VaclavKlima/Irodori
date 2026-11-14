import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createObjectSelectionGpu } from '../src/main/object-selection/gpu'
import { refineAutomaticSelection } from '../src/main/object-selection/automatic-gpu'
import { sha256 } from '../src/main/object-selection/model'
import reference from '../assets/tests/references/automatic-selection/guided-filter.json' with { type: 'json' }

test('guided research retains independent OpenCV parity, fractional coverage and odd native tails', async () => {
  expect(sha256(await readFile(reference.generator))).toBe(reference.generatorSha256)
  const rgba = gunzipSync(Buffer.from(reference.rgbaGzipBase64, 'base64'))
  const expected = gunzipSync(Buffer.from(reference.expectedGzipBase64, 'base64'))
  expect(sha256(rgba)).toBe(reference.rgbaSha256)
  expect(sha256(expected)).toBe(reference.expectedSha256)
  const guide = new Float32Array(128 * 128 * 3)
  const mask = new Float32Array(128 * 128)
  for (let pixel = 0; pixel < mask.length; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      guide[channel * mask.length + pixel] = rgba[pixel * 4 + channel] / 255
    mask[pixel] = pixel % 128 >= 64 ? 1 : 0
  }
  const gpu = await createObjectSelectionGpu(128)
  try {
    const actual = await refineAutomaticSelection(gpu.device, rgba, guide, mask, 128, 128, 128)
    expect(actual.byteLength).toBe(expected.byteLength)
    expect(actual.some((value) => value > 0 && value < 255)).toBe(true)
    for (let index = 0; index < actual.length; index++)
      expect(Math.abs(actual[index] - expected[index])).toBeLessThanOrEqual(1)
    const native = new Uint8Array(513 * 263 * 4).fill(127)
    for (const value of [0, 0.375, 1]) {
      const result = await refineAutomaticSelection(
        gpu.device,
        native,
        guide,
        new Float32Array(mask.length).fill(value),
        513,
        263,
        128,
      )
      expect(result.byteLength).toBe(513 * 263)
      expect(result.every((pixel) => pixel === Math.round(value * 255))).toBe(true)
    }
  } finally {
    gpu.close()
  }
})

test('guided refusal destroys already allocated buffers and leaves the same GPU usable', async () => {
  const gpu = await createObjectSelectionGpu(128)
  const resources: { buffer: GPUBuffer; destroyed: boolean }[] = []
  const limited = new Proxy(gpu.device, {
    get(target, key) {
      if (key === 'limits') return { maxBufferSize: 256, maxStorageBufferBindingSize: 256 }
      if (key === 'createBuffer')
        return (descriptor: GPUBufferDescriptor) => {
          const buffer = target.createBuffer(descriptor)
          const resource = { buffer, destroyed: false }
          const destroy = buffer.destroy.bind(buffer)
          buffer.destroy = () => {
            resource.destroyed = true
            destroy()
          }
          resources.push(resource)
          return buffer
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const rgba = new Uint8Array(17 * 13 * 4).fill(127)
  const guide = new Float32Array(128 * 128 * 3).fill(0.5)
  const mask = new Float32Array(128 * 128).fill(0.375)
  try {
    await expect(refineAutomaticSelection(limited, rgba, guide, mask, 17, 13, 128)).rejects.toThrow(
      'GPU buffer limit',
    )
    expect(resources.length).toBeGreaterThan(0)
    expect(resources.every((resource) => resource.destroyed)).toBe(true)
    const result = await refineAutomaticSelection(gpu.device, rgba, guide, mask, 17, 13, 128)
    expect(result).toHaveLength(17 * 13)
    expect(result.every((pixel) => pixel === 96)).toBe(true)
    await expect(
      refineAutomaticSelection(
        gpu.device,
        rgba,
        guide,
        new Float32Array(mask.length).fill(Number.NaN),
        17,
        13,
        128,
      ),
    ).rejects.toThrow('non-finite')
  } finally {
    gpu.close()
  }
})
