import {
  RESOURCE_POLICY_VERSION,
  validateManagedImageBytes,
  type ResourcePolicySnapshot,
  type ManagedImageBytes,
} from './resource-policy'
import { DETAIL_MAX_WINDOW_EDGE, DETAIL_MAX_STAGE_EDGE, DETAIL_TILE_EDGE } from './spatial-detail'
import type { DetailSize } from './spatial-detail'
import { frameByteLength, MAX_FRAME_BYTES } from './preview-frame'
import { ACES_DATA_BYTES } from './aces-data'

export const DETAIL_PARAMETER_BYTES = 208
export const DETAIL_BAND_ROWS = 64
export const DETAIL_WINDOW_BYTES = DETAIL_MAX_WINDOW_EDGE ** 2 * 16
export const DETAIL_STAGE_BYTES = DETAIL_MAX_STAGE_EDGE ** 2 * 16
export const DETAIL_TILE_BYTES = DETAIL_TILE_EDGE ** 2 * 16
export const DETAIL_GPU_BYTES =
  2 * DETAIL_WINDOW_BYTES + DETAIL_STAGE_BYTES + 2 * DETAIL_TILE_BYTES + 2 * DETAIL_PARAMETER_BYTES
// Both CPU feature planes may coexist until their references retire. Charge input,
// intermediate, output, snapshot/upload copies, readback and bounded controls together.
export const DETAIL_CPU_WORK_BYTES =
  5 * DETAIL_WINDOW_BYTES + DETAIL_STAGE_BYTES + DETAIL_TILE_BYTES + 4096
export const DETAIL_GPU_HOST_BYTES =
  DETAIL_CPU_WORK_BYTES +
  3 * DETAIL_WINDOW_BYTES +
  2 * DETAIL_TILE_BYTES +
  4 * DETAIL_PARAMETER_BYTES
export interface DetailAdmission {
  readonly policy: ResourcePolicySnapshot
  readonly reservation: ManagedImageBytes
}
export interface DetailMemoryPlan {
  readonly cpu: ManagedImageBytes
  readonly gpu: ManagedImageBytes
  readonly cpuAccepted: boolean
  readonly gpuAccepted: boolean
}
export interface DetailStreamMemoryPlan extends DetailMemoryPlan {
  readonly sourceBytes: number
  readonly outputBandBytes: number
  readonly descriptorBytes: number
  /** Existing reservations plus this adapter's simultaneously retained I/O. */
  readonly tileReservation: Readonly<ManagedImageBytes>
}
export interface DetailFrameMemoryPlan extends DetailStreamMemoryPlan {
  readonly retainedOutputBytes: number
}
export interface DetailPreviewMemoryPlan {
  readonly filter: DetailStreamMemoryPlan | DetailFrameMemoryPlan
  readonly admission: DetailAdmission
  readonly proofBackend: 'cpu' | 'gpu'
  readonly proofBytes: Readonly<ManagedImageBytes>
  readonly peakGpuBytes: number
}
export interface DetailProofMemoryPlan {
  readonly backend: 'cpu' | 'gpu'
  readonly bytes: Readonly<ManagedImageBytes>
  readonly total: Readonly<ManagedImageBytes>
  readonly accepted: boolean
}

function detailProofBytes(
  image: DetailSize,
  options: { readonly hdr: boolean; readonly workingOnly: boolean },
  proofGpu: boolean,
): Readonly<ManagedImageBytes> {
  const imageBytes = frameByteLength(image.width, image.height) * 4,
    capacity = image.width * DETAIL_BAND_ROWS,
    bytes = {
      ramBytes: options.workingOnly
        ? 0
        : (options.hdr ? capacity * 40 : imageBytes * 1.5) +
          96 * 96 * 16 +
          (proofGpu ? 2 * ACES_DATA_BYTES : 0),
      vramBytes: proofGpu ? ACES_DATA_BYTES + 176 + capacity * 24 : 0,
    }
  validateManagedImageBytes(bytes)
  return Object.freeze(bytes)
}

