import type { AdjustmentParameters } from '../../../shared/adjustments'

interface EditGestureCommitBase {
  readonly id: number
  readonly photoId: string
  readonly fromEpoch: number
  readonly baseRevision: number
  /** Final parameters from a locally observed draft, never an external edit. */
  readonly parameters: AdjustmentParameters
}

/** Private renderer metadata; a pending local write does not establish acceptance. */
export type EditGestureCommit = EditGestureCommitBase &
  (
    | { readonly phase: 'pending'; readonly revision: null }
    | { readonly phase: 'accepted'; readonly revision: number }
  )
