import { expect, test } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  hashImportSource,
  importSourceKey,
  inspectImportSource,
} from '../src/main/import-source-records'
import {
  cameraCommit,
  cameraReview,
  cameraSetup,
  cameraSource,
  gate,
} from './camera-import.helpers'

test('Fast persists across restart, reinsertion, reader and mount changes with no content work', async () => {
  const t = await cameraSetup()
  try {
    const path = join(t.card, 'PHOTO.ARW')
    await writeFile(path, 'camera original')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path], source))
    await t.restart()
    const moved = join(t.root, 'reinserted')
    await rename(t.card, moved)
    const fresh = await cameraSource(moved)
    fresh.deviceId = 'other-reader'
    fresh.roots[0].identity = 'other-mount'
    fresh.roots[0].filesystemIdentity += '-reinserted'
    const id = await cameraReview(t.library, [moved], fresh)
    expect(t.library.review(id)).toMatchObject({
      verificationMode: 'camera-fast',
      alreadyImported: 1,
      selected: 0,
    })
    t.library.requestReviewThumbnails(
      id,
      t.library.review(id).candidates.map((c) => c.id),
    )
    const added = join(moved, 'new.jpg')
    await writeFile(added, 'new photograph')
    const next = await cameraReview(t.library, [moved], fresh)
    expect(await cameraCommit(t.library, next)).toMatchObject({
      items: { total: 1 },
      transfer: { copied: 1 },
      outcomes: { imported: 1 },
    })
    expect(t.reads).toMatchObject({
      cardSampleBytes: 0,
      managedSampleBytes: 0,
      hashes: 0,
      copies: [path, added],
      thumbnails: [],
    })
    expect(await readdir(moved)).toEqual(['PHOTO.ARW', 'new.jpg'])
  } finally {
    await t.close()
  }
})

test('Fast accepts the same-size preserved-timestamp tradeoff and Full detects unsampled edits', async () => {
  const t = await cameraSetup({
    inspect: async (path) => {
      const inspection = await inspectImportSource(path)
      return {
        ...inspection,
        witness: { ...inspection.witness, mtimeNs: '1000000000', birthtimeNs: '0' },
      }
    },
  })
  try {
    const path = join(t.card, 'image.jpg'),
      bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    await writeFile(path, bytes)
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path], source))
    const old = await stat(path)
    bytes[bytes.length / 2] ^= 0xff
    await writeFile(path, bytes)
    await utimes(path, old.atime, old.mtime)
    const fast = await cameraReview(t.library, [path], source)
    expect(t.library.review(fast)).toMatchObject({ alreadyImported: 1, selected: 0 })
    expect(t.reads.hashes).toBe(0)
    t.library.setImportVerificationMode(fast, 'full')
    expect(t.library.review(fast)).toMatchObject({ verificationPending: true, alreadyImported: 0 })
    expect(() => t.library.importSelected(fast)).toThrow()
    await expect.poll(() => t.library.review(fast).verificationPending).toBe(false)
    expect(t.library.review(fast)).toMatchObject({ alreadyImported: 0, selected: 1 })
    await cameraCommit(t.library, fast)
    expect(t.library.list().total).toBe(2)
    expect(t.reads.hashes).toBe(1)
    expect(
      await readFile(
        join(
          t.root,
          'library',
          'originals',
          createHash('sha256').update(bytes).digest('hex'),
          'original.jpg',
        ),
      ),
    ).toEqual(bytes)
  } finally {
    await t.close()
  }
})

test('changed metadata bypasses sample rescue and reused filenames enter normal hashing', async () => {
  const t = await cameraSetup()
  try {
    const path = join(t.card, 'image.jpg')
    await writeFile(path, 'camera bytes')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path], source))
    await utimes(path, new Date('2020-01-01'), new Date('2020-01-01'))
    let id = await cameraReview(t.library, [path], source)
    expect(t.library.review(id)).toMatchObject({ alreadyImported: 0, selected: 1 })
    expect(await cameraCommit(t.library, id)).toMatchObject({
      outcomes: { duplicates: 1 },
      transfer: { copied: 1 },
    })
    await writeFile(path, 'reused filename')
    id = await cameraReview(t.library, [path], source)
    expect(t.library.review(id).selected).toBe(1)
    await cameraCommit(t.library, id)
    expect(t.reads.cardSampleBytes).toBe(0)
    expect(t.library.list().total).toBe(2)
  } finally {
    await t.close()
  }
})

