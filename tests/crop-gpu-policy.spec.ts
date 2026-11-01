import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { exportRenditions } from '../src/main/export/renditions'
import { cropGeometry, fitCrop, identityCrop } from '../src/shared/crop'
import { cropFrameMemoryPlan, cropMemoryPlan } from '../src/shared/crop-resources'
import { cropAdmission } from './crop-frame.helpers'
import { cropPreviewFixture } from './crop-preview.helpers'
import { detailExportFixture } from './detail-export.helpers'

const previousPreview = process.env.IRODORI_PREVIEW_BACKEND,
  previousExport = process.env.IRODORI_EXPORT_BACKEND

test.afterEach(() => {
  if (previousPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousPreview
  if (previousExport === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previousExport
})

function cpuOnlyAdmission() {
  const original = cropAdmission()
  return {
    policy: original.policy,
    reservation: {
      ...original.reservation,
      vramBytes: original.policy.vram.effectiveBytes - 1,
    },
  }
}

for (const mode of [undefined, 'auto'] as const)
  for (const hdr of [false, true]) {
    test(`${mode ?? 'default'} ${hdr ? 'HDR' : 'raster'} fractional crop preview refuses GPU admission without CPU recovery or a published variant`, async () => {
      if (mode === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
      else process.env.IRODORI_PREVIEW_BACKEND = mode
      const f = await cropPreviewFixture(hdr)
      try {
        const admission = cpuOnlyAdmission(),
          beforeWords = new Uint32Array(f.data.buffer).slice()
        f.previews.installCropAdmission(async () => admission)
        f.beforeCrop(async (job) => {
          expect(job.backend).toBe('gpu')
          const geometry = cropGeometry(job.asset, job.settings),
            memory = job.asset.hdr
              ? cropMemoryPlan(geometry, job)
              : cropFrameMemoryPlan(geometry, job)
          expect(geometry.pixelAligned).toBe(false)
          expect(memory.cpuAccepted).toBe(true)
          expect(memory.gpuAccepted).toBe(false)
        })
        await expect(f.previews.requestEditing(f.id, randomUUID())).rejects.toThrow(
          'Crop GPU preparation exceeds the frozen managed image budgets.',
        )
        expect(f.counters.crops).toBe(1)
        const names = await readdir(join(f.root, 'cache', PREVIEW_VERSION))
        expect(names.some((name) => name.startsWith('.tmp-'))).toBe(false)
        for (const name of names) {
          const entry = JSON.parse(
            await readFile(join(f.root, 'cache', PREVIEW_VERSION, name, 'entry.json'), 'utf8'),
          )
          expect(entry.crop).toBeUndefined()
        }
        expect(await readFile(f.path)).toEqual(f.original)
        expect(new Uint32Array(f.data.buffer)).toEqual(beforeWords)
      } finally {
        await f.close()
      }
    })

    test(`${mode ?? 'default'} ${hdr ? 'HDR' : 'raster'} fractional crop export refuses GPU admission without CPU recovery or partial files`, async () => {
      if (mode === undefined) delete process.env.IRODORI_EXPORT_BACKEND
      else process.env.IRODORI_EXPORT_BACKEND = mode
      const f = await detailExportFixture(hdr)
      try {
        const admission = cpuOnlyAdmission(),
          crop = fitCrop(f.frame, { ...identityCrop, angle: 4.23, width: 0.65, height: 0.65 }),
          geometry = cropGeometry(f.frame, crop),
          memory = hdr
            ? cropMemoryPlan(geometry, admission)
            : cropFrameMemoryPlan(geometry, admission),
          before = await readFile(f.job.asset.path)
        expect(memory.cpuAccepted).toBe(true)
        expect(memory.gpuAccepted).toBe(false)
        await expect(
          exportRenditions({
            ...f.exportJob,
            source: {
              ...f.source,
              processing: {
                ...f.source.processing,
                noiseReduction: undefined,
                detailSharpening: undefined,
                crop,
              },
            },
            cropAdmission: admission,
            detailAdmission: undefined,
            resizeAdmission: undefined,
          }),
        ).rejects.toThrow('Crop GPU preparation exceeds the frozen managed image budgets.')
        expect(await readdir(f.exportJob.directory)).toEqual([])
        expect(await readFile(f.job.asset.path)).toEqual(before)
        expect(await readFile(f.original)).toEqual(f.originalBytes)
      } finally {
        await f.close()
      }
    })
  }
