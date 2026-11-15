import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  ADJUSTMENT_VERSION,
  adjustmentPixelKey,
  type AdjustmentParameters,
  type DisplayTransform,
} from '../../shared/adjustments'
import { validateHdrSource } from '../../shared/hdr'
import {
  identityMaskGeometry,
  maskOutputSize,
  validateMaskGeometry,
  type MaskGeometry,
} from '../../shared/mask-geometry'
import { frameByteLength, MAX_FRAME_BYTES } from '../../shared/preview-frame'
import type { DetailAdmission } from '../../shared/detail-resources'
import type { WorkingAsset } from '../working-assets'
import { validateDetailTransform } from './detail-identity'

export const PREPARED_MASK_STACK_POLICY = 'masked-texture-consumed-stack-v1'
export const PREPARED_MASK_STACK_GRID_POLICY = 'masked-texture-cropped-stack-v1'
export const PREPARED_MASK_STACK_CONSUMED = 'global-and-local-point-v1'

export interface PreparedMaskStackParent {
  readonly identity: string
  /** The original pre-point parent remains leased; creative pixels never replace this asset. */
  readonly asset: WorkingAsset
}

export interface PreparedMaskStackContext {
  readonly parent: PreparedMaskStackParent
  readonly adjustments: AdjustmentParameters
  readonly domain: 'raster' | 'scene-linear' | 'authored-hdr'
  readonly transform?: DisplayTransform
  readonly whiteBalance?: readonly number[]
  /** When available, the producer's independently frozen root/amount/coverage identity. */
  readonly textureIdentity?: string
}

export interface PreparedMaskStack {
  readonly policy: typeof PREPARED_MASK_STACK_POLICY
  readonly state: 'complete'
  readonly consumed: typeof PREPARED_MASK_STACK_CONSUMED
  readonly gridPolicy: typeof PREPARED_MASK_STACK_GRID_POLICY
  readonly domain: PreparedMaskStackContext['domain']
  readonly parent: PreparedMaskStackParent
  readonly context: string
  /** Ordered effective Texture roots, amounts, coverage and frozen filter policy. */
  readonly textureIdentity: string
  readonly candidate: {
    readonly path: string
    readonly width: number
    readonly height: number
    readonly byteLength: number
    readonly sha256: string
  }
  /** Source-bound final union, one unquantized Float32 coverage value per native pixel. */
  readonly union: {
    readonly path: string
    readonly byteLength: number
    readonly sha256: string
  }
  readonly key: string
}

export interface PreparedMaskStackRequest {
  readonly stack: PreparedMaskStack
  readonly admission: DetailAdmission
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const validHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Only the new receipt key aliases an explicit, verified no-op crop with its absent form. */
function pointGeometry(geometry: MaskGeometry): MaskGeometry {
  validateMaskGeometry(geometry)
  if (!geometry.crop?.identity) return geometry
  const { crop, ...uncropped } = geometry,
    size = maskOutputSize(uncropped),
    identity = [1, 0, 0, 1, 0, 0]
  if (
    crop.pixelAligned !== true ||
    crop.source.width !== size.width ||
    crop.source.height !== size.height ||
    crop.width !== size.width ||
    crop.height !== size.height ||
    ![crop.outputToSource, crop.sourceToOutput].every(
      (matrix) =>
        Array.isArray(matrix) &&
        matrix.length === identity.length &&
        matrix.every((value, index) => value === identity[index]),
    )
  )
    throw new Error('Invalid prepared mask stack identity crop.')
  return uncropped
}

function parentData(parent: PreparedMaskStackParent, domain: PreparedMaskStackContext['domain']) {
  const asset = parent?.asset
  if (
    !asset ||
    !validHash(parent.identity) ||
    !validHash(asset.sha256) ||
    typeof asset.path !== 'string' ||
    !isAbsolute(asset.path) ||
    !['raster', 'scene-linear', 'authored-hdr'].includes(domain) ||
    asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
    asset.byteLength > MAX_FRAME_BYTES ||
    asset.width * asset.height > 24_000_000 ||
    (domain === 'raster'
      ? Boolean(asset.hdr)
      : !asset.hdr || Boolean(asset.hdr.source?.display) !== (domain === 'authored-hdr'))
  )
    throw new Error('Invalid prepared mask stack parent or unsupported source domain.')
  validateDetailTransform(asset.transform)
  if (asset.hdr) {
    const hdr = asset.hdr
    validateHdrSource(hdr.source)
    if (
      hdr.kind !== 'hdr-working-v1' ||
      hdr.width !== asset.width ||
      hdr.height !== asset.height ||
      hdr.byteLength !== asset.byteLength ||
      hdr.sha256 !== asset.sha256 ||
      !Array.isArray(hdr.strips) ||
      hdr.strips.length !== Math.ceil(asset.height / 64) ||
      hdr.strips.some(
        (strip, index) =>
          strip.byteLength !== Math.min(64, asset.height - index * 64) * asset.width * 16 ||
          !validHash(strip.sha256),
      )
    )
      throw new Error('Invalid prepared mask stack scene-linear parent.')
  }
  const geometry = pointGeometry(
    asset.maskGeometry ??
      asset.hdr?.maskGeometry ??
      identityMaskGeometry(asset.width, asset.height),
  )
  if (
    asset.maskGeometry &&
    asset.hdr?.maskGeometry &&
    JSON.stringify(geometry) !== JSON.stringify(pointGeometry(asset.hdr.maskGeometry))
  )
    throw new Error('Conflicting prepared mask stack parent geometry.')
  return {
    identity: parent.identity,
    width: asset.width,
    height: asset.height,
    byteLength: asset.byteLength,
    sha256: asset.sha256,
    transform: asset.transform,
    source: asset.hdr?.source ?? null,
    whiteBalance: asset.hdr?.whiteBalance ?? null,
    strips: asset.hdr?.strips ?? null,
    maskGeometry: geometry,
  }
}

/** Pixel context only: moving a leased file or renaming a mask does not change consumption. */
export function preparedMaskStackContext(context: PreparedMaskStackContext): string {
  if (
    !context.adjustments ||
    ![
      context.adjustments.exposureEv,
      context.adjustments.contrast,
      context.adjustments.highlights,
      context.adjustments.shadows,
      context.adjustments.whites,
      context.adjustments.blacks,
      context.adjustments.saturation,
      context.adjustments.vibrance,
    ].every(Number.isFinite)
  )
    throw new Error('Invalid prepared mask stack point controls.')
  const parent = parentData(context.parent, context.domain),
    asset = context.parent.asset,
    geometry = pointGeometry(
      context.adjustments.maskGeometry ??
        asset.maskGeometry ??
        asset.hdr?.maskGeometry ??
        identityMaskGeometry(asset.width, asset.height),
    ),
    transform = context.transform ?? asset.transform
  validateDetailTransform(transform)
  const size = maskOutputSize(geometry)
  if (
    size.width !== asset.width ||
    size.height !== asset.height ||
    (context.whiteBalance &&
      (context.whiteBalance.length !== 9 || !context.whiteBalance.every(Number.isFinite)))
  )
    throw new Error('Invalid prepared mask stack point geometry or white balance.')
  // JSON encodes NaN/Infinity as null, which must never alias an admitted point context.
  JSON.stringify(context.adjustments, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Invalid prepared mask stack point controls.')
    return value
  })
  const key = adjustmentPixelKey({ ...context.adjustments, maskGeometry: geometry })
  return sha(
    JSON.stringify([
      PREPARED_MASK_STACK_POLICY,
      PREPARED_MASK_STACK_GRID_POLICY,
      PREPARED_MASK_STACK_CONSUMED,
      ADJUSTMENT_VERSION,
      context.domain,
      parent,
      geometry,
      key,
      transform,
      context.whiteBalance ?? null,
    ]),
  )
}

