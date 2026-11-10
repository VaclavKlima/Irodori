import reference from '../../assets/tests/references/mask-color/reference.json' with { type: 'json' }
import { neutralMaskEdge, type ResolvedMask } from '../../src/shared/masks'

/** All fractional reference coverage is exactly one half at this canonical point. */
export const maskColorReferencePoint = [0.75, 0.5] as const
export function maskColorReferenceMasks(caseId: string): ResolvedMask[] {
  const entry = reference.cases.find((item) => item.id === caseId)
  if (!entry) throw new Error(`Unknown mask-color reference case: ${caseId}`)
  return entry.masks.map((item, index) => ({
    id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    name: caseId,
    head: null,
    enabled: item.enabled,
    inverted: item.coverage === 1,
    edge: { ...neutralMaskEdge },
    light: { ...item.light },
    color: { ...item.color },
    strokes:
      item.coverage === 0.5
        ? [{ mode: 'add', radius: 0.5, feather: 1, points: [{ x: 0.5, y: 0.5 }] }]
        : [],
  }))
}