test('legacy file imports bootstrap within bounded bytes and sample proof survives restart', async () => {
  const t = await cameraSetup()
  try {
    const path = join(t.card, 'image.jpg')
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 5))
    await cameraCommit(t.library, await cameraReview(t.library, [path]))
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    db.exec(
      'DROP TRIGGER remove_camera_imports; DROP TABLE camera_imports; DROP TABLE camera_samples; DROP INDEX camera_original_candidates; PRAGMA user_version = 13',
    )
    db.close()
    await t.restart()
    const source = await cameraSource(t.card)
    const id = await cameraReview(t.library, [path], source)
    expect(t.library.review(id)).toMatchObject({ alreadyImported: 1, selected: 0 })
    expect(t.reads).toMatchObject({
      cardSampleBytes: 262144,
      managedSampleBytes: 262144,
      hashes: 0,
      copies: [path],
    })
    const check = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 17 })
    expect(check.prepare('SELECT proof FROM camera_imports').get()).toEqual({ proof: 'sample' })
    check.close()
    await t.restart()
    const repeat = await cameraReview(t.library, [path], source)
    expect(t.library.review(repeat).alreadyImported).toBe(1)
    expect(t.reads.cardSampleBytes).toBe(262144)
    t.library.setImportVerificationMode(repeat, 'full')
    await expect.poll(() => t.library.review(repeat).verificationPending).toBe(false)
    expect(t.reads.hashes).toBe(1)
    const verified = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    expect(verified.prepare('SELECT proof FROM camera_imports').get()).toEqual({ proof: 'full' })
    verified.close()
  } finally {
    await t.close()
  }
})

for (const poolSize of [8, 9])
  test(`bootstrap bounds a pool of ${poolSize} distinct originals`, async () => {
    const t = await cameraSetup()
    try {
      const paths: string[] = []
      for (let index = 0; index < poolSize; index++) {
        const folder = join(t.root, `legacy-${index}`)
        await mkdir(folder)
        const path = join(folder, 'image.jpg')
        paths.push(path)
        await writeFile(path, Buffer.alloc(1024 * 1024, index))
      }
      await cameraCommit(t.library, await cameraReview(t.library, paths))
      const cardPath = join(t.card, 'image.jpg')
      await copyFile(paths[0], cardPath)
      const source = await cameraSource(t.card)
      // Version 13 provenance must not bypass the pool limit or sample uniqueness.
      const legacy = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
      legacy.prepare('INSERT INTO source_imports VALUES (?, ?, ?)').run(
        importSourceKey(source, cardPath)!,
        createHash('sha256')
          .update(Buffer.alloc(1024 * 1024))
          .digest('hex'),
        JSON.stringify((await inspectImportSource(cardPath)).witness),
      )
      legacy.close()
      const id = await cameraReview(t.library, [cardPath], source)
      expect(t.reads.cardSampleBytes).toBe(poolSize === 8 ? 262144 : 0)
      expect(t.reads.managedSampleBytes).toBe(poolSize === 8 ? 2 * 1024 * 1024 : 0)
      expect(t.library.review(id).alreadyImported).toBe(poolSize === 8 ? 1 : 0)
    } finally {
      await t.close()
    }
  })

