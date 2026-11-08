import { maskCanonicalPoint, type MaskGeometry } from './mask-geometry'
import type { ResolvedMask } from './masks'

export const objectSelectionCapabilities = {
  version: 1,
  model: 'sam2.1-hiera-tiny',
  backend: 'native-webgpu',
  prompts: ['box', 'positive-point', 'negative-point'],
  maxPromptSlots: 6,
  maxPixels: 32_000_000,
  maxDimension: 8192,
  manualCorrection: ['paint', 'erase', 'size', 'feather'],
  automaticMatting: false,
} as const

export interface ObjectSelectionPrompts {
  /** Canonical oriented, uncorrected source coordinates, normalized to [0,1]. */
  box?: [number, number, number, number]
  positivePoints: [number, number][]
  negativePoints: [number, number][]
}
export interface ObjectSelectionContext {
  photoId: string
  revision: number
  gridIdentity: string
  /** Complete current photograph dimensions, independent of zoom and pan. */
  width: number
  height: number
  geometry: MaskGeometry
  model: typeof objectSelectionCapabilities.model
  capabilities: typeof objectSelectionCapabilities
}
export interface ObjectSelectionRequest {
  photoId: string
  expectedRevision: number
  gridIdentity: string
  prompts: ObjectSelectionPrompts
  /** Replacing this base preserves every existing manual correction and control. */
  maskId?: string
}
export interface ObjectSelectionProposal {
  id: string
  photoId: string
  revision: number
  gridIdentity: string
  mask: ResolvedMask
  modelIdentity: string
}
export interface AcceptObjectSelection {
  proposalId: string
  photoId: string
  expectedRevision: number
}

const hash = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function validateSelectionTarget(photoId: unknown, revision: unknown): void {
  if (
    typeof photoId !== 'string' ||
    !hash.test(photoId) ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  )
    throw new Error('Supply a confirmed photograph and revision for object selection.')
}
export function validateObjectSelectionPrompts(value: unknown): ObjectSelectionPrompts {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !['box', 'positivePoints', 'negativePoints'].includes(key)) ||
    !Array.isArray(value.positivePoints) ||
    !Array.isArray(value.negativePoints)
  )
    throw new Error('Supply a box or positive point, with explicit positive/negative point lists.')
  const normalized = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  for (const point of [...value.positivePoints, ...value.negativePoints])
    if (!Array.isArray(point) || point.length !== 2 || !point.every(normalized))
      throw new Error('Selection points must be finite normalized source coordinates.')
  if (
    value.box !== undefined &&
    (!Array.isArray(value.box) ||
      value.box.length !== 4 ||
      !value.box.every(normalized) ||
      value.box[0] >= value.box[2] ||
      value.box[1] >= value.box[3])
  )
    throw new Error('The selection box is empty or outside the source photograph.')
  if (value.box === undefined && !value.positivePoints.length)
    throw new Error('Start object selection with a box or a positive point.')
  if (
    (value.box === undefined ? 0 : 2) + value.positivePoints.length + value.negativePoints.length >
    objectSelectionCapabilities.maxPromptSlots
  )
    throw new Error(
      'Object selection supports six prompt slots. A box uses two; remove a point or use Paint/Erase.',
    )
  return structuredClone(value) as unknown as ObjectSelectionPrompts
}
export function validateObjectSelectionRequest(value: unknown): ObjectSelectionRequest {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['photoId', 'expectedRevision', 'gridIdentity', 'prompts', 'maskId'].includes(key),
    ) ||
    typeof value.gridIdentity !== 'string' ||
    !hash.test(value.gridIdentity) ||
    (value.maskId !== undefined && (typeof value.maskId !== 'string' || !uuid.test(value.maskId)))
  )
    throw new Error('Invalid object-selection request. Refresh the photograph context.')
  validateSelectionTarget(value.photoId, value.expectedRevision)
  return {
    ...(value as unknown as ObjectSelectionRequest),
    prompts: validateObjectSelectionPrompts(value.prompts),
  }
}
export function validateAcceptObjectSelection(value: unknown): AcceptObjectSelection {
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) => !['proposalId', 'photoId', 'expectedRevision'].includes(key),
    ) ||
    typeof value.proposalId !== 'string' ||
    !uuid.test(value.proposalId)
  )
    throw new Error('Invalid selection proposal. Generate the selection again.')
  validateSelectionTarget(value.photoId, value.expectedRevision)
  return value as unknown as AcceptObjectSelection
}

export interface SelectionPoint {
  x: number
  y: number
}
export interface SelectionRectangle extends SelectionPoint {
  width: number
  height: number
}

export function selectionCanonicalPoint(point: SelectionPoint, geometry: MaskGeometry) {
  const canonical = maskCanonicalPoint(point, geometry)
  return [canonical.x, canonical.y].every(
    (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  )
    ? ([canonical.x, canonical.y] as [number, number])
    : null
}

/** A box guides segmentation, rather than clipping its result to an exact ROI.
 * Sample its displayed perimeter through crop/lens mapping and pad the enclosing
 * canonical prompt by one native pixel. The visible rectangle stays on its grid.
 */
export function selectionCanonicalBox(
  start: SelectionPoint,
  end: SelectionPoint,
  geometry: MaskGeometry,
): { rectangle: SelectionRectangle; box: [number, number, number, number] } | null {
  const x = Math.min(start.x, end.x),
    y = Math.min(start.y, end.y),
    width = Math.abs(end.x - start.x),
    height = Math.abs(end.y - start.y)
  if (width < 1 || height < 1) return null
  const points: [number, number][] = []
  for (let index = 0; index <= 16; index++) {
    const fraction = index / 16
    for (const point of [
      { x: x + width * fraction, y },
      { x: x + width * fraction, y: y + height },
      { x, y: y + height * fraction },
      { x: x + width, y: y + height * fraction },
    ]) {
      const canonical = selectionCanonicalPoint(point, geometry)
      if (!canonical) return null
      points.push(canonical)
    }
  }
  return {
    rectangle: { x, y, width, height },
    box: [
      Math.max(0, Math.min(...points.map((point) => point[0])) - 1 / geometry.canonicalWidth),
      Math.max(0, Math.min(...points.map((point) => point[1])) - 1 / geometry.canonicalHeight),
      Math.min(1, Math.max(...points.map((point) => point[0])) + 1 / geometry.canonicalWidth),
      Math.min(1, Math.max(...points.map((point) => point[1])) + 1 / geometry.canonicalHeight),
    ],
  }
}
