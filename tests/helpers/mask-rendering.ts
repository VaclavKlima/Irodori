import { expect, test } from '@playwright/test'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewProcess } from '../../src/main/preview-process'
import { ExportProcess } from '../../src/main/export/process'
import { identity } from '../../src/main/export/files'
import type { ExportSource } from '../../src/main/export/types'
import { neutralAdjustments } from '../../src/shared/adjustments'
import { automaticLensSettings } from '../../src/shared/lens'
import { defaultExportOptions } from '../../src/shared/export'
import { proofFixture } from '../export-proof.helpers'
import { cropAdmission } from '../crop-frame.helpers'
import { sha } from '../export.helpers'

export async function sourceFor(path: string, raw = false): Promise<ExportSource> {
  const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let metadata
  try {
    metadata = await worker.inspect(path, new AbortController().signal)
  } finally {
    await worker.close(true)
  }
  const dimensions = raw ? { width: 5472, height: 3648 } : await sharp(path).metadata()
  const bytes = await readFile(path)
  return {
    path,
    hdr: !!metadata.hdrEligible || metadata.hdrJpeg?.state === 'supported',
    identity: identity(await lstat(path)),
    photo: {
      id: sha(bytes),
      filename: raw ? 'Sony.ARW' : 'Photograph.jpg',
      format: raw ? 'ARW' : 'JPEG',
      width: dimensions.width!,
      height: dimensions.height!,
      bytes: bytes.length,
      importedAt: new Date().toISOString(),
      previewSource: 'decoded',
      previewUrl: '',
      thumbnailUrl: '',
    },
    processing: {
      metadata,
      processing: raw || metadata.hdrJpeg?.state === 'supported' ? 'hdr-v1' : 'display-referred-v1',
      settings: automaticLensSettings,
      revision: 3,
      adjustments: structuredClone(neutralAdjustments),
    },
  }
}

export async function compare(source: ExportSource, root: string) {
  const fixture = await proofFixture({ source, real: true })
  try {
    const options = {
      ...structuredClone(defaultExportOptions),
      output: source.hdr ? ('hdr' as const) : ('sdr' as const),
      quality: 100,
    }
    const proof = await fixture.proofs.request('dialog', { ...fixture.request(), options })
    const lease = fixture.proofs.acquire(new URL(proof.primary.url))!
    let primary
    try {
      primary = await readFile(lease.path)
    } finally {
      lease.release()
    }
    const directory = join(root, crypto.randomUUID())
    await mkdir(directory, { recursive: true })
    const admission = cropAdmission()
    const result = await new ExportProcess(
      resolve('out/main/export-worker.js'),
      resolve('out/main/preview-worker.js'),
    ).render(
      {
        source,
        options,
        hdr: source.hdr,
        directory,
        cropPolicy: proof.pipeline.crop,
        detailPolicy: proof.pipeline.detail,
        resizePolicy: proof.pipeline.resize,
        outputSharpeningPolicy: proof.pipeline.outputSharpening,
        cropAdmission: admission,
        detailAdmission: admission,
        resizeAdmission: admission,
        outputSharpeningAdmission: admission,
      },
      new AbortController().signal,
    )
    expect(result.diagnostics?.renderer).toBe('gpu')
    const decoded = await sharp(result.path)
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(primary.length).toBe(decoded.data.length)
    let maximum = 0
    for (let i = 0; i < primary.length; i++)
      maximum = Math.max(maximum, Math.abs(primary[i] - decoded.data[i]))
    expect(maximum).toBeLessThanOrEqual(2)
    await test.info().attach('mask-proof-export', {
      contentType: 'application/json',
      body: JSON.stringify({
        width: proof.width,
        height: proof.height,
        output: proof.output,
        maximumCodeDifference: maximum,
        adapter: result.diagnostics?.adapter,
      }),
    })
    await fixture.proofs.release('dialog', proof.id)
    return decoded
  } finally {
    await fixture.close()
  }
}
