import { expect, test } from '@playwright/test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeOutputProof } from '../src/main/export/proof-decode'
import { createPreviewAssetStream } from '../src/main/preview-asset-stream'
import { proofFixture, interrupted } from './export-proof.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import sharp from 'sharp'

test('proof leases preserve source/history/preferences, isolate batch targets and drain streams before cleanup', async () => {
  const f = await proofFixture()
  try {
    const prefs = await f.library.getExportPreferences(),
      history = await f.library.getEditHistory(f.photos[1].id)
    const proof = await f.proofs.request('dialog', f.request(f.photos[1].id))
    expect(proof).toMatchObject({
      photoId: f.photos[1].id,
      revision: 0,
      width: 17,
      height: 11,
      quality: 90,
      output: 'sdr',
      resizeMethod: 'original',
    })
    expect(JSON.stringify(proof)).not.toContain(f.root)
    expect(f.library.exports.leased([f.photos[1].id])).toBe(true)
    expect(f.library.exports.leased([f.photos[0].id])).toBe(false)
    expect(() => f.library.deletePhotos([f.photos[1].id])).toThrow('source photographs')
    expect(await f.library.getExportPreferences()).toEqual(prefs)
    expect(await f.library.getEditHistory(f.photos[1].id)).toEqual(history)
    const asset = f.proofs.acquire(new URL(proof.primary.url))!
    expect(asset.byteLength).toBe(17 * 11 * 4)
    expect(
      f.proofs.acquire(new URL(proof.primary.url.replace('primary', 'overview'))),
    ).toBeUndefined()
    await f.proofs.release('other-owner', proof.id)
    const probe = f.proofs.acquire(new URL(proof.primary.url))!
    expect(probe).toBeDefined()
    probe.release()
    asset.release()
    const streaming = f.proofs.acquire(new URL(proof.primary.url))!
    const stream = createPreviewAssetStream(
      streaming,
      0,
      streaming.byteLength - 1,
      new AbortController().signal,
    )
    stream.on('error', () => {})
    await f.proofs.release('dialog', proof.id)
    expect(stream.destroyed).toBe(true)
    expect(f.proofs.acquire(new URL(proof.primary.url))).toBeUndefined()
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
    expect(f.library.exports.leased([proof.photoId])).toBe(false)
  } finally {
    await f.close()
  }
})

test('only the same owner replaces a candidate; Console work waits without cancelling the dialog', async () => {
  const events: string[] = [],
    f = await proofFixture({
      render: async (job, signal) => {
        events.push(job.source.photo.id)
        return interrupted(signal)
      },
    })
  try {
    const first = f.request(),
      p1 = f.proofs.request('dialog', first).catch(String)
    await expect.poll(() => events.length).toBe(1)
    await expect(f.proofs.request('dialog', first)).rejects.toThrow('distinct')
    const consoleRequest = f.request(f.photos[1].id),
      consoleWork = f.proofs.request('console', consoleRequest).catch(String)
    f.proofs.cancel('console', first.token)
    expect(events).toHaveLength(1)
    const replacement = f.request(),
      next = f.proofs.request('dialog', replacement).catch(String)
    expect(await p1).toContain('superseded')
    await expect.poll(() => events.length).toBe(2)
    expect(events[1]).toBe(f.photos[1].id)
    f.proofs.cancel('dialog', consoleRequest.token)
    expect(events).toHaveLength(2)
    f.proofs.cancel('console', consoleRequest.token)
    expect(await consoleWork).toContain('cancelled')
    await expect.poll(() => events.length).toBe(3)
    f.proofs.cancel('dialog', replacement.token)
    expect(await next).toContain('cancelled')
    expect(f.library.exports.leased(f.photos.map((p) => p.id))).toBe(false)
  } finally {
    await f.close()
  }
})

