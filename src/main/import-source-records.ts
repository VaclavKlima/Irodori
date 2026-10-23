import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, statfs } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathWithin, type DeviceSource } from './import-devices'

/** Exact source observations stay in main and never become content identities. */
export interface ImportSourceWitness {
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
  birthtimeNs: string
}

export interface ImportSourceInspection {
  witness: ImportSourceWitness
  reusable: boolean
}

export interface ImportSourceHashControl {
  checkpoint?: () => Promise<void>
  chunk?: <T>(work: () => Promise<T>) => Promise<T>
}

function sourceWitness(information: BigIntStats): ImportSourceWitness {
  return {
    dev: information.dev.toString(),
    ino: information.ino.toString(),
    size: information.size.toString(),
    mtimeNs: information.mtimeNs.toString(),
    ctimeNs: information.ctimeNs.toString(),
    birthtimeNs: information.birthtimeNs.toString(),
  }
}

// These local Linux filesystems expose an inode change time independent of modification time.
// These legacy observations remain hints elsewhere; persistent camera policy lives in
// camera-recognition.ts and does not depend on mount/inode change tokens.
const reliableFilesystems = new Set([
  0xef53n, // ext family; inspection also rejects coarse-second inode change times.
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0x1021994n, // tmpfs
  0xf2f52010n, // F2FS
  0x794c7630n, // OverlayFS
])

export function reliableImportChangeToken(
  filesystemType: bigint | number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === 'linux' &&
    (typeof filesystemType === 'bigint' || Number.isSafeInteger(filesystemType)) &&
    reliableFilesystems.has(BigInt(filesystemType))
  )
}

export async function inspectImportSource(path: string): Promise<ImportSourceInspection> {
  const information = await lstat(path, { bigint: true })
  if (!information.isFile() || information.isSymbolicLink())
    throw new Error('The import source is not an ordinary file.')
  const witness = sourceWitness(information)
  let reusable = false
  try {
    const filesystem = await statfs(path, { bigint: true })
    reusable =
      information.ino > 0n &&
      information.ctimeNs > 0n &&
      information.ctimeNs % 1_000_000_000n !== 0n &&
      reliableImportChangeToken(filesystem.type)
  } catch {
    // Failing to establish a reliable change token never makes a file a known duplicate.
  }
  return { witness, reusable }
}

/** Uncertain prior imports are hashed directly; no original is copied or staged. */
export async function hashImportSource(
  path: string,
  signal: AbortSignal,
  control: ImportSourceHashControl = {},
): Promise<string> {
  signal.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error('The import source is not an ordinary file.')
  const witness = sourceWitness(before)
  signal.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameImportSourceWitness(sourceWitness(opened), witness))
      throw new Error('The import source changed while checking its contents.')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const run = control.chunk ?? (async <T>(work: () => Promise<T>) => work())
    let remaining = before.size
    while (remaining > 0n) {
      signal.throwIfAborted()
      await control.checkpoint?.()
      const bytesRead = await run(async () => {
        signal.throwIfAborted()
        const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
        const result = await handle.read(buffer, 0, length, null)
        signal.throwIfAborted()
        return result.bytesRead
      })
      signal.throwIfAborted()
      if (!bytesRead) throw new Error('The import source changed while checking its contents.')
      remaining -= BigInt(bytesRead)
      hash.update(buffer.subarray(0, bytesRead))
    }
    const [finished, current] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ])
    signal.throwIfAborted()
    if (
      !finished.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameImportSourceWitness(sourceWitness(finished), witness) ||
      !sameImportSourceWitness(sourceWitness(current), witness)
    )
      throw new Error('The import source changed while checking its contents.')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Current volume/root identity deliberately invalidates reuse after uncertain remounts. */
export function importSourceKey(source: DeviceSource, path: string): string | undefined {
  const root = source.roots.find(
    (root) =>
      pathWithin(root.path, path) && !root.nestedMounts.some((mount) => pathWithin(mount, path)),
  )
  if (!root) return undefined
  const paths = /^[a-z]:[\\/]/i.test(root.path) || root.path.startsWith('\\\\') ? win32 : posix
  const relativePath = paths.relative(root.path, path)
  if (!relativePath) return undefined
  return createHash('sha256')
    .update(
      JSON.stringify([
        'source-import-v1',
        source.deviceId,
        root.identity,
        root.filesystemIdentity,
        root.filesystemDevice,
        relativePath,
      ]),
    )
    .digest('hex')
}

const witnessFields: (keyof ImportSourceWitness)[] = [
  'dev',
  'ino',
  'size',
  'mtimeNs',
  'ctimeNs',
  'birthtimeNs',
]
const hashPattern = /^[a-f0-9]{64}$/

export function validWitness(value: unknown): value is ImportSourceWitness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = value as Record<string, unknown>
  return witnessFields.every(
    (field) => typeof fields[field] === 'string' && /^-?\d+$/.test(fields[field]),
  )
}

export function sameImportSourceWitness(
  first: ImportSourceWitness,
  second: ImportSourceWitness,
): boolean {
  return witnessFields.every((field) => first[field] === second[field])
}

/** Records are learned only from a completed, validated full hash and a live original. */
export class ImportSourceRecords {
  constructor(protected db: DatabaseSync) {}

  /** Fresh library setup calls this inside its bootstrap transaction. */
  initialize(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS source_imports (source_key TEXT PRIMARY KEY, photo_id TEXT NOT NULL, witness TEXT NOT NULL); CREATE INDEX IF NOT EXISTS source_imports_photo_id ON source_imports(photo_id); CREATE TRIGGER IF NOT EXISTS remove_source_imports AFTER DELETE ON photos BEGIN DELETE FROM source_imports WHERE photo_id = old.id; END;',
    )
  }

  /** An unreliable change token makes this a hint requiring full content verification. */
  find(key: string, witness: ImportSourceWitness): string | undefined {
    if (!hashPattern.test(key) || !validWitness(witness)) return undefined
    const row = this.db
      .prepare(
        "SELECT source_imports.photo_id, source_imports.witness FROM source_imports JOIN photos ON photos.id = source_imports.photo_id WHERE source_key = ? AND COALESCE(json_extract(photos.photo, '$.assetKind'), 'original') = 'original' AND NOT EXISTS (SELECT 1 FROM removals WHERE removals.id = photos.id)",
      )
      .get(key) as { photo_id: string; witness: string } | undefined
    if (!row || !hashPattern.test(row.photo_id)) return undefined
    try {
      const stored: unknown = JSON.parse(row.witness)
      return validWitness(stored) && sameImportSourceWitness(stored, witness)
        ? row.photo_id
        : undefined
    } catch {
      return undefined
    }
  }
}
