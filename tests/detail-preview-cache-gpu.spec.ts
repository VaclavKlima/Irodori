import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PreviewEngine } from '../src/main/preview-engine'
import { prepareDetailPreview } from '../src/main/processing/detail-preview'
import { workingSourceIdentity } from '../src/main/working-assets'
import { PREPARED_PROOF_VERSION } from '../src/shared/preview-frame'
import { detailCacheFixture } from './detail-preview-cache.helpers'

test('tiny raster, scene-HDR and authored-HDR application cache variants retain GPU/CPU agreement and backend-independent reuse', async () => {
  const previous = process.env.IRODORI_PREVIEW_BACKEND
  try {
    for (const [hdr, authored] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      process.env.IRODORI_PREVIEW_BACKEND = 'gpu'
      const f = await detailCacheFixture(hdr, undefined, authored),
        engine = new PreviewEngine(undefined, 'cpu')
      try {
        const frame = await f.previews.requestEditing(f.id, randomUUID()),
          cpuDirectory = await f.source.directory('cache-cpu-reference'),
          cpu = await prepareDetailPreview(
            cpuDirectory,
            {
              ...f.source.job,
              sourceIdentity: workingSourceIdentity(f.id, f.options, hdr),
            },
            new AbortController().signal,
            (options, backend) => engine.renderPreparedFull(cpuDirectory, options, backend),
          ),
          fullOwner = f.previews.acquire(new URL(frame.url))!,
          linearOwner = f.previews.acquire(new URL(frame.linear!.url!))!
        try {
          const actual = await readFile(fullOwner.path),
            reference = await readFile(join(cpuDirectory, 'full.rgba')),
            linearBytes = await readFile(linearOwner.path),
            referenceBytes = await readFile(join(cpuDirectory, 'linear.f32')),
            linear = new Float32Array(
              linearBytes.buffer,
              linearBytes.byteOffset,
              linearBytes.length / 4,
            ),
            expected = new Float32Array(
              referenceBytes.buffer,
              referenceBytes.byteOffset,
              referenceBytes.length / 4,
            )
          let maximumCodeDifference = 0,
            maximumLinearRatio = 0,
            alphaExact = true
          for (let i = 0; i < actual.length; i++) {
            maximumCodeDifference = Math.max(
              maximumCodeDifference,
              Math.abs(actual[i] - reference[i]),
            )
            if (i % 4 === 3)
              alphaExact &&= actual[i] === reference[i] && Object.is(linear[i], expected[i])
            else
              maximumLinearRatio = Math.max(
                maximumLinearRatio,
                Math.abs(linear[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i])),
              )
          }
          expect(maximumCodeDifference).toBeLessThanOrEqual(1)
          expect(maximumLinearRatio).toBeLessThanOrEqual(1)
          expect(alphaExact).toBe(true)
        } finally {
          fullOwner.release()
          linearOwner.release()
        }
        const entries = await f.entries(),
          filtered = entries.find((entry) => entry.metadata.detailSource && entry.metadata.linear)!,
          proof = entries.find(
            (entry) => entry.metadata.detailSource && entry.metadata.format === 'rgba8-srgb',
          )!
        expect(filtered.metadata.detail.backend).toBe('gpu')
        expect(filtered.metadata.detail.gpuTiles).toBe(1)
        expect(filtered.metadata.detail.adapter).toBeTruthy()
        expect(filtered.metadata.sourceKey).toBe(cpu.detail!.key)
        expect(proof.metadata.preparedProofVersion).toBe(PREPARED_PROOF_VERSION)
        expect(proof.metadata.diagnostics.proofBackend).toBe(hdr && !authored ? 'gpu' : 'cpu')
        if (hdr && !authored) {
          expect(proof.metadata.diagnostics.proofGpuStrips).toBeGreaterThan(0)
          expect(proof.metadata.diagnostics.proofCpuStrips).toBe(0)
        }
        expect(proof.metadata.diagnostics.fallback).toBeUndefined()
        process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
        const cached = await f.previews.requestEditing(f.id, randomUUID())
        expect(cached.url).toBe(frame.url)
        expect(cached.linear!.url).toBe(frame.linear!.url)
        expect(f.counters.sources).toBe(1)
        expect(f.counters.filters).toBe(1)
        expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
      } finally {
        await engine.close()
        await f.close()
      }
    }
  } finally {
    if (previous === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
    else process.env.IRODORI_PREVIEW_BACKEND = previous
  }
})
