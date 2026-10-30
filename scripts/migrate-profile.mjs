import { backup, DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const exists = async (path) =>
  lstat(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
const quote = (name) => `"${name.replaceAll('"', '""')}"`
const hash = (data) => createHash('sha256').update(data).digest('hex')

async function* files(directory) {
  if (!(await exists(directory))) return
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) yield* files(path)
    else if (item.isFile()) yield path
  }
}
async function originals(profile) {
  const result = []
  for await (const path of files(join(profile, 'library', 'originals'))) {
    if (!/^original\.[a-z0-9]+$/i.test(basename(path))) continue
    const info = await lstat(path, { bigint: true })
    result.push({
      path: relative(profile, path),
      inode: String(info.ino),
      bytes: String(info.size),
      modified: String(info.mtimeNs),
    })
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** Explicit, offline profile migration. Original photographs and floating-point masters are never written. */
export async function migrateProfile(from, to, evidence) {
  if (![from, to, evidence].every(isAbsolute)) throw new Error('Use absolute migration paths.')
  from = await realpath(from)
  to = resolve(to)
  evidence = resolve(evidence)
  if (to === from || to.startsWith(from + sep) || evidence.startsWith(from + sep))
    throw new Error('Migration paths must be separate.')
  if (await exists(to))
    throw new Error('The destination profile already exists; no files were changed.')
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
    if (await exists(join(from, name)))
      throw new Error('Close the application before migrating its profile.')
  await mkdir(dirname(to), { recursive: true })
  if ((await lstat(from)).dev !== (await lstat(dirname(to))).dev)
    throw new Error('Profile migration requires an atomic move on the same filesystem.')
  await mkdir(evidence, { recursive: true })
  const before = await originals(from),
    oldName = basename(from),
    newName = basename(to),
    oldLower = oldName.toLowerCase(),
    newLower = newName.toLowerCase(),
    scheme = `${oldLower}-photo:`,
    technical = new Set([
      'decoder',
      'implementation',
      'provider',
      'version',
      'processing',
      'rendering',
      'pipeline',
      'protocol',
    ])
  function transform(value, key = '', parent) {
    if (typeof value === 'string') {
      if (key.endsWith('Url') && value.startsWith(scheme))
        return `${newLower}-photo:${value.slice(scheme.length)}`
      if (value.startsWith(from + sep)) return to + value.slice(from.length)
      if (key === 'format' && parent?.assetKind === 'derived') return `${newName.toUpperCase()} HDR`
      if (key === 'filename' && parent?.assetKind === 'derived' && value.endsWith(`.${oldLower}`))
        return value.slice(0, -oldLower.length) + newLower
      if (technical.has(key) && value.startsWith(oldLower + '-'))
        return newLower + value.slice(oldLower.length)
      return value
    }
    if (Array.isArray(value)) return value.map((item) => transform(item))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, transform(item, name, value)]),
      )
    return value
  }
  const report = {
    version: 1,
    from,
    to,
    catalog: false,
    updatedCells: 0,
    updatedSidecars: [],
    retiredCaches: [],
    originals: before,
    complete: false,
  }
  await writeFile(join(evidence, 'migration.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  const path = join(from, 'library', 'catalog.sqlite')
  if (await exists(path)) {
    const db = new DatabaseSync(path)
    try {
      await backup(db, join(evidence, 'catalog-before.sqlite'))
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const { name } of db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all()) {
          const columns = db
            .prepare(`PRAGMA table_info(${quote(name)})`)
            .all()
            .filter((column) => String(column.type).toUpperCase().includes('TEXT'))
          for (const column of columns) {
            const rows = db
              .prepare(
                `SELECT rowid AS migrationRow, ${quote(column.name)} AS value FROM ${quote(name)}`,
              )
              .all()
            for (const row of rows) {
              if (typeof row.value !== 'string') continue
              const first = row.value.trimStart()[0]
              if (first !== '{' && first !== '[') continue
              let parsed
              try {
                parsed = JSON.parse(row.value)
              } catch {
                continue
              }
              const normalized = transform(parsed)
              if (JSON.stringify(normalized) === JSON.stringify(parsed)) continue
              db.prepare(`UPDATE ${quote(name)} SET ${quote(column.name)} = ? WHERE rowid = ?`).run(
                JSON.stringify(normalized),
                row.migrationRow,
              )
              report.updatedCells++
            }
          }
        }
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
          throw new Error('Catalog verification failed.')
        db.exec('COMMIT')
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        report.catalog = true
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }
  for await (const sidecar of files(join(from, 'library'))) {
    if (
      !sidecar.endsWith('.json') ||
      relative(from, sidecar).startsWith(join('library', 'cache') + sep)
    )
      continue
    const bytes = await readFile(sidecar)
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      continue
    }
    const transformed = transform(value)
    if (JSON.stringify(value) === JSON.stringify(transformed)) continue
    const saved = join(evidence, 'sidecars', relative(from, sidecar))
    await mkdir(dirname(saved), { recursive: true })
    await writeFile(saved, bytes, { flag: 'wx' })
    await writeFile(sidecar, JSON.stringify(transformed) + '\n')
    report.updatedSidecars.push({ path: relative(from, sidecar), previousSha256: hash(bytes) })
  }
  for (const name of [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnCache',
    'DawnWebGPUCache',
    join('library', 'cache'),
  ]) {
    const cache = join(from, name)
    if (!(await exists(cache))) continue
    const saved = join(evidence, 'retired-caches', name)
    await mkdir(dirname(saved), { recursive: true })
    await rename(cache, saved)
    report.retiredCaches.push(name)
  }
  if (await exists(to))
    throw new Error(
      'The destination profile appeared during migration; the retained source was not overwritten.',
    )
  await rename(from, to)
  if (JSON.stringify(await originals(to)) !== JSON.stringify(before))
    throw new Error('Original-file identity changed during migration.')
  report.complete = true
  await writeFile(join(evidence, 'migration.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' }, evidence: { type: 'string' } },
  })
  if (!values.from || !values.to || !values.evidence)
    throw new Error('Use --from, --to and --evidence with absolute paths.')
  const report = await migrateProfile(values.from, values.to, values.evidence)
  console.log(
    JSON.stringify({
      complete: report.complete,
      originals: report.originals.length,
      updatedCells: report.updatedCells,
      destination: report.to,
    }),
  )
}
