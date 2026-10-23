/** Admission budgets for managed image resources, never process or driver hard caps. */
export const RESOURCE_MIB = 1024 ** 2
export const RESOURCE_UNKNOWN_GPU_BYTES = 2 * 1024 ** 3
export const RESOURCE_POLICY_VERSION = 'managed-image-memory-v1'

/** Existing managed owners carried into the next image preparation phase. */
export interface ManagedImageBytes {
  readonly ramBytes: number
  readonly vramBytes: number
}

export function validateManagedImageBytes(value: ManagedImageBytes): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, 'ramBytes') ||
    !Object.hasOwn(value, 'vramBytes') ||
    !Number.isSafeInteger(value.ramBytes) ||
    value.ramBytes < 0 ||
    !Number.isSafeInteger(value.vramBytes) ||
    value.vramBytes < 0
  )
    throw new Error('Invalid managed image reservation.')
}
const MAX_OVERRIDE_MIB = Math.floor(Number.MAX_SAFE_INTEGER / RESOURCE_MIB)

export interface ResourceSettings {
  readonly version: 1
  /** Null selects Automatic. The requested custom value survives changes in hardware. */
  readonly ramMiB: number | null
  readonly vramMiB: number | null
}

export const DEFAULT_RESOURCE_SETTINGS: Readonly<ResourceSettings> = Object.freeze({
  version: 1,
  ramMiB: null,
  vramMiB: null,
})

export type UnknownGpuCapacityReason =
  'unavailable' | 'adapter-unverified' | 'adapter-mismatch' | 'ambiguous-adapter'

/** Main must prove the capacity belongs to the actual processing adapter before using matched. */
export type GpuMemoryObservation =
  | {
      readonly status: 'matched'
      readonly adapterId: string
      readonly totalBytes: number
      readonly availableBytes: number | null
    }
  | {
      readonly status: 'unknown'
      readonly reason: UnknownGpuCapacityReason
    }

export interface ResourceMemoryObservation {
  readonly ram: {
    readonly totalBytes: number
    /** Linux MemAvailable, not MemFree. Null means the observation was unavailable. */
    readonly availableBytes: number | null
  }
  readonly gpu: GpuMemoryObservation
}

export type ResourceBudgetBasis =
  | 'automatic-capacity'
  | 'automatic-available'
  | 'automatic-unknown-gpu'
  | 'custom-request'
  | 'custom-physical-capacity'

export interface ResolvedResourceBudget {
  readonly mode: 'automatic' | 'custom'
  readonly requestedMiB: number | null
  /** Rounded down to whole MiB. Zero is valid when available resources are below one MiB. */
  readonly effectiveBytes: number
  readonly capacityStatus: 'known' | 'unknown'
  readonly capacityBytes: number | null
  readonly availableBytes: number | null
  readonly basis: ResourceBudgetBasis
  readonly capacityClamped: boolean
  readonly fallbackBytes: number | null
  readonly unknownCapacityReason: UnknownGpuCapacityReason | null
}

export interface ResourcePolicySnapshot {
  readonly version: typeof RESOURCE_POLICY_VERSION
  readonly scope: 'managed-image-resources'
  /** Supplied by the owner; resolving never mutates or increments a global revision. */
  readonly revision: number
  readonly ram: ResolvedResourceBudget
  readonly vram: ResolvedResourceBudget
  readonly gpuAdapterId: string | null
}

/** Advisory identity from the actual processing adapter; main verifies capacity separately. */
export interface ResourceAdapterIdentity {
  readonly vendor: string
  readonly architecture: string
  readonly device: string
  readonly description: string
}

export interface ResourceSettingsView {
  readonly settings: Readonly<ResourceSettings>
  /** Successful preference writes, separate from the admitted policy generation. */
  readonly revision: number
  readonly status: 'default' | 'loaded' | 'recovered'
  readonly issue: 'invalid-settings' | 'read-unavailable' | null
  readonly policy: ResourcePolicySnapshot
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`Invalid ${name}.`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: readonly string[], name: string) {
  const actual = Reflect.ownKeys(value)
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string' || !expected.includes(key))
  )
    throw new Error(`Invalid ${name} fields.`)
}

function override(value: unknown, name: string): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_OVERRIDE_MIB
  )
    throw new Error(`Invalid ${name}; choose Automatic or a positive whole number of MiB.`)
  return value
}

/** Strict JSON boundary: no coercion, unknown keys, unsupported versions, or implicit defaults. */
export function validateResourceSettings(value: unknown): Readonly<ResourceSettings> {
  const settings = record(value, 'resource settings')
  keys(settings, ['version', 'ramMiB', 'vramMiB'], 'resource settings')
  if (settings.version !== 1) throw new Error('Unsupported resource settings version.')
  return Object.freeze({
    version: 1,
    ramMiB: override(settings.ramMiB, 'RAM budget'),
    vramMiB: override(settings.vramMiB, 'GPU memory budget'),
  })
}

