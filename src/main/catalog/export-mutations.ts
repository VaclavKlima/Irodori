import { catalogTransaction } from './transaction'
import { randomUUID } from 'node:crypto'
import { ExportReadStore, type Grant } from '../export/store'
import type { ExportDestination } from '../../shared/export'
import type { BackgroundTask } from '../../shared/contracts'
import type { ExportFile, ExportManifest } from '../export/types'

export class ExportMutations extends ExportReadStore {
  authorize(directory: Omit<Grant, 'id'>): ExportDestination {
    const data = { id: randomUUID(), ...directory }
    const prefs = this.preferences()
    catalogTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO export_destinations VALUES (?, ?)')
        .run(data.id, JSON.stringify(data))
      this.db
        .prepare('UPDATE export_preferences SET data = ? WHERE singleton = 1')
        .run(JSON.stringify({ ...prefs, destinationId: data.id }))
    })
    return { id: data.id, label: data.path, available: true }
  }
  accept(manifest: ExportManifest, task: BackgroundTask, custom: boolean) {
    catalogTransaction(this.db, () => {
      this.db
        .prepare('INSERT INTO export_jobs VALUES (?, ?, ?)')
        .run(manifest.id, JSON.stringify(manifest), JSON.stringify(task))
      for (const [index, source] of manifest.sources.entries())
        this.file(manifest.id, {
          index,
          photoId: source.photo.id,
          filename: source.photo.filename,
          status: 'pending',
        })
      const prefs = this.preferences()
      this.db.prepare('UPDATE export_preferences SET data = ? WHERE singleton = 1').run(
        JSON.stringify({
          ...prefs,
          destinationId: manifest.destinationId,
          lastCustom: custom ? manifest.options : prefs.lastCustom,
        }),
      )
    })
  }
  file(jobId: string, file: ExportFile) {
    this.db
      .prepare('INSERT OR REPLACE INTO export_files VALUES (?, ?, ?)')
      .run(jobId, file.index, JSON.stringify(file))
  }
  task(task: BackgroundTask) {
    this.db
      .prepare('UPDATE export_jobs SET task = ? WHERE id = ?')
      .run(JSON.stringify(task), task.id)
  }
  dismiss(id: string) {
    catalogTransaction(this.db, () => {
      this.db.prepare('DELETE FROM export_files WHERE job_id = ?').run(id)
      this.db.prepare('DELETE FROM export_jobs WHERE id = ?').run(id)
    })
  }
}
