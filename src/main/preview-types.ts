import type { ImageStatistics } from '../shared/statistics'
import type { HdrStatistics, HdrAnalysisDomain } from '../shared/hdr-statistics'
import type { HdrWorkingAsset, DisplayTarget } from '../shared/hdr'
import type { HdrPixel } from '../shared/hdr-pixel'
export interface HdrStatisticsJob {
  asset: HdrWorkingAsset
  adjustments: AdjustmentParameters
  domain: HdrAnalysisDomain
  target: DisplayTarget
}
export interface HdrPixelJob extends HdrStatisticsJob {
  x: number
  y: number
}
import type { AdjustmentParameters } from '../shared/adjustments'
import type { LensSettings, ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import type { PhotoMetadata, Photo, LinearAsset } from '../shared/contracts'

/** Main-owned admission snapshot for an actual HDR RAW source miss. */
export interface HdrRawPreparation {
  readonly originalSha256: string
  readonly parentWorkingKey: string
  readonly policy: import('../shared/resource-policy').ResourcePolicySnapshot
  readonly rendererReservation: { readonly ramBytes: number; readonly vramBytes: number }
}
export interface NativeRawWorkerContext extends HdrRawPreparation {
  /** Main-generated capability for one source request in the current full worker job. */
  readonly nonce: string
}
export interface NativeRawDiagnostics {
  readonly validationMs: number
  readonly sourceBytes: number
  readonly peakRamBytes: number
  readonly peakGpuBytes: number
  readonly childMs: number
  readonly armedMs: number
}
export type NativeRawWorkerRequest =
  | { readonly type: 'raw-source-request'; readonly nonce: string }
  | { readonly type: 'raw-source-reader-ready'; readonly nonce: string }
export type NativeRawMainMessage =
  | { readonly type: 'raw-source-stream'; readonly nonce: string }
  | {
      readonly type: 'raw-source-exit'
      readonly nonce: string
      readonly code: number | null
      readonly signal: string | null
      readonly diagnostics: NativeRawDiagnostics
    }
  | {
      readonly type: 'raw-source-declined'
      readonly nonce: string
      readonly reason: 'unavailable' | 'memory-limit'
      readonly message: string
    }

export interface HdrFirstSurfaceArtifact {
  readonly identity: import('../shared/hdr-first-surface').HdrFirstSurfaceIdentity
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly sha256: string
  readonly programHashes: Readonly<Record<string, string>>
  readonly timings: Record<string, number>
}
export type HdrFirstSurfaceProgress =
  | { readonly status: 'ready'; readonly artifact: HdrFirstSurfaceArtifact }
  | { readonly status: 'declined'; readonly reason: string }

export type PreviewStage = 'unpack' | 'gpu' | 'cpu' | 'cache'
export interface PreviewWarmResult {
  readonly status: 'ready' | 'unavailable' | 'skipped'
  readonly kernel: import('../renderer/src/preview/hdr-shader').HdrCacheKernelKind
  readonly elapsedMs: number
  readonly timings: import('../shared/preview-diagnostics').PreviewWarmTimings
  readonly reason?: string
}
export type PreviewWorkerRequest =
  | { type: 'close' }
  | { type: 'release' }
  | NativeRawMainMessage
  | {
      type:
        | 'process'
        | 'thumbnail'
        | 'thumbnail-fallback'
        | 'full'
        | 'metadata'
        | 'capture-metadata'
        | 'capture-metadata-session'
        | 'statistics'
        | 'pixel'
        | 'warmup'
      path: string
      output: string
      options?: ProcessingOptions
      frame?: { width: number; height: number; sha256: string; hdr?: HdrStatisticsJob }
      pixel?: HdrPixelJob
      importMode?: 'embedded' | 'fallback'
      importSeed?: PreviewResult
      kernel?: import('../renderer/src/preview/hdr-shader').HdrCacheKernelKind
      nativeRaw?: NativeRawWorkerContext
    }
export type PreviewWorkerResponse =
  | NativeRawWorkerRequest
  | { type: 'stage'; stage: PreviewStage }
  | { type: 'first-surface'; progress: HdrFirstSurfaceProgress }
  | {
      type: 'result'
      result:
        | PreviewResult
        | ThumbnailResult
        | FullPreviewResult
        | ProcessingMetadata
        | ImageStatistics
        | HdrStatistics
        | HdrPixel
        | PreviewWarmResult
        | import('../shared/capture-sequence').CaptureMetadata
    }
  | { type: 'error'; error: string }

export interface PreviewResult {
  needsFallback?: boolean
  preparation?: { timings: Record<string, number>; cpuMicros: number; rssBytes: number }
  captureMetadata?: import('../shared/capture-sequence').CaptureMetadata
  processing?: ProcessingMetadata
  metadata: PhotoMetadata
  source: Photo['previewSource']
}

export interface PreviewProcessor {
  createWorker?(): PreviewProcessor
  prepare?(
    path: string,
    output: string,
    signal: AbortSignal,
    fallback: boolean,
    seed?: PreviewResult,
  ): Promise<PreviewResult>
  process(path: string, output: string, signal: AbortSignal): Promise<PreviewResult>
  close(): Promise<void>
}

export interface CaptureMetadataProcessor {
  inspectCapture(
    path: string,
    signal: AbortSignal,
  ): Promise<import('../shared/capture-sequence').CaptureMetadata>
  inspectCaptures?(
    paths: string[],
    signal: AbortSignal,
    beforeRead?: (index: number) => Promise<void>,
  ): Promise<import('../shared/capture-sequence').CaptureMetadata[]>
  close(): Promise<void>
}

export type ThumbnailResult =
  { state: 'ready'; source: Photo['previewSource'] } | { state: 'needs-fallback' }

export interface ThumbnailProcessor {
  thumbnail(
    path: string,
    output: string,
    signal: AbortSignal,
    fallback?: boolean,
  ): Promise<ThumbnailResult>
  close(): Promise<void>
}

/** Elapsed worker-process clocks, including CPU scheduling and GPU waits, never GPU timestamps.
 * workerPreparationMs encloses the preparation stages. workerGpuTotalMs encloses GPU stages;
 * workerGpuProcessingMs includes workerGpuCorrectionMs, and workerGpuReadbackMs includes its
 * map and orientation-copy children. Parent and child durations must not be added together.
 */
export interface HdrPreparationTimings {
  workerNativeRawSourceMs?: number
  workerNativeRawValidateMs?: number
  workerNativeRawReceiveMs?: number
  workerPreparationMs?: number
  workerDecoderOpenMs?: number
  workerUnpackMs?: number
  workerSensorSourceMs?: number
  workerCorrectionPlanMs?: number
  workerGpuTotalMs?: number
  workerGpuInitializeMs?: number
  workerGpuUploadMs?: number
  workerGpuProcessingMs?: number
  workerGpuCorrectionMs?: number
  workerGpuReadbackMs?: number
  workerGpuReadbackMapMs?: number
  workerGpuOrientationCopyMs?: number
  workerCpuFallbackMs?: number
  workerDecoderCloseMs?: number
  workerGpuReleaseMs?: number
  workerHighlightBlendMs?: number
  workerCpuGeometryMs?: number
  workerNativeOpenMs?: number
  workerNativeWriteMs?: number
  workerNativeWholeHashMs?: number
  workerNativeStripHashMs?: number
  workerNativeCloseMs?: number
}

export interface FullPreviewResult {
  firstSurface?: HdrFirstSurfaceArtifact
  firstSurfaceDecline?: string
  statistics?: ImageStatistics
  adjustments?: AdjustmentParameters
  linear?: LinearAsset
  settingsRevision?: number
  appliedCorrections?: LensSettings
  width: number
  height: number
  format: 'rgba8-srgb' | 'hdr-working'
  byteLength: number
  sha256: string
  renderId: string
  placeholderBytes: number
  diagnostics?: {
    sourceBackend?: 'wasm-libraw' | 'native-rust-rows'
    clock?: 'worker-performance'
    backend: 'cpu' | 'gpu'
    adapter?: string
    fallback?: string
    timings: Record<string, number> & HdrPreparationTimings
  }
}

export interface FullPreviewProcessor {
  prewarmHdr?(
    kernel: import('../renderer/src/preview/hdr-shader').HdrCacheKernelKind,
  ): Promise<PreviewWarmResult>
  hdrPixel?(path: string, job: HdrPixelJob, signal: AbortSignal): Promise<HdrPixel>
  hdrStatistics?(path: string, job: HdrStatisticsJob, signal: AbortSignal): Promise<HdrStatistics>
  statistics?(
    path: string,
    frame: { width: number; height: number; sha256: string },
    signal: AbortSignal,
  ): Promise<ImageStatistics>
  renderFull(
    path: string,
    output: string,
    signal: AbortSignal,
    options?: ProcessingOptions,
    onFirstSurface?: (progress: HdrFirstSurfaceProgress) => Promise<void>,
    preparation?: HdrRawPreparation,
  ): Promise<FullPreviewResult>
  close(): Promise<void>
  releaseFrame?(): void
}
