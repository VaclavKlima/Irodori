import type { AdjustmentParameters } from './adjustments'
import { neutralAdjustments } from './adjustments'
import { validatePatch } from './edits'
import { validateTarget, type DisplayTarget } from './hdr'
import type { ResourcePolicySnapshot } from './resource-policy'
import type { WhiteBalanceProfile } from './white-balance'
import { PREVIEW_ASSET_VERSION } from './preview-frame'

export const HDR_FIRST_SURFACE_VERSION = 'hdr-first-surface-v1' as const
export interface HdrFirstSurfaceManagedBytes {
  readonly ramBytes: number
  readonly vramBytes: number
}
export interface HdrFirstSurfaceView {
  readonly fit: boolean
  readonly scale: number
  readonly x: number
  readonly y: number
}

/** Display snapshot only. Source paths, source policy and budgets are main-owned. */
export interface HdrFirstSurfaceRequest {
  readonly version: typeof HDR_FIRST_SURFACE_VERSION
  readonly generation: number
  readonly settingsRevision: number
  readonly parameters: Readonly<AdjustmentParameters>
  readonly target: Readonly<DisplayTarget>
  readonly viewport: { readonly width: number; readonly height: number }
  readonly dpr: number
  readonly view: HdrFirstSurfaceView
  readonly comparison: 'before' | 'after' | 'split'
  readonly split: number
  readonly hdrRanges: boolean
  readonly kernel: 'linear64'
  /** Existing browser owners, captured after earlier presenters retire. */
  readonly rendererReservation: HdrFirstSurfaceManagedBytes
}

/** Main/worker only: the verified preparation key exists before the final F32 hash. */
export interface HdrFirstSurfaceRenderRequest extends HdrFirstSurfaceRequest {
  readonly originalSha256: string
  readonly parentWorkingKey: string
  readonly image: { readonly width: number; readonly height: number }
  readonly whiteBalance?: Readonly<WhiteBalanceProfile>
  readonly sourceIdentity: Readonly<Record<string, unknown>>
  readonly policy: Readonly<ResourcePolicySnapshot>
}
export type HdrFirstSurfacePreparation = Omit<
  HdrFirstSurfaceRenderRequest,
  'image' | 'whiteBalance' | 'sourceIdentity'
>

export type HdrFirstSurfaceIdentity = Omit<
  HdrFirstSurfaceRenderRequest,
  'rendererReservation' | 'policy'
>

export const HDR_FIRST_SURFACE_ORIENTATION_VERSION = 'decoder-flip-before-first-mip-v1' as const
export interface HdrFirstSurfaceOrientation {
  readonly version: typeof HDR_FIRST_SURFACE_ORIENTATION_VERSION
  readonly decoderFlip: number
  readonly corrected: { readonly width: number; readonly height: number }
  readonly selectedLevel: number
  readonly firstMip: 'source' | 'ordinary' | 'oriented'
}

/** A transient rendered viewport, never a full-resolution working asset. */
export interface HdrFirstSurfaceOffer {
  readonly version: typeof HDR_FIRST_SURFACE_VERSION
  readonly photoId: string
  readonly requestId: string
  readonly surfaceId: string
  readonly identity: HdrFirstSurfaceIdentity
  readonly policy: Readonly<ResourcePolicySnapshot>
  readonly width: number
  readonly height: number
  readonly format: 'rgba16float-le'
  readonly byteLength: number
  readonly sha256: string
  readonly url: string
}

const requestFields = [
  'version',
  'generation',
  'settingsRevision',
  'parameters',
  'target',
  'viewport',
  'dpr',
  'view',
  'comparison',
  'split',
  'hdrRanges',
  'kernel',
  'rendererReservation',
] as const
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Geometry follows the decoder's existing mirror-then-transpose readback policy. */
export function hdrFirstSurfaceImage(
  corrected: { readonly width: number; readonly height: number },
  decoderFlip: number,
): { readonly width: number; readonly height: number } {
  if (
    !integer(corrected?.width, 1) ||
    !integer(corrected?.height, 1) ||
    !integer(corrected.width * corrected.height * 16, 1) ||
    !integer(decoderFlip) ||
    decoderFlip > 7
  )
    throw new Error('Invalid first HDR surface decoder geometry.')
  return Object.freeze(
    decoderFlip & 4
      ? { width: corrected.height, height: corrected.width }
      : { width: corrected.width, height: corrected.height },
  )
}

