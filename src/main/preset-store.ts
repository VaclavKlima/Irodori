import type { DatabaseSync } from 'node:sqlite'
import { COLLECTION_CHUNK_SIZE, CollectionChangedError } from '../shared/collections'
import {
  PRESET_STORE_VERSION,
  exactPresetFields,
  presetNameKey,
  validateEditingPreset,
  validatePresetId,
  validatePresetRevision,
  type EditingPreset,
  type PresetPage,
  type PresetQuery,
} from '../shared/presets'
import { DEFAULT_PRESET_APPEARANCE } from '../shared/preset-appearance'

/** Independently versioned local definitions. Reads never initialize or repair storage. */
export class PresetReadStore {
  constructor(protected db: DatabaseSync) {}
  validateExisting() {
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('preset_store', 'edit_presets')",
        )
        .all()
      if (!tables.length) return
      const state = this.db.prepare('SELECT * FROM preset_store').all() as {
        singleton: number
        version: number
        revision: number
      }[]
      if (
        tables.length !== 2 ||
        state.length !== 1 ||
        state[0].singleton !== 1 ||
        ![1, PRESET_STORE_VERSION].includes(state[0].version) ||
        !Number.isSafeInteger(state[0].revision) ||
        state[0].revision < 0
      )
        throw new Error('Invalid preset store version.')
      for (const row of this.db
        .prepare('SELECT id, name_key, data FROM edit_presets')
        .iterate() as Iterable<{ id: string; name_key: string; data: string }>) {
        const p = JSON.parse(row.data)
        if (state[0].version === 1) validateEditingPreset(p, true)
        else validateEditingPreset(p)
        if (p.id !== row.id || presetNameKey(p.name) !== row.name_key)
          throw new Error('Invalid preset index.')
      }
    } catch (cause) {
      throw new Error('This preset store format is unsupported. Its library was preserved.', {
        cause,
      })
    }
  }
  initialize() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS preset_store (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO preset_store VALUES (1, ${PRESET_STORE_VERSION}, 0);
      CREATE TABLE IF NOT EXISTS edit_presets (id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);`)
    const state = this.db.prepare('SELECT version FROM preset_store WHERE singleton = 1').get() as {
      version: number
    }
    if (state.version === 1) {
      // The library's explicit startup transaction owns this migration, before the writer opens.
      const update = this.db.prepare('UPDATE edit_presets SET data = ? WHERE id = ?')
      for (const row of this.db.prepare('SELECT id, data FROM edit_presets').iterate() as Iterable<{
        id: string
        data: string
      }>) {
        const preset = JSON.parse(row.data)
        validateEditingPreset(preset, true)
        const migrated: EditingPreset = {
          ...preset,
          appearance: preset.appearance ?? { ...DEFAULT_PRESET_APPEARANCE },
        }
        validateEditingPreset(migrated)
        update.run(JSON.stringify(migrated), row.id)
      }
      this.db
        .prepare('UPDATE preset_store SET version = ? WHERE singleton = 1')
        .run(PRESET_STORE_VERSION)
    } else if (state.version !== PRESET_STORE_VERSION)
      throw new Error('This preset store requires a newer version of Irodori.')
  }
  get(id: string): EditingPreset {
    validatePresetId(id)
    const row = this.db.prepare('SELECT data FROM edit_presets WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('This preset is unavailable. Refresh the presets list.')
    return JSON.parse(row.data)
  }
  list(query: PresetQuery = {}): PresetPage {
    if (
      !exactPresetFields(query, [], ['search', 'offset', 'expectedStoreRevision', 'anchorId']) ||
      (query.search !== undefined &&
        (typeof query.search !== 'string' || query.search.length > 500)) ||
      !Number.isSafeInteger(query.offset ?? 0) ||
      (query.offset ?? 0) < 0 ||
      (query.expectedStoreRevision !== undefined &&
        (!Number.isSafeInteger(query.expectedStoreRevision) || query.expectedStoreRevision < 0))
    )
      throw new Error('Invalid preset query.')
    if (query.anchorId !== undefined) validatePresetId(query.anchorId)
    // A read transaction freezes the count, ordering revision and chunk together.
    this.db.exec('BEGIN')
    try {
      const { revision } = this.db
        .prepare('SELECT revision FROM preset_store WHERE singleton = 1')
        .get() as { revision: number }
      if (query.expectedStoreRevision !== undefined && query.expectedStoreRevision !== revision)
        throw new CollectionChangedError()
      const search = presetNameKey(query.search?.trim() ?? ''),
        where = 'instr(name_key, ?) > 0',
        total = (
          this.db
            .prepare(`SELECT COUNT(*) AS count FROM edit_presets WHERE ${where}`)
            .get(search) as { count: number }
        ).count,
        rows = this.db
          .prepare(
            `SELECT data FROM edit_presets WHERE ${where} ORDER BY name_key, id LIMIT ? OFFSET ?`,
          )
          .all(search, COLLECTION_CHUNK_SIZE, query.offset ?? 0) as { data: string }[]
      const anchor =
        query.anchorId &&
        (this.db
          .prepare(`SELECT id, name_key FROM edit_presets WHERE id = ? AND ${where}`)
          .get(query.anchorId, search) as { id: string; name_key: string } | undefined)
      const anchorIndex = anchor
        ? (
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM edit_presets WHERE ${where} AND (name_key < ? OR (name_key = ? AND id < ?))`,
              )
              .get(search, anchor.name_key, anchor.name_key, anchor.id) as { count: number }
          ).count
        : null
      return {
        total,
        storeRevision: revision,
        anchorIndex,
        presets: rows.map((row) => {
          const p = JSON.parse(row.data) as EditingPreset
          return {
            id: p.id,
            name: p.name,
            revision: p.revision,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            appearance: p.appearance,
            groups: p.definition.groups,
          }
        }),
      }
    } finally {
      this.db.exec('ROLLBACK')
    }
  }
}

