import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { DeviceSource } from './import-devices'
import { pathWithin } from './import-devices'
import {
  inspectImportSource,
  sameImportSourceWitness,
  type ImportSourceWitness,
  type ImportSourceHashControl,
} from './import-source-records'

export interface CameraSourceKey {
  volume: string
  path: string
}
export interface CameraBinding {
  photoId: string
  size: string
  mtimeNs: string
  birthtimeNs: string
  proof: 'full' | 'sample'
}

export function cameraSourceKey(source: DeviceSource, path: string): CameraSourceKey | undefined {
  const root = source.roots.find(
    (root) =>
      pathWithin(root.path, path) && !root.nestedMounts.some((mount) => pathWithin(mount, path)),
  )
  if (!root?.volumeIdentity) return
  const api = /^[a-z]:[\\/]/i.test(root.path) || root.path.startsWith('\\\\') ? win32 : posix
  const relative = api.relative(root.path, path)
  if (!relative) return
  return { volume: root.volumeIdentity, path: relative.split(api.sep).join('/').toLowerCase() }
}

export function cameraMetadataMatches(
  binding: CameraBinding,
  witness: ImportSourceWitness,
): boolean {
  return (
    binding.size === witness.size &&
    binding.mtimeNs === witness.mtimeNs &&
    binding.birthtimeNs === witness.birthtimeNs
  )
}

export const CAMERA_SAMPLE_VERSION = 1
const windowBytes = 64 * 1024
export function cameraSampleWindows(size: number): { offset: number; length: number }[] {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid original size.')
  if (size <= 4 * windowBytes) return [{ offset: 0, length: size }]
  const windows: { offset: number; length: number }[] = []
  for (const offset of [0, Math.floor(size / 3), Math.floor((size * 2) / 3), size - windowBytes]) {
    const previous = windows.at(-1)
    if (previous && offset <= previous.offset + previous.length)
      previous.length = Math.max(previous.length, offset + windowBytes - previous.offset)
    else windows.push({ offset, length: windowBytes })
  }
  return windows
}

/** At most 256 KiB, with the same no-follow and before/after observations as full hashing. */
export async function sampleCameraOriginal(
  path: string,
  signal: AbortSignal,
  control: ImportSourceHashControl = {},
): Promise<{ digest: string; bytes: number }> {
  signal.throwIfAborted()
  const before = (await inspectImportSource(path)).witness
  const size = Number(before.size)
  const windows = cameraSampleWindows(size)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev.toString() !== before.dev ||
      opened.ino.toString() !== before.ino ||
      opened.size.toString() !== before.size ||
      opened.mtimeNs.toString() !== before.mtimeNs ||
      opened.ctimeNs.toString() !== before.ctimeNs
    )
      throw new Error('The original changed while sampling its contents.')
    const digest = createHash('sha256').update(
      JSON.stringify(['camera-sample', CAMERA_SAMPLE_VERSION, size, windows]),
    )
    let bytes = 0
    const run = control.chunk ?? (async <T>(work: () => Promise<T>) => work())
    for (const window of windows) {
      const buffer = Buffer.allocUnsafe(window.length)
      let read = 0
      while (read < window.length) {
        signal.throwIfAborted()
        await control.checkpoint?.()
        const count = await run(async () => {
          signal.throwIfAborted()
          return (await handle.read(buffer, read, window.length - read, window.offset + read))
            .bytesRead
        })
        signal.throwIfAborted()
        if (!count) throw new Error('The original changed while sampling its contents.')
        read += count
      }
      bytes += read
      digest.update(buffer)
    }
    const after = await inspectImportSource(path)
    const finished = await handle.stat({ bigint: true })
    signal.throwIfAborted()
    if (
      !sameImportSourceWitness(before, after.witness) ||
      finished.size.toString() !== before.size ||
      finished.mtimeNs.toString() !== before.mtimeNs ||
      finished.ctimeNs.toString() !== before.ctimeNs
    )
      throw new Error('The original changed while sampling its contents.')
    return { digest: digest.digest('hex'), bytes }
  } finally {
    await handle.close()
  }
}

/** Current camera recognition reads; bootstrap owns schema initialization. */
export class CameraRecognition {
  private lookup!: StatementSync
  private liveLookup!: StatementSync
  private poolLookup!: StatementSync
  constructor(protected db: DatabaseSync) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS camera_imports (volume_id TEXT NOT NULL, relative_path TEXT NOT NULL, photo_id TEXT NOT NULL, size TEXT NOT NULL, mtime_ns TEXT NOT NULL, birthtime_ns TEXT NOT NULL, proof TEXT NOT NULL CHECK (proof IN ('full', 'sample')), PRIMARY KEY (volume_id, relative_path));
      CREATE INDEX IF NOT EXISTS camera_imports_photo ON camera_imports(photo_id);
      CREATE TABLE IF NOT EXISTS camera_samples (photo_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS camera_original_candidates ON photos(lower(json_extract(photo, '$.filename')), json_extract(photo, '$.bytes'));
      CREATE TRIGGER IF NOT EXISTS remove_camera_imports AFTER DELETE ON photos BEGIN DELETE FROM camera_imports WHERE photo_id = old.id; DELETE FROM camera_samples WHERE photo_id = old.id; END;
    `)
    this.prepare()
  }

  /** Prepare current-schema reads without schema or persistent writes. */
  prepare(): void {
    this.lookup = this.db.prepare(
      'SELECT photo_id AS photoId, size, mtime_ns AS mtimeNs, birthtime_ns AS birthtimeNs, proof FROM camera_imports WHERE volume_id = ? AND relative_path = ?',
    )
    this.liveLookup = this.db.prepare(
      "SELECT id FROM photos WHERE id = ? AND COALESCE(json_extract(photo, '$.assetKind'), 'original') = 'original' AND NOT EXISTS (SELECT 1 FROM removals WHERE removals.id = photos.id)",
    )
    this.poolLookup = this.db.prepare(
      "SELECT id, photo FROM photos WHERE lower(json_extract(photo, '$.filename')) = ? AND json_extract(photo, '$.bytes') = ? AND COALESCE(json_extract(photo, '$.assetKind'), 'original') = 'original' AND NOT EXISTS (SELECT 1 FROM removals WHERE removals.id = photos.id) LIMIT 9",
    )
  }

  binding(key: CameraSourceKey): CameraBinding | undefined {
    return this.lookup.get(key.volume, key.path) as unknown as CameraBinding | undefined
  }
  live(id: string): boolean {
    return !!this.liveLookup.get(id)
  }
  candidates(filename: string, size: number): { id: string; filename: string }[] {
    const rows = this.poolLookup.all(filename.toLowerCase(), size) as {
      id: string
      photo: string
    }[]
    if (rows.length > 8) return []
    return rows.map((row) => ({
      id: row.id,
      filename: (JSON.parse(row.photo) as { filename: string }).filename,
    }))
  }

  sample(id: string): string | undefined {
    return (
      this.db
        .prepare('SELECT digest FROM camera_samples WHERE photo_id = ? AND version = ?')
        .get(id, CAMERA_SAMPLE_VERSION) as { digest: string } | undefined
    )?.digest
  }

  revision(): string {
    return JSON.stringify([
      this.db.prepare('PRAGMA data_version').get(),
      this.db.prepare('SELECT total_changes()').get(),
    ])
  }
}
