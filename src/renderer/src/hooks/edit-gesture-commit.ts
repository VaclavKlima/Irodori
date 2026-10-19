import { sameAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import type { EditSettings, EditState } from '../../../shared/edits'
import { correctionKinds } from '../../../shared/lens'
import type { EditGestureCommit } from '../preview/edit-gesture'

export interface EditGestureScope {
  readonly photoId: string | undefined
  readonly enabled: boolean
}
export interface EditGestureCommitSnapshot {
  readonly scope: EditGestureScope
  readonly commit: EditGestureCommit
}

function parametersSnapshot(parameters: AdjustmentParameters): AdjustmentParameters {
  return Object.freeze({
    whiteBalance: parameters.whiteBalance
      ? Object.freeze({ ...parameters.whiteBalance })
      : undefined,
    exposureEv: parameters.exposureEv,
    contrast: parameters.contrast,
    highlights: parameters.highlights,
    shadows: parameters.shadows,
    whites: parameters.whites,
    blacks: parameters.blacks,
  })
}
function settingsKey(settings: EditSettings) {
  const white = settings.whiteBalance
  return JSON.stringify([
    settings.version,
    settings.processing,
    ...correctionKinds.map((kind) => settings.lens[kind]),
    white.mode,
    ...(white.mode === 'custom' ? [white.kelvin, white.tint] : []),
    settings.exposureEv,
    settings.contrast,
    settings.highlights,
    settings.shadows,
    settings.whites,
    settings.blacks,
  ])
}

/** One local write may authorize a handoff; observing the same pixels cannot accept it. */
export class EditGestureCommits {
  private scope: EditGestureScope | null = null
  private serial = 0
  private intent = 0
  private record: {
    snapshot: EditGestureCommitSnapshot
    baseSettings: string
    expectedSettings: string
  } | null = null

  get snapshot() {
    return this.record?.snapshot ?? null
  }
  get intentGeneration() {
    return this.intent
  }
  /** Awaiting local input must not resume after cancellation, history or scope replacement. */
  isActive(scope: EditGestureScope, intent = this.intent) {
    return this.scope === scope && scope.enabled && !!scope.photoId && intent === this.intent
  }
  enter(scope: EditGestureScope) {
    if (this.scope === scope) return
    this.scope = scope
    this.invalidate()
  }
  leave(scope: EditGestureScope) {
    if (this.scope !== scope) return
    this.scope = null
    this.invalidate()
  }
  invalidate() {
    this.intent++
    this.record = null
  }
  begin(
    scope: EditGestureScope,
    base: EditState,
    fromEpoch: number,
    parameters: AdjustmentParameters,
  ): EditGestureCommit | null {
    if (
      !this.isActive(scope) ||
      scope.photoId !== base.photoId ||
      sameAdjustments(base.settings, parameters)
    )
      return null
    const expectedSettings = settingsKey({
      ...base.settings,
      ...parameters,
      whiteBalance: parameters.whiteBalance ?? { mode: 'as-shot' },
    })
    const previous = this.record
    if (
      previous?.snapshot.scope === scope &&
      previous.snapshot.commit.fromEpoch === fromEpoch &&
      previous.snapshot.commit.baseRevision === base.revision &&
      previous.expectedSettings === expectedSettings
    )
      return previous.snapshot.commit
    const commit: EditGestureCommit = Object.freeze({
      id: ++this.serial,
      photoId: base.photoId,
      fromEpoch,
      baseRevision: base.revision,
      parameters: parametersSnapshot(parameters),
      phase: 'pending',
      revision: null,
    })
    this.record = {
      snapshot: Object.freeze({ scope, commit }),
      baseSettings: settingsKey(base.settings),
      expectedSettings,
    }
    return commit
  }
  observe(next: EditState) {
    const record = this.record
    if (!record || record.snapshot.commit.photoId !== next.photoId) return
    const { baseRevision } = record.snapshot.commit
    if (next.revision < baseRevision) return
    const settings = settingsKey(next.settings)
    if (
      (next.revision === baseRevision && settings === record.baseSettings) ||
      (next.revision === baseRevision + 1 && settings === record.expectedSettings)
    )
      return
    this.record = null
  }
  observeRevision(photoId: string, revision: number) {
    const commit = this.record?.snapshot.commit
    if (commit?.photoId === photoId && revision > commit.baseRevision + 1) this.record = null
  }
  succeeded(scope: EditGestureScope, id: number, next: EditState) {
    const record = this.record
    if (!record || !this.isActive(scope) || record.snapshot.commit.id !== id) return
    const commit = record.snapshot.commit
    if (
      next.photoId !== commit.photoId ||
      next.revision !== commit.baseRevision + 1 ||
      settingsKey(next.settings) !== record.expectedSettings
    ) {
      this.record = null
      return
    }
    if (commit.phase === 'accepted') return
    const accepted: EditGestureCommit = Object.freeze({
      ...commit,
      phase: 'accepted',
      revision: next.revision,
    })
    record.snapshot = Object.freeze({ scope, commit: accepted })
  }
  failed(scope: EditGestureScope, id: number) {
    if (this.isActive(scope) && this.record?.snapshot.commit.id === id) this.record = null
  }
}
