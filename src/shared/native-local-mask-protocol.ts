import type { AdjustmentParameters } from './adjustments'
import { maskColorBalanceMatrices } from './mask-color'
import { clippingCoverageMasks } from './clipping-coverage'
import { maskCapabilities, validateMaskColor, validateMaskLight } from './masks'
import { NATIVE_MASK_REQUEST_BYTES } from './native-color-protocol'

export const NATIVE_LOCAL_MASK_BYTES = 128

/** Top-first roots match the GPU coverage strip's pixel-major component order. */
export const nativeLocalMaskRoots = clippingCoverageMasks

/** Bounded coefficients only; coverage is supplied by the existing GPU stage. */
export function nativeLocalMaskValues(
  parameters: Pick<AdjustmentParameters, 'localMasks'>,
): Float64Array<ArrayBuffer> {
  const roots = nativeLocalMaskRoots(parameters)
  if (roots.length > maskCapabilities.maxMasks) throw new Error('Too many clipping masks.')
  for (const mask of roots) {
    validateMaskLight(mask.light)
    validateMaskColor(mask.color)
  }
  return new Float64Array(
    roots.flatMap((mask) => [
      mask.light.exposureEv,
      mask.light.contrast,
      mask.light.highlights,
      mask.light.shadows,
      mask.light.whites,
      mask.light.blacks,
      mask.color.saturation,
      ...(maskColorBalanceMatrices(mask.color)?.rec2020 ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    ]),
  )
}

/** Validate the echoed packet envelope before allocating a response buffer. */
export function nativeMaskRequestLength(request: Uint8Array): number {
  if (request.byteLength < NATIVE_MASK_REQUEST_BYTES)
    throw new Error('Invalid admitted mask request.')
  const view = new DataView(request.buffer, request.byteOffset, request.byteLength),
    version = view.getUint32(8, true),
    count = view.getUint32(28, true),
    magic = new TextDecoder().decode(request.subarray(0, 8)),
    length = NATIVE_MASK_REQUEST_BYTES + count * NATIVE_LOCAL_MASK_BYTES
  if (
    count > maskCapabilities.maxMasks ||
    request.byteLength !== length ||
    (count === 0 ? magic !== 'MASKCPU3' || version !== 3 : magic !== 'MASKCPU4' || version !== 4)
  )
    throw new Error('Invalid admitted mask request.')
  return length
}
