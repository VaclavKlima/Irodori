import { ACES_DATA_BYTES } from './aces-data'
import { acesPrecisionData } from './aces-precision-wgsl'
import { CREATIVE_COLOR_PARAMETER_BYTES } from './creative-color-gpu'
import { TONE_CURVE_PARAMETER_BYTES } from './tone-curves-gpu'
import { frameByteLength, MAX_FRAME_BYTES } from './preview-frame'
import {
  RESOURCE_POLICY_VERSION,
  validateManagedImageBytes,
  type ManagedImageBytes,
  type ResourcePolicySnapshot,
} from './resource-policy'

export const EXPORT_GPU_LIMIT_BYTES = 1024 ** 3
export const EXPORT_ENCODER_LIMIT_BYTES = 2 * 1024 ** 3
export const EXPORT_JPEG_INPUT_LIMIT_BYTES = 256 * 1024 ** 2
export const EXPORT_SDR_CODEC_SCRATCH_BYTES = 16 * 1024 ** 2
export interface ExportAdmission {
  readonly policy: ResourcePolicySnapshot
  readonly reservation: ManagedImageBytes
}
export interface ExportAllocation {
  readonly bytes: Readonly<ManagedImageBytes>
  readonly total: Readonly<ManagedImageBytes>
  readonly accepted: boolean
}
export class ExportResourceError extends Error {}

function bytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid export memory accounting.')
  return value
}
export function validateExportAdmission(admission: ExportAdmission): void {
  validateManagedImageBytes(admission.reservation)
  const policy = admission.policy
  if (
    policy.version !== RESOURCE_POLICY_VERSION ||
    policy.scope !== 'managed-image-resources' ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 0
  )
    throw new Error('Invalid export resource policy.')
  bytes(policy.ram.effectiveBytes)
  bytes(policy.vram.effectiveBytes)
}
function allocation(admission: ExportAdmission, ramBytes: number, vramBytes = 0): ExportAllocation {
  validateExportAdmission(admission)
  const own = Object.freeze({ ramBytes: bytes(ramBytes), vramBytes: bytes(vramBytes) }),
    total = Object.freeze({
      ramBytes: bytes(admission.reservation.ramBytes + own.ramBytes),
      vramBytes: bytes(admission.reservation.vramBytes + own.vramBytes),
    })
  return Object.freeze({
    bytes: own,
    total,
    accepted:
      total.ramBytes <= admission.policy.ram.effectiveBytes &&
      total.vramBytes <= admission.policy.vram.effectiveBytes,
  })
}
export function requireExportAllocation(plan: ExportAllocation): void {
  if (!plan.accepted)
    throw new ExportResourceError(
      'Export exceeds the frozen managed image budgets. Choose smaller dimensions or increase the memory budget.',
    )
}
function pixels(width: number, height: number): number {
  if (frameByteLength(width, height) * 4 > MAX_FRAME_BYTES)
    throw new Error('Export exceeds the floating-point image limit.')
  return width * height
}
export function exportInputMemoryPlan(
  width: number,
  height: number,
  admission: ExportAdmission,
): ExportAllocation {
  return allocation(admission, pixels(width, height) * 16 + 16 * 1024)
}

/** Decoder heap, decoded primary/HDR planes, strip conversion and compact overview. */
export function exportProofDecodePlan(
  width: number,
  height: number,
  hdr: boolean,
  jpegBytes: number,
  admission: ExportAdmission,
): ExportAllocation {
  if (jpegBytes > EXPORT_JPEG_INPUT_LIMIT_BYTES)
    throw new Error('Output preview JPEG exceeds the 256 MiB input limit.')
  const own = pixels(width, height) * (hdr ? 80 : 12) + bytes(jpegBytes) * 3 + 64 * 1024 ** 2
  const plan = allocation(admission, own)
  return { ...plan, accepted: plan.accepted && own <= EXPORT_ENCODER_LIMIT_BYTES }
}

/** Exact explicit buffers; device limits may further decline only the optional retained HDR plane. */
export function exportGpuAllocation(
  capacity: number,
  hdr: boolean,
  packed: boolean,
  creative: boolean,
  deferredPixels = 0,
  limitBytes = EXPORT_GPU_LIMIT_BYTES,
  primary = false,
  curves = false,
) {
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity * 16 > MAX_FRAME_BYTES ||
    [hdr, packed, creative].some((value) => typeof value !== 'boolean')
  )
    throw new Error('Invalid export GPU allocation.')
  bytes(deferredPixels)
  bytes(limitBytes)
  if (deferredPixels * 16 > MAX_FRAME_BYTES) throw new Error('Invalid retained export dimensions.')
  const stride = packed ? (hdr ? 3 : 1) : hdr ? 6 : 3,
    outputBytes = bytes(4 + capacity * stride * 4),
    baseBytes = bytes(
      192 +
        capacity * 16 * (primary ? 2 : 1) +
        2 * outputBytes +
        2 * ACES_DATA_BYTES +
        acesPrecisionData.byteLength +
        (creative ? CREATIVE_COLOR_PARAMETER_BYTES : 0) +
        (curves ? TONE_CURVE_PARAMETER_BYTES : 0),
    ),
    limit = Math.min(limitBytes, EXPORT_GPU_LIMIT_BYTES),
    deferredBytes = hdr && packed ? bytes(deferredPixels * 20) : 0,
    deferred = deferredBytes > 0 && baseBytes + deferredBytes <= limit
  return Object.freeze({
    stride,
    outputBytes,
    baseBytes,
    limitBytes: limit,
    deferredBytes: deferred ? deferredBytes : 0,
    totalBytes: bytes(baseBytes + (deferred ? deferredBytes : 0)),
    accepted: baseBytes <= limit,
  })
}

