import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { createObjectSelectionGpu } from '../src/main/object-selection/gpu'
import { objectSelectionSessionOptions } from '../src/main/object-selection/model'
import { ObjectSelectionProcess } from '../src/main/object-selection/process'
import reference from '../assets/tests/references/object-selection/runtime-sampling.json' with { type: 'json' }

const rgba = (width: number, height: number) => {
  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 97 + 31) % 256
  for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255
  return pixels
}

test('GPU model sampling matches frozen upstream Torch enlargement, reduction and anisotropic references', async () => {
  expect(
    createHash('sha256')
      .update(await readFile(reference.generator))
      .digest('hex'),
  ).toBe(reference.generatorSha256)
  expect(reference.absoluteTolerance).toBe(1e-6)
  const gpu = await createObjectSelectionGpu()
  try {
    for (const fixture of reference.preprocessing) {
      const actual = await gpu.preprocess(
        rgba(fixture.width, fixture.height),
        fixture.width,
        fixture.height,
      )
      expect(actual).toHaveLength(3 * 1024 * 1024)
      for (const sample of fixture.samples)
        expect(Math.abs(actual[sample.index] - sample.value)).toBeLessThanOrEqual(
          reference.absoluteTolerance,
        )
    }
    const logits = Float32Array.from(
      { length: 256 * 256 },
      (_, index) => ((index % 256) - 127.4) * 0.03 + (Math.floor(index / 256) - 100.6) * 0.02,
    )
    const actual = await gpu.reconstruct(
      logits,
      reference.reconstruction.width,
      reference.reconstruction.height,
    )
    expect(Array.from(actual)).toEqual(reference.reconstruction.expected)
  } finally {
    gpu.close()
  }
})

test('the production inference policy refuses an actual CPU-only operator without a CPU retry', async () => {
  const options = objectSelectionSessionOptions()
  expect(options.extra).toMatchObject({ session: { disable_cpu_ep_fallback: '1' } })
  expect(
    createHash('sha256')
      .update(await readFile('assets/tests/references/object-selection/runtime-cpu-only.onnx'))
      .digest('hex'),
  ).toBe('8d29351450bddc8538ae7f64aee46f7bee6952457fc99d92ddd140b82d004223')
  // This graph normalizes strings and has no WebGPU kernel. Successful CPU fallback is a failure.
  await expect(
    ort.InferenceSession.create(
      resolve('assets/tests/references/object-selection/runtime-cpu-only.onnx'),
      options,
    ),
  ).rejects.toThrow(/CPU|fallback|execution provider/i)
})

test('the bundled GPU worker retains features, returns native binary coverage and owns cancellation/retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-object-selection-worker-'))
  const runtime = new ObjectSelectionProcess({
    workerPath: resolve('out/main/object-selection-worker.js'),
    modelDirectory: resolve('out/main/object-selection-model'),
  })
  const input = join(directory, 'source.rgba')
  const source = {
    key: 'synthetic-canonical-source-v1',
    path: input,
    width: 192,
    height: 128,
    format: 'rgba8' as const,
  }
  const signal = new AbortController().signal
  try {
    await writeFile(input, rgba(source.width, source.height))
    const prepared = await runtime.prepare(source, signal)
    expect(prepared).toMatchObject({
      key: source.key,
      width: source.width,
      height: source.height,
      modelIdentity: 'sam2.1-hiera-tiny-f32-labels-v1',
    })
    // Removing the source proves that subsequent prompt requests reuse confirmed encoder features.
    await rm(input)
    await expect(runtime.prepare(source, signal)).resolves.toEqual(prepared)
    for (const [name, prompts] of [
      ['box', { key: source.key, box: [0.2, 0.2, 0.8, 0.8] as const }],
      [
        'refined',
        {
          key: source.key,
          box: [0.2, 0.2, 0.8, 0.8] as const,
          positivePoints: [[0.5, 0.5]] as [number, number][],
          negativePoints: [[0.1, 0.1]] as [number, number][],
        },
      ],
    ] as const) {
      const result = await runtime.refine(prompts, join(directory, `${name}.png`), signal)
      const png = await readFile(result.path)
      const metadata = await sharp(png).metadata()
      const coverage = await sharp(png).greyscale().raw().toBuffer()
      expect(metadata).toMatchObject({
        format: 'png',
        width: source.width,
        height: source.height,
        channels: 1,
      })
      expect(new Set(coverage).size).toBeLessThanOrEqual(2)
      expect(Array.from(new Set(coverage)).every((value) => value === 0 || value === 255)).toBe(
        true,
      )
      expect(createHash('sha256').update(png).digest('hex')).toBe(result.sha256)
      expect(png.byteLength).toBe(result.encodedBytes)
      expect(Number.isFinite(result.predictedIou)).toBe(true)
    }
    expect(() =>
      runtime.refine(
        { key: source.key, positivePoints: Array.from({ length: 7 }, () => [0.5, 0.5]) },
        join(directory, 'overflow.png'),
        signal,
      ),
    ).toThrow(/six prompt slots/)
    await expect(runtime.prepare(source, signal)).resolves.toEqual(prepared)
    const pid = (runtime as unknown as { owned: { child: { pid: number } } }).owned.child.pid
    const controller = new AbortController()
    const cancelledPath = join(directory, 'cancelled.png')
    const pending = runtime.refine(
      { key: source.key, positivePoints: [[0.5, 0.5]] },
      cancelledPath,
      controller.signal,
    )
    setTimeout(() => controller.abort(), 1)
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(readFile(cancelledPath)).rejects.toThrow(/ENOENT/)
    await expect(readFile(`${cancelledPath}.tmp`)).rejects.toThrow(/ENOENT/)
    await writeFile(input, rgba(source.width, source.height))
    const retried = await runtime.run(
      source,
      { key: source.key, positivePoints: [[0.5, 0.5]] },
      join(directory, 'retried.png'),
      signal,
    )
    expect(retried).toMatchObject({ key: source.key, width: source.width, height: source.height })
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
