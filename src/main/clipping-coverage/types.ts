import type { AdjustmentParameters } from '../../shared/adjustments'

/** Internal isolated-worker contract. Owned paths never enter the renderer bridge. */
export interface ClippingCoverageResult {
  path: string
  sha256: string
  byteLength: number
  maskCount: number
  width: number
  height: number
  key: string
  stripSha256: string[]
}

export interface ClippingCoverageWorkerRequest {
  id: number
  parameters: AdjustmentParameters
  width: number
  height: number
  key: string
  outputPath: string
}

export interface ClippingCoverageWorkerReply {
  id: number
  result?: ClippingCoverageResult
  error?: string
}
