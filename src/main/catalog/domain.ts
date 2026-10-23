import { catalogTransaction } from './transaction'
import type { DatabaseSync } from 'node:sqlite'
import type { Photo } from '../../shared/contracts'
import { initialSettings, SETTINGS_VERSION, type EditHistory } from '../../shared/edits'
import {
  automaticLensSettings,
  PROCESSING_METADATA_VERSION,
  type ProcessingOptions,
} from '../../shared/lens'
import type { CatalogCommand } from './contracts'
import { StackMutations } from './stack-mutations'
import { BrowseMutations } from './browse-mutations'
import { WorkspaceMutations } from './workspace-mutations'
import { CameraMutations } from './camera-mutations'
import { ImportSourceMutations } from './import-source-mutations'
import { ExportMutations } from './export-mutations'

/** Only the dedicated writer uses this after the explicit startup phase ends. */
export class CatalogMutations {
  readonly stacks: StackMutations
  readonly browse: BrowseMutations
  readonly workspace: WorkspaceMutations
  readonly camera: CameraMutations
  readonly sources: ImportSourceMutations
  readonly exports: ExportMutations
  constructor(readonly db: DatabaseSync) {
    this.stacks = new StackMutations(db)
    this.browse = new BrowseMutations(db)
    this.workspace = new WorkspaceMutations(db, this.browse)
    this.camera = new CameraMutations(db)
    this.sources = new ImportSourceMutations(db)
    this.exports = new ExportMutations(db)
  }
  transaction<T>(work: () => T): T {
    return catalogTransaction(this.db, work)
  }
  private photo(id: string): Photo {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid photo ID.')
    const row = this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
      { photo: string } | undefined
    if (!row) throw new Error('This photo is unavailable.')
    return JSON.parse(row.photo)
  }
  readEdits(id: string): EditHistory {
    const row = this.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('This photo has no confirmed edit history.')
    const history = JSON.parse(row.data) as EditHistory
    if (
      history.settings.version !== SETTINGS_VERSION ||
      history.snapshots.some((snapshot) => snapshot.settings.version !== SETTINGS_VERSION)
    )
      throw new Error('These edits require a newer version of Luma.')
    return history
  }
  /** Used only inside startup or the transaction that publishes processing metadata. */
  seedEdits(id: string, data: ProcessingOptions, createdAt: string): EditHistory {
    if (this.db.prepare('SELECT 1 FROM edits WHERE id = ?').get(id)) return this.readEdits(id)
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid edit timestamp.')
    const settings = initialSettings(data.settings)
    const seed = this.db.prepare('SELECT processing_identity FROM photos WHERE id = ?').get(id) as
      { processing_identity: 'display-referred-v1' | 'hdr-v1' } | undefined
    if (!seed) throw new Error('This photo is unavailable.')
    if (!['display-referred-v1', 'hdr-v1'].includes(seed.processing_identity))
      throw new Error('This photo has an unsupported processing identity.')
    settings.processing = seed.processing_identity
    const history: EditHistory = {
      photoId: id,
      revision: data.revision,
      settings,
      canUndo: false,
      canRedo: false,
      cursor: 0,
      snapshots: [{ settings, createdAt }],
    }
    this.db.prepare('INSERT INTO edits (id, data) VALUES (?, ?)').run(id, JSON.stringify(history))
    return history
  }
  execute(command: CatalogCommand): unknown {
    switch (command.operation) {
      case 'processing.publish': {
        const { id, data, createdAt } = command.payload
        return this.transaction(() => {
          const photo = this.photo(id)
          this.db
            .prepare('INSERT OR REPLACE INTO processing (id, data) VALUES (?, ?)')
            .run(id, JSON.stringify(data))
          const history = this.seedEdits(id, data, createdAt)
          if (data.metadata.hdrJpeg?.state === 'supported') {
            this.db.prepare("UPDATE photos SET processing_identity = 'hdr-v1' WHERE id = ?").run(id)
            history.settings.processing = 'hdr-v1'
            for (const snapshot of history.snapshots) snapshot.settings.processing = 'hdr-v1'
            this.db
              .prepare('UPDATE edits SET data = ? WHERE id = ?')
              .run(JSON.stringify(history), id)
          }
          this.browse.put(photo, data.metadata, undefined, this.stacks.capture(id) ?? undefined)
        })
      }
      case 'edits.commit': {
        const { history, expectedRevision } = command.payload
        if (
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 0 ||
          history.revision !== expectedRevision
        )
          throw new Error('Edit conflict: reload the confirmed settings and try again.')
        return this.transaction(() => {
          this.photo(history.photoId)
          const previous = this.readEdits(history.photoId)
          if (previous.revision !== expectedRevision)
            throw new Error('Edit conflict: reload the confirmed settings and try again.')
          if (
            !Number.isSafeInteger(history.cursor) ||
            history.cursor < 0 ||
            history.cursor >= history.snapshots.length ||
            history.settings.version !== SETTINGS_VERSION ||
            history.snapshots.some((snapshot) => snapshot.settings.version !== SETTINGS_VERSION) ||
            JSON.stringify(history.settings) !==
              JSON.stringify(history.snapshots[history.cursor].settings)
          )
            throw new Error('Invalid confirmed edit history.')
          const lensChanged =
            previous.settings.processing !== history.settings.processing ||
            JSON.stringify(previous.settings.lens) !== JSON.stringify(history.settings.lens)
          history.revision++
          history.canUndo = history.cursor > 0
          history.canRedo = history.cursor < history.snapshots.length - 1
          this.db
            .prepare('UPDATE edits SET data = ? WHERE id = ?')
            .run(JSON.stringify(history), history.photoId)
          return { history, lensChanged }
        })
      }
      case 'workspace.save':
        return this.workspace.save(command.payload)
      case 'stack.group': {
        const p = command.payload
        return this.stacks.group(p.ids, p.coverId, p.revision)
      }
      case 'stack.ungroup': {
        const p = command.payload
        return this.stacks.ungroup(p.id, p.revision)
      }
      case 'stack.remove': {
        const p = command.payload
        return this.stacks.remove(p.photoId, p.revision)
      }
      case 'stack.cover': {
        const p = command.payload
        return this.stacks.setCover(p.id, p.photoId, p.revision)
      }
      case 'stack.expanded': {
        const p = command.payload
        return this.stacks.setExpanded(p.id, p.expanded, p.revision)
      }
      case 'capture.publish':
        return this.transaction(() => {
          const p = command.payload,
            photo = this.photo(p.photoId)
          this.stacks.putCapture(p.photoId, p.metadata)
          const row = this.db.prepare('SELECT data FROM processing WHERE id = ?').get(p.photoId) as
            { data: string } | undefined
          this.browse.put(
            photo,
            row ? (JSON.parse(row.data) as ProcessingOptions).metadata : undefined,
            undefined,
            p.metadata,
          )
        })
      case 'capture.reconcile':
        return this.stacks.reconcileCaptures()
      case 'original.publish':
        return this.transaction(() => {
          const { photo, processingIdentity, metadata, capture, createdAt } = command.payload
          this.db
            .prepare(
              'INSERT INTO photos (id, imported_at, photo, processing_identity) VALUES (?, ?, ?, ?)',
            )
            .run(photo.id, photo.importedAt, JSON.stringify(photo), processingIdentity)
          if (metadata) {
            const data: ProcessingOptions = {
              metadata,
              settings: automaticLensSettings,
              revision: 0,
            }
            this.db
              .prepare('INSERT OR REPLACE INTO processing (id, data) VALUES (?, ?)')
              .run(photo.id, JSON.stringify(data))
            this.seedEdits(photo.id, data, createdAt)
          }
          if (capture) this.stacks.putCapture(photo.id, capture)
          this.browse.put(photo, metadata, undefined, capture)
        })
      case 'source.record': {
        const p = command.payload
        return this.transaction(() => this.sources.record(p.key, p.witness, p.photoId))
      }
      case 'camera.record': {
        const p = command.payload
        return this.transaction(() => this.camera.record(p.key, p.witness, p.photoId, p.proof))
      }
      case 'camera.sample': {
        const p = command.payload
        return this.transaction(() => this.camera.cacheSample(p.photoId, p.digest))
      }
      case 'removal.journal':
        return this.transaction(() => {
          const p = command.payload
          this.db.prepare('INSERT INTO removals (id, staged) VALUES (?, ?)').run(p.id, p.staged)
        })
      case 'removal.clear':
        return this.transaction(() => {
          this.db.prepare('DELETE FROM removals WHERE id = ?').run(command.payload.id)
        })
      case 'removal.finish':
        return this.transaction(() => {
          this.db.prepare('DELETE FROM photos WHERE id = ?').run(command.payload.id)
          this.stacks.repairRemoval(command.payload.id)
          this.db.prepare('DELETE FROM removals WHERE id = ?').run(command.payload.id)
        })
      case 'merge.journal':
        return this.transaction(() => {
          this.db
            .prepare('INSERT INTO merge_publications (id, manifest_sha256) VALUES (?, ?)')
            .run(command.payload.id, command.payload.manifestSha256)
        })
      case 'merge.publish':
        return this.transaction(() => {
          const { manifest, createdAt } = command.payload,
            { photo, metadata } = manifest
          this.db
            .prepare(
              "INSERT OR IGNORE INTO photos (id, imported_at, photo, processing_identity) VALUES (?, ?, ?, 'hdr-v1')",
            )
            .run(photo.id, photo.importedAt, JSON.stringify(photo))
          this.db
            .prepare('INSERT OR IGNORE INTO derived_assets (id, manifest) VALUES (?, ?)')
            .run(photo.id, JSON.stringify(manifest))
          const options: ProcessingOptions = {
            processing: 'hdr-v1',
            metadata: {
              ...metadata,
              version: PROCESSING_METADATA_VERSION,
              mergeMaster: { asset: manifest.asset, recipe: manifest.recipe },
            },
            settings: { distortion: false, vignetting: false, chromaticAberration: false },
            revision: 0,
          }
          this.db
            .prepare('INSERT OR IGNORE INTO processing (id, data) VALUES (?, ?)')
            .run(photo.id, JSON.stringify(options))
          this.seedEdits(photo.id, options, createdAt)
          this.browse.put(photo, options.metadata, manifest)
          this.stacks.attachMerge(manifest)
          this.db.prepare('DELETE FROM merge_publications WHERE id = ?').run(photo.id)
        })
      case 'export.authorize':
        return this.exports.authorize(command.payload)
      case 'export.accept': {
        const p = command.payload
        return this.exports.accept(p.manifest, p.task, p.custom)
      }
      case 'export.file': {
        const p = command.payload
        return this.transaction(() => this.exports.file(p.jobId, p.file))
      }
      case 'export.task':
        return this.transaction(() => this.exports.task(command.payload.task))
      case 'export.dismiss':
        return this.exports.dismiss(command.payload.id)
    }
  }
}
