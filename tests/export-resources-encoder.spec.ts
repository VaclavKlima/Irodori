import { expect, test } from '@playwright/test'
import { mkdir, readdir } from 'node:fs/promises'
import sharp from 'sharp'
import { encodeExportHdr } from '../src/main/export/encoder'
import { halfFloat, loadUltraHdr } from '../src/main/export/codec'
import { exportHdrEncodePlan } from '../src/shared/export-resources'
import { detailFrameJob } from './detail-frame.helpers'
import { validatePrimary } from '../src/main/export/jpeg'

test('tiny native and WASM encoders refuse an insufficient reservation before output and retain the original primary when admitted', async () => {
  const width = 8,
    height = 8,
    half = new Uint16Array(width * height * 4),
    sdr = await sharp({
      create: { width, height, channels: 3, background: { r: 50, g: 90, b: 120 } },
    })
      .withIccProfile('srgb')
      .jpeg()
      .toBuffer()
  for (let i = 0; i < half.length; i += 4)
    half.set([halfFloat(0.25), halfFloat(0.5), halfFloat(1.5), 0x3c00], i)
  for (const mode of ['native', 'wasm'] as const) {
    const directory = test.info().outputPath(mode)
    await mkdir(directory, { recursive: true })
    const admission = structuredClone(detailFrameJob().admission!),
      plan = exportHdrEncodePlan(width, height, sdr.length, mode, admission)
    Object.assign(admission.policy.ram, { effectiveBytes: plan.total.ramBytes - 1 })
    await expect(
      encodeExportHdr(half, width, height, sdr, 90, 4, directory, mode, undefined, admission),
    ).rejects.toThrow('frozen managed image budgets')
    expect(await readdir(directory)).toEqual([])
    Object.assign(admission.policy.ram, { effectiveBytes: plan.total.ramBytes })
    const result = await encodeExportHdr(
      half,
      width,
      height,
      sdr,
      90,
      4,
      directory,
      mode,
      undefined,
      admission,
    )
    expect(result.backend).toBe(mode)
    expect(result.admission!.accepted).toBe(true)
    expect(() => validatePrimary(result.output, sdr)).not.toThrow()
  }
  const codec = await loadUltraHdr()
  expect(() => codec.encode(new Uint8Array(half.buffer), width, height, sdr, 90, 4, 1)).toThrow(
    'admitted output storage',
  )
})
