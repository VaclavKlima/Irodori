import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { StackSummary } from '../shared/stacks'
import {
  photoActionIds,
  type ActionPhotoReference,
  type PhotoActionsContext,
  type PhotoActionAvailability,
} from '../shared/photo-actions'
import { MERGE_LIMITS } from '../shared/merge'

const facts = `p.id, json_extract(p.photo, '$.filename') AS filename,
  json_extract(p.photo, '$.format') AS format,
  COALESCE(json_extract(p.photo, '$.assetKind'), 'original') AS assetKind,
  m.stack_id AS groupId, s.revision AS groupRevision`
const joins =
  'LEFT JOIN stack_members m ON m.photo_id = p.id LEFT JOIN stacks s ON s.id = m.stack_id'
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)

/** Five bounded bulk reads at most, synchronously on the catalog owner's connection. */
export class PhotoActionsStore {
  constructor(private db: DatabaseSync) {}

  read(photoId: string | null, selectedIds: string[]): PhotoActionsContext {
    if (
      (photoId !== null && !validId(photoId)) ||
      !Array.isArray(selectedIds) ||
      selectedIds.some((id) => !validId(id))
    )
      throw new Error('Invalid photo actions targets.')
    const ids = [...new Set(selectedIds)]
    const state = this.db
      .prepare(
        `SELECT (SELECT revision FROM stack_state) AS galleryRevision,
        (SELECT revision FROM browse_state) AS catalogRevision,
        SUM(COALESCE(json_extract(photo, '$.assetKind'), 'original') != 'derived'
          AND upper(json_extract(photo, '$.format')) = 'ARW') AS originalArwCount FROM photos`,
      )
      .get() as Pick<PhotoActionsContext, 'galleryRevision' | 'catalogRevision'> & {
      originalArwCount: number | null
    }
    const selection = this.db
      .prepare(
        `SELECT ${facts} FROM json_each(?) requested JOIN photos p ON p.id = requested.value
        ${joins} ORDER BY requested.key`,
      )
      .all(JSON.stringify(ids)) as unknown as ActionPhotoReference[]
    const photo = photoId
      ? ((this.db.prepare(`SELECT ${facts} FROM photos p ${joins} WHERE p.id = ?`).get(photoId) as
          ActionPhotoReference | undefined) ?? null)
      : null
    let group: PhotoActionsContext['group'] = null
    if (photo?.groupId) {
      const row = this.db
        .prepare(
          `SELECT stacks.*,
        (SELECT COUNT(*) FROM stack_members WHERE stack_id = stacks.id) AS count
        FROM stacks WHERE id = ?`,
        )
        .get(photo.groupId) as {
        id: string
        cover_id: string
        expanded: number
        origin: StackSummary['origin']
        revision: number
        count: number
      }
      const photos = this.db
        .prepare(`SELECT ${facts} FROM photos p ${joins} WHERE m.stack_id = ? ORDER BY m.position`)
        .all(row.id) as unknown as ActionPhotoReference[]
      if (photos.length !== row.count)
        throw new Error('This photo group has unavailable photographs.')
      group = {
        stack: {
          id: row.id,
          coverId: row.cover_id,
          expanded: !!row.expanded,
          origin: row.origin,
          revision: row.revision,
          count: row.count,
        },
        photos,
        originals: photos.filter((p) => p.assetKind !== 'derived'),
      }
    }
    const selected = new Set(ids)
    const groupSelection =
      !!group && ids.length === group.photos.length && group.photos.every((p) => selected.has(p.id))
    return {
      ...state,
      originalArwCount: state.originalArwCount ?? 0,
      photo,
      selection,
      group,
      targetsCurrent: selection.length === ids.length && (!photoId || !!photo),
      targetIdentity: createHash('sha256')
        .update(JSON.stringify({ photo, selection, group }))
        .digest('hex'),
      equivalent: {
        photoSelection: !!photo && ids.length === 1 && ids[0] === photo.id,
        groupSelection,
        mergeInputs:
          !!group &&
          selection.length === group.originals.length &&
          selection.every(
            (p, index) => p.id === group.originals[index].id && p.assetKind !== 'derived',
          ),
      },
      availability: Object.fromEntries(
        photoActionIds.map((id) => [id, { kind: 'inapplicable' }]),
      ) as PhotoActionsContext['availability'],
    }
  }
}

export function originalMergeApplicable(photos: readonly ActionPhotoReference[]): boolean {
  return (
    photos.length >= MERGE_LIMITS.minSources &&
    photos.length <= MERGE_LIMITS.maxSources &&
    photos.every((p) => p.assetKind !== 'derived' && p.format.toUpperCase() === 'ARW')
  )
}

export function actionAvailability(applicable: boolean, reason?: string): PhotoActionAvailability {
  return !applicable
    ? { kind: 'inapplicable' }
    : reason
      ? { kind: 'blocked', reason }
      : { kind: 'applicable' }
}
