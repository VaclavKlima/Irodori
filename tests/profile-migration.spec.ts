import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateProfile } from '../scripts/migrate-profile.mjs'

test('offline profile migration preserves original bytes, inodes and history while updating owned references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-profile-migration-')),
    from = join(root, 'PreviousEditor'),
    to = join(root, 'Irodori'),
    evidence = join(root, 'evidence'),
    photo = join(from, 'library', 'originals', 'fixture', 'original.png'),
    bytes = Buffer.from([0, 1, 2, 127, 255]),
    history = JSON.stringify({ revision: 9, snapshots: [{ exposureEv: 1.5 }], cursor: 0 })
  await mkdir(join(photo, '..'), { recursive: true })
  await mkdir(join(from, 'library', 'cache'))
  await writeFile(photo, bytes)
  await writeFile(join(from, 'library', 'cache', 'retained-proof'), 'cached evidence')
  const before = await stat(photo),
    db = new DatabaseSync(join(from, 'library', 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos(id TEXT PRIMARY KEY, photo TEXT); CREATE TABLE edits(id TEXT PRIMARY KEY, data TEXT)',
  )
  db.prepare('INSERT INTO photos VALUES (?, ?)').run(
    'original',
    JSON.stringify({
      filename: 'previouseditor-portrait.png',
      assetKind: 'original',
      previewUrl: 'previouseditor-photo://library/original/preview',
      thumbnailUrl: 'previouseditor-photo://library/original/thumb',
      artist: 'PreviousEditor Museum',
    }),
  )
  db.prepare('INSERT INTO photos VALUES (?, ?)').run(
    'derived',
    JSON.stringify({
      filename: 'Portrait-HDR.previouseditor',
      assetKind: 'derived',
      format: 'PREVIOUSEDITOR HDR',
      previewUrl: 'previouseditor-photo://library/derived/preview',
    }),
  )
  db.prepare('INSERT INTO edits VALUES (?, ?)').run('original', history)
  db.close()
  try {
    const report = await migrateProfile(from, to, evidence)
    expect(report.complete).toBe(true)
    const moved = join(to, 'library', 'originals', 'fixture', 'original.png')
    expect(await readFile(moved)).toEqual(bytes)
    expect((await stat(moved)).ino).toBe(before.ino)
    expect(report.originals).toHaveLength(1)
    expect(
      await readFile(
        join(evidence, 'retired-caches', 'library', 'cache', 'retained-proof'),
        'utf8',
      ),
    ).toBe('cached evidence')
    const reopened = new DatabaseSync(join(to, 'library', 'catalog.sqlite'))
    try {
      expect(reopened.prepare('SELECT data FROM edits').get()!.data).toBe(history)
      const photos = reopened
        .prepare('SELECT photo FROM photos ORDER BY id')
        .all()
        .map((row) => JSON.parse(row.photo as string))
      expect(photos[0]).toMatchObject({
        filename: 'Portrait-HDR.irodori',
        format: 'IRODORI HDR',
        previewUrl: 'irodori-photo://library/derived/preview',
      })
      expect(photos[1]).toMatchObject({
        filename: 'previouseditor-portrait.png',
        artist: 'PreviousEditor Museum',
        previewUrl: 'irodori-photo://library/original/preview',
      })
    } finally {
      reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const blocked of ['existing destination', 'active profile'] as const)
  test(`profile migration preserves data when blocked by ${blocked}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-profile-refusal-')),
      from = join(root, 'PreviousEditor'),
      to = join(root, 'Irodori')
    await mkdir(from)
    await writeFile(join(from, 'retained'), 'preserve')
    if (blocked === 'existing destination') await mkdir(to)
    else await writeFile(join(from, 'SingletonLock'), 'running')
    try {
      await expect(migrateProfile(from, to, join(root, 'evidence'))).rejects.toThrow(
        blocked === 'existing destination' ? 'already exists' : 'Close the application',
      )
      expect(await readFile(join(from, 'retained'), 'utf8')).toBe('preserve')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
