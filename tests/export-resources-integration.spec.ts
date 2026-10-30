import { expect, test } from '@playwright/test'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { ExportProcess } from '../src/main/export/process'
import { exportRenditions } from '../src/main/export/renditions'
import { exportSdrEncodePlan } from '../src/shared/export-resources'
import type { ExportWorkerPhase } from '../src/shared/export'
import { detailExportFixture } from './detail-export.helpers'
import { sha } from './export.helpers'

test('the real SDR worker refuses rendition and encoder budgets before output, then reuses unchanged filtering at the admitted boundary', async () => {
  const previous = process.env.IRODORI_EXPORT_BACKEND,
    f = await detailExportFixture()
  try {
    process.env.IRODORI_EXPORT_BACKEND = 'cpu'
    const reference = await exportRenditions(f.exportJob),
      filteredPath = join(f.exportJob.preparationDirectory!, 'detail-primary.f32'),
      filtered = await readFile(filteredPath),
      markerPath = join(f.exportJob.preparationDirectory!, 'detail-primary.json'),
      marker = await readFile(markerPath),
      admission = structuredClone(f.exportJob.detailAdmission!),
      encodePlan = exportSdrEncodePlan(f.frame.width, f.frame.height, {
        ...admission,
        reservation: {
          ...admission.reservation,
          ramBytes: admission.reservation.ramBytes + reference.rgb.byteLength,
        },
      }),
      worker = new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      )
    for (const [name, limit, phases] of [
      ['render-refusal', reference.diagnostics.memory!.cpu.total.ramBytes - 1, []],
      ['encode-refusal', encodePlan.total.ramBytes - 1, ['rendition-rendered']],
      ['admitted', encodePlan.total.ramBytes, undefined],
    ] as const) {
      Object.assign(admission.policy.ram, { effectiveBytes: limit })
      const directory = await f.directory(name),
        observed: ExportWorkerPhase[] = [],
        result = worker.render(
          {
            ...f.exportJob,
            directory,
            cropAdmission: admission,
            detailAdmission: admission,
            workerProgressIdentity: {
              exportId: crypto.randomUUID(),
              fileIndex: 0,
              attemptId: crypto.randomUUID(),
            },
          },
          new AbortController().signal,
          (event) => observed.push(event.phase),
        )
      if (phases) {
        await expect(result).rejects.toThrow('frozen managed image budgets')
        expect(observed).toEqual(phases)
        expect(await readdir(directory)).toEqual([])
      } else {
        const encoded = await result,
          info = await sharp(encoded.path).metadata()
        expect([info.width, info.height]).toEqual([f.frame.width, f.frame.height])
        expect(sha(await readFile(encoded.path))).toBe(encoded.sha256)
        expect(encoded.diagnostics!.detail!.primary!.preparation).toBe('retained')
        expect(encoded.diagnostics!.memory!.sdr).toMatchObject({
          accepted: true,
          total: { ramBytes: limit },
        })
        expect(observed).toEqual([
          'rendition-rendered',
          'sdr-jpeg-obtained',
          'output-validated-written',
        ])
      }
      expect(await readFile(filteredPath)).toEqual(filtered)
      expect(await readFile(markerPath)).toEqual(marker)
      expect(await readFile(f.original)).toEqual(f.originalBytes)
    }
  } finally {
    if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
    else process.env.IRODORI_EXPORT_BACKEND = previous
    await f.close()
  }
})
