import { expect, test } from '@playwright/test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import { prepareDetailPreview } from '../src/main/processing/detail-preview'
import { renderAdjustments } from '../src/shared/adjustments'
import { adjustHdr, hdrAdjustmentMatrix, outputHdr, SDR_TARGET, encodeHdr } from '../src/shared/hdr'
import { neutralNoiseReduction, neutralDetailSharpening } from '../src/shared/spatial-detail'
import { identityCrop } from '../src/shared/crop'
import { detailPreviewFixture } from './detail-preview.helpers'
import { canonicalDetailFrame, detailFrameJob } from './detail-frame.helpers'
import { sha } from './export.helpers'

test('a real PNG passes through frozen worker detail preparation and point rendering with matching frame/placeholder identity', async () => {
  const f = await detailPreviewFixture(),
    worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  try {
    const frozen = structuredClone(f.job),
      output = await f.directory('worker'),
      expected = canonicalDetailFrame(f.frame, { ...detailFrameJob(), ...frozen }),
      rgba = Buffer.from(
        renderAdjustments(expected, frozen.options.adjustments!, f.frame.transform),
      ),
      pending = worker.prepareDetailPreview(f.original, output, f.job, new AbortController().signal)
    Object.assign(f.job.noiseReduction, { luminance: 0 })
    Object.assign(f.job.options.adjustments!, { exposureEv: -1 })
    Object.assign(f.job.asset, { sha256: '0'.repeat(64) })
    const result = await pending,
      linear = await readFile(join(output, 'linear.f32'))
    expect(linear.equals(Buffer.from(expected.buffer))).toBe(true)
    expect(linear.equals(await readFile(frozen.asset.path))).toBe(false)
    expect((await readFile(join(output, 'full.rgba'))).equals(rgba)).toBe(true)
    expect(result.sha256).toBe(sha(rgba))
    expect(result.linear!.sha256).toBe(sha(linear))
    expect(result.settingsRevision).toBe(7)
    expect(result.adjustments).toEqual(frozen.options.adjustments)
    expect(result.detail).toMatchObject({
      sourceSha256: frozen.asset.sha256,
      sourceIdentity: frozen.sourceIdentity,
      noiseReduction: frozen.noiseReduction,
      detailSharpening: frozen.detailSharpening,
      proofBackendRequest: 'cpu',
    })
    expect(result.renderId).toContain(result.detail!.key)
    expect(result.renderId).toContain(result.linear!.sha256)
    expect((await stat(join(output, 'placeholder.png'))).size).toBe(result.placeholderBytes)
    const next = structuredClone(frozen),
      nextOutput = await f.directory('point-change')
    Object.assign(next.options.adjustments!, { exposureEv: -0.5 })
    const changed = await worker.prepareDetailPreview(
      f.original,
      nextOutput,
      next,
      new AbortController().signal,
    )
    expect(changed.detail!.key).toBe(result.detail!.key)
    expect(changed.linear!.sha256).toBe(result.linear!.sha256)
    expect(changed.sha256).not.toBe(result.sha256)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await worker.close()
    await f.close()
  }
})

test('prepared HDR scene and authored sources render the filtered float data through their own output domain', async () => {
  for (const authored of [false, true]) {
    const f = await detailPreviewFixture(true, authored),
      engine = new PreviewEngine(undefined, 'cpu')
    try {
      const output = await f.directory('hdr-proof'),
        filtered = canonicalDetailFrame(f.frame, { ...detailFrameJob('rec2020'), ...f.job }),
        expected = Buffer.alloc(filtered.length),
        wrongScene = Buffer.alloc(filtered.length),
        wb =
          hdrAdjustmentMatrix(f.job.options.adjustments!, f.job.asset.hdr!.whiteBalance) ??
          undefined
      for (let i = 0; i < filtered.length; i += 4) {
        const adjusted = adjustHdr(
            [filtered[i], filtered[i + 1], filtered[i + 2]],
            f.job.options.adjustments!,
            wb,
          ),
          rgb = outputHdr(adjusted, SDR_TARGET, f.job.asset.hdr!.source).rgb,
          scene = outputHdr(adjusted, SDR_TARGET).rgb
        for (let c = 0; c < 3; c++) {
          expected[i + c] = Math.round(encodeHdr(rgb[c]) * 255)
          wrongScene[i + c] = Math.round(encodeHdr(scene[c]) * 255)
        }
        expected[i + 3] = wrongScene[i + 3] = Math.round(filtered[i + 3] * 255)
      }
      const result = await prepareDetailPreview(
        output,
        f.job,
        new AbortController().signal,
        (options, backend) => engine.renderPreparedFull(output, options, backend),
      )
      expect((await readFile(join(output, 'full.rgba'))).equals(expected)).toBe(true)
      expect(result.sha256).toBe(sha(expected))
      expect(result.linear!.hdr!.source).toEqual(f.job.asset.hdr!.source)
      if (authored)
        expect(Math.max(...expected.map((v, i) => Math.abs(v - wrongScene[i])))).toBeGreaterThan(10)
      const working = await f.directory('working-only'),
        workingJob = { ...f.job, workingOnly: true }
      let renders = 0
      const source = await prepareDetailPreview(
        working,
        workingJob,
        new AbortController().signal,
        async () => {
          renders++
          throw new Error('Unexpected proof.')
        },
      )
      expect(renders).toBe(0)
      expect(source).toMatchObject({ format: 'hdr-working', byteLength: 0, placeholderBytes: 0 })
      expect(source.detail!.proofBackendRequest).toBe('none')
      expect(source.linear!.sha256).toBe(result.linear!.sha256)
      expect(source.detail!.memory.proofBytes).toEqual({ ramBytes: 0, vramBytes: 0 })
    } finally {
      await engine.close()
      await f.close()
    }
  }
})