test('multiple sample matches leave candidates eligible and missing identity samples each review', async () => {
  const t = await cameraSetup()
  try {
    const original = join(t.root, 'original')
    await mkdir(original)
    const path = join(original, 'image.jpg'),
      bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    await writeFile(path, bytes)
    await cameraCommit(t.library, await cameraReview(t.library, [path]))
    const cardPath = join(t.card, 'image.jpg')
    await copyFile(path, cardPath)
    const source = await cameraSource(t.card, false)
    for (let index = 1; index <= 2; index++) {
      const id = await cameraReview(t.library, [cardPath], source)
      expect(t.library.review(id).alreadyImported).toBe(1)
      expect(t.reads.cardSampleBytes).toBe(index * 262144)
      expect(t.reads.managedSampleBytes).toBe(262144)
      if (index === 2) {
        t.library.setImportVerificationMode(id, 'full')
        await expect.poll(() => t.library.review(id).verificationPending).toBe(false)
        expect(t.library.review(id).alreadyImported).toBe(1)
        expect(t.reads.hashes).toBe(1)
      }
    }
    bytes[bytes.length / 2] ^= 0xff
    await writeFile(path, bytes)
    await cameraCommit(t.library, await cameraReview(t.library, [path]))
    const id = await cameraReview(t.library, [cardPath], source)
    expect(t.library.review(id)).toMatchObject({ alreadyImported: 0, selected: 1 })
  } finally {
    await t.close()
  }
})

test('superseded Full hashes acknowledge promptly, preserve IDs and selection, and cannot publish stale results', async () => {
  const entered = gate(),
    release = gate()
  let delayed = false
  const t = await cameraSetup({
    hash: async (...args) => {
      if (delayed) {
        entered.release()
        await release.promise
      }
      return hashImportSource(...args)
    },
  })
  try {
    const known = join(t.card, 'known.jpg'),
      added = join(t.card, 'new.jpg')
    await writeFile(known, 'known photo')
    await writeFile(added, 'new photo')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [known], source))
    const id = await cameraReview(t.library, [known, added], source)
    const ids = t.library.review(id).candidates.map((c) => c.id)
    const newId = t.library.review(id).candidates.find((c) => c.filename === 'new.jpg')!.id
    t.library.select(id, [newId], false)
    delayed = true
    t.library.setImportVerificationMode(id, 'full')
    await entered.promise
    expect(t.library.review(id)).toMatchObject({
      verificationPending: true,
      alreadyImported: 0,
      selected: 1,
    })
    expect(() => t.library.importSelected(id)).toThrow()
    t.library.setImportVerificationMode(id, 'camera-fast')
    release.release()
    await expect.poll(() => t.library.review(id).verificationPending).toBe(false)
    expect(t.library.review(id)).toMatchObject({
      verificationMode: 'camera-fast',
      alreadyImported: 1,
      selected: 0,
    })
    expect(t.library.review(id).candidates.map((c) => c.id)).toEqual(ids)
    expect(t.library.listTasks().some((task) => task.id === id)).toBe(false)
  } finally {
    release.release()
    await t.close()
  }
})

test('Full rehashes before acceptance; Fast revalidates metadata without reading known contents', async () => {
  const t = await cameraSetup()
  try {
    const path = join(t.card, 'known.jpg'),
      added = join(t.card, 'new.jpg')
    await writeFile(path, 'known photo')
    await writeFile(added, 'new photo')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path], source))
    const id = await cameraReview(t.library, [path, added], source, 'full')
    expect(t.reads.hashes).toBe(1)
    await cameraCommit(t.library, id)
    expect(t.reads.hashes).toBe(2)
    const nextPath = join(t.card, 'next.jpg')
    await writeFile(nextPath, 'next photo')
    const next = await cameraReview(t.library, [path, nextPath], source)
    await writeFile(path, 'known changed photo')
    await expect(Promise.resolve().then(() => t.library.importSelected(next))).rejects.toThrow(
      'changed',
    )
    expect(t.library.listTasks().some((task) => task.id === next)).toBe(false)
    expect(t.reads.hashes).toBe(2)
  } finally {
    await t.close()
  }
})

