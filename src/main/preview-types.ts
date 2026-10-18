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

export type PreviewStage = 'unpack' | 'gpu' | 'cpu' | 'cache'
export type PreviewWorkerRequest =
  | { type: 'close' }
  | { type: 'release' }
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
      path: string
      output: string
      options?: ProcessingOptions
      frame?: { width: number; height: number; sha256: string; hdr?: HdrStatisticsJob }
      pixel?: HdrPixelJob
      importMode?: 'embedded' | 'fallback'
      importSeed?: PreviewResult
    }
export type PreviewWorkerResponse =
  | { type: 'stage'; stage: PreviewStage }
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
    clock?: 'worker-performance'
    backend: 'cpu' | 'gpu'
    adapter?: string
    fallback?: string
    timings: Record<string, number> & HdrPreparationTimings
  }
}

export interface FullPreviewProcessor {
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
  ): Promise<FullPreviewResult>
  close(): Promise<void>
  releaseFrame?(): void
}
