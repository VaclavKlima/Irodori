import type { Photo } from '../../shared/contracts'
import type { ProcessingOptions } from '../../shared/lens'
import type { ExportOptions, ExportResult } from '../../shared/export'

export interface FileIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}
export interface ExportSource {
  photo: Photo
  path: string
  processing: ProcessingOptions
  identity: FileIdentity
  hdr: boolean
}
export interface ExportManifest {
  version: 1
  id: string
  acceptedAt: string
  rendering: string
  codec: string
  pipeline: {
    display: string
    hdrContent: string
    adjustments: string
    lens: string
    sdrEncoder: string
  }
  destinationId: string
  options: ExportOptions
  sources: ExportSource[]
}
export interface ExportFile extends Omit<ExportResult, 'status'> {
  status: ExportResult['status'] | 'pending' | 'writing' | 'publishing'
  partial?: string
  identity?: FileIdentity
  sha256?: string
  diagnostics?: ExportDiagnostics
}
export interface ExportDiagnostics {
  renderer: 'gpu' | 'cpu'
  encoder: 'native' | 'wasm' | 'sdr'
  adapter?: string
  rendererFallback?: string
  gpuMemoryBytes?: number
  encoderFallback?: string
  encoderMemory?: { kind: 'process-rss' | 'wasm-heap'; peakBytes: number }
  sourceBackend?: string
  sourceFallback?: string
  retries?: number
  stages: Record<string, number>
}
export interface ExportRenderResult {
  path: string
  sha256: string
  diagnostics?: ExportDiagnostics
}
export interface ExportRenderJob {
  source: ExportSource
  options: ExportOptions
  directory: string
  hdr: boolean
}
