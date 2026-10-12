import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DeviceSource } from '../src/main/import-devices'
import {
  importSourceKey,
  hashImportSource,
  ImportSourceRecords,
  inspectImportSource,
  reliableImportChangeToken,
  sameImportSourceWitness,
  type ImportSourceWitness,
} from '../src/main/import-source-records'

const originalId = 'a'.repeat(64)
const otherId = 'b'.repeat(64)
const key = 'c'.repeat(64)
const witness: ImportSourceWitness = {
  dev: '42',
  ino: '9007199254740995',
  size: '64',
  mtimeNs: '1700000000000000001',
  ctimeNs: '1700000000000000002',
  birthtimeNs: '1700000000000000000',
}

function database(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, photo TEXT NOT NULL); CREATE TABLE IF NOT EXISTS removals (id TEXT PRIMARY KEY, staged TEXT NOT NULL); BEGIN IMMEDIATE;',
  )
  const records = new ImportSourceRecords(db)
  records.initialize()
  db.exec('COMMIT')
  return { db, records }
}

function photo(db: DatabaseSync, id: string, assetKind?: 'original' | 'derived') {
  db.prepare('INSERT INTO photos (id, photo) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, assetKind }),
  )
}

test('only verified local Linux change-token filesystems permit metadata reuse', () => {
  for (const type of [0xef53n, 0x58465342n, 0x9123683en, 0x1021994n, 0xf2f52010n, 0x794c7630n]) {
    expect(reliableImportChangeToken(type, 'linux')).toBe(true)
    expect(reliableImportChangeToken(Number(type), 'linux')).toBe(true)
    expect(reliableImportChangeToken(type, 'win32')).toBe(false)
    expect(reliableImportChangeToken(type, 'darwin')).toBe(false)
  }
  for (const type of [0x4d44n, 0x2011bab0n, 0x6969n, 0xff534d42n, 0x5346544en, 0n, 123n])
    expect(reliableImportChangeToken(type, 'linux')).toBe(false)
  for (const type of [NaN, Infinity, 0.5])
    expect(reliableImportChangeToken(type, 'linux')).toBe(false)
})

test('opaque source keys distinguish volume, root replacement, relative paths and nested mounts', () => {
  const source: DeviceSource = {
    deviceId: 'mounted-device',
    displayName: 'Card',
    roots: [
      {
        path: '/media/card',
        identity: 'volume-token',
        filesystemDevice: '42',
        filesystemIdentity: '42:1',
        nestedMounts: ['/media/card/mounted'],
      },
    ],
  }
  const path = '/media/card/DCIM/100SONY/photo.ARW'
  const initial = importSourceKey(source, path)
  expect(initial).toMatch(/^[a-f0-9]{64}$/)
  expect(importSourceKey(structuredClone(source), path)).toBe(initial)
  expect(importSourceKey(source, '/media/card/DCIM/101SONY/photo.ARW')).not.toBe(initial)
  for (const field of ['identity', 'filesystemDevice', 'filesystemIdentity'] as const) {
    const changed = structuredClone(source)
    changed.roots[0][field] += '-changed'
    expect(importSourceKey(changed, path)).not.toBe(initial)
  }
  expect(importSourceKey({ ...source, deviceId: 'other-device' }, path)).not.toBe(initial)
  for (const outside of [
    '/media/card',
    '/media/card-other/photo.ARW',
    '/media/card/../photo.ARW',
    '/media/card/mounted/photo.ARW',
    'relative/photo.ARW',
  ])
    expect(importSourceKey(source, outside)).toBeUndefined()
  const windows = structuredClone(source)
  windows.roots[0].path = 'E:\\'
  windows.roots[0].nestedMounts = ['E:\\mounted']
  expect(importSourceKey(windows, 'E:\\DCIM\\photo.ARW')).toMatch(/^[a-f0-9]{64}$/)
  expect(importSourceKey(windows, 'E:\\mounted\\photo.ARW')).toBeUndefined()
  expect(importSourceKey(windows, 'F:\\DCIM\\photo.ARW')).toBeUndefined()
})

