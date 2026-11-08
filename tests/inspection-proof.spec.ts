import { expect, test } from '@playwright/test'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { inspectionContext } from '../src/main/agent/inspection-source'
import { decodeOutputProof } from '../src/main/export/proof-decode'
import { exportGeometry } from '../src/shared/export'
import { interrupted, proofFixture } from './export-proof.helpers'
import { cropAdmission } from './crop-frame.helpers'
import { sha } from './export.helpers'

test('inspection maps photo bounds into decoded enlarged export pixels and preserves native PNG pixels', async () => {
  let jpeg = Buffer.alloc(0)
  const f = await proofFixture({
    render: async (job) => {
      const sourceGeometry = { width: job.source.photo.width!, height: job.source.photo.height! },
        geometry = exportGeometry(sourceGeometry.width, sourceGeometry.height, job.options.size),
        path = join(job.directory, 'output.jpg')
      await mkdir(job.directory, { recursive: true })
      jpeg = await sharp(job.source.path)
        .resize(geometry)
        .withIccProfile('srgb')
        .jpeg({ quality: job.options.quality, chromaSubsampling: '4:4:4' })
        .toBuffer()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, jpeg)
      return { path, geometry, sourceGeometry, sha256: sha(jpeg) }
    },
  })
  try {
    const request = f.request(),
      lease = f.library.exports.acquireProofSource(request.preparationId, request.photoId)
    const context = inspectionContext(lease.source, { width: 17, height: 11 })
    lease.release()
    request.options.size = { mode: 'longest', edge: 34, allowEnlargement: true, method: 'lanczos3' }
    request.options.quality = 47
    const result = await f.proofs.inspect(request, {
      region: {
        units: 'pixels',
        gridIdentity: context.gridIdentity,
        x: 2,
        y: 3,
        width: 5,
        height: 4,
      },
      resolutionPercent: 100,
      encoding: { format: 'png' },
    })
    expect(result.export).toMatchObject({ width: 34, height: 22, quality: 47 })
    expect(result.members[0]).toMatchObject({
      label: 'after',
      width: 10,
      height: 8,
      native: 'export-native',
      mimeType: 'image/png',
      photoBounds: { x: 2, y: 3, width: 5, height: 4 },
      bounds: { x: 4, y: 6, width: 10, height: 8 },
      encoding: { format: 'png', lossless: true },
      requestedRendition: 'sdr',
      effectiveRendition: 'sdr',
      sourceDynamicRange: 'sdr',
    })
    const actual = await sharp(Buffer.from(result.members[0].data, 'base64'))
        .removeAlpha()
        .raw()
        .toBuffer(),
      expected = await sharp(jpeg)
        .extract({ left: 4, top: 6, width: 10, height: 8 })
        .removeAlpha()
        .raw()
        .toBuffer()
    expect(actual.equals(expected)).toBe(true)
    expect(f.proofs.bytes).toBe(0)
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
    expect(f.library.exports.leased([request.photoId])).toBe(false)
  } finally {
    await f.close()
  }
})

test('matched output members encode complete JPEGs sequentially and coexist with a displayed proof', async () => {
  const seen: { exposure: number; quality: number; sharpening: unknown; scratch: number }[] = []
  const f: Awaited<ReturnType<typeof proofFixture>> = await proofFixture({
    render: async (job) => {
      seen.push({
        exposure: job.source.processing.adjustments?.exposureEv ?? 0,
        quality: job.options.quality,
        sharpening: job.options.outputSharpening,
        scratch: (await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).length,
      })
      const path = join(job.directory, 'output.jpg'),
        geometry = { width: 17, height: 11 }
      await sharp(job.source.path).jpeg({ quality: job.options.quality }).toFile(path)
      return { path, geometry, sourceGeometry: geometry, sha256: sha(await readFile(path)) }
    },
  })
  try {
    const dialog = await f.proofs.request('dialog', f.request(f.photos[1].id))
    await f.library.updateEdits(f.photos[0].id, { exposureEv: 1 }, 0)
    const preparation = await f.library.prepareExport([f.photos[0].id]),
      request = { ...f.request(), preparationId: preparation.id }
    request.options.quality = 39
    request.options.outputSharpening = 'standard'
    const result = await f.proofs.inspect(request, {
      comparison: 'pair',
      resolutionPercent: 100,
      encoding: { format: 'jpeg', quality: 71 },
    })
    expect(result.members.map((m) => m.label)).toEqual(['before', 'after'])
    expect(result.members.map((m) => m.encoding)).toEqual([
      { format: 'jpeg', quality: 71, lossless: false },
      { format: 'jpeg', quality: 71, lossless: false },
    ])
    expect(result.members[0].comparison).toBe('neutral rendition derived from current revision')
    expect(result.members[0].revision).toBe(result.members[1].revision)
    expect(seen.slice(1)).toEqual([
      { exposure: 0, quality: 39, sharpening: 'standard', scratch: 2 },
      { exposure: 1, quality: 39, sharpening: 'standard', scratch: 2 },
    ])
    const displayed = f.proofs.acquire(new URL(dialog.primary.url))!
    expect(displayed).toBeDefined()
    displayed.release()
    expect((await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).length).toBe(1)
    await f.proofs.release('dialog', dialog.id)
  } finally {
    await f.close()
  }
})

