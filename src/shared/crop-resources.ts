import type { CropGeometry } from './crop'
import { CROP_TILE_EDGE } from './crop-filter'
import {
  RESOURCE_POLICY_VERSION,
  validateManagedImageBytes,
  type ManagedImageBytes,
  type ResourcePolicySnapshot,
} from './resource-policy'

// Same bounded storage plan as the native compute owner; kept free of Node/GPU imports.
export const CROP_WINDOW_EDGE = Math.ceil(Math.SQRT2 * CROP_TILE_EDGE) + 6
export const CROP_WINDOW_BYTES = CROP_WINDOW_EDGE ** 2 * 16
export const CROP_TILE_BYTES = CROP_TILE_EDGE ** 2 * 16
export const CROP_PARAMETERS_BYTES = 96
export const CROP_COMPUTE_BYTES = CROP_WINDOW_BYTES + 2 * CROP_TILE_BYTES + CROP_PARAMETERS_BYTES
export interface CropAdmission {
  readonly policy: ResourcePolicySnapshot
  readonly reservation: ManagedImageBytes
}
export interface CropMemoryPlan {
  readonly identity: boolean
  readonly integer: boolean
  readonly cpu: ManagedImageBytes
  readonly gpu: ManagedImageBytes
  readonly cpuAccepted: boolean
  readonly gpuAccepted: boolean
}
function bytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid crop memory accounting.')
  return value
}
export function cropMemoryPlan(geometry: CropGeometry, admission: CropAdmission): CropMemoryPlan {
  return memoryPlan(geometry, admission, 'disk', false)
}

/** The adapter owns an existing frame; charge it once, with no second source copy. */
export function cropFrameMemoryPlan(
  geometry: CropGeometry,
  admission: CropAdmission,
  retainOutput = false,
): CropMemoryPlan {
  return memoryPlan(geometry, admission, 'frame', retainOutput)
}

function memoryPlan(
  geometry: CropGeometry,
  admission: CropAdmission,
  source: 'disk' | 'frame',
  retainOutput: boolean,
): CropMemoryPlan {
  const { policy, reservation } = admission
  validateManagedImageBytes(reservation)
  if (
    policy.version !== RESOURCE_POLICY_VERSION ||
    policy.scope !== 'managed-image-resources' ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 0
  )
    throw new Error('Invalid crop resource policy.')
  const ram = bytes(policy.ram.effectiveBytes),
    vram = bytes(policy.vram.effectiveBytes),
    input = bytes(geometry.source.width * geometry.source.height * 16),
    output = bytes(geometry.width * geometry.height * 16),
    sourceStrip = Math.min(64, geometry.source.height) * geometry.source.width * 16,
    outputStrip = Math.min(64, geometry.height) * geometry.width * 16
  if (input > 512 * 1024 ** 2 || output > 512 * 1024 ** 2)
    throw new Error('Crop working pixels exceed the image memory limit.')
  const existingRam = bytes(reservation.ramBytes + (source === 'frame' ? input : 0)),
    cpuRam = geometry.identity
      ? 0
      : source === 'frame'
        ? outputStrip + CROP_TILE_BYTES + (retainOutput ? output : 0)
        : geometry.pixelAligned
          ? output + sourceStrip
          : input + sourceStrip + outputStrip + CROP_TILE_BYTES,
    gpuRam =
      geometry.identity || geometry.pixelAligned
        ? cpuRam
        : cpuRam + 2 * CROP_WINDOW_BYTES + 2 * CROP_TILE_BYTES + CROP_PARAMETERS_BYTES,
    cpu = { ramBytes: bytes(existingRam + cpuRam), vramBytes: reservation.vramBytes },
    gpu = {
      ramBytes: bytes(existingRam + gpuRam),
      vramBytes: bytes(
        reservation.vramBytes +
          (geometry.identity || geometry.pixelAligned ? 0 : CROP_COMPUTE_BYTES),
      ),
    }
  return Object.freeze({
    identity: geometry.identity,
    integer: geometry.pixelAligned,
    cpu: Object.freeze(cpu),
    gpu: Object.freeze(gpu),
    cpuAccepted: geometry.identity || (cpu.ramBytes <= ram && cpu.vramBytes <= vram),
    gpuAccepted: geometry.identity || (gpu.ramBytes <= ram && gpu.vramBytes <= vram),
  })
}