function capacity(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${name} capacity.`)
  return value
}

function available(value: unknown, total: number, name: string) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > total)
    throw new Error(`Invalid ${name} available memory.`)
  return value
}

function validateObservation(value: unknown): ResourceMemoryObservation {
  const observation = record(value, 'resource memory observation')
  keys(observation, ['ram', 'gpu'], 'resource memory observation')
  const ram = record(observation.ram, 'RAM observation')
  keys(ram, ['totalBytes', 'availableBytes'], 'RAM observation')
  const ramTotal = capacity(ram.totalBytes, 'RAM')
  const gpu = record(observation.gpu, 'GPU observation')
  let checkedGpu: GpuMemoryObservation
  if (gpu.status === 'matched') {
    keys(gpu, ['status', 'adapterId', 'totalBytes', 'availableBytes'], 'matched GPU observation')
    if (typeof gpu.adapterId !== 'string' || !gpu.adapterId.trim())
      throw new Error('A matched GPU observation requires its processing adapter identity.')
    const totalBytes = capacity(gpu.totalBytes, 'GPU')
    checkedGpu = {
      status: 'matched',
      adapterId: gpu.adapterId,
      totalBytes,
      availableBytes: available(gpu.availableBytes, totalBytes, 'GPU'),
    }
  } else if (gpu.status === 'unknown') {
    keys(gpu, ['status', 'reason'], 'unknown GPU observation')
    if (
      !['unavailable', 'adapter-unverified', 'adapter-mismatch', 'ambiguous-adapter'].includes(
        gpu.reason as string,
      )
    )
      throw new Error('Unknown GPU capacity requires an explicit reason.')
    checkedGpu = { status: 'unknown', reason: gpu.reason as UnknownGpuCapacityReason }
  } else throw new Error('Invalid GPU adapter match status.')
  return {
    ram: {
      totalBytes: ramTotal,
      availableBytes: available(ram.availableBytes, ramTotal, 'RAM'),
    },
    gpu: checkedGpu,
  }
}

function wholeMiB(bytes: number) {
  return Math.floor(bytes / RESOURCE_MIB) * RESOURCE_MIB
}

function resolveBudget(
  requestedMiB: number | null,
  capacityBytes: number | null,
  availableBytes: number | null,
  unknownCapacityReason: UnknownGpuCapacityReason | null,
): ResolvedResourceBudget {
  let effectiveBytes: number,
    basis: ResourceBudgetBasis,
    capacityClamped = false,
    fallbackBytes: number | null = null
  if (requestedMiB !== null) {
    const requestedBytes = requestedMiB * RESOURCE_MIB
    capacityClamped = capacityBytes !== null && requestedBytes > capacityBytes
    effectiveBytes = wholeMiB(
      capacityBytes === null ? requestedBytes : Math.min(requestedBytes, capacityBytes),
    )
    basis = capacityClamped ? 'custom-physical-capacity' : 'custom-request'
  } else if (capacityBytes === null) {
    effectiveBytes = RESOURCE_UNKNOWN_GPU_BYTES
    fallbackBytes = RESOURCE_UNKNOWN_GPU_BYTES
    basis = 'automatic-unknown-gpu'
  } else {
    const capacityShare = Math.floor(capacityBytes / 4)
    // floor(available * .75), using subtraction to avoid unsafe integer multiplication.
    const availableShare =
      availableBytes === null ? null : availableBytes - Math.ceil(availableBytes / 4)
    effectiveBytes = wholeMiB(
      availableShare === null ? capacityShare : Math.min(capacityShare, availableShare),
    )
    basis =
      availableShare !== null && availableShare < capacityShare
        ? 'automatic-available'
        : 'automatic-capacity'
  }
  return Object.freeze({
    mode: requestedMiB === null ? 'automatic' : 'custom',
    requestedMiB,
    effectiveBytes,
    capacityStatus: capacityBytes === null ? 'unknown' : 'known',
    capacityBytes,
    availableBytes,
    basis,
    capacityClamped,
    fallbackBytes,
    unknownCapacityReason,
  })
}

/** Resolve at safe photo/job admission. Consumers keep this snapshot until that work releases it. */
export function resolveResourcePolicy(
  settings: ResourceSettings,
  observation: ResourceMemoryObservation,
  revision: number,
): ResourcePolicySnapshot {
  const checked = validateResourceSettings(settings)
  const memory = validateObservation(observation)
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error('Invalid resource policy revision.')
  const gpu = memory.gpu
  return Object.freeze({
    version: RESOURCE_POLICY_VERSION,
    scope: 'managed-image-resources',
    revision,
    ram: resolveBudget(checked.ramMiB, memory.ram.totalBytes, memory.ram.availableBytes, null),
    vram: resolveBudget(
      checked.vramMiB,
      gpu.status === 'matched' ? gpu.totalBytes : null,
      gpu.status === 'matched' ? gpu.availableBytes : null,
      gpu.status === 'unknown' ? gpu.reason : null,
    ),
    gpuAdapterId: gpu.status === 'matched' ? gpu.adapterId : null,
  })
}
