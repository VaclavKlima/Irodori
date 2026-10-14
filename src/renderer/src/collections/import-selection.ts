import type { ImportCandidate, ImportReviewSummary } from '../../../shared/contracts'

export interface SelectionChange {
  version: number
  ids: string[] | null
  selected: boolean
  previous: boolean
  bytes: number
}
export function applyReviewSelection(
  review: ImportReviewSummary,
  changes: SelectionChange[],
): ImportReviewSummary {
  let current = review
  for (const change of changes) {
    if (change.version <= review.selectionRevision) continue
    current = {
      ...current,
      selected:
        change.ids === null
          ? change.selected
            ? current.unchecked +
              current.ready -
              (current.onlyMissing ? current.alreadyImported : 0)
            : 0
          : current.selected + (change.selected === change.previous ? 0 : change.selected ? 1 : -1),
      selectedBytes:
        change.ids === null
          ? change.selected
            ? current.totalBytes - (current.onlyMissing ? current.alreadyImportedBytes : 0)
            : 0
          : current.selectedBytes +
            (change.selected === change.previous
              ? 0
              : change.selected
                ? change.bytes
                : -change.bytes),
    }
  }
  return current
}
export function applyCandidateSelection(
  candidate: ImportCandidate,
  selectionRevision: number,
  changes: SelectionChange[],
  onlyMissing?: boolean,
): ImportCandidate {
  if (
    !['unchecked', 'ready'].includes(candidate.status) ||
    (onlyMissing && candidate.alreadyImported)
  )
    return candidate
  let selected = candidate.selected
  for (const change of changes)
    if (
      change.version > selectionRevision &&
      (change.ids === null || change.ids.includes(candidate.id))
    )
      selected = change.selected
  return selected === candidate.selected ? candidate : { ...candidate, selected }
}
