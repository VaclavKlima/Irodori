import { sameAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import type { EditGestureCommit } from './edit-gesture'

export interface HdrGestureConfirmation {
  readonly revision: number
  readonly settings: AdjustmentParameters
}
export interface HdrGestureEditing {
  readonly gesturing: boolean
  readonly epoch: number
  readonly commit: EditGestureCommit | null
  readonly confirmed: HdrGestureConfirmation | null
  readonly context: string | null
  readonly nativePresented: boolean
}
export type HdrGestureStage = 'feedback' | 'refinement'
export type HdrGesturePlan = 'ordinary' | 'hold' | HdrGestureStage

/** One local draft may finish with one transient image and one confirmed refinement. */
export class HdrGestureHandoff {
  private editing?: HdrGestureEditing
  private observed?: { epoch: number; revision: number; context: string }
  private active?: {
    commit: EditGestureCommit
    context: string
    feedback: 'needed' | 'queued' | 'presented'
    refinement: 'needed' | 'queued' | 'presented'
    feedbackSerial?: number
    refinementSerial?: number
  }
  private retired = 0
  private visible?: { context: string; epoch: number; parameters: AdjustmentParameters }

  update(next: HdrGestureEditing) {
    const previous = this.editing
    this.editing = structuredClone(next)
    if (next.gesturing && !previous?.gesturing) {
      this.invalidate()
      if (next.nativePresented && next.context && next.confirmed)
        this.observed = {
          epoch: next.epoch,
          revision: next.confirmed.revision,
          context: next.context,
        }
    }
    const commit = next.commit,
      observed = this.observed
    if (
      !commit ||
      !observed ||
      !next.nativePresented ||
      next.context !== observed.context ||
      commit.fromEpoch !== observed.epoch ||
      commit.baseRevision !== observed.revision ||
      commit.id <= this.retired ||
      next.epoch < commit.fromEpoch ||
      next.epoch > commit.fromEpoch + 1 ||
      (commit.phase === 'accepted' && commit.revision !== commit.baseRevision + 1) ||
      (this.active && this.active.commit.id !== commit.id)
    ) {
      if (this.active) this.invalidate()
      if (previous && previous.epoch !== next.epoch) this.observed = undefined
      return false
    }
    if (
      next.confirmed &&
      (next.confirmed.revision >
        (commit.phase === 'accepted' ? commit.revision : commit.baseRevision + 1) ||
        (next.confirmed.revision > commit.baseRevision &&
          !sameAdjustments(next.confirmed.settings, commit.parameters)))
    ) {
      this.invalidate()
      return false
    }
    if (this.active) {
      if (
        this.active.commit.photoId !== commit.photoId ||
        (this.active.commit.phase === 'accepted' && commit.phase !== 'accepted') ||
        !sameAdjustments(this.active.commit.parameters, commit.parameters)
      ) {
        this.invalidate()
        return false
      }
      this.active.commit = structuredClone(commit)
    } else {
      const alreadyVisible =
        this.visible?.context === observed.context &&
        this.visible.epoch === commit.fromEpoch &&
        sameAdjustments(this.visible.parameters, commit.parameters)
      this.active = {
        commit: structuredClone(commit),
        context: observed.context,
        feedback: alreadyVisible ? 'presented' : 'needed',
        refinement: 'needed',
      }
    }
    return true
  }

  get id() {
    return this.active?.commit.id
  }
  get pending() {
    return !!this.active && this.active.refinement !== 'presented'
  }
  get phase() {
    if (!this.active) return 'idle'
    if (this.active.feedback !== 'presented') return 'feedback'
    if (this.active.commit.phase === 'pending') return 'awaiting-acceptance'
    if (!this.confirmed()) return 'awaiting-confirmation'
    return this.active.refinement === 'presented' ? 'complete' : 'refinement'
  }
  private confirmed() {
    const commit = this.active?.commit,
      confirmed = this.editing?.confirmed
    return (
      commit?.phase === 'accepted' &&
      confirmed?.revision === commit.revision &&
      sameAdjustments(confirmed.settings, commit.parameters)
    )
  }
  plan(context: string, parameters: AdjustmentParameters): HdrGesturePlan {
    const active = this.active
    if (!active) return 'ordinary'
    if (context !== active.context || !sameAdjustments(parameters, active.commit.parameters)) {
      this.invalidate()
      return 'ordinary'
    }
    if (active.feedback === 'needed') return 'feedback'
    if (active.feedback === 'queued') return 'hold'
    if (active.refinement === 'needed' && this.confirmed()) return 'refinement'
    // Retain the completed marker until the next actual change, avoiding duplicate draws.
    return 'hold'
  }
  queued(stage: HdrGestureStage, serial: number) {
    if (!this.active || this.active[stage] !== 'needed') return false
    if (stage === 'refinement' && (this.active.feedback !== 'presented' || !this.confirmed()))
      return false
    this.active[stage] = 'queued'
    this.active[`${stage}Serial`] = serial
    return true
  }
  authorize(
    id: number,
    stage: HdrGestureStage,
    context: string,
    parameters: AdjustmentParameters,
    serial?: number,
  ): { revision: number | null } | null {
    const active = this.active,
      editing = this.editing
    if (
      !active ||
      !editing ||
      id !== active.commit.id ||
      context !== active.context ||
      !sameAdjustments(parameters, active.commit.parameters) ||
      active[stage] === 'presented' ||
      (serial !== undefined &&
        (active[stage] !== 'queued' || active[`${stage}Serial`] !== serial)) ||
      (stage === 'refinement' && !this.confirmed())
    )
      return null
    return {
      revision:
        stage === 'refinement' && active.commit.phase === 'accepted'
          ? active.commit.revision
          : null,
    }
  }
  published(
    context: string,
    epoch: number,
    parameters: AdjustmentParameters,
    interactive: boolean,
    handoff?: { id: number; stage: HdrGestureStage; serial: number },
  ) {
    if (handoff && !this.authorize(handoff.id, handoff.stage, context, parameters, handoff.serial))
      return false
    this.visible = interactive
      ? { context, epoch, parameters: structuredClone(parameters) }
      : undefined
    if (handoff) this.active![handoff.stage] = 'presented'
    return true
  }
  /** Queue invalidation discards work, while an unconfirmed local draft may remain metadata. */
  invalidateQueued(id?: number, serial?: number) {
    if (!this.active || (id !== undefined && id !== this.active.commit.id)) return
    for (const stage of ['feedback', 'refinement'] as const)
      if (
        this.active[stage] === 'queued' &&
        (serial === undefined || this.active[`${stage}Serial`] === serial)
      ) {
        this.active[stage] = 'needed'
        delete this.active[`${stage}Serial`]
      }
  }
  invalidate() {
    if (this.active) this.retired = Math.max(this.retired, this.active.commit.id)
    this.active = undefined
    this.observed = undefined
  }
}