test('preparation expiry and source replacement require reopening Export without retargeting', async () => {
  const f = await proofFixture(),
    now = Date.now
  try {
    Date.now = () => now() + 16 * 60_000
    await expect(f.proofs.request('dialog', f.request())).rejects.toThrow('expired')
    Date.now = now
    await writeFile(
      join(f.root, 'library', 'originals', f.photos[0].id, 'original.png'),
      'changed original',
    )
    await expect(f.proofs.request('dialog', f.request())).rejects.toThrow('source changed')
    expect(f.library.exports.leased(f.photos.map((p) => p.id))).toBe(false)
  } finally {
    Date.now = now
    await f.close()
  }
})

test('one candidate can coexist with a displayed proof; a third retained image is refused', async () => {
  const f = await proofFixture()
  try {
    const a = await f.proofs.request('dialog', f.request()),
      b = await f.proofs.request('console', f.request(f.photos[1].id))
    await expect(f.proofs.request('dialog', f.request())).rejects.toThrow('Release the previous')
    await f.proofs.release('console', b.id)
    const replacement = await f.proofs.request('dialog', f.request())
    expect(replacement.identity).toBe(a.identity)
    await f.proofs.release('dialog', a.id)
    await f.proofs.release('dialog', replacement.id)
    expect(f.library.exports.leased(f.photos.map((p) => p.id))).toBe(false)
  } finally {
    await f.close()
  }
})

test('cancelled proof decoding waits for the actual bundled Node worker exit before removing scratch', async () => {
  let pidPath = '',
    decoder: PreviewProcess | undefined
  const f = await proofFixture({
    decode: async (path, directory, job, signal) => {
      pidPath = join(directory, 'decoder.pid')
      decoder = new PreviewProcess(join(f.root, 'decoder-lifecycle.mjs'))
      try {
        return await decoder.decodeOutputProof(path, directory, job, signal)
      } finally {
        await decoder.close(true)
      }
    },
  })
  try {
    await writeFile(
      join(f.root, 'decoder-lifecycle.mjs'),
      `
      import { writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      process.on('message', async (job) => {
        if (job.type === 'close') return
        await writeFile(join(job.output, 'decoder.pid'), String(process.pid))
      })
    `,
    )
    const request = f.request(),
      work = f.proofs.request('dialog', request)
    void work.catch(() => {})
    await expect
      .poll(async () => (pidPath ? readFile(pidPath, 'utf8').catch(() => '') : ''))
      .toMatch(/^\d+$/)
    const pid = Number(await readFile(pidPath, 'utf8'))
    process.kill(pid, 0)
    f.proofs.cancel('dialog', request.token)
    await expect(work).rejects.toThrow('cancelled')
    expect(() => process.kill(pid, 0)).toThrow()
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
    expect(f.library.exports.leased([request.photoId])).toBe(false)
  } finally {
    await decoder?.close(true)
    await f.close()
  }
})

test('a noisy overview meets the Console payload limit while the decoded proof retains its full dimensions', async () => {
  const f = await proofFixture()
  try {
    const directory = join(f.root, 'noisy-overview')
    await mkdir(directory)
    const pixels = Buffer.alloc(1024 * 1024 * 3)
    let seed = 719
    for (let i = 0; i < pixels.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      pixels[i] = seed >>> 24
    }
    const path = join(directory, 'input.jpg')
    await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
      .withIccProfile('srgb')
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toFile(path)
    const { cropAdmission } = await import('./crop-frame.helpers')
    const result = await decodeOutputProof(path, directory, {
      width: 1024,
      height: 1024,
      hdr: false,
      admission: cropAdmission(),
    })
    expect(result).toMatchObject({ width: 1024, height: 1024, byteLength: 1024 * 1024 * 4 })
    expect(result.overview.byteLength).toBeLessThanOrEqual(1024 ** 2)
    expect(result.overview.width).toBeLessThan(1024)
    expect((await readFile(join(directory, 'primary.rgba'))).length).toBe(1024 * 1024 * 4)
  } finally {
    await f.close()
  }
})

