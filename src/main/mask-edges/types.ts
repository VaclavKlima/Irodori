import type { ResolvedMask } from '../../shared/masks'
import type { MaskRange } from '../../shared/mask-ranges'
import type { MaskRangeSource } from '../mask-ranges/types'

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
}
export interface MaskEdgeWorkerReply {
  id: number
  result?: MaskEdgeResult
  error?: string
}
