import type { CropAdmission } from './crop-resources'

const MIB = 1024 ** 2
const MODEL_ALLOWANCE = 512 * MIB
const MODEL_INPUT = 3 * 1024 * 1024 * 4

/** Managed image estimates, not a measurement or hard cap of opaque driver heaps. */
export function objectSelectionMemoryPlan(
  width: number,
  height: number,
  admission: CropAdmission,
  selection?: 'sky' | 'background',
) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 8192) ||
    width * height > 32_000_000
  )
    throw new Error('Invalid object-selection resource dimensions.')
  const pixels = width * height
  const modelAllowance = selection ? 1024 * MIB : MODEL_ALLOWANCE
  // The source worker closes before inference. Preprocessing buffers are destroyed
  // before encoder execution; reconstruction runs after decoder completion.
  const preprocessing = pixels * 4 + 1024 * Math.min(width, height) * 16 + 2 * MODEL_INPUT + 16
  const guideEdge = selection === 'background' ? 1024 : 128
  const reconstruction = selection
    ? pixels * 6 + guideEdge * guideEdge * (16 + 3 * 64 + 2 * 16) + 32
    : Math.ceil(pixels / 4) * 8 + 256 * 256 * 4 + 16
  const sourcePreparation = pixels * 12
  const additionalVram = Math.max(
    sourcePreparation,
    modelAllowance + preprocessing,
    modelAllowance + reconstruction,
  )
  const additionalRam = pixels * 24 + (selection ? 2 : 1) * 1024 ** 3
  const ramBytes = admission.reservation.ramBytes + additionalRam
  const vramBytes = admission.reservation.vramBytes + additionalVram
  return {
    ramBytes,
    vramBytes,
    additionalRam,
    additionalVram,
    phases: { sourcePreparation, preprocessing, reconstruction, modelAllowance },
    accepted:
      ramBytes <= admission.policy.ram.effectiveBytes &&
      vramBytes <= admission.policy.vram.effectiveBytes,
  }
}
