import type { PhotoReference } from './contracts'
import type { StackSummary } from './stacks'

export const photoActionIds = [
  'photo-export',
  'selection-export',
  'photo-cover',
  'photo-remove',
  'selection-hdr',
  'selection-noise',
  'selection-group',
  'group-select',
  'group-hdr',
  'group-noise',
  'group-ungroup',
  'library-scan',
  'photo-trash',
  'selection-trash',
  'group-trash',
] as const
export type PhotoActionId = (typeof photoActionIds)[number]
export type PhotoActionAvailability =
  { kind: 'applicable' } | { kind: 'blocked'; reason: string } | { kind: 'inapplicable' }

/** Stored catalog facts only: no originals, thumbnails, or processing metadata. */
export interface ActionPhotoReference extends PhotoReference {
  format: string
  assetKind: 'original' | 'derived'
  groupId: string | null
  groupRevision: number | null
}
export interface PhotoActionsContext {
  photo: ActionPhotoReference | null
  selection: ActionPhotoReference[]
  group: {
    stack: StackSummary
    photos: ActionPhotoReference[]
    originals: ActionPhotoReference[]
  } | null
  galleryRevision: number
  catalogRevision: number
  originalArwCount: number
  targetsCurrent: boolean
  /** Changes only when a relevant target changes; unrelated imports may change revisions. */
  targetIdentity: string
  equivalent: { photoSelection: boolean; groupSelection: boolean; mergeInputs: boolean }
  availability: Record<PhotoActionId, PhotoActionAvailability>
}

export type PhotoMenuSectionId = 'photo' | 'selection' | 'group' | 'library' | 'trash'
export type PhotoMenuIcon =
  'export' | 'cover' | 'remove' | 'merge' | 'group' | 'select' | 'ungroup' | 'trash'
export interface PhotoMenuAction {
  id: PhotoActionId
  scope: PhotoMenuSectionId
  label: string
  icon: PhotoMenuIcon
  availability: Exclude<PhotoActionAvailability, { kind: 'inapplicable' }>
  destructive: boolean
  shortcut?: string
}
export interface PhotoMenuModel {
  sections: { id: PhotoMenuSectionId; heading: string; actions: PhotoMenuAction[] }[]
  blockers: string[]
}

/** One flat command model for both workspaces and both invocation surfaces. */
export function buildPhotoMenu(context: PhotoActionsContext, toolbar: boolean): PhotoMenuModel {
  const count = context.selection.length
  const groupCount = context.group?.photos.length ?? 0
  const originalCount = context.group?.originals.length ?? 0
  const sections: PhotoMenuModel['sections'] = []
  const blockers = new Set<string>()
  const section = (
    id: PhotoMenuSectionId,
    heading: string,
    commands: { id: PhotoActionId; label: string; icon: PhotoMenuIcon; shortcut?: string }[],
  ) => {
    const actions = commands.flatMap((command): PhotoMenuAction[] => {
      const availability = context.availability[command.id]
      if (availability.kind === 'inapplicable') return []
      if (availability.kind === 'blocked') blockers.add(availability.reason)
      const scope = command.id.startsWith('photo-')
        ? 'photo'
        : command.id.startsWith('selection-')
          ? 'selection'
          : command.id.startsWith('group-')
            ? 'group'
            : 'library'
      return [{ ...command, scope, availability, destructive: id === 'trash' }]
    })
    if (actions.length) sections.push({ id, heading, actions })
  }
  section('photo', `Photo · ${context.photo?.filename ?? ''}`, [
    ...(!context.equivalent.photoSelection
      ? [{ id: 'photo-export' as const, label: 'Export this photo…', icon: 'export' as const }]
      : []),
    { id: 'photo-cover', label: 'Set this photo as group cover', icon: 'cover' },
    { id: 'photo-remove', label: 'Remove this photo from group', icon: 'remove' },
  ])
  section('selection', `Selection · ${count} ${count === 1 ? 'photo' : 'photos'}`, [
    { id: 'selection-export', label: 'Export selected photos…', icon: 'export' },
    { id: 'selection-hdr', label: 'Merge selected photos to HDR…', icon: 'merge' },
    { id: 'selection-noise', label: 'Stack selected photos for noise reduction…', icon: 'merge' },
    { id: 'selection-group', label: 'Group selected photos', icon: 'group' },
  ])
  section(
    'group',
    `Photo group · ${groupCount} ${groupCount === 1 ? 'photo' : 'photos'} · ${originalCount} ${originalCount === 1 ? 'original' : 'originals'}`,
    [
      { id: 'group-select', label: 'Select entire group', icon: 'select' },
      ...(!context.equivalent.mergeInputs
        ? ([
            {
              id: 'group-hdr',
              label: `Merge ${originalCount} group originals to HDR…`,
              icon: 'merge',
            },
            {
              id: 'group-noise',
              label: `Stack ${originalCount} group originals for noise reduction…`,
              icon: 'merge',
            },
          ] as const)
        : []),
      { id: 'group-ungroup', label: 'Ungroup photos', icon: 'ungroup' },
    ],
  )
  if (toolbar)
    section('library', 'Library operations', [
      { id: 'library-scan', label: 'Group capture sequences', icon: 'group' },
    ])
  section('trash', 'Trash', [
    ...(!context.equivalent.photoSelection
      ? ([{ id: 'photo-trash', label: 'Move this photo to Trash…', icon: 'trash' }] as const)
      : []),
    {
      id: 'selection-trash',
      label:
        count === 1 ? 'Move selected photo to Trash…' : `Move ${count} selected photos to Trash…`,
      icon: 'trash',
      shortcut: 'Del',
    },
    ...(!context.equivalent.groupSelection
      ? ([
          {
            id: 'group-trash',
            label: `Move entire group to Trash (${groupCount} ${groupCount === 1 ? 'photo' : 'photos'})…`,
            icon: 'trash',
          },
        ] as const)
      : []),
  ])
  return { sections, blockers: [...blockers] }
}