/** Completed creative-stage identity is separate from the upstream WorkingAsset identity. */
export function preparedMaskStackKey(stack: Omit<PreparedMaskStack, 'key'>): string {
  return sha(
    JSON.stringify([
      stack.policy,
      stack.state,
      stack.consumed,
      stack.gridPolicy,
      stack.domain,
      parentData(stack.parent, stack.domain),
      stack.context,
      stack.textureIdentity,
      stack.candidate.width,
      stack.candidate.height,
      stack.candidate.byteLength,
      stack.candidate.sha256,
      stack.union.byteLength,
      stack.union.sha256,
    ]),
  )
}

/** Metadata gate only. The worker separately hashes leased files and validates union/alpha on GPU. */
export function validatePreparedMaskStack(
  stack: PreparedMaskStack,
  context: PreparedMaskStackContext,
): void {
  if (
    !stack ||
    stack.policy !== PREPARED_MASK_STACK_POLICY ||
    stack.state !== 'complete' ||
    stack.consumed !== PREPARED_MASK_STACK_CONSUMED ||
    stack.gridPolicy !== PREPARED_MASK_STACK_GRID_POLICY ||
    stack.domain !== context.domain ||
    !validHash(stack.context) ||
    !validHash(stack.textureIdentity) ||
    !validHash(stack.key) ||
    !stack.candidate ||
    !stack.union ||
    !validHash(stack.candidate.sha256) ||
    !validHash(stack.union.sha256) ||
    typeof stack.candidate.path !== 'string' ||
    !isAbsolute(stack.candidate.path) ||
    typeof stack.union.path !== 'string' ||
    !isAbsolute(stack.union.path)
  )
    throw new Error('Invalid or incomplete prepared mask stack receipt.')
  const asset = context.parent.asset,
    expected = preparedMaskStackContext(context)
  if (
    stack.context !== expected ||
    preparedMaskStackContext({ ...context, parent: stack.parent }) !== expected ||
    stack.candidate.width !== asset.width ||
    stack.candidate.height !== asset.height ||
    stack.candidate.byteLength !== asset.byteLength ||
    stack.union.byteLength !== asset.width * asset.height * 4 ||
    (context.textureIdentity !== undefined && stack.textureIdentity !== context.textureIdentity) ||
    new Set([asset.path, stack.candidate.path, stack.union.path].map((path) => resolve(path)))
      .size !== 3 ||
    new Set(
      [stack.parent.asset.path, stack.candidate.path, stack.union.path].map((path) =>
        resolve(path),
      ),
    ).size !== 3 ||
    preparedMaskStackKey(stack) !== stack.key
  )
    throw new Error('Prepared mask stack does not match its parent, point context or native grid.')
}