/** The normal cache plan's centered-Fit level, independent of device pixel density. */
export function hdrFirstSurfaceMipLevel(
  image: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): number {
  hdrFirstSurfaceImage(image, 0)
  if (
    !finite(viewport?.width) ||
    viewport.width <= 0 ||
    !finite(viewport?.height) ||
    viewport.height <= 0
  )
    throw new Error('Invalid first HDR surface viewport.')
  const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height)
  return Math.max(
    0,
    Math.min(
      Math.floor(Math.log2(Math.max(image.width, image.height))),
      Math.floor(Math.log2(1 / scale)),
    ),
  )
}

export function hdrFirstSurfaceOrientation(
  corrected: { readonly width: number; readonly height: number },
  decoderFlip: number,
  selectedLevel: number,
): Readonly<HdrFirstSurfaceOrientation> {
  const image = hdrFirstSurfaceImage(corrected, decoderFlip)
  if (
    !integer(selectedLevel) ||
    selectedLevel > Math.floor(Math.log2(Math.max(image.width, image.height))) ||
    (decoderFlip !== 0 && selectedLevel === 0)
  )
    throw new Error('Unsupported first HDR surface orientation level.')
  return Object.freeze({
    version: HDR_FIRST_SURFACE_ORIENTATION_VERSION,
    decoderFlip,
    corrected: Object.freeze({ width: corrected.width, height: corrected.height }),
    selectedLevel,
    firstMip: selectedLevel === 0 ? 'source' : decoderFlip === 0 ? 'ordinary' : 'oriented',
  })
}

/** Verify a retained half against its actual corrected geometry and normal mip selection. */
export function validateHdrFirstSurfaceOrientation(
  value: unknown,
  image: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): asserts value is HdrFirstSurfaceOrientation {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !object(value.corrected) ||
    Object.keys(value.corrected).length !== 2
  )
    throw new Error('Invalid first HDR surface orientation identity.')
  const corrected = value.corrected as unknown as HdrFirstSurfaceOrientation['corrected']
  const expectedImage = hdrFirstSurfaceImage(corrected, value.decoderFlip as number)
  const expected = hdrFirstSurfaceOrientation(
    corrected,
    value.decoderFlip as number,
    hdrFirstSurfaceMipLevel(image, viewport),
  )
  if (
    image.width !== expectedImage.width ||
    image.height !== expectedImage.height ||
    value.version !== expected.version ||
    value.selectedLevel !== expected.selectedLevel ||
    value.firstMip !== expected.firstMip
  )
    throw new Error('The first HDR surface orientation does not match its source or mip.')
}

export function validateHdrFirstSurfaceRequest(
  value: unknown,
): asserts value is HdrFirstSurfaceRequest {
  if (
    !object(value) ||
    Object.keys(value).length !== requestFields.length ||
    Object.keys(value).some(
      (key) => !requestFields.includes(key as (typeof requestFields)[number]),
    ) ||
    value.version !== HDR_FIRST_SURFACE_VERSION ||
    !integer(value.generation, 1) ||
    !integer(value.settingsRevision) ||
    !object(value.parameters) ||
    Object.keys(value.parameters).length !== Object.keys(neutralAdjustments).length ||
    Object.keys(neutralAdjustments).some(
      (key) => !Object.prototype.hasOwnProperty.call(value.parameters, key),
    ) ||
    !object(value.viewport) ||
    !finite(value.viewport.width) ||
    value.viewport.width <= 0 ||
    !finite(value.viewport.height) ||
    value.viewport.height <= 0 ||
    !finite(value.dpr) ||
    value.dpr <= 0 ||
    value.dpr > 4 ||
    !object(value.view) ||
    typeof value.view.fit !== 'boolean' ||
    !finite(value.view.scale) ||
    value.view.scale <= 0 ||
    !finite(value.view.x) ||
    !finite(value.view.y) ||
    !['before', 'after', 'split'].includes(String(value.comparison)) ||
    !finite(value.split) ||
    value.split < 0 ||
    value.split > 1 ||
    typeof value.hdrRanges !== 'boolean' ||
    value.kernel !== 'linear64' ||
    !object(value.rendererReservation) ||
    !integer(value.rendererReservation.ramBytes) ||
    !integer(value.rendererReservation.vramBytes)
  )
    throw new Error('Invalid first HDR surface request.')
  validatePatch(value.parameters)
  validateTarget(value.target as unknown as DisplayTarget)
  const target = value.target as DisplayTarget
  if (
    target.headroom !== null &&
    (!finite(target.headroom) || target.headroom < 1 || target.headroom > 100)
  )
    throw new Error('Invalid first HDR surface headroom.')
  const width = Math.round(value.viewport.width * value.dpr)
  const height = Math.round(value.viewport.height * value.dpr)
  if (!integer(width, 1) || !integer(height, 1) || !integer(width * height * 8, 1))
    throw new Error('Invalid first HDR surface extent.')
}