test('same-size in-place edits with restored mtime and atomic replacements change the full witness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-source-witness-'))
  const path = join(directory, 'photo.jpg')
  const modified = new Date('2020-01-01T00:00:00.000Z')
  try {
    await writeFile(path, 'original content')
    await utimes(path, modified, modified)
    const before = await inspectImportSource(path)
    const information = await lstat(path, { bigint: true })
    expect(before.witness.ino).toBe(information.ino.toString())
    expect(before.witness.mtimeNs).toBe(information.mtimeNs.toString())
    expect(before.witness.ctimeNs).toBe(information.ctimeNs.toString())
    expect(before.witness.birthtimeNs).toBe(information.birthtimeNs.toString())
    const handle = await open(path, 'r+')
    try {
      await handle.write(Buffer.from('modified content'), 0, 16, 0)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await utimes(path, modified, modified)
    const changed = await inspectImportSource(path)
    expect(changed.witness.size).toBe(before.witness.size)
    expect(changed.witness.mtimeNs).toBe(before.witness.mtimeNs)
    expect(changed.witness.ino).toBe(before.witness.ino)
    expect(changed.witness.ctimeNs).not.toBe(before.witness.ctimeNs)
    expect(sameImportSourceWitness(before.witness, changed.witness)).toBe(false)
    const replacement = join(directory, 'replacement.jpg')
    await writeFile(replacement, 'replaced content')
    await utimes(replacement, modified, modified)
    await rename(replacement, path)
    const replaced = await inspectImportSource(path)
    expect(replaced.witness.size).toBe(before.witness.size)
    expect(replaced.witness.mtimeNs).toBe(before.witness.mtimeNs)
    expect(replaced.witness.ino).not.toBe(before.witness.ino)
    expect(sameImportSourceWitness(changed.witness, replaced.witness)).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('source inspection rejects directories, symlinks and missing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-source-inspection-'))
  try {
    const path = join(directory, 'photo.jpg')
    await writeFile(path, 'original')
    await expect(inspectImportSource(directory)).rejects.toThrow('ordinary file')
    await expect(inspectImportSource(join(directory, 'missing.jpg'))).rejects.toThrow()
    if (process.platform !== 'win32') {
      const link = join(directory, 'linked.jpg')
      await symlink(path, link)
      await expect(inspectImportSource(link)).rejects.toThrow('ordinary file')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('records survive reopening and every source-witness field participates in exact matching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-source-records-'))
  const path = join(directory, 'catalog.sqlite')
  let opened = database(path)
  try {
    photo(opened.db, originalId)
    expect(opened.records.record(key, witness, originalId)).toBe(true)
    opened.db.close()
    opened = database(path)
    expect(opened.records.find(key, witness)).toBe(originalId)
    for (const field of Object.keys(witness) as (keyof ImportSourceWitness)[]) {
      const changed = { ...witness, [field]: (BigInt(witness[field]) + 1n).toString() }
      expect(opened.records.find(key, changed)).toBeUndefined()
    }
    const reordered = Object.fromEntries(
      Object.entries(witness).reverse(),
    ) as unknown as ImportSourceWitness
    expect(opened.records.find(key, reordered)).toBe(originalId)
    photo(opened.db, otherId, 'original')
    expect(opened.records.record(key, witness, otherId)).toBe(true)
    expect(opened.records.find(key, witness)).toBe(otherId)
  } finally {
    opened.db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('unknown, derived and removal-journal targets cannot be learned or reused', () => {
  const { db, records } = database()
  try {
    expect(records.record(key, witness, originalId)).toBe(false)
    photo(db, originalId)
    photo(db, otherId, 'derived')
    expect(records.record(key, witness, otherId)).toBe(false)
    expect(records.record(key, witness, originalId)).toBe(true)
    db.prepare('INSERT INTO removals (id, staged) VALUES (?, ?)').run(originalId, 'pending')
    expect(records.find(key, witness)).toBeUndefined()
    expect(records.record(key, witness, originalId)).toBe(false)
    db.prepare('DELETE FROM removals WHERE id = ?').run(originalId)
    expect(records.find(key, witness)).toBe(originalId)
    db.prepare('UPDATE photos SET photo = ? WHERE id = ?').run(
      JSON.stringify({ assetKind: 'derived' }),
      originalId,
    )
    expect(records.find(key, witness)).toBeUndefined()
    db.prepare('DELETE FROM photos WHERE id = ?').run(originalId)
    expect(db.prepare('SELECT source_key FROM source_imports').all()).toEqual([])
    photo(db, originalId)
    expect(records.find(key, witness)).toBeUndefined()
  } finally {
    db.close()
  }
})

test('successful deletion invalidates every source record in the same rollback-capable transaction', () => {
  const { db, records } = database()
  try {
    photo(db, originalId)
    records.record(key, witness, originalId)
    records.record('d'.repeat(64), witness, originalId)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM photos WHERE id = ?').run(originalId)
    expect(db.prepare('SELECT source_key FROM source_imports').all()).toEqual([])
    db.exec('ROLLBACK')
    expect(records.find(key, witness)).toBe(originalId)
    expect(records.find('d'.repeat(64), witness)).toBe(originalId)
    db.exec('BEGIN IMMEDIATE')
    db.prepare('DELETE FROM photos WHERE id = ?').run(originalId)
    db.exec('COMMIT')
    expect(db.prepare('SELECT source_key FROM source_imports').all()).toEqual([])
  } finally {
    db.close()
  }
})

test('invalid keys or damaged legacy record data remain uncertain', () => {
  const { db, records } = database()
  try {
    photo(db, originalId)
    expect(records.find(key, witness)).toBeUndefined()
    expect(records.record('source/path.jpg', witness, originalId)).toBe(false)
    expect(records.record(key, witness, 'not-a-content-hash')).toBe(false)
    expect(records.find('source/path.jpg', witness)).toBeUndefined()
    db.prepare('INSERT INTO source_imports (source_key, photo_id, witness) VALUES (?, ?, ?)').run(
      key,
      originalId,
      '{invalid',
    )
    expect(records.find(key, witness)).toBeUndefined()
    db.prepare('UPDATE source_imports SET witness = ? WHERE source_key = ?').run(
      JSON.stringify({ ...witness, ino: Number(witness.ino) }),
      key,
    )
    expect(records.find(key, witness)).toBeUndefined()
    expect(records.record(key, witness, originalId)).toBe(true)
    expect(records.find(key, witness)).toBe(originalId)
  } finally {
    db.close()
  }
})

test('uncertain source hashing preserves bytes and creates no staging or other files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-source-hash-'))
  const path = join(directory, 'photo.ARW')
  const contents = Buffer.alloc(3 * 1024 * 1024 + 31, 7)
  try {
    await writeFile(path, contents)
    const before = await inspectImportSource(path)
    let admissions = 0
    let checkpoints = 0
    const actual = await hashImportSource(path, new AbortController().signal, {
      checkpoint: async () => {
        checkpoints++
      },
      chunk: async (work) => {
        admissions++
        return work()
      },
    })
    expect(actual).toBe(createHash('sha256').update(contents).digest('hex'))
    expect(admissions).toBeGreaterThan(1)
    expect(checkpoints).toBe(admissions)
    expect((await inspectImportSource(path)).witness).toEqual(before.witness)
    expect(await readFile(path)).toEqual(contents)
    expect(await readdir(directory)).toEqual(['photo.ARW'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('hash cancellation stops further source reads and closes the source without changing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-source-hash-cancel-'))
  const path = join(directory, 'photo.ARW')
  const contents = Buffer.alloc(4 * 1024 * 1024, 11)
  const abort = new AbortController()
  try {
    await writeFile(path, contents)
    const before = await inspectImportSource(path)
    let admissions = 0
    await expect(
      hashImportSource(path, abort.signal, {
        chunk: async (work) => {
          admissions++
          const result = await work()
          abort.abort()
          return result
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(admissions).toBe(1)
    expect((await inspectImportSource(path)).witness).toEqual(before.witness)
    expect(await readFile(path)).toEqual(contents)
    await expect(hashImportSource(path, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await rename(path, join(directory, 'closed-source.ARW'))
    expect(await readdir(directory)).toEqual(['closed-source.ARW'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const mutation of ['in-place', 'replacement'] as const) {
  test(`source hashing rejects ${mutation} changes during scheduled reads`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luma-source-hash-change-'))
    const path = join(directory, 'photo.ARW')
    const contents = Buffer.alloc(3 * 1024 * 1024, 13)
    try {
      await writeFile(path, contents)
      let admissions = 0
      await expect(
        hashImportSource(path, new AbortController().signal, {
          chunk: async (work) => {
            const result = await work()
            if (++admissions === 1) {
              if (mutation === 'in-place') await writeFile(path, Buffer.alloc(contents.length, 17))
              else {
                const replacement = join(directory, 'replacement.ARW')
                await writeFile(replacement, contents)
                await rename(replacement, path)
              }
            }
            return result
          },
        }),
      ).rejects.toThrow('source changed')
      expect(await readdir(directory)).toEqual(['photo.ARW'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