test('HDR requests refuse before rendering and stale grids never silently become whole images', async () => {
  let calls = 0
  const f = await proofFixture({
    render: async () => {
      calls++
      throw new Error('unexpected render')
    },
  })
  try {
    await expect(f.proofs.inspect(f.request(), { hdr: true })).rejects.toThrow(
      'no client/version/model/transport combination is qualified',
    )
    expect(calls).toBe(0)
    await expect(f.proofs.inspect(f.request(), { resolutionPercent: 0 })).rejects.toThrow(
      'resolutionPercent',
    )
    expect(calls).toBe(0)
  } finally {
    await f.close()
  }
  const normal = await proofFixture()
  try {
    await expect(
      normal.proofs.inspect(normal.request(), {
        region: { units: 'pixels', gridIdentity: 'stale-grid', x: 0, y: 0, width: 2, height: 2 },
      }),
    ).rejects.toThrow('inspection grid changed')
    expect(normal.library.exports.leased(normal.photos.map((p) => p.id))).toBe(false)
    expect(await readdir(join(normal.root, 'library', 'cache', 'output-proofs'))).toEqual([])
  } finally {
    await normal.close()
  }
})

test('transfer JPEG quality is independent from the complete export JPEG quality', async () => {
  const f = await proofFixture()
  try {
    const directory = join(f.root, 'transfer')
    await mkdir(directory)
    const input = join(directory, 'complete.jpg')
    await sharp(join(f.root, 'library', 'originals', f.photos[0].id, 'original.png'))
      .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
      .toFile(input)
    const decoded = await decodeOutputProof(input, directory, {
      width: 17,
      height: 11,
      hdr: false,
      admission: cropAdmission(),
      inspection: {
        bounds: { x: 1, y: 2, width: 9, height: 6 },
        width: 9,
        height: 6,
        encoding: { format: 'jpeg', quality: 13 },
      },
    })
    const expected = await sharp(input).ensureAlpha().raw().toBuffer()
    const transfer = await sharp(expected, { raw: { width: 17, height: 11, channels: 4 } })
      .extract({ left: 1, top: 2, width: 9, height: 6 })
      .removeAlpha()
      .withIccProfile('srgb')
      .jpeg({ quality: 13, chromaSubsampling: '4:4:4' })
      .toBuffer()
    expect((await readFile(join(directory, 'inspection.jpg'))).equals(transfer)).toBe(true)
    expect(decoded.inspection?.byteLength).toBe(transfer.byteLength)
  } finally {
    await f.close()
  }
})

test('a pair is withheld when the revision changes during its second complete decode', async () => {
  let count = 0,
    finish: (() => void) | undefined
  const f = await proofFixture({
    decode: async (path, directory, job) => {
      const decoded = await decodeOutputProof(path, directory, job)
      if (++count === 2)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return decoded
    },
  })
  try {
    const request = f.request(),
      work = f.proofs.inspect(request, {
        comparison: 'pair',
        resolutionPercent: 100,
        encoding: { format: 'png' },
      })
    void work.catch(() => {})
    await expect.poll(() => !!finish).toBe(true)
    await f.library.updateEdits(request.photoId, { exposureEv: 1 }, 0)
    finish!()
    await expect(work).rejects.toThrow('edits changed')
    expect(f.proofs.bytes).toBe(0)
    expect(f.library.exports.leased([request.photoId])).toBe(false)
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
  } finally {
    finish?.()
    await f.close()
  }
})

test('cancelling the second pair member releases frozen sources, decoded assets and scratch', async () => {
  let count = 0
  const f = await proofFixture({
    decode: async (path, directory, job, signal) => {
      if (++count === 2) return interrupted(signal)
      return decodeOutputProof(path, directory, job)
    },
  })
  try {
    const controller = new AbortController(),
      request = f.request(),
      work = f.proofs.inspect(
        request,
        {
          comparison: 'pair',
          resolutionPercent: 100,
          encoding: { format: 'png' },
        },
        controller.signal,
      )
    void work.catch(() => {})
    await expect.poll(() => count).toBe(2)
    controller.abort(new Error('Stopped inspection.'))
    await expect(work).rejects.toThrow('Stopped inspection')
    expect(f.proofs.bytes).toBe(0)
    expect(f.library.exports.leased([request.photoId])).toBe(false)
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
  } finally {
    await f.close()
  }
})

test('extended PNG payload overflow refuses the requested image without reducing dimensions', async () => {
  const { encodeInspectionTransfer } = await import('../src/main/export/inspection-transfer'),
    f = await proofFixture()
  try {
    const directory = join(f.root, 'oversized-transfer')
    await mkdir(directory)
    const width = 1800,
      height = 1800,
      pixels = Buffer.alloc(width * height * 4)
    let seed = 991
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        pixels[i + c] = seed >>> 24
      }
      pixels[i + 3] = 255
    }
    await expect(
      encodeInspectionTransfer(
        pixels,
        { width, height },
        {
          bounds: { x: 0, y: 0, width, height },
          width,
          height,
          encoding: { format: 'png' },
        },
        directory,
        cropAdmission(),
      ),
    ).rejects.toThrow('8 MiB image payload limit')
    expect(await readdir(directory)).toEqual([])
  } finally {
    await f.close()
  }
})