test('neutral/geometry/domain and admission checks reject invalid preview jobs before output ownership', async () => {
  const f = await detailPreviewFixture()
  try {
    const output = await f.directory('invalid'),
      render = async () => {
        throw new Error('Unexpected renderer.')
      }
    for (const job of [
      {
        ...f.job,
        noiseReduction: neutralNoiseReduction,
        detailSharpening: neutralDetailSharpening,
      },
      { ...f.job, options: { ...f.job.options, crop: { ...identityCrop, width: 0.8 } } },
      { ...f.job, workingOnly: true },
      { ...f.job, options: { ...f.job.options, processing: 'hdr-v1' as const } },
    ])
      await expect(
        prepareDetailPreview(output, job, new AbortController().signal, render),
      ).rejects.toThrow()
    const denied = structuredClone(f.job)
    Object.assign(denied.policy.ram, { effectiveBytes: 1 })
    await expect(
      prepareDetailPreview(output, denied, new AbortController().signal, render),
    ).rejects.toThrow('budgets')
    const damaged = structuredClone(f.job)
    damaged.asset.sha256 = '0'.repeat(64)
    await expect(
      prepareDetailPreview(output, damaged, new AbortController().signal, render),
    ).rejects.toThrow('Damaged detail working source')
    await expect(stat(join(output, 'linear.f32'))).rejects.toThrow()
    const existing = Buffer.from('preserve existing proof')
    await writeFile(join(output, 'full.rgba'), existing)
    await expect(
      prepareDetailPreview(output, f.job, new AbortController().signal, render),
    ).rejects.toThrow('unpublished')
    expect(await readFile(join(output, 'full.rgba'))).toEqual(existing)
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await f.close()
  }
})

test('proof cancellation and mismatching rendered identity remove only this job outputs', async () => {
  const f = await detailPreviewFixture(),
    engine = new PreviewEngine(undefined, 'cpu')
  try {
    const output = await f.directory('cancelled'),
      controller = new AbortController()
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((done) => {
        entered = done
      }),
      hold = new Promise<void>((done) => {
        release = done
      }),
      pending = prepareDetailPreview(output, f.job, controller.signal, async (options, backend) => {
        entered()
        await hold
        return engine.renderPreparedFull(output, options, backend)
      })
    await ready
    controller.abort()
    release()
    await expect(pending).rejects.toThrow()
    for (const name of ['linear.f32', 'full.rgba', 'placeholder.png'])
      await expect(stat(join(output, name))).rejects.toThrow()
    for (const failure of ['revision', 'sha']) {
      const invalid = await f.directory(`invalid-${failure}`)
      await expect(
        prepareDetailPreview(
          invalid,
          f.job,
          new AbortController().signal,
          async (options, backend) => {
            const result = await engine.renderPreparedFull(invalid, options, backend)
            return {
              ...result,
              ...(failure === 'revision' ? { settingsRevision: 999 } : { sha256: '0'.repeat(64) }),
            }
          },
        ),
      ).rejects.toThrow()
      for (const name of ['linear.f32', 'full.rgba', 'placeholder.png'])
        await expect(stat(join(invalid, name))).rejects.toThrow()
    }
    expect(await readFile(f.original)).toEqual(f.originalBytes)
  } finally {
    await engine.close()
    await f.close()
  }
})