test('failed Trash preserves Fast bindings and successful deletion clears bindings and cached samples', async () => {
  let allowTrash = false
  let root = ''
  const t = await cameraSetup({
    trash: async (path) => {
      if (!allowTrash) throw new Error('Fixture Trash unavailable')
      await rename(path, join(root, 'trash', basename(path)))
    },
  })
  root = t.root
  try {
    const path = join(t.card, 'image.jpg')
    await writeFile(path, 'original')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path]))
    expect(t.library.review(await cameraReview(t.library, [path], source)).alreadyImported).toBe(1)
    const photo = t.library.list().photos[0]
    let deletion = t.library.deletePhotos([photo.id])!
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === deletion)?.status)
      .toBe('failed')
    expect(t.library.review(await cameraReview(t.library, [path], source)).alreadyImported).toBe(1)
    allowTrash = true
    deletion = t.library.deletePhotos([photo.id])!
    await expect
      .poll(() => t.library.listTasks().find((task) => task.id === deletion)?.status)
      .toBe('completed')
    const [restored] = await readdir(join(t.root, 'trash'))
    await rename(join(t.root, 'trash', restored), join(t.root, 'library', 'removed', restored))
    await t.restart()
    const next = await cameraReview(t.library, [path], source)
    expect(t.library.review(next)).toMatchObject({ alreadyImported: 0, selected: 1 })
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    expect(db.prepare('SELECT * FROM camera_imports').all()).toEqual([])
    expect(db.prepare('SELECT * FROM camera_samples').all()).toEqual([])
    db.close()
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(
      await readFile(join(t.root, 'library', 'removed', restored, 'original.jpg'), 'utf8'),
    ).toBe('original')
  } finally {
    await t.close()
  }
})

for (const state of ['staged', 'restored', 'trashed'] as const)
  test(`camera bindings follow ${state} removal-journal recovery`, async () => {
    const t = await cameraSetup()
    try {
      const path = join(t.card, 'image.jpg')
      await writeFile(path, 'original')
      const source = await cameraSource(t.card)
      await cameraCommit(t.library, await cameraReview(t.library, [path]))
      await cameraReview(t.library, [path], source)
      const photo = t.library.list().photos[0]
      await t.library.close()
      const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
      const staged = `${photo.id}-${randomUUID()}`
      db.prepare('INSERT INTO removals VALUES (?, ?)').run(photo.id, staged)
      db.close()
      if (state !== 'restored')
        await rename(
          join(t.root, 'library', 'originals', photo.id),
          join(t.root, 'library', 'removed', staged),
        )
      if (state === 'trashed')
        await rename(join(t.root, 'library', 'removed', staged), join(t.root, 'trash', staged))
      await t.restart()
      const id = await cameraReview(t.library, [path], source)
      expect(t.library.review(id).alreadyImported).toBe(state === 'trashed' ? 0 : 1)
      const check = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
      expect(check.prepare('SELECT * FROM removals').all()).toEqual([])
      expect(check.prepare('SELECT * FROM camera_imports').all()).toHaveLength(
        state === 'trashed' ? 0 : 1,
      )
      check.close()
    } finally {
      await t.close()
    }
  })

test('cancelling separate Full verification prevents late mutations and task creation', async () => {
  const entered = gate(),
    release = gate()
  const t = await cameraSetup({
    hash: async (...args) => {
      entered.release()
      await release.promise
      return hashImportSource(...args)
    },
  })
  try {
    const path = join(t.card, 'image.jpg')
    await writeFile(path, 'original')
    const source = await cameraSource(t.card)
    await cameraCommit(t.library, await cameraReview(t.library, [path], source))
    const id = await cameraReview(t.library, [path], source)
    t.library.setImportVerificationMode(id, 'full')
    await entered.promise
    const cancel = t.library.cancel(id)
    release.release()
    await cancel
    expect(t.library.review(id)).toMatchObject({ phase: 'cancelled', alreadyImported: 0 })
    expect(t.library.listTasks().some((task) => task.id === id)).toBe(false)
  } finally {
    release.release()
    await t.close()
  }
})
