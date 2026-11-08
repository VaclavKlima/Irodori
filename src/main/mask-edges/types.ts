import type { ResolvedMask } from '../../shared/masks'

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
}
export interface MaskEdgeWorkerReply {
  id: number
  result?: MaskEdgeResult
  error?: string
}