/** A cached filtered source needs only point/output storage, without retired filter allocations. */
export function detailProofMemoryPlan(
  image: DetailSize,
  admission: DetailAdmission,
  options: { readonly hdr: boolean; readonly authoredHdr: boolean; readonly preferGpu: boolean },
): DetailProofMemoryPlan {
  const frozen = structuredClone(admission)
  validateDetailAdmission(frozen)
  if (
    frameByteLength(image.width, image.height) * 4 > MAX_FRAME_BYTES ||
    Object.values(options).some((v) => typeof v !== 'boolean')
  )
    throw new Error('Invalid detail proof allocation.')
  const make = (gpu: boolean): DetailProofMemoryPlan => {
    const bytes = detailProofBytes(image, { hdr: options.hdr, workingOnly: false }, gpu),
      total = Object.freeze({
        ramBytes: frozen.reservation.ramBytes + bytes.ramBytes,
        vramBytes: frozen.reservation.vramBytes + bytes.vramBytes,
      })
    validateManagedImageBytes(total)
    return Object.freeze({
      backend: gpu ? 'gpu' : 'cpu',
      bytes,
      total,
      accepted:
        total.ramBytes <= frozen.policy.ram.effectiveBytes &&
        total.vramBytes <= frozen.policy.vram.effectiveBytes,
    })
  }
  if (options.hdr && !options.authoredHdr && options.preferGpu) {
    const gpu = make(true)
    if (gpu.accepted) return gpu
  }
  return make(false)
}

/** Filter GPU resources retire before proof allocation; CPU image ownership stays reserved. */
export function detailPreviewMemoryPlan(
  image: DetailSize,
  admission: DetailAdmission,
  options: {
    readonly hdr: boolean
    readonly authoredHdr: boolean
    readonly workingOnly: boolean
    readonly preferGpu: boolean
  },
): DetailPreviewMemoryPlan {
  const frozen = structuredClone(admission),
    imageBytes = frameByteLength(image.width, image.height) * 4
  if (
    imageBytes > MAX_FRAME_BYTES ||
    Object.values(options).some((v) => typeof v !== 'boolean') ||
    (options.workingOnly && !options.hdr)
  )
    throw new Error('Invalid detail preview allocation.')
  const make = (proofGpu: boolean): DetailPreviewMemoryPlan => {
    const proofBytes = detailProofBytes(image, options, proofGpu),
      { ramBytes, vramBytes } = proofBytes,
      admitted = {
        policy: frozen.policy,
        reservation: {
          ramBytes: frozen.reservation.ramBytes + ramBytes,
          vramBytes: frozen.reservation.vramBytes,
        },
      },
      filter = options.hdr
        ? detailStreamMemoryPlan(image, admitted, true)
        : detailFrameMemoryPlan(image, admitted)
    return Object.freeze({
      filter,
      admission: admitted,
      proofBackend: proofGpu ? 'gpu' : 'cpu',
      proofBytes,
      peakGpuBytes: Math.max(filter.gpu.vramBytes, frozen.reservation.vramBytes + vramBytes),
    })
  }
  const cpu = make(false)
  if (!options.workingOnly && options.hdr && !options.authoredHdr && options.preferGpu) {
    const gpu = make(true)
    if (
      frozen.reservation.vramBytes + gpu.proofBytes.vramBytes <=
        frozen.policy.vram.effectiveBytes &&
      gpu.filter.cpuAccepted &&
      (gpu.filter.gpuAccepted || !cpu.filter.gpuAccepted)
    )
      return gpu
  }
  return cpu
}

