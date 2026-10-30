import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detailFrameReader, detailWorkingFrame } from '../src/main/processing/detail-frame'
import { prepareDetailWorkingAsset } from '../src/main/processing/detail-preparation'
import { detailFrameMemoryPlan, DETAIL_GPU_BYTES } from '../src/shared/detail-resources'
import {
  neutralNoiseReduction,
  neutralDetailSharpening,
  compileNoiseReduction,
  compileDetailSharpening,
  spatialDetailTile,
} from '../src/shared/spatial-detail'
import type { SpatialDetailGpu } from '../src/main/gpu/spatial-detail'
import { detailFrame, detailFrameJob, canonicalDetailFrame } from './detail-frame.helpers'
import { sha } from './export.helpers'

const bytesOf = (data: Float32Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength)

test('identity borrows the validated frame and exact strip views without a resource request or GPU', async () => {
  const frame = detailFrame(),
    job = {
      ...detailFrameJob(),
      noiseReduction: neutralNoiseReduction,
      detailSharpening: neutralDetailSharpening,
      admission: undefined,
      backend: 'gpu' as const,
    },
    before = Buffer.from(frame.data.buffer).toString('hex')
  let attempts = 0
  const factory = () => {
      attempts++
      throw new Error('Unexpected device initialization.')
    },
    result = await detailWorkingFrame(frame, job, new AbortController().signal, factory)
  expect(result.frame).toBe(frame)
  expect(result.transform).toBe(frame.transform)
  expect(result.memory).toBeUndefined()
  let offset = 0
  for await (const band of detailFrameReader(frame, job, new AbortController().signal, factory)
    .strips) {
    expect(band.buffer).toBe(frame.data.buffer)
    expect(band.byteOffset).toBe(frame.data.byteOffset + offset * 4)
    offset += band.length
  }
  expect(offset).toBe(frame.data.length)
  expect(result.diagnostics.backend).toBe('identity')
  expect(attempts).toBe(0)
  expect(Buffer.from(frame.data.buffer).toString('hex')).toBe(before)
})

test('streamed and retained authored frames match canonical native tiles at maximum halo in both primaries', async () => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const frame = detailFrame(),
      job = detailFrameJob(primaries),
      before = Buffer.from(frame.data.buffer).toString('hex')
    Object.assign(job.detailSharpening, { radius: 3 })
    const expected = canonicalDetailFrame(frame, job),
      retained = await detailWorkingFrame(frame, job, new AbortController().signal),
      streamed = detailFrameReader(frame, job, new AbortController().signal),
      parts: Buffer[] = []
    for await (const band of streamed.strips) parts.push(Buffer.from(bytesOf(band)))
    expect(bytesOf(retained.frame.data).equals(bytesOf(expected))).toBe(true)
    expect(Buffer.concat(parts).equals(bytesOf(expected))).toBe(true)
    expect(retained.transform).toEqual(frame.transform)
    expect(retained.frame.cpuSource).toBeUndefined()
    expect(retained.frame.identity).toBeUndefined()
    expect(retained.primaries).toBe(primaries)
    expect(retained.diagnostics).toMatchObject({
      backend: 'cpu',
      cpuTiles: 6,
      gpuTiles: 0,
      maxSourceStrips: 3,
    })
    expect(retained.memory!.sourceBytes).toBe(frame.data.buffer.byteLength)
    expect(retained.memory!.cpu.ramBytes - streamed.memory!.cpu.ramBytes).toBe(
      frame.data.byteLength,
    )
    expect(Buffer.from(frame.data.buffer).toString('hex')).toBe(before)
  }
})

test('frame metadata and control snapshots survive caller replacement before the first iteration', async () => {
  const frame = detailFrame(19, 131),
    job = detailFrameJob(),
    expected = canonicalDetailFrame(frame, job),
    reader = detailFrameReader(frame, job, new AbortController().signal),
    parts: Buffer[] = []
  Object.assign(job.noiseReduction, { luminance: 0, chroma: 0 })
  Object.assign(frame.transform, { white: 0.2 })
  Object.assign(frame, { width: 1, height: 1, data: new Float32Array(4) })
  for await (const band of reader.strips) parts.push(Buffer.from(bytesOf(band)))
  expect(reader.width).toBe(19)
  expect(reader.height).toBe(131)
  expect(reader.transform.white).toBe(0.83)
  expect(Buffer.concat(parts).equals(bytesOf(expected))).toBe(true)
})

