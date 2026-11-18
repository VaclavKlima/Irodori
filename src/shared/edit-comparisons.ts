import type { EditComparisonSource } from './edit-checkpoints'
import type { InspectionImage, InspectionOptions, PreviewContext } from './inspection'

export type EditComparisonMemberId = 'a' | 'b'
export interface PrepareEditComparisonRequest {
  photoId: string
  baseline: EditComparisonSource
  target: EditComparisonSource
  requestId: string
}
export interface EditComparisonMember {
  source: EditComparisonSource
  label: string
  identity: string
  capturedFromRevision: number
}
export interface EditComparisonSession {
  id: string
  photoId: string
  members: readonly [EditComparisonMember, EditComparisonMember]
  context: PreviewContext
}
export type EditComparisonInspectionOptions = Omit<InspectionOptions, 'comparison'>
export interface EditComparisonInspectionImage extends Omit<
  InspectionImage,
  'label' | 'comparison'
> {
  label: EditComparisonMemberId
  version: EditComparisonMember
  comparison: 'saved checkpoint' | 'frozen current edit'
}
export interface EditComparisonInspectionResult {
  photoId: string
  sessionId: string
  gridIdentity: string
  members: readonly [EditComparisonInspectionImage, EditComparisonInspectionImage]
}
