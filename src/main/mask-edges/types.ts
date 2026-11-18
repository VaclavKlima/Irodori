import type { ResolvedMask } from '../../shared/masks'
import type { MaskRange } from '../../shared/mask-ranges'
import type { MaskRangeSource } from '../mask-ranges/types'
import type { MaskGeometry } from '../../shared/mask-geometry'
import type { InspectionBounds } from '../../shared/inspection'
import type { MaskPreviewView } from '../../shared/mask-preview'

/** Internal managed-worker contract; paths never enter the renderer bridge. */
export interface MaskEdgeResult {
  path: string
  hash: string
  width: number
  height: number
  encodedBytes: number
  key: string
}
export interface MaskEdgeWorkerRequest {
  id: number
  mask: ResolvedMask
  width: number
  height: number
  key: string
  outputPath: string
  range?: { source: MaskRangeSource; parameters: MaskRange }
  inspection?: {
    geometry: MaskGeometry
    grid: { width: number; height: number }
    bounds: InspectionBounds
    view: MaskPreviewView
    photoPath?: string
  }
}
export interface MaskPreviewWorkerImage extends MaskEdgeResult {
  label: 'coverage' | 'overlay'
}
export interface MaskPreviewWorkerResult {
  key: string
  /** Actual Dawn adapter witness; not a claim about Electron or physical HDR presentation. */
  adapter?: string
  members: MaskPreviewWorkerImage[]
}
export interface DiagnosticOverlayMask {
  label: 'clipping' | 'above-white'
  width: number
  height: number
  dataBase64: string
  outputPath: string
  targetMode: 'hdr' | 'sdr'
}
export interface DiagnosticOverlayRequest {
  /** Composite Console proofs use a registered SDR PNG. Editor flags have transparent backgrounds. */
  basePath?: string
  masks: DiagnosticOverlayMask[]
}
export interface DiagnosticOverlayImage {
  label: DiagnosticOverlayMask['label']
  path: string
  sha256: string
  byteLength: number
  width: number
  height: number
}
export type MaskWorkerRequest =
  MaskEdgeWorkerRequest | { id: number; diagnosticOverlays: DiagnosticOverlayRequest }
export interface MaskEdgeWorkerReply {
  id: number
  result?: MaskEdgeResult
  preview?: MaskPreviewWorkerResult
  diagnosticOverlays?: DiagnosticOverlayImage[]
  error?: string
}