test('HDR in-memory and file preparations agree and replace stale hashes, URLs and native handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-detail-frame-hdr-')),
    frame = detailFrame(19, 131, true),
    job = detailFrameJob('rec2020'),
    before = bytesOf(frame.data).toString('hex')
  try {
    const source = join(root, 'source.f32'),
      sourceIdentity = sha(Buffer.from('isolated HDR frame source'))
    await writeFile(source, bytesOf(frame.data))
    const result = await detailWorkingFrame(frame, job, new AbortController().signal),
      file = await prepareDetailWorkingAsset(
        source,
        { ...job, ...job.admission!, sourceIdentity, asset: frame.hdr! },
        join(root, 'derived.f32'),
        new AbortController().signal,
      ),
      actual = bytesOf(result.frame.data)
    expect(actual.equals(await readFile(file.path))).toBe(true)
    expect(result.frame.hdr).toEqual(file.asset)
    expect(result.frame.hdr!.sha256).toBe(sha(actual))
    expect(result.frame.hdr!.sha256).not.toBe(frame.hdr!.sha256)
    expect(result.frame.hdr!.source).toEqual(frame.hdr!.source)
    expect(result.frame.hdr!.url).toBeUndefined()
    expect(result.frame.cpuSource).toBeUndefined()
    expect(result.frame.identity).toBeUndefined()
    expect(bytesOf(frame.data).toString('hex')).toBe(before)
    const damaged = { ...frame, hdr: structuredClone(frame.hdr!) }
    damaged.hdr.sha256 = '0'.repeat(64)
    let attempts = 0
    await expect(
      detailWorkingFrame(damaged, { ...job, backend: 'gpu' }, new AbortController().signal, () => {
        attempts++
        throw new Error('Unexpected GPU setup.')
      }),
    ).rejects.toThrow('Damaged detail source HDR frame')
    expect(attempts).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('admission and source validation precede derived publication and allow an equivalent CPU route', async () => {
  const frame = detailFrame(5, 3),
    job = detailFrameJob(),
    denied = structuredClone(job)
  let attempted = 0
  const factory = () => {
    attempted++
    throw new Error('Unexpected GPU setup.')
  }
  Object.assign(denied.admission!.policy.ram, { effectiveBytes: 1 })
  await expect(
    detailWorkingFrame(frame, denied, new AbortController().signal, factory),
  ).rejects.toThrow('budgets')
  await expect(
    detailWorkingFrame(
      frame,
      { ...job, admission: undefined },
      new AbortController().signal,
      factory,
    ),
  ).rejects.toThrow('admission')
  const memory = detailFrameMemoryPlan(frame, job.admission!, true, frame.data.buffer.byteLength),
    exact = structuredClone(job)
  Object.assign(exact.admission!.policy.ram, { effectiveBytes: memory.cpu.ramBytes - 1 })
  await expect(
    detailWorkingFrame(frame, exact, new AbortController().signal, factory),
  ).rejects.toThrow('budgets')
  expect(
    detailFrameReader(frame, exact, new AbortController().signal, factory).memory!.cpuAccepted,
  ).toBe(true)
  const cpu = structuredClone(job)
  Object.assign(cpu.admission!.policy.vram, {
    effectiveBytes: cpu.admission!.reservation.vramBytes,
  })
  const result = await detailWorkingFrame(
    frame,
    { ...cpu, backend: 'auto' },
    new AbortController().signal,
    factory,
  )
  expect(result.diagnostics.backend).toBe('cpu')
  expect(result.diagnostics.fallback).toContain('admission')
  await expect(
    detailWorkingFrame(frame, { ...cpu, backend: 'gpu' }, new AbortController().signal, factory),
  ).rejects.toThrow('budgets')
  const malformed = detailFrame(5, 3)
  malformed.data[4] = NaN
  await expect(
    detailWorkingFrame(malformed, job, new AbortController().signal, factory),
  ).rejects.toThrow('source pixels')
  expect(() =>
    detailFrameReader(
      { ...frame, transform: { ...frame.transform, white: 0 } },
      job,
      new AbortController().signal,
    ),
  ).toThrow('transform')
  expect(() =>
    detailFrameReader(detailFrame(5, 3, true), job, new AbortController().signal),
  ).toThrow('HDR descriptor')
  expect(attempted).toBe(0)
})

test('early frame-iterator return retains the input lease until GPU retirement completes', async () => {
  const frame = detailFrame(19, 131),
    job = { ...detailFrameJob(), backend: 'gpu' as const },
    before = bytesOf(frame.data).toString('hex')
  let entered!: () => void,
    release!: () => void,
    retired = false
  const closing = new Promise<void>((done) => {
      entered = done
    }),
    hold = new Promise<void>((done) => {
      release = done
    }),
    gpu: SpatialDetailGpu = {
      adapter: 'isolated-frame-retirement',
      bytes: DETAIL_GPU_BYTES,
      allocatedBytes: DETAIL_GPU_BYTES,
      programCount: 3,
      precisionRecoveryTiles: 0,
      async render(value) {
        return spatialDetailTile(
          value.image,
          value.tile,
          value.source,
          compileNoiseReduction(value.noiseReduction),
          compileDetailSharpening(value.detailSharpening),
          value.primaries,
        )
      },
      async close() {
        entered()
        await hold
        retired = true
      },
    },
    reader = detailFrameReader(frame, job, new AbortController().signal, () => gpu)
  expect((await reader.strips.next()).value!.length).toBe(frame.width * 64 * 4)
  const pending = reader.strips.return(undefined)
  await closing
  expect(retired).toBe(false)
  release()
  await pending
  expect(retired).toBe(true)
  expect(reader.diagnostics.gpuTiles).toBe(1)
  expect(bytesOf(frame.data).toString('hex')).toBe(before)
})
