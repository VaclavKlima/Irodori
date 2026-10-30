import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { CameraError } from './model.ts'

export async function durableJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
export async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export class CameraStore {
  root: string
  private database?: DatabaseSync
  private owned = false
  lockPath: string
  constructor(
    root: string,
    lockPath = join(tmpdir(), `irodori-camera-control-${process.getuid?.() ?? 'user'}.sqlite`),
  ) {
    this.root = resolve(root)
    this.lockPath = lockPath
  }
  async init() {
    await Promise.all(
      ['sessions', 'operations', 'requests'].map((part) =>
        mkdir(join(this.root, part), { recursive: true, mode: 0o700 }),
      ),
    )
  }
  claim() {
    if (this.owned) return
    this.database ??= new DatabaseSync(this.lockPath)
    this.database.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER)')
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.owned = true
    } catch {
      throw new CameraError(
        'camera-busy',
        'Another camera-service instance owns the host camera broker. Close its sessions first.',
      )
    }
  }
  release() {
    if (this.owned) {
      this.database!.exec('ROLLBACK')
      this.owned = false
    }
  }
  close() {
    this.release()
    this.database?.close()
    this.database = undefined
  }
  path(group: 'sessions' | 'operations' | 'requests', id: string) {
    return join(this.root, group, `${id}.json`)
  }
}