test('decoded stale completions and changed/expired preparations are refused and clean all scratch', async () => {
  let finish: (() => void) | undefined
  const f = await proofFixture({
    decode: async (path, directory, job) => {
      const decoded = await decodeOutputProof(path, directory, job)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return decoded
    },
  })
  try {
    const request = f.request(),
      pending = f.proofs.request('dialog', request)
    void pending.catch(() => {})
    await expect.poll(() => !!finish).toBe(true)
    await f.library.updateEdits(request.photoId, { exposureEv: 1 }, 0)
    finish!()
    await expect(pending).rejects.toThrow('edits changed')
    await expect(f.proofs.request('dialog', f.request())).rejects.toThrow('edits changed')
    const other = await f.library.prepareExport([f.photos[1].id])
    f.library.exports.dispose(other.id)
    await expect(
      f.proofs.request('dialog', { ...f.request(f.photos[1].id), preparationId: other.id }),
    ).rejects.toThrow('export preparation')
    expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
  } finally {
    finish?.()
    await f.close()
  }
})

test('decode cancellation, damaged pixels and managed resource refusal release sources and storage', async () => {
  for (const mode of ['decode-cancel', 'damaged', 'budget'] as const) {
    let decoding = false
    const f = await proofFixture({
      admission:
        mode === 'budget'
          ? async () => {
              const { cropAdmission } = await import('./crop-frame.helpers')
              const admission = cropAdmission()
              Object.assign(admission.policy.ram, { effectiveBytes: 1 })
              return admission
            }
          : undefined,
      decode: async (path, directory, job, signal) => {
        decoding = true
        if (mode === 'decode-cancel') return interrupted(signal)
        const result = await decodeOutputProof(path, directory, job)
        await writeFile(join(directory, 'primary.rgba'), Buffer.alloc(result.byteLength))
        return result
      },
    })
    try {
      const request = f.request(),
        work = f.proofs.request('dialog', request)
      void work.catch(() => {})
      if (mode === 'decode-cancel') {
        await expect.poll(() => decoding).toBe(true)
        f.proofs.cancel('dialog', request.token)
      }
      await expect(work).rejects.toThrow(
        mode === 'damaged' ? 'damaged' : mode === 'budget' ? 'budgets' : 'cancelled',
      )
      expect(f.library.exports.leased([request.photoId])).toBe(false)
      expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
    } finally {
      await f.close()
    }
  }
})

test('Console overviews release full assets and interrupted scratch is removed on startup', async () => {
  const f = await proofFixture()
  try {
    const overview = await f.proofs.overview(f.request())
    expect(overview).toMatchObject({
      width: 17,
      height: 11,
      overview: { width: 17, height: 11, mimeType: 'image/jpeg' },
    })
    expect(overview.overview.rendition).toContain('overview')
    expect(Buffer.from(overview.data, 'base64').length).toBeLessThanOrEqual(1024 ** 2)
    expect(JSON.stringify(overview)).not.toContain('irodori-photo:')
    expect(f.proofs.bytes).toBe(0)
    expect(f.library.exports.leased([f.photos[0].id])).toBe(false)
    const scratch = join(f.root, 'library', 'cache', 'output-proofs', 'interrupted-owned')
    await mkdir(scratch, { recursive: true })
    await writeFile(join(scratch, 'output.jpg'), 'interrupted')
    await f.library.close()
    const { PhotoLibrary } = await import('./photo-library.helpers')
    const reopened = new PhotoLibrary(
      join(f.root, 'library'),
      {
        process: async () => {
          throw new Error('Unexpected import')
        },
        close: async () => {},
      },
      () => {},
    )
    try {
      await reopened.open()
      await expect(readdir(scratch)).rejects.toThrow()
    } finally {
      await reopened.close()
    }
  } finally {
    await f.close()
  }
})
