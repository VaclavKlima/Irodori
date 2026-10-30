import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cropFrameReader, cropWorkingFrame } from '../src/main/processing/crop-frame'
import { prepareCropWorkingAsset } from '../src/main/processing/crop-preparation'
import { resampleCropTile } from '../src/shared/crop-filter'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { CROP_COMPUTE_BYTES, cropFrameMemoryPlan } from '../src/shared/crop-resources'
import { cropAdmission, cropFrame } from './crop-frame.helpers'
import { workingAsset } from './export.helpers'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { automaticLensSettings } from '../src/shared/lens'

test('the preview worker refuses an unprepared crop instead of silently displaying the wrong geometry', async () => {
  const engine = new PreviewEngine()
  try {
    await expect(
      engine.renderFull('/no-source-read.png', '/no-output', undefined, {
        crop: { ...identityCrop, quarterTurns: 1 },
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        revision: 0,
      }),
    ).rejects.toThrow('prepared preview variant')
  } finally {
    await engine.close()
  }
})

test('identity borrows original frame and strips without a GPU, copy or color-transform change', async () => {
  const frame = cropFrame(),
    job = { settings: { ...identityCrop }, backend: 'gpu' as const },
    signal = new AbortController().signal
  let attempts = 0
  const factory = async () => {
    attempts++
    throw new Error('Unexpected GPU owner.')
  }
  const result = await cropWorkingFrame(frame, job, signal, factory)
  expect(result.frame).toBe(frame)
  expect(result.transform).toBe(frame.transform)
  expect(result.diagnostics.backend).toBe('identity')
  let length = 0
  for await (const strip of cropFrameReader(frame, job, signal, factory).strips) {
    expect(strip.buffer).toBe(frame.data.buffer)
    expect(strip.byteOffset).toBe(frame.data.byteOffset + length * 4)
    length += strip.length
  }
  expect(length).toBe(frame.data.length)
  expect(attempts).toBe(0)
  expect(Object.is(frame.data[0], -0)).toBe(true)
})

test('authored frame and authenticated file adapters produce identical cropped native pixels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-crop-frame-')),
    frame = cropFrame(),
    before = Buffer.from(frame.data.buffer).subarray().toString('hex'),
    signal = new AbortController().signal,
    source = join(root, 'source.f32'),
    bytes = Buffer.from(frame.data.buffer),
    asset = workingAsset(bytes, frame.width, frame.height)
  await writeFile(source, bytes)
  try {
    for (const settings of [
      { ...identityCrop, quarterTurns: 1 as const },
      fitCrop(frame, { ...identityCrop, angle: 4.23, width: 0.9, height: 0.8 }),
    ]) {
      const result = await cropWorkingFrame(
          frame,
          { settings, admission: cropAdmission(), backend: 'cpu' },
          signal,
        ),
        file = await prepareCropWorkingAsset(
          source,
          { asset, settings, ...cropAdmission(), backend: 'cpu' },
          join(root, `crop-${settings.angle}.f32`),
          signal,
        )
      expect(Buffer.from(result.frame.data.buffer)).toEqual(await readFile(file.path))
      expect(result.frame.transform).toBe(frame.transform)
      expect(result.geometry).toEqual(file.geometry)
      expect(result.memory!.cpu.ramBytes).toBeGreaterThan(
        cropAdmission().reservation.ramBytes + frame.data.byteLength + result.frame.data.byteLength,
      )
    }
    expect(Buffer.from(frame.data.buffer).toString('hex')).toBe(before)
    expect(await readFile(source)).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('frame admission charges its existing input once and distinguishes streamed and retained output', async () => {
  const frame = cropFrame(),
    settings = fitCrop(frame, { ...identityCrop, angle: -9.87 }),
    geometry = cropGeometry(frame, settings),
    admission = cropAdmission(),
    streamed = cropFrameMemoryPlan(geometry, admission),
    retained = cropFrameMemoryPlan(geometry, admission, true)
  expect(retained.cpu.ramBytes - streamed.cpu.ramBytes).toBe(geometry.width * geometry.height * 16)
  expect(streamed.cpu.ramBytes).toBeGreaterThan(
    admission.reservation.ramBytes + frame.data.byteLength,
  )
  Object.assign(admission.policy.ram, { effectiveBytes: streamed.cpu.ramBytes })
  const reader = cropFrameReader(
    frame,
    { settings, admission, backend: 'cpu' },
    new AbortController().signal,
  )
  await expect(
    cropWorkingFrame(frame, { settings, admission, backend: 'cpu' }, new AbortController().signal),
  ).rejects.toThrow('managed image budgets')
  Object.assign(admission.policy.ram, { effectiveBytes: 0 })
  // The reader freezes policy/settings before its first iteration.
  expect((await reader.strips.next()).done).toBe(false)
  await reader.strips.return(undefined)
  expect(() =>
    cropFrameReader(frame, { settings, backend: 'cpu' }, new AbortController().signal),
  ).toThrow('resource admission')
})

test('early iterator return drains GPU work; simulated loss continues with the same source and CPU filter', async () => {
  const frame = cropFrame(),
    settings = fitCrop(frame, { ...identityCrop, angle: 4.23, width: 0.9, height: 0.9 }),
    job = { settings, admission: cropAdmission(), backend: 'auto' as const },
    signal = new AbortController().signal
  let closed = 0,
    calls = 0
  const factory = async () => ({
    adapter: 'synthetic-frame-loss',
    bytes: CROP_COMPUTE_BYTES,
    precisionRecoveryTiles: 0,
    async render(
      geometry: Parameters<typeof resampleCropTile>[0],
      tile: Parameters<typeof resampleCropTile>[1],
      window: Parameters<typeof resampleCropTile>[2],
    ) {
      if (++calls === 2) throw new Error('Synthetic frame GPU loss.')
      return resampleCropTile(geometry, tile, window)
    },
    async close() {
      closed++
    },
  })
  const actual = await cropWorkingFrame(frame, job, signal, factory),
    expected = await cropWorkingFrame(frame, { ...job, backend: 'cpu' }, signal)
  expect(actual.diagnostics.backend).toBe('mixed')
  expect(actual.diagnostics.fallback).toContain('Synthetic frame GPU loss')
  expect(Buffer.from(actual.frame.data.buffer)).toEqual(Buffer.from(expected.frame.data.buffer))
  expect(closed).toBe(1)
  calls = 0
  const partial = cropFrameReader(frame, job, signal, factory)
  await partial.strips.next()
  await partial.strips.return(undefined)
  expect(closed).toBe(2)
})

test('timer cancellation and invalid pixels abort a frame crop without changing the borrowed source', async () => {
  const frame = cropFrame(),
    settings = fitCrop(frame, { ...identityCrop, angle: 12.34 }),
    job = { settings, admission: cropAdmission(), backend: 'cpu' as const },
    before = new Uint32Array(frame.data.buffer).slice(),
    abort = new AbortController()
  const pending = cropWorkingFrame(frame, job, abort.signal)
  setTimeout(() => abort.abort(new Error('Frame crop cancelled.')), 0)
  await expect(pending).rejects.toThrow('Frame crop cancelled')
  expect(new Uint32Array(frame.data.buffer)).toEqual(before)
  frame.data[10] = NaN
  await expect(cropWorkingFrame(frame, job, new AbortController().signal)).rejects.toThrow(
    'Invalid crop source pixels',
  )
})
