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
    backend: 'cpu' | 'gpu'
    adapter?: string
    fallback?: string
    timings: Record<string, number>
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
