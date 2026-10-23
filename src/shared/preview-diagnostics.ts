export interface PreviewPresentation {
  photoId: string
  revision: number
  targetGeneration: number
  backend: 'webgpu-hdr' | 'canvas2d-hdr-sdr' | 'legacy'
  mode: 'hdr' | 'sdr'
  stage: 'loading' | 'presented' | 'failed'
  reason: string
  timings: Record<string, number>
}
/** Worker wall clocks. Missing stages were not attempted; total includes every attempted stage. */
export interface PreviewWarmTimings {
  readonly wasmMs?: number
  readonly tableMs?: number
  readonly gpuMs?: number
  readonly totalMs: number
}
export interface PreviewDiagnostics {
  /** Historical startup-hint outcome, not current worker/device readiness after idle retirement. */
  prewarm?: {
    status: 'pending' | 'ready' | 'unavailable' | 'skipped'
    kernel: 'linear64'
    elapsedMs?: number
    workerElapsedMs?: number
    workerTimings?: PreviewWarmTimings
    reason?: string
  }
  photoId?: string
  revision?: number
  renderingIdentity?: string
  preparationBackend?: 'cpu' | 'gpu'
  cacheHit?: boolean
  loadingStage: 'idle' | 'preparing' | 'prepared' | 'failed'
  timings: Record<string, number>
  presentation?: PreviewPresentation
}
