import { mkdir, readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { exportRenditions } from '../src/main/export/renditions'
import { defaultExportOptions } from '../src/shared/export'
import { detailExportFixture } from './detail-export.helpers'
import { syntheticExportSource } from './export.helpers'

const previous = process.env.IRODORI_EXPORT_BACKEND
test.afterEach(() => {
  if (previous === undefined) delete process.env.IRODORI_EXPORT_BACKEND
  else process.env.IRODORI_EXPORT_BACKEND = previous
})

for (const mode of [undefined, 'auto'] as const)
  for (const hdr of [false, true])
    test(`${mode ?? 'default'} scene-linear ${hdr ? 'HDR' : 'SDR'} export propagates GPU initialization failure without CPU recovery`, async () => {
      if (mode === undefined) delete process.env.IRODORI_EXPORT_BACKEND
      else process.env.IRODORI_EXPORT_BACKEND = mode
      const directory = test.info().outputPath('initialization-failure')
      await mkdir(directory)
      const source = await syntheticExportSource(directory, 7, 5, (x, y) => [x / 6, y / 4, 2]),
        original = await readFile(source.path),
        failure = new Error('Injected export GPU initialization failure.')
      let calls = 0,
        encodes = 0
      await expect(
        exportRenditions(
          { source, directory, options: defaultExportOptions, hdr },
          async () => {
            calls++
            throw failure
          },
          async () => {
            encodes++
            throw new Error('Unexpected early encoding before initialization.')
          },
        ),
      ).rejects.toBe(failure)
      expect(calls).toBe(1)
      expect(encodes).toBe(0)
      expect(await readFile(source.path)).toEqual(original)
    })

// Generated PNG and synthetic HDR descriptors; no gain-map decoder is exercised.
for (const authored of [false, true])
  test(`automatic ${authored ? 'authored HDR working/primary' : 'raster'} export retains its distinct legacy source domain`, async () => {
    process.env.IRODORI_EXPORT_BACKEND = 'auto'
    const f = await detailExportFixture(authored, authored)
    let calls = 0
    try {
      const result = await exportRenditions(
        {
          ...f.exportJob,
          source: {
            ...f.source,
            processing: {
              ...f.source.processing,
              noiseReduction: undefined,
              detailSharpening: undefined,
            },
          },
        },
        async () => {
          calls++
          throw new Error('The scene-linear GPU shader cannot replace this source domain.')
        },
      )
      expect(result.diagnostics.renderer).toBe('cpu')
      expect(result.diagnostics.rendererFallback).toBeUndefined()
      expect(calls).toBe(0)
      expect(await readFile(f.original)).toEqual(f.originalBytes)
    } finally {
      await f.close()
    }
  })
