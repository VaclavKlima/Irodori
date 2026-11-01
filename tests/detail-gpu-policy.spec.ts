import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { prepareExportDetailStage } from '../src/main/export/detail'
import { detailFrameMemoryPlan, detailStreamMemoryPlan } from '../src/shared/detail-resources'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { detailExportFixture } from './detail-export.helpers'

const previousPreview = process.env.IRODORI_PREVIEW_BACKEND,
  previousExport = process.env.IRODORI_EXPORT_BACKEND

test.afterEach(() => {
  if (previousPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousPreview
  if (previousExport === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previousExport
})

for (const mode of [undefined, 'auto'] as const)
  for (const hdr of [false, true]) {
    test(`${mode ?? 'default'} ${hdr ? 'HDR' : 'raster'} detail preview refuses GPU admission without CPU recovery or a published variant`, async () => {
      if (mode === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
      else process.env.IRODORI_PREVIEW_BACKEND = mode
      const f = await detailCacheFixture(hdr)
      try {
        const workingBefore = await readFile(f.source.job.asset.path),
          admission = structuredClone({
            policy: f.source.job.policy,
            reservation: {
              ...f.source.job.reservation,
              vramBytes: f.source.job.policy.vram.effectiveBytes - 1,
            },
          })
        f.previews.installDetailAdmission(async () => admission)
        f.beforeDetail(async (job) => {
          expect(job.backend).toBe('gpu')
          const memory = hdr
            ? detailStreamMemoryPlan(f.source.frame, job, true)
            : detailFrameMemoryPlan(f.source.frame, job)
          expect(memory.cpuAccepted).toBe(true)
          expect(memory.gpuAccepted).toBe(false)
        })
        await expect(f.previews.requestEditing(f.id, randomUUID())).rejects.toThrow(
          'Detail GPU preview exceeds the frozen managed image budgets.',
        )
        expect(f.counters.filters).toBe(1)
        const entries = await f.entries()
        expect(entries.some((entry) => entry.metadata.detailSource)).toBe(false)
        expect(
          (await readdir(join(f.root, PREVIEW_VERSION))).some((name) => name.startsWith('.tmp-')),
        ).toBe(false)
        expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
        expect(await readFile(f.source.job.asset.path)).toEqual(workingBefore)
      } finally {
        await f.close()
      }
    })

    test(`${mode ?? 'default'} ${hdr ? 'HDR' : 'raster'} detail export refuses GPU admission and removes partial preparation without CPU recovery`, async () => {
      if (mode === undefined) delete process.env.IRODORI_EXPORT_BACKEND
      else process.env.IRODORI_EXPORT_BACKEND = mode
      const f = await detailExportFixture(hdr)
      try {
        const admission = structuredClone({
            policy: f.exportJob.detailAdmission!.policy,
            reservation: {
              ...f.exportJob.detailAdmission!.reservation,
              vramBytes: f.exportJob.detailAdmission!.policy.vram.effectiveBytes - 1,
            },
          }),
          source = hdr ? f.job.asset : f.frame,
          workingBefore = await readFile(f.job.asset.path)
        const memory = hdr
          ? detailStreamMemoryPlan(source, admission, true)
          : detailFrameMemoryPlan(f.frame, admission, true, f.frame.data.buffer.byteLength)
        expect(memory.cpuAccepted).toBe(true)
        expect(memory.gpuAccepted).toBe(false)
        await expect(
          prepareExportDetailStage(
            f.exportJob,
            hdr ? 'working' : 'primary',
            source,
            admission,
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          hdr
            ? 'Detail GPU preparation exceeds the frozen managed image budgets.'
            : 'Detail frame GPU processing exceeds the frozen managed image budgets.',
        )
        expect(await readdir(f.exportJob.preparationDirectory!)).toEqual([])
        expect(await readFile(f.job.asset.path)).toEqual(workingBefore)
        expect(await readFile(f.original)).toEqual(f.originalBytes)
      } finally {
        await f.close()
      }
    })
  }