/** Borrowed input is charged once by backing allocation; no copied source-strip planes. */
export function detailFrameMemoryPlan(
  image: DetailSize,
  admission: DetailAdmission,
  retainOutput = false,
  backingBytes = frameByteLength(image.width, image.height) * 4,
): DetailFrameMemoryPlan {
  const imageBytes = frameByteLength(image.width, image.height) * 4
  if (
    imageBytes > MAX_FRAME_BYTES ||
    !Number.isSafeInteger(backingBytes) ||
    backingBytes < imageBytes ||
    backingBytes > MAX_FRAME_BYTES ||
    typeof retainOutput !== 'boolean'
  )
    throw new Error('Invalid detail frame allocation.')
  validateManagedImageBytes(admission.reservation)
  const sourceBytes = backingBytes,
    outputBandBytes = image.width * Math.min(DETAIL_BAND_ROWS, image.height) * 16,
    retainedOutputBytes = retainOutput ? imageBytes : 0,
    descriptorBytes = Math.ceil(image.height / DETAIL_BAND_ROWS) * 1024 + 8192,
    tileReservation = Object.freeze({
      ramBytes:
        admission.reservation.ramBytes +
        sourceBytes +
        outputBandBytes +
        retainedOutputBytes +
        descriptorBytes,
      vramBytes: admission.reservation.vramBytes,
    }),
    plan = detailMemoryPlan({ ...admission, reservation: tileReservation }, true)
  return Object.freeze({
    ...plan,
    sourceBytes,
    outputBandBytes,
    retainedOutputBytes,
    descriptorBytes,
    tileReservation,
  })
}

/** Three immutable source strips cover a 64-row band and the maximum 13-pixel halo. */
export function detailStreamMemoryPlan(
  image: DetailSize,
  admission: DetailAdmission,
  active: boolean,
): DetailStreamMemoryPlan {
  if (frameByteLength(image.width, image.height) * 4 > MAX_FRAME_BYTES)
    throw new Error('Detail source exceeds the floating-point image limit.')
  validateManagedImageBytes(admission.reservation)
  const sourceBytes =
      image.width * Math.min((active ? 3 : 1) * DETAIL_BAND_ROWS, image.height) * 16,
    outputBandBytes = active ? image.width * Math.min(DETAIL_BAND_ROWS, image.height) * 16 : 0,
    descriptorBytes = Math.ceil(image.height / DETAIL_BAND_ROWS) * 1024 + 8192,
    tileReservation = Object.freeze({
      ramBytes: admission.reservation.ramBytes + sourceBytes + outputBandBytes + descriptorBytes,
      vramBytes: admission.reservation.vramBytes,
    }),
    plan = detailMemoryPlan({ ...admission, reservation: tileReservation }, active)
  return Object.freeze({ ...plan, sourceBytes, outputBandBytes, descriptorBytes, tileReservation })
}
function validateDetailAdmission(admission: DetailAdmission): void {
  const { policy, reservation } = admission
  validateManagedImageBytes(reservation)
  if (
    policy.version !== RESOURCE_POLICY_VERSION ||
    policy.scope !== 'managed-image-resources' ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 0 ||
    ![policy.ram.effectiveBytes, policy.vram.effectiveBytes].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    )
  )
    throw new Error('Invalid detail resource policy.')
}

export function detailMemoryPlan(admission: DetailAdmission, active: boolean): DetailMemoryPlan {
  validateDetailAdmission(admission)
  const { policy, reservation } = admission
  const cpu = {
      ramBytes: reservation.ramBytes + (active ? DETAIL_CPU_WORK_BYTES : DETAIL_TILE_BYTES),
      vramBytes: reservation.vramBytes,
    },
    gpu = {
      ramBytes: reservation.ramBytes + (active ? DETAIL_GPU_HOST_BYTES : DETAIL_TILE_BYTES),
      vramBytes: reservation.vramBytes + (active ? DETAIL_GPU_BYTES : 0),
    }
  validateManagedImageBytes(cpu)
  validateManagedImageBytes(gpu)
  return Object.freeze({
    cpu: Object.freeze(cpu),
    gpu: Object.freeze(gpu),
    cpuAccepted:
      cpu.ramBytes <= policy.ram.effectiveBytes && cpu.vramBytes <= policy.vram.effectiveBytes,
    gpuAccepted:
      gpu.ramBytes <= policy.ram.effectiveBytes && gpu.vramBytes <= policy.vram.effectiveBytes,
  })
}
