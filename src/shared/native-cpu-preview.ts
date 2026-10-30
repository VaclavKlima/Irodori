import type { AdjustmentParameters } from './adjustments'
import type { ResourcePolicySnapshot } from './resource-policy'

export const NATIVE_CPU_PREVIEW_VERSION = 'native-cpu-preview-v3' as const
export interface CpuPreviewSourceRef {
  readonly photoId: string
  /** Token of the actual main-owned prepared source, never a path or URL. */
  readonly cacheId: string
  readonly renderingIdentity: string
  readonly workingSha256: string
}
export function validateCpuPreviewSourceRef(value: unknown): asserts value is CpuPreviewSourceRef {
  const ref = value as CpuPreviewSourceRef | null
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).sort().join(',') !== 'cacheId,photoId,renderingIdentity,workingSha256' ||
    typeof ref.photoId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.photoId) ||
    typeof ref.cacheId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.cacheId) ||
    typeof ref.workingSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(ref.workingSha256) ||
    typeof ref.renderingIdentity !== 'string' ||
    !ref.renderingIdentity ||
    ref.renderingIdentity.length > 512
  )
    throw new Error('Invalid native CPU source reference.')
}
export interface CpuPreviewRequest {
  readonly version: typeof NATIVE_CPU_PREVIEW_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly source: CpuPreviewSourceRef
  /** Main authorizes this unfiltered capability against source and the same revision. */
  readonly beforeSource?: CpuPreviewSourceRef
  readonly generation: number
  readonly expectedSettingsRevision: number
  readonly parameters: AdjustmentParameters
  readonly quality: 'draft' | 'normal'
  readonly hdrRanges: boolean
  readonly headroom: number | null
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number }
}
export interface CpuPreviewPlane {
  readonly format: 'rgba8-srgb'
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly sha256: string
  /** Main-created irodori-photo capability URL, never a filesystem location. */
  readonly url: string
}
export interface CpuPreviewSamples {
  readonly format: 'rgba-f32le-straight'
  readonly sampleCount: number
  readonly draftCount: number
  readonly byteLength: number
  readonly sha256: string
  readonly url: string
}
export interface CpuPreviewPair {
  readonly version: typeof NATIVE_CPU_PREVIEW_VERSION
  readonly pairId: string
  readonly requestId: string
  readonly sessionId: string
  readonly source: CpuPreviewSourceRef
  readonly beforeSource?: CpuPreviewSourceRef
  readonly generation: number
  readonly settingsRevision: number
  readonly parameters: AdjustmentParameters
  readonly hdrRanges: boolean
  readonly headroom: number | null
  readonly quality: 'draft' | 'normal'
  readonly sourceDimensions: { readonly width: number; readonly height: number }
  readonly policy: Readonly<ResourcePolicySnapshot>
  readonly after: CpuPreviewPlane
  readonly before: CpuPreviewPlane
  readonly samples: CpuPreviewSamples
  /** Present only when Before has distinct source pixels; never relabel After samples. */
  readonly beforeSamples?: CpuPreviewSamples
  readonly diagnostics: {
    readonly implementation: 'float64-ctl-cpu-strip-v1'
    readonly threads: 1 | 4 | 8
    readonly sourceAttestedByMain: true
    readonly outputValidatedAfterChildClose: true
    readonly sourceReadHashSampleMs: number
    readonly childAndOutputMs: number
    readonly managedRamPeakBytes: number
    readonly managedGpuPeakBytes: number
    readonly beforeCacheHit?: boolean
    readonly beforeSourceReadHashSampleMs?: number
  }
}

/** An admission result, never a replacement for an already published pair. */
export interface CpuPreviewMemoryLimit {
  readonly kind: 'memory-limit'
  readonly version: typeof NATIVE_CPU_PREVIEW_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
  readonly policy: Readonly<ResourcePolicySnapshot>
}
/** The controller has drained an intentionally superseded or cancelled job. */
export interface CpuPreviewCancelled {
  readonly kind: 'cancelled'
  readonly version: typeof NATIVE_CPU_PREVIEW_VERSION
  readonly requestId: string
  readonly sessionId: string
  readonly generation: number
}
export type CpuPreviewOutcome = CpuPreviewPair | CpuPreviewMemoryLimit | CpuPreviewCancelled

/** Specific capability plus four owner operations; no arbitrary IPC, paths,
 * executables or ports. Releasing a null pair closes that owner session. */
export interface NativeCpuPreviewBridge {
  /** Explicit platform policy, never automatic recovery after a native failure. */
  getCpuPreviewBackend(): Promise<'native' | 'javascript'>
  renderCpuPreview(request: CpuPreviewRequest): Promise<CpuPreviewOutcome>
  /** Completion means the native process and all I/O owners actually drained. */
  cancelCpuPreview(sessionId: string, requestId: string): Promise<void>
  /** Called only after both new bitmaps publish. Main retires its old-pair pin here. */
  acknowledgeCpuPreview(
    sessionId: string,
    pairId: string,
    replacedPairId: string | null,
  ): Promise<void>
  /** Stale, failed or no-longer-visible pairs release after their streams drain. */
  releaseCpuPreview(sessionId: string, pairId: string | null): Promise<void>
}
