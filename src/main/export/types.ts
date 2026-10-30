import type { Photo } from '../../shared/contracts'
import type { ProcessingOptions } from '../../shared/lens'
import type { ExportOptions, ExportResult } from '../../shared/export'
import type { CropGeometry } from '../../shared/crop'
import type { CropPreparationResult } from '../processing/crop-preparation'

type CropStageDiagnostics = Pick<
  CropPreparationResult,
  'backend' | 'adapter' | 'fallback' | 'cpuTiles' | 'gpuTiles' | 'precisionRecoveryTiles'
> & { memory?: CropPreparationResult['memory'] }
export interface ExportCropDiagnostics {
  geometry: CropGeometry
  geometryVersion: CropPreparationResult['geometryVersion']
  filterVersion: CropPreparationResult['filterVersion']
  working?: CropStageDiagnostics
  primary?: CropStageDiagnostics
}

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
export interface ExportCropPolicy {
  geometry: string
  filter: string
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
    crop?: ExportCropPolicy
    detail?: ExportDetailPolicy
    resize?: ExportResizePolicy
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
  memory?: {
    render?: ReturnType<typeof import('../../shared/export-resources').exportRenderMemoryPlan>
    sdr?: ReturnType<typeof import('../../shared/export-resources').exportSdrEncodePlan>
    hdr?: ReturnType<typeof import('../../shared/export-resources').exportHdrEncodePlan>
  }
  detail?: ExportDetailDiagnostics
  crop?: ExportCropDiagnostics
  resize?: {
    policy: ExportResizePolicy
    input: { width: number; height: number }
    output: { width: number; height: number }
    enlarged: boolean
  }
  renderer: 'gpu' | 'cpu'
  encoder: 'native' | 'wasm' | 'sdr'
  adapter?: string
  rendererFallback?: string
  gpuMemoryBytes?: number
  encoderFallback?: string
  encoderMemory?: { kind: 'process-rss' | 'wasm-heap'; peakBytes: number }
  sourceBackend?: string
  sourceFallback?: string
  sourcePreparation?: 'decoded' | 'preview-cache' | 'retained' | 'managed'
  retries?: number
  stages: Record<string, number>
}
export interface ExportRenderResult {
  path: string
  sha256: string
  diagnostics?: ExportDiagnostics
}
export interface ExportRenderJob {
  resizePolicy?: ExportResizePolicy
  resizeAdmission?: import('../../shared/export-resources').ExportAdmission
  detailPolicy?: ExportDetailPolicy
  detailAdmission?: import('../../shared/detail-resources').DetailAdmission
  /** Accepted geometry/filter versions, copied from the immutable export manifest. */
  cropPolicy?: ExportCropPolicy
  /** Main-owned live resource snapshot; it is not a saved edit or renderer parameter. */
  cropAdmission?: import('../../shared/crop-resources').CropAdmission
  workerProgressIdentity?: { exportId: string; fileIndex: number; attemptId: string }
  source: ExportSource
  options: ExportOptions
  directory: string
  hdr: boolean
  /** Main-owned preparation survives foreground retry; output in directory stays disposable. */
  preparationDirectory?: string
  workingAsset?: Omit<import('../working-assets').WorkingAssetLease, 'release'>
  /** Authored HDR keeps its independently prepared SDR primary under a separate source lease. */
  primaryWorkingAsset?: Omit<import('../working-assets').WorkingAssetLease, 'release'>
}

export interface ExportResizePolicy {
  filter: string
}

export interface ExportDetailPolicy {
  stage: string
  noiseReduction: string
  detailSharpening: string
}
export interface ExportDetailStageDiagnostics {
  key: string
  preparation: 'preview-cache' | 'retained' | 'filtered'
  sourceIdentity: string
  sourceSha256: string
  work?: import('../processing/detail-bands').DetailBandDiagnostics
}
export interface ExportDetailDiagnostics {
  policy: ExportDetailPolicy
  working?: ExportDetailStageDiagnostics
  primary?: ExportDetailStageDiagnostics
}