/** Conservative metadata/row-cache reservation for the existing separable Lanczos3 implementation. */
export function exportResizeBytes(
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: number,
): number {
  pixels(width, height)
  pixels(outWidth, outHeight)
  if (![3, 6].includes(channels)) throw new Error('Invalid export resize channels.')
  if (width === outWidth && height === outHeight) return 0
  const taps = Math.ceil(
      6 * Math.max(width, outWidth) +
        2 * outWidth +
        6 * Math.max(height, outHeight) +
        2 * outHeight,
    ),
    rows = Math.min(height, Math.ceil(6 * Math.max(1, height / outHeight)) + 2)
  return bytes(taps * 128 + width * channels * 4 + (rows + 2) * outWidth * channels * 4 + 16 * 1024)
}

/** Conservative GPU row-cache phase; rendition buffers retire before this allocation. */
export function exportResizeGpuAllocation(
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: number,
  admission: ExportAdmission,
) {
  const referenceHostBytes = exportResizeBytes(width, height, outWidth, outHeight, channels)
  if (width === outWidth && height === outHeight)
    return Object.freeze({ ...allocation(admission, 0), rowCapacity: 0, gpuLimitBytes: 0 })
  const rowCapacity = Math.min(height, Math.ceil(6 * Math.max(1, height / outHeight)) + 2),
    horizontalTaps = Math.ceil(6 * Math.max(width, outWidth) + 2 * outWidth),
    verticalTaps = Math.ceil(6 * Math.max(height, outHeight) + 2 * outHeight),
    // Four words per descriptor/tap also cover split-weight packets without relying on their layout.
    tableBytes = bytes(16 * (outWidth + outHeight + horizontalTaps + verticalTaps)),
    inputRowBytes = bytes(width * channels * 4),
    outputRowBytes = bytes(outWidth * channels * 4),
    rowMapBytes = bytes(height * 4),
    gpuBytes = bytes(
      256 + inputRowBytes + (rowCapacity + 2) * outputRowBytes + tableBytes + rowMapBytes,
    ),
    // Retain the existing conservative host allowance, plus snapshots/uploads/readback.
    hostBytes = bytes(
      referenceHostBytes + 4 * tableBytes + 2 * inputRowBytes + 3 * outputRowBytes + rowMapBytes,
    ),
    plan = allocation(admission, hostBytes, gpuBytes),
    gpuLimitBytes = Math.min(
      EXPORT_GPU_LIMIT_BYTES,
      Math.max(0, admission.policy.vram.effectiveBytes - admission.reservation.vramBytes),
    )
  return Object.freeze({
    ...plan,
    accepted: plan.accepted && gpuBytes <= gpuLimitBytes,
    rowCapacity,
    gpuLimitBytes,
  })
}
export interface ExportRenderLayout {
  readonly width: number
  readonly height: number
  readonly outWidth: number
  readonly outHeight: number
  readonly hdr: boolean
  readonly sourceHdr: boolean
  readonly gpuAllowed: boolean
  readonly authoredHdr?: boolean
  readonly creative: boolean
  readonly curves?: boolean
  /** Active output filtering needs linear renditions even at unchanged dimensions. */
  readonly outputSharpening?: boolean
  /** Distinct original/filtered backing allocations, already retained before output allocation. */
  readonly inputBytes: number
}
export function exportRenderMemoryPlan(layout: ExportRenderLayout, admission: ExportAdmission) {
  validateExportAdmission(admission)
  const count = pixels(layout.outWidth, layout.outHeight)
  pixels(layout.width, layout.height)
  if (
    [layout.hdr, layout.sourceHdr, layout.gpuAllowed, layout.creative].some(
      (v) => typeof v !== 'boolean',
    ) ||
    (layout.outputSharpening !== undefined && typeof layout.outputSharpening !== 'boolean')
  )
    throw new Error('Invalid export rendering domain.')
  const inputs = bytes(layout.inputBytes),
    channels = layout.hdr ? 6 : 3,
    original = layout.width === layout.outWidth && layout.height === layout.outHeight,
    packed = original && !layout.outputSharpening,
    capacity = layout.width * 64,
    outputs = bytes(count * (layout.hdr ? 11 : 3)),
    retainedBytes = bytes(inputs + outputs),
    controls =
      4 * ACES_DATA_BYTES +
      2 * acesPrecisionData.byteLength +
      4096 +
      (layout.creative ? 2 * CREATIVE_COLOR_PARAMETER_BYTES : 0) +
      (layout.curves ? 2 * TONE_CURVE_PARAMETER_BYTES : 0),
    cpuWorkBytes = bytes(
      layout.width * Math.min(64, layout.height) * (channels * 4 + (layout.sourceHdr ? 16 : 0)) +
        controls,
    ),
    resizeBytes = exportResizeBytes(
      layout.width,
      layout.height,
      layout.outWidth,
      layout.outHeight,
      channels,
    ),
    availableVram = Math.max(
      0,
      admission.policy.vram.effectiveBytes - admission.reservation.vramBytes,
    ),
    gpuBuffers = exportGpuAllocation(
      capacity,
      layout.hdr,
      packed,
      layout.creative,
      packed && layout.hdr && !layout.authoredHdr ? count : 0,
      availableVram,
      layout.authoredHdr === true,
      layout.curves === true,
    ),
    gpuWorkBytes = bytes(
      capacity * (3 * 16 + 2 * gpuBuffers.stride * 4 + (layout.authoredHdr ? 32 : 0)) + controls,
    ),
    resizeGpu = exportResizeGpuAllocation(
      layout.width,
      layout.height,
      layout.outWidth,
      layout.outHeight,
      channels,
      {
        policy: admission.policy,
        reservation: {
          ramBytes: bytes(admission.reservation.ramBytes + retainedBytes),
          vramBytes: admission.reservation.vramBytes,
        },
      },
    ),
    cpu = allocation(admission, retainedBytes + Math.max(cpuWorkBytes, resizeBytes)),
    gpu = allocation(
      admission,
      retainedBytes + Math.max(gpuWorkBytes, resizeBytes),
      gpuBuffers.totalBytes,
    )
  return Object.freeze({
    retainedBytes,
    outputs,
    cpuWorkBytes,
    gpuWorkBytes,
    resizeBytes,
    resizeGpu,
    cpu,
    gpu,
    gpuAccepted: layout.gpuAllowed && gpuBuffers.accepted && gpu.accepted,
    gpuLimitBytes: gpuBuffers.limitBytes,
    gpuBuffers,
    /** Main owners, retained inputs/output and CPU rendition work; primary crop adds its own source/scratch. */
    cpuLive: Object.freeze({
      ramBytes: bytes(admission.reservation.ramBytes + retainedBytes + cpuWorkBytes),
      vramBytes: admission.reservation.vramBytes,
    }),
  })
}

