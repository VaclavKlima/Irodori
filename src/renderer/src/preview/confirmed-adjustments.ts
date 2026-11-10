import { snapshotAdjustments, type AdjustmentParameters } from '../../../shared/adjustments'
import type { EditState } from '../../../shared/edits'
import { validateMaskGeometry, type MaskGeometry } from '../../../shared/mask-geometry'
import { resolveMasks } from '../../../shared/masks'
import { hasLocalMasks } from '../../../shared/masks-gpu'
import type { EditGestureCommit } from './edit-gesture'

export interface ConfirmedAdjustmentSource {
  readonly photoId: string
  readonly maskGeometry?: MaskGeometry
}

function bindGeometry(
  parameters: AdjustmentParameters,
  photoId: string,
  source?: ConfirmedAdjustmentSource,
): AdjustmentParameters | null {
  if (source && source.photoId !== photoId) return null
  const geometry = source?.maskGeometry
  if (!geometry) return hasLocalMasks(parameters) ? null : parameters
  try {
    validateMaskGeometry(geometry)
  } catch {
    return null
  }
  return { ...parameters, maskGeometry: structuredClone(geometry) }
}

/** Resolve only accepted durable content; rendered drafts never establish confirmation. */
export function confirmedAdjustments(
  state: EditState | null,
  photoId: string | undefined,
  source?: ConfirmedAdjustmentSource,
): AdjustmentParameters | null {
  if (!state || !photoId || state.photoId !== photoId) return null
  const parameters = {
    ...snapshotAdjustments(state.settings),
    localMasks: structuredClone(
      resolveMasks(state.settings.maskStack, state.maskContent ?? [], state.maskBases ?? []),
    ),
  }
  return bindGeometry(parameters, photoId, source)
}

/** A local token owns its captured coverage; only its current source grid is bound here. */
export function confirmedGestureCommit(
  commit: EditGestureCommit | null,
  photoId: string | undefined,
  source?: ConfirmedAdjustmentSource,
): EditGestureCommit | null {
  if (!commit || !photoId || commit.photoId !== photoId) return null
  const parameters = bindGeometry(commit.parameters, photoId, source)
  return parameters ? { ...commit, parameters } : null
}
