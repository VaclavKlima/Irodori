import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { commit, scan, setup } from './library.helpers'

test('existing RAW imports load processing metadata lazily and persist independent settings', async () => {
  const t = await setup()
  try {
    const session = await scan(t.service, [resolve('tests/fixtures/sony-zv1.ARW')])
    await commit(t.service, session)
    const id = t.service.list().photos[0].id
    // Model a pre-correction catalog row without reimporting or touching its original.
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    db.prepare('DELETE FROM processing WHERE id = ?').run(id)
    db.close()
    const [a, b] = await Promise.all([t.service.getLensSettings(id), t.service.getLensSettings(id)])
    expect(a).toEqual(b)
    expect(a.profile.distortion?.values).toHaveLength(11)
    expect(a.profile.vignetting?.values).toHaveLength(16)
    expect(a.revision).toBe(0)
    await Promise.all([
      t.service.updateLensSettings(id, 'distortion', false),
      t.service.updateLensSettings(id, 'vignetting', false),
    ])
    expect(await t.service.getLensSettings(id)).toMatchObject({
      revision: 2,
      settings: { distortion: false, vignetting: false, chromaticAberration: true },
    })
    const staleDb = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    const stale = JSON.parse(
      (staleDb.prepare('SELECT data FROM processing WHERE id = ?').get(id) as { data: string })
        .data,
    )
    stale.metadata.version = 0
    staleDb.prepare('UPDATE processing SET data = ? WHERE id = ?').run(JSON.stringify(stale), id)
    staleDb.close()
    expect(await t.service.getLensSettings(id)).toMatchObject({
      revision: 2,
      settings: { distortion: false, vignetting: false, chromaticAberration: true },
    })
    await expect(t.service.getLensSettings('../outside')).rejects.toThrow('unavailable')
    await expect(
      t.service.updateLensSettings(id, 'distortion', 'yes' as unknown as boolean),
    ).rejects.toThrow('Invalid')
    expect(await readFile(join(t.root, 'library', 'originals', id, 'original.arw'))).toEqual(
      await readFile('tests/fixtures/sony-zv1.ARW'),
    )
  } finally {
    await t.close()
  }
})

test('decodes the real Sony ZV-1 RAW when embedded preview extraction fails', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'irodori-raw-'))
  const engine = new PreviewEngine(async () => {
    throw new Error('Embedded preview unavailable')
  })
  try {
    const input = resolve('tests/fixtures/sony-zv1.ARW')
    const before = createHash('sha256')
      .update(await readFile(input))
      .digest('hex')
    const result = await engine.process(input, root)
    expect(result.source).toBe('decoded')
    expect(result.metadata.camera).toBe('ZV-1')
    expect(result.metadata.width).toBeGreaterThan(5000)
    expect(result.metadata.height).toBeGreaterThan(3000)
    const preview = await sharp(join(root, 'preview.jpg')).metadata()
    expect(preview.width).toBe(2560)
    const stats = await sharp(join(root, 'preview.jpg')).stats()
    expect(stats.channels.some((channel) => channel.stdev > 10)).toBe(true)
    expect(
      createHash('sha256')
        .update(await readFile(input))
        .digest('hex'),
    ).toBe(before)
  } finally {
    await engine.close()
    await rm(root, { recursive: true, force: true })
  }
})
