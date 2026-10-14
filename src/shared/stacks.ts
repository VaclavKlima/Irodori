import type { Photo, PhotoReference } from './contracts'

export interface StackSummary {
  id: string
  coverId: string
  count: number
  expanded: boolean
  origin: 'manual' | 'merge' | 'capture'
  revision: number
}
export interface StackOverview {
  revision: number
  stacks: StackSummary[]
}
export interface StackSnapshot {
  stack: StackSummary
  photos: Photo[]
}
export interface StackMembers extends StackSnapshot {
  total: number
}
export interface GalleryEntry {
  photo: Photo
  stack?: StackSummary
  cover?: PhotoReference
  memberIndex?: number
  mergeSourceCount?: number
}
export interface GalleryRevision {
  catalogRevision: number
  revision: number
}
export interface GallerySummary extends GalleryRevision {
  total: number
  storedTotal: number
  hiddenSelectedIds: string[]
}
export interface GalleryRead extends GallerySummary {
  entries: GalleryEntry[]
}
export interface GalleryChunk extends GalleryRead {
  offset: number
}
export interface GalleryLocation extends GalleryChunk {
  offset: number
  index: number
  /** The requested photo can be hidden behind its cover. */
  photo: Photo
}

/** Inputs follow flat catalog order; each stack's members follow persisted order. */
export function projectGallery(
  photos: Photo[],
  stacks: { summary: StackSummary; memberIds: string[] }[],
  sourceCounts = new Map<string, number>(),
): GalleryEntry[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const memberships = new Map<string, (typeof stacks)[number]>()
  for (const stack of stacks) for (const id of stack.memberIds) memberships.set(id, stack)
  return photos.flatMap((photo): GalleryEntry[] => {
    const group = memberships.get(photo.id)
    if (!group) return [{ photo, mergeSourceCount: sourceCounts.get(photo.id) }]
    if (photo.id !== group.summary.coverId) return []
    const cover = { id: photo.id, filename: photo.filename }
    const ids = [photo.id, ...group.memberIds.filter((id) => id !== photo.id)]
    return (group.summary.expanded ? ids : [photo.id]).flatMap((id, memberIndex) => {
      const member = byId.get(id)
      return member
        ? [
            {
              photo: member,
              stack: group.summary,
              cover,
              memberIndex,
              mergeSourceCount: sourceCounts.get(id),
            },
          ]
        : []
    })
  })
}

export function galleryPosition(entries: GalleryEntry[], id: string, coverId?: string): number {
  const direct = entries.findIndex((entry) => entry.photo.id === id)
  return direct >= 0 ? direct : entries.findIndex((entry) => entry.photo.id === coverId)
}