/** Ordering is explicit so equivalent adjustment objects have the same display key. */
export function hdrFirstSurfaceRequestKey(request: HdrFirstSurfaceRequest): string {
  validateHdrFirstSurfaceRequest(hdrFirstSurfaceSnapshot(request))
  const p = request.parameters,
    t = request.target
  return JSON.stringify([
    HDR_FIRST_SURFACE_VERSION,
    request.generation,
    request.settingsRevision,
    [
      p.exposureEv,
      p.contrast,
      p.highlights,
      p.shadows,
      p.whites,
      p.blacks,
      p.whiteBalance?.mode === 'custom'
        ? ['custom', p.whiteBalance.kelvin, p.whiteBalance.tint]
        : ['as-shot'],
    ],
    [t.outputVersion, t.generation, t.mode, t.colorSpace, t.peak, t.headroom],
    [request.viewport.width, request.viewport.height],
    request.dpr,
    [
      request.view.fit,
      request.view.fit ? null : request.view.scale,
      request.view.x,
      request.view.y,
    ],
    request.comparison,
    request.split,
    request.hdrRanges,
    request.kernel,
  ])
}

/** Select only the display fields from an internally enriched preparation identity. */
export function hdrFirstSurfaceSnapshot(request: HdrFirstSurfaceRequest): HdrFirstSurfaceRequest {
  return Object.fromEntries(
    requestFields.map((key) => [key, request[key]]),
  ) as unknown as HdrFirstSurfaceRequest
}

export function hdrFirstSurfaceOfferMatches(
  offer: HdrFirstSurfaceOffer,
  request: HdrFirstSurfaceRequest,
  photoId: string,
  requestId: string,
): boolean {
  try {
    return checkedOfferMatches(offer, request, photoId, requestId)
  } catch {
    return false
  }
}

function checkedOfferMatches(
  offer: HdrFirstSurfaceOffer,
  request: HdrFirstSurfaceRequest,
  photoId: string,
  requestId: string,
): boolean {
  const identity = offer.identity
  const width = Math.round(request.viewport.width * request.dpr)
  const height = Math.round(request.viewport.height * request.dpr)
  if (
    offer.version !== HDR_FIRST_SURFACE_VERSION ||
    offer.photoId !== photoId ||
    offer.requestId !== requestId ||
    identity.originalSha256 !== photoId ||
    !/^[a-f0-9]{64}$/.test(identity.parentWorkingKey) ||
    !/^[a-f0-9]{64}$/.test(offer.sha256) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(offer.surfaceId) ||
    offer.url !==
      `luma-photo://library/${photoId}/first/${PREVIEW_ASSET_VERSION}/${offer.surfaceId}` ||
    offer.format !== 'rgba16float-le' ||
    offer.width !== width ||
    offer.height !== height ||
    offer.byteLength !== width * height * 8 ||
    !integer(identity.image.width, 1) ||
    !integer(identity.image.height, 1) ||
    !integer(identity.image.width * identity.image.height * 16, 1) ||
    identity.image.width * identity.image.height * 16 > 512 * 1024 ** 2
  )
    return false
  if (identity.view.fit) {
    const fit = Math.min(
      1,
      request.viewport.width / identity.image.width,
      request.viewport.height / identity.image.height,
    )
    if (identity.view.scale !== fit || identity.view.x !== 0 || identity.view.y !== 0) return false
  }
  return (
    hdrFirstSurfaceRequestKey({ ...identity, rendererReservation: request.rendererReservation }) ===
    hdrFirstSurfaceRequestKey(request)
  )
}
