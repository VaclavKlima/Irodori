import type { WorkingFrame } from '../../../shared/adjustments'
import { hdrSourceIdentity } from './hdr-source-cache'

/** Main/loader lineage checks precede this local geometry and rendering-domain check. */
export function checkedHdrComparison(after: WorkingFrame, before: WorkingFrame) {
  if (
    !after.hdr ||
    !before.hdr ||
    before.width !== after.width ||
    before.height !== after.height ||
    before.hdr.width !== before.width ||
    before.hdr.height !== before.height ||
    JSON.stringify(before.transform) !== JSON.stringify(after.transform) ||
    JSON.stringify(before.hdr.source) !== JSON.stringify(after.hdr.source) ||
    JSON.stringify(before.hdr.whiteBalance) !== JSON.stringify(after.hdr.whiteBalance)
  )
    throw new Error('The HDR comparison source does not match its edited frame.')
  const identity = hdrSourceIdentity(before.hdr)
  if (identity.key === hdrSourceIdentity(after.hdr).key) return undefined
  // Freeze small capabilities/metadata before the first asynchronous boundary.
  return {
    frame: {
      ...before,
      hdr: structuredClone(before.hdr),
      cpuSource: before.cpuSource ? { ...before.cpuSource } : undefined,
    },
    identity,
  }
}