/** Invoked only inside the dedicated catalog writer's transaction. */
export class PresetMutations extends PresetReadStore {
  private unique(name: string, except?: string) {
    const row = this.db
      .prepare('SELECT id FROM edit_presets WHERE name_key = ?')
      .get(presetNameKey(name)) as { id: string } | undefined
    if (row && row.id !== except) throw new Error('A preset with this name already exists.')
  }
  private changed() {
    this.db.exec('UPDATE preset_store SET revision = revision + 1 WHERE singleton = 1')
  }
  create(preset: EditingPreset) {
    validateEditingPreset(preset)
    if (preset.revision !== 1) throw new Error('A new preset must start at revision 1.')
    this.unique(preset.name)
    this.db
      .prepare('INSERT INTO edit_presets VALUES (?, ?, ?)')
      .run(preset.id, presetNameKey(preset.name), JSON.stringify(preset))
    this.changed()
    return preset
  }
  update(preset: EditingPreset, expectedPresetRevision: number) {
    validateEditingPreset(preset)
    const before = this.expected(preset.id, expectedPresetRevision)
    if (preset.revision !== before.revision + 1 || preset.createdAt !== before.createdAt)
      throw new Error('Invalid preset replacement.')
    this.unique(preset.name, preset.id)
    this.db
      .prepare('UPDATE edit_presets SET name_key = ?, data = ? WHERE id = ?')
      .run(presetNameKey(preset.name), JSON.stringify(preset), preset.id)
    this.changed()
    return preset
  }
  expected(id: string, revision: number) {
    validatePresetRevision(revision)
    const p = this.get(id)
    if (p.revision !== revision)
      throw new Error('Preset revision conflict. Refresh the preset before trying again.')
    return p
  }
  delete(id: string, revision: number) {
    this.expected(id, revision)
    this.db.prepare('DELETE FROM edit_presets WHERE id = ?').run(id)
    this.changed()
  }
}
