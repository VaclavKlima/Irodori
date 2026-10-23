import type { BackgroundTask, Photo } from '../../shared/contracts'
import type { EditHistory } from '../../shared/edits'
import type { ProcessingOptions, ProcessingMetadata } from '../../shared/lens'
import type { ProcessingIdentity } from '../../shared/hdr'
import type { CaptureMetadata } from '../../shared/capture-sequence'
import type { WorkspaceChange } from '../../shared/workspace'
import type { StackSummary } from '../../shared/stacks'
import type { MergeManifest } from '../../shared/merge'
import type { ExportDestination } from '../../shared/export'
import type { CameraBinding, CameraSourceKey } from '../camera-recognition'
import type { ImportSourceWitness } from '../import-source-records'
import type { ExportFile, ExportManifest } from '../export/types'
import type { Grant } from '../export/store'

/** Main-only domain operations. No renderer, SQL text, callback or file execution API. */
export interface CatalogOperations {
  'processing.publish': {
    input: { id: string; data: ProcessingOptions; createdAt: string }
    output: void
  }
  'edits.commit': {
    input: { history: EditHistory; expectedRevision: number }
    output: { history: EditHistory; lensChanged: boolean }
  }
  'workspace.save': { input: WorkspaceChange; output: number }
  'stack.group': {
    input: { ids: string[]; coverId: string; revision: number }
    output: StackSummary
  }
  'stack.ungroup': { input: { id: string; revision: number }; output: void }
  'stack.remove': { input: { photoId: string; revision: number }; output: StackSummary | null }
  'stack.cover': { input: { id: string; photoId: string; revision: number }; output: StackSummary }
  'stack.expanded': {
    input: { id: string; expanded: boolean; revision: number }
    output: StackSummary
  }
  'capture.publish': { input: { photoId: string; metadata: CaptureMetadata }; output: void }
  'capture.reconcile': { input: Record<string, never>; output: number }
  'original.publish': {
    input: {
      photo: Photo
      processingIdentity: ProcessingIdentity
      metadata?: ProcessingMetadata
      capture?: CaptureMetadata
      createdAt: string
    }
    output: void
  }
  'source.record': {
    input: { key: string; witness: ImportSourceWitness; photoId: string }
    output: boolean
  }
  'camera.record': {
    input: {
      key: CameraSourceKey
      witness: ImportSourceWitness
      photoId: string
      proof: CameraBinding['proof']
    }
    output: void
  }
  'camera.sample': { input: { photoId: string; digest: string }; output: void }
  'removal.journal': { input: { id: string; staged: string }; output: void }
  'removal.clear': { input: { id: string }; output: void }
  'removal.finish': { input: { id: string }; output: void }
  'merge.journal': { input: { id: string; manifestSha256: string }; output: void }
  'merge.publish': { input: { manifest: MergeManifest; createdAt: string }; output: void }
  'export.authorize': { input: Omit<Grant, 'id'>; output: ExportDestination }
  'export.accept': {
    input: { manifest: ExportManifest; task: BackgroundTask; custom: boolean }
    output: void
  }
  'export.file': { input: { jobId: string; file: ExportFile }; output: void }
  'export.task': { input: { task: BackgroundTask }; output: void }
  'export.dismiss': { input: { id: string }; output: void }
}
export type CatalogOperation = keyof CatalogOperations
export type CatalogCommand<K extends CatalogOperation = CatalogOperation> = {
  [P in K]: { operation: P; payload: CatalogOperations[P]['input'] }
}[K]
export type CatalogOutput<K extends CatalogOperation> = CatalogOperations[K]['output']
export type CatalogRequest =
  { type: 'mutate'; sequence: number; command: CatalogCommand } | { type: 'close' }
export type CatalogResponse =
  | { type: 'ready' }
  | { type: 'result'; sequence: number; value: unknown }
  | { type: 'rejected'; sequence: number; message: string }
  | { type: 'closed' }

/** These commands are already admitted durable mutations; abort cannot undo a COMMIT. */
export interface CatalogCommands {
  command<K extends CatalogOperation>(command: CatalogCommand<K>): Promise<CatalogOutput<K>>
}
