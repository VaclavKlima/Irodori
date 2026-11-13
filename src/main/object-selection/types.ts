export type ObjectSelectionPoint = readonly [number, number]

/** Internal main/worker contract. Filesystem paths never cross the renderer bridge. */
export interface ObjectSelectionSource {
  key: string
  path: string
  width: number
  height: number
  format: 'rgba8'
}

export interface ObjectSelectionPrompts {
  key: string
  box?: readonly [number, number, number, number]
  positivePoints?: readonly ObjectSelectionPoint[]
  negativePoints?: readonly ObjectSelectionPoint[]
}

export interface ObjectSelectionPrepared {
  key: string
  width: number
  height: number
  modelIdentity: string
}

export interface ObjectSelectionResult extends ObjectSelectionPrepared {
  path: string
  sha256: string
  encodedBytes: number
  selectedCandidate: number
  predictedIou: number
}

export type ObjectSelectionWorkerRequest = {
  id: number
  modelDirectory: string
} & (
  | { operation: 'prepare'; source: ObjectSelectionSource }
  | { operation: 'refine'; prompts: ObjectSelectionPrompts; outputPath: string }
  | {
      operation: 'automatic'
      selection: 'sky' | 'background'
      source: ObjectSelectionSource
      outputPath: string
    }
)

export type ObjectSelectionWorkerReply = {
  id: number
  result?: ObjectSelectionPrepared | ObjectSelectionResult
  error?: string
}
