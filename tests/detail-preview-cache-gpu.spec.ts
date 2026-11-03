import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareDetailPreview } from '../src/main/processing/detail-preview'
import { workingSourceIdentity } from '../src/main/working-assets'
import { PREPARED_PROOF_VERSION } from '../src/shared/preview-frame'
import { detailCacheFixture } from './detail-preview-cache.helpers'
import { ReferencePreviewEngine } from './reference-preview-engine'

const digest = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('tiny raster, scene-HDR and authored-HDR application cache variants retain GPU/CPU agreement and backend-independent reuse', async ({}, info) => {
  const previous = process.env.IRODORI_PREVIEW_BACKEND
  try {
    for (const [hdr, authored] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      process.env.IRODORI_PREVIEW_BACKEND = 'gpu'
      const f = await detailCacheFixture(hdr, undefined, authored),
        engine = new ReferencePreviewEngine(),
        tag = !hdr ? 'raster' : authored ? 'authored-hdr' : 'scene-hdr',
        evidenceDirectory = info.outputPath(tag),
        retained = new Map<string, Uint8Array>()
      let comparison: Record<string, unknown> = { hdr, authored }
      try {
        if (authored) expect(f.source.primaryJob).toBeDefined()
        const referenceJob = f.source.primaryJob ?? f.source.job
        const frame = await f.previews.requestEditing(f.id, randomUUID()),
          cpuDirectory = await f.source.directory('cache-cpu-reference'),
          cpu = await prepareDetailPreview(
            cpuDirectory,
            {
              ...referenceJob,
              sourceIdentity: workingSourceIdentity(f.id, f.options, hdr && !authored),
            },
            new AbortController().signal,
            (options, backend) => engine.renderPreparedFull(cpuDirectory, options, backend),
          ),
          fullOwner = f.previews.acquire(new URL(frame.url))!,
          linearOwner = f.previews.acquire(new URL(frame.linear!.url!))!
        const entries = await f.entries()
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
          retained.set('actual.rgba', actual)
          retained.set('reference.rgba', reference)
          retained.set('actual-linear.f32', linearBytes)
          retained.set('reference-linear.f32', referenceBytes)
          const referenceUpstream = await readFile(referenceJob.asset.path),
            upstreams: Record<string, unknown>[] = []
          for (const [index, entry] of entries
            .filter((entry) => !entry.metadata.detailSource && entry.metadata.linear)
            .entries()) {
            const path = join(entry.path, 'linear.f32'),
              bytes = await readFile(path)
            upstreams.push({
              index,
              path,
              width: entry.metadata.width,
              height: entry.metadata.height,
              sourceKey: entry.metadata.sourceKey,
              recordedSha256: entry.metadata.linear.sha256,
              ...digest(bytes),
            })
          }
          let maximumCodeDifference = 0,
            maximumLinearRatio = 0,
            alphaExact = true,
            worstCodeIndex = 0,
            worstLinearIndex = 0
          for (let i = 0; i < actual.length; i++) {
            if (Math.abs(actual[i] - reference[i]) > maximumCodeDifference) worstCodeIndex = i
            maximumCodeDifference = Math.max(
              maximumCodeDifference,
              Math.abs(actual[i] - reference[i]),
            )
            if (i % 4 === 3)
              alphaExact &&= actual[i] === reference[i] && Object.is(linear[i], expected[i])
            else {
              const ratio =
                Math.abs(linear[i] - expected[i]) / (2e-6 + 2e-5 * Math.abs(expected[i]))
              if (ratio > maximumLinearRatio) worstLinearIndex = i
              maximumLinearRatio = Math.max(maximumLinearRatio, ratio)
            }
          }
          const pixel = Math.floor(worstCodeIndex / 4),
            pixelAt = pixel * 4
          comparison = {
            ...comparison,
            actual: {
              width: frame.width,
              height: frame.height,
              rgba: digest(actual),
              linear: digest(linearBytes),
            },
            reference: {
              width: cpu.width,
              height: cpu.height,
              rgba: digest(reference),
              linear: digest(referenceBytes),
              detail: cpu.detail,
              diagnostics: cpu.diagnostics,
            },
            source: {
              original: digest(f.source.originalBytes),
              referenceUpstream: { ...digest(referenceUpstream), asset: referenceJob.asset },
              applicationUpstreams: upstreams,
            },
            maximumCodeDifference,
            worstCode: {
              index: worstCodeIndex,
              x: pixel % frame.width,
              y: Math.floor(pixel / frame.width),
              channel: worstCodeIndex % 4,
              actualRgba: [...actual.subarray(pixelAt, pixelAt + 4)],
              referenceRgba: [...reference.subarray(pixelAt, pixelAt + 4)],
              actualLinearRgba: [...linear.subarray(pixelAt, pixelAt + 4)],
              referenceLinearRgba: [...expected.subarray(pixelAt, pixelAt + 4)],
            },
            maximumLinearRatio,
            worstLinear: {
              index: worstLinearIndex,
              actual: linear[worstLinearIndex],
              reference: expected[worstLinearIndex],
            },
            alphaExact,
            entries,
          }
          await mkdir(evidenceDirectory, { recursive: true })
          const path = join(evidenceDirectory, 'comparison.json')
          await writeFile(path, JSON.stringify(comparison, null, 2) + '\n')
          await info.attach(`${tag} comparison`, { path, contentType: 'application/json' })
          expect(maximumCodeDifference).toBeLessThanOrEqual(1)
          expect(maximumLinearRatio).toBeLessThanOrEqual(1)
          expect(alphaExact).toBe(true)
        } finally {
          fullOwner.release()
          linearOwner.release()
        }
        const filtered = entries.find(
            (entry) => entry.metadata.detailSource && entry.metadata.linear,
          )!,
          proof = entries.find(
            (entry) => entry.metadata.detailSource && entry.metadata.format === 'rgba8-srgb',
          )!
        expect(filtered.metadata.detail.backend).toBe('gpu')
        expect(filtered.metadata.detail.sourceSha256).toBe(referenceJob.asset.sha256)
        expect(filtered.metadata.detail.gpuTiles).toBe(1)
        expect(filtered.metadata.detail.adapter).toBeTruthy()
        expect(filtered.metadata.sourceKey).toBe(cpu.detail!.key)
        expect(proof.metadata.preparedProofVersion).toBe(PREPARED_PROOF_VERSION)
        expect(proof.metadata.diagnostics.proofBackend).toBe('gpu')
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
      } catch (error) {
        await mkdir(evidenceDirectory, { recursive: true })
        await Promise.all(
          [...retained].map(([name, bytes]) => writeFile(join(evidenceDirectory, name), bytes)),
        )
        await writeFile(
          join(evidenceDirectory, 'comparison.json'),
          JSON.stringify(
            { ...comparison, failure: String(error), retainedFiles: [...retained.keys()] },
            null,
            2,
          ) + '\n',
        )
        throw error
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
