import type { AdjustmentParameters } from './adjustments'
import type { DisplayTarget } from './hdr'
import type { HdrAnalysisDomain } from './hdr-statistics'
import type { CpuPreviewSourceRef } from './native-cpu-preview'
import type { ManagedImageBytes, ResourcePolicySnapshot } from './resource-policy'

export const NATIVE_HDR_MASK_VERSION = 'native-hdr-mask-v3' as const
export interface NativeHdrMaskRequest {
  readonly version: typeof NATIVE_HDR_MASK_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly source: CpuPreviewSourceRef
  /** Exact edited source authorizing a distinct original Before; never a path. */
  readonly comparisonOf?: CpuPreviewSourceRef
  readonly generation: number
  readonly expectedSettingsRevision: number
  readonly comparison: 'before' | 'after'
  readonly domain: HdrAnalysisDomain
  readonly parameters: AdjustmentParameters
  readonly target: DisplayTarget
  /** Existing presenter snapshot, including healthy GPU/source/recovery owners. */
  readonly existingOwners: ManagedImageBytes
}
export interface NativeHdrMaskResult {
  readonly kind: 'mask'
  readonly version: typeof NATIVE_HDR_MASK_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly maskId: string
  readonly source: CpuPreviewSourceRef
  readonly comparisonOf?: CpuPreviewSourceRef
  readonly generation: number
  readonly settingsRevision: number
  readonly comparison: 'before' | 'after'
  readonly domain: HdrAnalysisDomain
  readonly parameters: AdjustmentParameters
  readonly target: DisplayTarget
  readonly policy: Readonly<ResourcePolicySnapshot>
  readonly width: number
  readonly height: number
  readonly format: 'r8-hdr-mask-bits-v1'
  readonly arithmeticSha256: string
  readonly byteLength: number
  readonly sha256: string
  /** A main-issued capability, never a renderer filesystem path. */
  readonly url: string
  /** Held in the presenter's otherReservations until receiver/hash/reducer drain. */
  readonly additionalReservation: ManagedImageBytes
}
export interface NativeHdrMaskDeclined {
  readonly kind: 'mask-declined'
  readonly version: typeof NATIVE_HDR_MASK_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
  readonly reason: 'presentation-priority' | 'previous-receiver' | 'memory-limit'
}
export interface NativeHdrMaskCancelled {
  readonly kind: 'cancelled'
  readonly version: typeof NATIVE_HDR_MASK_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
}
export type NativeHdrMaskOutcome =
  NativeHdrMaskResult | NativeHdrMaskDeclined | NativeHdrMaskCancelled
export interface NativeHdrMaskBridge {
  renderHdrMask(request: NativeHdrMaskRequest): Promise<NativeHdrMaskOutcome>
  /** Completes after the real native child, source and output parser have drained. */
  cancelHdrMask(sessionId: string, requestId: string): Promise<void>
  /** Receiver calls only after actual fetch/hash/reduction ownership has drained. */
  releaseHdrMask(sessionId: string, maskId: string): Promise<void>
}
