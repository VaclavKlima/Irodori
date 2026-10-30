import { expect, test } from '@playwright/test'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PreviewProcess } from '../src/main/preview-process'
import { prepareNativeRawExecutable } from '../src/main/native-raw-executable'
import { noLensSettings } from '../src/shared/lens'
import {
  sourceAgreementCodeHashes,
  sourceAgreementHash,
  sourceAgreementIdentity,
  sourceAgreementJson,
  verifyFullSourceDetail,
} from './professional-source-agreement.helpers'

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('full native Sony RAW linear source agrees between canonical CPU and production GPU detail streams', async ({}, info) => {
  test.setTimeout(60 * 60 * 1000)
  const root = info.outputPath('full-source'),
    original = resolve('tests/fixtures/sony-zv1.ARW'),
    expectedOriginalHash = '14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2',
    input = join(root, 'sony-zv1.ARW'),
    prepared = join(root, 'prepared'),
    producer = new PreviewProcess(resolve('out/main/preview-worker.js'), 90_000, 30_000, () =>
      prepareNativeRawExecutable(resolve('out/main')),
    ),
    cancellation = new AbortController(),
    timer = setTimeout(
      () => cancellation.abort(new Error('Full-source acceptance timed out.')),
      58 * 60 * 1000,
    ),
    codeBefore = await sourceAgreementCodeHashes(resolve('.'))
  timer.unref()
  await mkdir(prepared, { recursive: true })
  await sourceAgreementJson(join(root, 'implementation-before.json'), codeBefore)
  try {
    expect(await sourceAgreementHash(original)).toBe(expectedOriginalHash)
    await copyFile(original, input)
    await chmod(input, 0o444)
    expect(await sourceAgreementHash(input)).toBe(expectedOriginalHash)
    const metadata = await producer.inspect(input, cancellation.signal),
      options = {
        metadata,
        settings: noLensSettings,
        revision: 0,
        processing: 'hdr-v1' as const,
        prepareLinear: true,
        workingOnly: true,
      },
      frame = await producer.renderFull(input, prepared, cancellation.signal, options)
    await producer.close()
    expect(frame.format).toBe('hdr-working')
    const asset = frame.linear?.hdr
    if (!asset) throw new Error('The real RAW producer did not return a linear working asset.')
    // Verified uncorrected decoder axes, rather than catalog JPEG dimensions or an ROI.
    expect([asset.width, asset.height]).toEqual([5496, 3672])
    expect([frame.width, frame.height]).toEqual([asset.width, asset.height])
    expect(asset.byteLength).toBe(asset.width * asset.height * 16)
    expect(asset.width * asset.height).toBeGreaterThan(20_000_000)
    const sourceIdentity = sourceAgreementIdentity({
      originalSha256: expectedOriginalHash,
      options,
      asset,
    })
    await sourceAgreementJson(join(root, 'source.json'), {
      original,
      originalSha256: expectedOriginalHash,
      input,
      options,
      frame,
      sourceIdentity,
    })
    await verifyFullSourceDetail(
      join(root, 'detail'),
      join(prepared, 'linear.f32'),
      asset,
      sourceIdentity,
      cancellation.signal,
    )
  } finally {
    clearTimeout(timer)
    await producer.close(true)
    const codeAfter = await sourceAgreementCodeHashes(resolve('.'))
    await sourceAgreementJson(join(root, 'implementation-after.json'), codeAfter)
    expect(codeAfter).toEqual(codeBefore)
    expect(await sourceAgreementHash(original)).toBe(expectedOriginalHash)
    expect(await sourceAgreementHash(input)).toBe(expectedOriginalHash)
  }
})
