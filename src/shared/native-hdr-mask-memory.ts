import type { ManagedImageBytes, ResourcePolicySnapshot } from './resource-policy'
import { validateManagedImageBytes } from './resource-policy'

/** Same local managed-image accounting as RAW preparation, never an OS/RSS cap. */
export function nativeHdrMaskMemory(
  width: number,
  height: number,
  existing: ManagedImageBytes,
  policy: Readonly<ResourcePolicySnapshot>,
  replacesDrainedJsScan = false,
) {
  validateManagedImageBytes(existing)
  if (
    ![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 32768) ||
    width * height * 16 > 512 * 1024 ** 2
  )
    throw new Error('Unsupported native mask source geometry.')
  const pixels = width * height,
    stripPixels = width * Math.min(height, 64),
    sourceStrip = stripPixels * 16
  // The existing planner's two R8 pyramids remain charged. Credit two existing
  // source strips only after the corresponding JS scan has actually drained.
  const credit = replacesDrainedJsScan ? sourceStrip * 2 : 0
  const additional = Object.freeze({
    ramBytes:
      sourceStrip * 2 -
      credit +
      stripPixels * 2 +
      pixels * 2 +
      1024 ** 2 +
      7 * 512 * 1024 +
      6 * 64 * 1024 +
      4096,
    vramBytes: 0,
  })
  const peak = Object.freeze({
    ramBytes: existing.ramBytes + additional.ramBytes,
    vramBytes: existing.vramBytes,
  })
  if (![peak.ramBytes, peak.vramBytes].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Invalid native mask managed reservation.')
  return Object.freeze({
    additional,
    peak,
    creditedJsSourceStripBytes: credit,
    accepted:
      peak.ramBytes <= policy.ram.effectiveBytes && peak.vramBytes <= policy.vram.effectiveBytes,
    scope: 'local-managed-hdr-mask-plus-explicit-existing-owners' as const,
  })
}
