import type { DatabaseSync } from 'node:sqlite'
import type { BackgroundTask } from '../shared/contracts'
import type { EditHistory } from '../shared/edits'
import {
  transferredSettings,
  editTransferCapabilities,
  transferPatch,
  type CopiedEdits,
  type EditTransferGroup,
  type EditPasteTarget,
  type EditApplicationResult,
  type EditApplicationPage,
} from '../shared/edit-transfer'
import type { CatalogCommands } from './catalog/contracts'
import { COLLECTION_CHUNK_SIZE } from '../shared/collections'
import { supportsEditingSettings } from './catalog/editing-migration'
import { SETTINGS_VERSION } from '../shared/edits'
import { correctionKinds } from '../shared/lens'

export interface EditApplicationManifest {
  version: 1
  id: string
  source: CopiedEdits
  groups: EditTransferGroup[]
  targets: EditPasteTarget[]
}
export interface ApplicationCommit {
  id: string
  ordinal: number
}
type StoredManifest = Omit<EditApplicationManifest, 'targets'>

const outcomeKeys = ['applied', 'unchanged', 'conflict', 'unavailable', 'failed'] as const
type StoredOutcome = (typeof outcomeKeys)[number]
type OutcomeCounts = NonNullable<BackgroundTask['editApplication']>
const emptyCounts = (): OutcomeCounts => ({
  applied: 0,
  unchanged: 0,
  conflict: 0,
  unavailable: 0,
  failed: 0,
})
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const photoId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
function invalid(): never {
  throw new Error('Invalid edit application.')
}
function fields(value: unknown, required: string[], optional: string[] = []): boolean {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
function validateStoredManifest(manifest: StoredManifest) {
  if (
    !fields(manifest, ['version', 'id', 'source', 'groups']) ||
    manifest.version !== 1 ||
    !uuid(manifest.id)
  )
    invalid()
  const source = manifest.source
  if (
    !fields(source, ['version', 'clipboard', 'settings', 'lensKinds'], ['whiteBalanceIdentity']) ||
    source.version !== 1 ||
    !supportsEditingSettings(source.settings as unknown as Record<string, unknown>) ||
    source.settings.version !== SETTINGS_VERSION ||
    (source.whiteBalanceIdentity !== undefined &&
      (typeof source.whiteBalanceIdentity !== 'string' || !source.whiteBalanceIdentity)) ||
    !Array.isArray(source.lensKinds) ||
    source.lensKinds.length > correctionKinds.length ||
    new Set(source.lensKinds).size !== source.lensKinds.length ||
    source.lensKinds.some((kind) => !correctionKinds.includes(kind))
  )
    invalid()
  const clipboard = source.clipboard
  if (
    !fields(clipboard, ['id', 'photoId', 'filename', 'revision', 'copiedAt', 'groups']) ||
    !uuid(clipboard.id) ||
    !photoId(clipboard.photoId) ||
    typeof clipboard.filename !== 'string' ||
    !count(clipboard.revision) ||
    typeof clipboard.copiedAt !== 'string' ||
    !Number.isFinite(Date.parse(clipboard.copiedAt))
  )
    invalid()
  validateTransferSourceGroups(source)
  transferPatch(source, manifest.groups)
}
function validateTransferSourceGroups(source: CopiedEdits) {
  // transferPatch verifies selected groups; validate every advertised group as well.
  transferPatch(source, source.clipboard.groups)
  if (
    (source.clipboard.groups.includes('white-balance') && !source.whiteBalanceIdentity) ||
    (source.clipboard.groups.includes('lens') && !source.lensKinds.length)
  )
    invalid()
}
function validateTask(task: BackgroundTask, id: string) {
  if (
    !object(task) ||
    task.id !== id ||
    task.kind !== 'edit-application' ||
    typeof task.title !== 'string' ||
    !['running', 'cancelling', 'completed', 'cancelled', 'failed'].includes(task.status) ||
    !fields(task.progress, ['completed', 'total', 'unit']) ||
    task.progress!.unit !== 'items' ||
    !count(task.progress!.completed) ||
    !count(task.progress!.total) ||
    task.progress!.total < 1 ||
    task.progress!.total > editTransferCapabilities.maxTargets ||
    task.progress!.completed > task.progress!.total ||
    !fields(task.editApplication, [...outcomeKeys]) ||
    outcomeKeys.some((key) => !count(task.editApplication![key])) ||
    outcomeKeys.reduce((sum, key) => sum + task.editApplication![key], 0) !==
      task.progress!.completed ||
    !count(task.errorCount) ||
    task.errorCount !==
      task.editApplication!.conflict +
        task.editApplication!.unavailable +
        task.editApplication!.failed ||
    (task.phase !== undefined && typeof task.phase !== 'string') ||
    (task.detail !== undefined && typeof task.detail !== 'string') ||
    (task.unprocessed !== undefined &&
      (!count(task.unprocessed) ||
        task.unprocessed !== task.progress!.total - task.progress!.completed)) ||
    (task.finishedAt !== undefined && !count(task.finishedAt)) ||
    (task.status === 'completed' && task.progress!.completed !== task.progress!.total)
  )
    invalid()
  const terminal = !['running', 'cancelling'].includes(task.status)
  if (
    terminal
      ? task.finishedAt === undefined || task.unprocessed === undefined
      : task.finishedAt !== undefined
  )
    invalid()
}
function validateTarget(target: EditPasteTarget) {
  if (
    !fields(target, ['photoId', 'filename', 'revision'], ['unavailable']) ||
    !photoId(target.photoId) ||
    typeof target.filename !== 'string' ||
    !Number.isSafeInteger(target.revision) ||
    target.revision < (target.unavailable ? -1 : 0) ||
    (target.unavailable !== undefined &&
      (typeof target.unavailable !== 'string' || !target.unavailable))
  )
    invalid()
}
function validateResult(result: EditApplicationResult, target: EditPasteTarget, ordinal: number) {
  if (
    !fields(
      result,
      ['photoId', 'filename', 'revision', 'ordinal', 'outcome'],
      ['unavailable', 'message', 'resultingRevision'],
    ) ||
    result.ordinal !== ordinal ||
    result.photoId !== target.photoId ||
    result.filename !== target.filename ||
    result.revision !== target.revision ||
    result.unavailable !== target.unavailable ||
    !outcomeKeys.includes(result.outcome as StoredOutcome) ||
    (result.message !== undefined && typeof result.message !== 'string')
  )
    invalid()
  const success = result.outcome === 'applied' || result.outcome === 'unchanged'
  if (
    success
      ? target.unavailable ||
        !count(result.resultingRevision) ||
        result.resultingRevision !== target.revision + (result.outcome === 'applied' ? 1 : 0)
      : result.resultingRevision !== undefined
  )
    invalid()
}

export class EditApplicationReadStore {
  constructor(protected db: DatabaseSync) {}
  validateExisting() {
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('edit_applications', 'edit_application_targets', 'edit_application_results')",
        )
        .all()
      if (!tables.length) return
      if (tables.length !== 3) invalid()
      for (const table of ['edit_application_targets', 'edit_application_results'])
        if (
          this.db
            .prepare(
              `SELECT 1 FROM ${table} AS row LEFT JOIN edit_applications AS job ON job.id = row.job_id WHERE job.id IS NULL LIMIT 1`,
            )
            .get()
        )
          invalid()
      const targets = this.db.prepare(
        'SELECT ordinal, data FROM edit_application_targets WHERE job_id = ? ORDER BY ordinal',
      )
      const results = this.db.prepare(
        'SELECT result.ordinal, result.data, target.data AS target FROM edit_application_results AS result LEFT JOIN edit_application_targets AS target ON target.job_id = result.job_id AND target.ordinal = result.ordinal WHERE result.job_id = ? ORDER BY result.ordinal',
      )
      for (const row of this.db
        .prepare('SELECT id, manifest, task FROM edit_applications')
        .iterate() as Iterable<{ id: string; manifest: string; task: string }>) {
        const manifest = JSON.parse(row.manifest) as StoredManifest,
          task = JSON.parse(row.task) as BackgroundTask
        validateStoredManifest(manifest)
        if (manifest.id !== row.id) invalid()
        validateTask(task, row.id)
        let targetCount = 0
        const seen = new Set<string>()
        for (const entry of targets.iterate(row.id) as Iterable<{
          ordinal: number
          data: string
        }>) {
          if (entry.ordinal !== targetCount++ || targetCount > editTransferCapabilities.maxTargets)
            invalid()
          const target = JSON.parse(entry.data) as EditPasteTarget
          validateTarget(target)
          if (seen.has(target.photoId)) invalid()
          seen.add(target.photoId)
        }
        if (targetCount !== task.progress!.total) invalid()
        const counts = emptyCounts()
        let resultCount = 0
        for (const entry of results.iterate(row.id) as Iterable<{
          ordinal: number
          data: string
          target: string | null
        }>) {
          if (entry.ordinal !== resultCount++ || entry.target === null) invalid()
          const result = JSON.parse(entry.data) as EditApplicationResult,
            target = JSON.parse(entry.target) as EditPasteTarget
          validateResult(result, target, entry.ordinal)
          counts[result.outcome as StoredOutcome]++
        }
        if (outcomeKeys.some((key) => counts[key] !== task.editApplication![key])) invalid()
      }
    } catch (cause) {
      throw new Error('This edit application format is unsupported. Its library was preserved.', {
        cause,
      })
    }
  }
  initialize() {
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS edit_applications (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, task TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edit_application_targets (job_id TEXT NOT NULL REFERENCES edit_applications(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id, ordinal));
      CREATE TABLE IF NOT EXISTS edit_application_results (job_id TEXT NOT NULL REFERENCES edit_applications(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id, ordinal));`)
  }
  has(id: string) {
    return !!this.db.prepare('SELECT 1 FROM edit_applications WHERE id = ?').get(id)
  }
  tasks(): BackgroundTask[] {
    return (
      this.db.prepare('SELECT task FROM edit_applications ORDER BY rowid').all() as {
        task: string
      }[]
    ).map((row) => JSON.parse(row.task))
  }
  job(id: string): { manifest: StoredManifest; task: BackgroundTask } {
    const row = this.db
      .prepare('SELECT manifest, task FROM edit_applications WHERE id = ?')
      .get(id) as { manifest: string; task: string } | undefined
    if (!row) throw new Error('This edit application has been dismissed.')
    const manifest = JSON.parse(row.manifest) as StoredManifest
    if (manifest.version !== 1)
      throw new Error('This edit application requires a newer version of Irodori.')
    return { manifest, task: JSON.parse(row.task) }
  }
  results(id: string, offset = 0): EditApplicationPage {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result offset.')
    const { task } = this.job(id)
    const rows = this.db
      .prepare(
        'SELECT ordinal, data FROM edit_application_results WHERE job_id = ? AND ordinal >= ? AND ordinal < ?',
      )
      .all(id, offset, offset + COLLECTION_CHUNK_SIZE) as { ordinal: number; data: string }[]
    const completed = new Map(
      rows.map((row) => [row.ordinal, JSON.parse(row.data) as EditApplicationResult]),
    )
    const outcome =
      task.status === 'cancelled'
        ? 'cancelled'
        : task.status === 'failed'
          ? 'interrupted'
          : 'pending'
    const targets = this.db
      .prepare(
        'SELECT ordinal, data FROM edit_application_targets WHERE job_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?',
      )
      .all(id, offset, COLLECTION_CHUNK_SIZE) as { ordinal: number; data: string }[]
    return {
      results: targets.map(
        (row) =>
          completed.get(row.ordinal) ?? { ...JSON.parse(row.data), ordinal: row.ordinal, outcome },
      ),
      total: task.progress!.total,
    }
  }
  errors(id: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid result offset.')
    this.job(id)
    const where =
      "job_id = ? AND json_extract(data, '$.outcome') IN ('failed', 'conflict', 'unavailable')"
    const rows = this.db
      .prepare(
        `SELECT data FROM edit_application_results WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`,
      )
      .all(id, COLLECTION_CHUNK_SIZE, offset) as { data: string }[]
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM edit_application_results WHERE ${where}`)
        .get(id) as { count: number }
    ).count
    return {
      errors: rows.map((row) => {
        const r = JSON.parse(row.data) as EditApplicationResult
        return { filename: r.filename, message: r.message ?? r.outcome }
      }),
      total,
    }
  }
}

