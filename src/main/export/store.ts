import type { DatabaseSync } from 'node:sqlite'
import type { BackgroundTask } from '../../shared/contracts'
import {
  EXPORT_VERSION,
  validateExportOptions,
  type ExportOptions,
  type ExportPreferences,
  type ExportDestination,
} from '../../shared/export'
import { directoryIdentity, validateDirectory } from './files'
import type { CatalogCommands } from '../catalog/contracts'
import type { ExportFile, ExportManifest, FileIdentity } from './types'

export interface Grant {
  id: string
  path: string
  identity: FileIdentity
}
interface Preferences {
  version: 1
  destinationId: string | null
  lastCustom: ExportOptions | null
}
export class ExportReadStore {
  constructor(protected db: DatabaseSync) {}
  initialize() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS export_preferences (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS export_destinations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS export_jobs (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, task TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS export_files (job_id TEXT NOT NULL REFERENCES export_jobs(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id, ordinal));`)
    this.db
      .prepare('INSERT OR IGNORE INTO export_preferences VALUES (1, ?)')
      .run(JSON.stringify({ version: EXPORT_VERSION, destinationId: null, lastCustom: null }))
    this.preferences()
  }
  preferences(): Preferences {
    const row = this.db
      .prepare('SELECT data FROM export_preferences WHERE singleton = 1')
      .get() as { data: string }
    const value = JSON.parse(row.data) as Preferences
    if (value.version !== 1)
      throw new Error('These export preferences require a newer Luma version.')
    if (value.lastCustom) validateExportOptions(value.lastCustom)
    return value
  }
  grant(id: string): Grant {
    if (typeof id !== 'string') throw new Error('Invalid export destination.')
    const row = this.db.prepare('SELECT data FROM export_destinations WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('Choose an authorized export folder first.')
    return JSON.parse(row.data) as Grant
  }
  async publicPreferences(): Promise<ExportPreferences> {
    const prefs = this.preferences()
    let destination: ExportDestination | null = null
    if (prefs.destinationId) {
      const grant = this.grant(prefs.destinationId)
      const available = await validateDirectory(grant).then(
        () => true,
        () => false,
      )
      destination = { id: grant.id, label: grant.path, available }
    }
    return { version: 1, destination, lastCustom: prefs.lastCustom }
  }

  files(jobId: string): ExportFile[] {
    return (
      this.db
        .prepare('SELECT data FROM export_files WHERE job_id = ? ORDER BY ordinal')
        .all(jobId) as { data: string }[]
    ).map((row) => JSON.parse(row.data))
  }
  filePage(jobId: string, offset: number, limit: number, failed = false) {
    const where = failed ? "job_id = ? AND json_extract(data, '$.status') = 'failed'" : 'job_id = ?'
    const rows = this.db
      .prepare(`SELECT data FROM export_files WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`)
      .all(jobId, limit, offset) as { data: string }[]
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM export_files WHERE ${where}`).get(jobId) as {
        count: number
      }
    ).count
    return { files: rows.map((row) => JSON.parse(row.data) as ExportFile), total }
  }

  jobs(): { manifest: ExportManifest; task: BackgroundTask }[] {
    return (
      this.db.prepare('SELECT manifest, task FROM export_jobs ORDER BY rowid').all() as {
        manifest: string
        task: string
      }[]
    ).map((row) => ({ manifest: JSON.parse(row.manifest), task: JSON.parse(row.task) }))
  }
}

export class ExportStore extends ExportReadStore {
  constructor(
    db: DatabaseSync,
    private writer: CatalogCommands,
  ) {
    super(db)
  }
  async authorize(path: string): Promise<ExportDestination> {
    const directory = await directoryIdentity(path)
    return this.writer.command({ operation: 'export.authorize', payload: directory })
  }
  accept(manifest: ExportManifest, task: BackgroundTask, custom: boolean) {
    return this.writer.command({ operation: 'export.accept', payload: { manifest, task, custom } })
  }
  file(jobId: string, file: ExportFile) {
    return this.writer.command({ operation: 'export.file', payload: { jobId, file } })
  }
  task(task: BackgroundTask) {
    return this.writer.command({ operation: 'export.task', payload: { task } })
  }
  dismiss(id: string) {
    return this.writer.command({ operation: 'export.dismiss', payload: { id } })
  }
}