/** A reservation model, not a claim about libvips process RSS. Actual encoded bytes are checked too. */
export function exportSdrEncodePlan(width: number, height: number, admission: ExportAdmission) {
  const count = pixels(width, height),
    outputLimitBytes = Math.min(EXPORT_JPEG_INPUT_LIMIT_BYTES, bytes(count * 12 + 1024 ** 2)),
    scratchBytes = bytes(count * 4 + EXPORT_SDR_CODEC_SCRATCH_BYTES)
  return Object.freeze({
    ...allocation(admission, outputLimitBytes + scratchBytes),
    outputLimitBytes,
  })
}

/** Retains the existing 56-byte/pixel plus primary-copy and 128 MiB codec reservation. */
export function exportHdrEncodePlan(
  width: number,
  height: number,
  sdrBytes: number,
  backend: 'native' | 'wasm',
  admission: ExportAdmission,
) {
  const count = pixels(width, height)
  bytes(sdrBytes)
  if (
    !sdrBytes ||
    sdrBytes > EXPORT_JPEG_INPUT_LIMIT_BYTES ||
    !['native', 'wasm'].includes(backend)
  )
    throw new Error('Invalid HDR encoder memory accounting.')
  const codecBytes = bytes(count * 56 + sdrBytes * 3 + 128 * 1024 ** 2),
    outputLimitBytes = Math.min(
      MAX_FRAME_BYTES,
      bytes(sdrBytes + Math.min(EXPORT_JPEG_INPUT_LIMIT_BYTES, count * 12 + 1024 ** 2) + 1024 ** 2),
    ),
    workBytes =
      backend === 'wasm'
        ? bytes(codecBytes + 2 * outputLimitBytes)
        : Math.max(codecBytes, 2 * outputLimitBytes),
    plan = allocation(admission, workBytes)
  return Object.freeze({
    ...plan,
    codecBytes,
    outputLimitBytes,
    accepted: codecBytes <= EXPORT_ENCODER_LIMIT_BYTES && plan.accepted,
  })
}