/** Invoked only by the catalog owner, inside the surrounding catalog transaction. */
export class EditApplicationMutations extends EditApplicationReadStore {
  accept(manifest: EditApplicationManifest, task: BackgroundTask) {
    const { targets, ...stored } = manifest
    validateStoredManifest(stored)
    validateTask(task, manifest.id)
    for (const target of targets) validateTarget(target)
    if (
      manifest.version !== 1 ||
      manifest.id !== task.id ||
      task.kind !== 'edit-application' ||
      task.status !== 'running' ||
      !manifest.targets.length ||
      manifest.targets.length > editTransferCapabilities.maxTargets ||
      new Set(manifest.targets.map((t) => t.photoId)).size !== manifest.targets.length ||
      manifest.targets.some(
        (target) =>
          !/^[a-f0-9]{64}$/.test(target.photoId) ||
          !Number.isSafeInteger(target.revision) ||
          target.revision < (target.unavailable ? -1 : 0) ||
          typeof target.filename !== 'string',
      ) ||
      !task.progress ||
      task.progress.completed !== 0 ||
      task.progress.total !== manifest.targets.length ||
      !task.editApplication ||
      Object.values(task.editApplication).some((count) => count !== 0)
    )
      throw new Error('Invalid edit application.')
    this.db
      .prepare('INSERT INTO edit_applications VALUES (?, ?, ?)')
      .run(manifest.id, JSON.stringify(stored), JSON.stringify(task))
    const insert = this.db.prepare('INSERT INTO edit_application_targets VALUES (?, ?, ?)')
    targets.forEach((target, ordinal) => insert.run(manifest.id, ordinal, JSON.stringify(target)))
  }
  private target(commit: ApplicationCommit) {
    const job = this.job(commit.id)
    const row = this.db
      .prepare('SELECT data FROM edit_application_targets WHERE job_id = ? AND ordinal = ?')
      .get(commit.id, commit.ordinal) as { data: string } | undefined
    if (
      !Number.isSafeInteger(commit.ordinal) ||
      commit.ordinal < 0 ||
      commit.ordinal !== job.task.progress!.completed ||
      !['running', 'cancelling'].includes(job.task.status) ||
      !row ||
      this.db
        .prepare('SELECT 1 FROM edit_application_results WHERE job_id = ? AND ordinal = ?')
        .get(commit.id, commit.ordinal)
    )
      throw new Error('This edit application result is no longer pending.')
    return { ...job, target: JSON.parse(row.data) as EditPasteTarget }
  }
  confirm(commit: ApplicationCommit, before: EditHistory, after: EditHistory) {
    const { manifest, target } = this.target(commit)
    if (
      target.unavailable ||
      target.photoId !== before.photoId ||
      target.revision !== before.revision ||
      after.photoId !== before.photoId ||
      after.revision !== before.revision + 1 ||
      JSON.stringify(transferredSettings(before.settings, manifest.source, manifest.groups)) !==
        JSON.stringify(after.settings)
    )
      throw new Error('Edit application revision or settings conflict.')
    this.result(commit, { outcome: 'applied', resultingRevision: after.revision }, true)
  }
  result(
    commit: ApplicationCommit,
    result: Pick<EditApplicationResult, 'outcome' | 'message' | 'resultingRevision'>,
    confirmed = false,
  ) {
    const { target, task } = this.target(commit)
    if (
      !['applied', 'unchanged', 'conflict', 'unavailable', 'failed'].includes(result.outcome) ||
      (result.outcome === 'applied' && !confirmed)
    )
      throw new Error('Invalid edit application result.')
    if (result.outcome === 'unchanged') {
      const { manifest } = this.job(commit.id)
      const row = this.db.prepare('SELECT data FROM edits WHERE id = ?').get(target.photoId) as
        { data: string } | undefined
      const current = row && (JSON.parse(row.data) as EditHistory | undefined)
      if (
        !current ||
        current.revision !== target.revision ||
        JSON.stringify(current.settings) !==
          JSON.stringify(transferredSettings(current.settings, manifest.source, manifest.groups))
      )
        throw new Error('Edit application revision conflict.')
    }
    const saved: EditApplicationResult = { ...target, ...result, ordinal: commit.ordinal }
    validateResult(saved, target, commit.ordinal)
    this.db
      .prepare('INSERT INTO edit_application_results VALUES (?, ?, ?)')
      .run(commit.id, commit.ordinal, JSON.stringify(saved))
    task.progress!.completed++
    task.editApplication![result.outcome as keyof NonNullable<BackgroundTask['editApplication']>]++
    if (['conflict', 'unavailable', 'failed'].includes(result.outcome)) task.errorCount++
    task.detail = `${task.editApplication!.applied} applied, ${task.editApplication!.unchanged} unchanged, ${task.errorCount} not applied`
    this.task(task)
  }
  task(task: BackgroundTask) {
    this.job(task.id)
    validateTask(task, task.id)
    this.db
      .prepare('UPDATE edit_applications SET task = ? WHERE id = ?')
      .run(JSON.stringify(task), task.id)
  }
  dismiss(id: string) {
    const { task } = this.job(id)
    if (['running', 'cancelling'].includes(task.status))
      throw new Error('Cancel the task before dismissing it.')
    this.db.prepare('DELETE FROM edit_application_results WHERE job_id = ?').run(id)
    this.db.prepare('DELETE FROM edit_application_targets WHERE job_id = ?').run(id)
    this.db.prepare('DELETE FROM edit_applications WHERE id = ?').run(id)
  }
}

export class EditApplicationStore extends EditApplicationReadStore {
  constructor(
    db: DatabaseSync,
    private writer: CatalogCommands,
  ) {
    super(db)
  }
  accept(manifest: EditApplicationManifest, task: BackgroundTask) {
    return this.writer.command({
      operation: 'edit-application.accept',
      payload: { manifest, task },
    })
  }
  result(
    commit: ApplicationCommit,
    result: Pick<EditApplicationResult, 'outcome' | 'message' | 'resultingRevision'>,
  ) {
    return this.writer.command({
      operation: 'edit-application.result',
      payload: { commit, result },
    })
  }
  task(task: BackgroundTask) {
    return this.writer.command({ operation: 'edit-application.task', payload: { task } })
  }
  dismiss(id: string) {
    return this.writer.command({ operation: 'edit-application.dismiss', payload: { id } })
  }
}
