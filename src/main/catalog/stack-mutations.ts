import { catalogTransaction } from './transaction'
import { randomUUID } from 'node:crypto'
import { StackStore } from '../stacks'
import type { Photo } from '../../shared/contracts'
import type { MergeManifest } from '../../shared/merge'
import {
  detectCaptureSequences,
  preciseCaptureTime,
  type CaptureMetadata,
} from '../../shared/capture-sequence'
import type { StackSummary } from '../../shared/stacks'

/** Runtime catalog writer; bootstrap may use it before the main read guard. */
export class StackMutations extends StackStore {
  private transaction<T>(work: () => T): T {
    return catalogTransaction(this.db, work)
  }
  private bump() {
    this.db.exec('UPDATE stack_state SET revision = revision + 1 WHERE singleton = 1')
  }
  private remember(ids: string[], reason: string) {
    for (const id of ids)
      this.db.prepare('INSERT OR REPLACE INTO stack_overrides VALUES (?, ?)').run(id, reason)
  }
  private ordered(ids: string[], coverId: string): string[] {
    const photos = ids.map((id) => {
      const row = this.db.prepare('SELECT rowid, photo FROM photos WHERE id = ?').get(id) as {
        rowid: number
        photo: string
      }
      const photo = JSON.parse(row.photo) as Photo
      const metadata = this.capture(id)
      const time =
        preciseCaptureTime(metadata?.preciseTime) ??
        preciseCaptureTime(
          photo.capturedAt
            ?.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')
            .replace(/(T\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/, '$1.0$2'),
        )
      const imported = Date.parse(photo.importedAt)
      // A per-photo fallback produces a total order even when only some dates are known.
      const sortTime =
        time ?? (Number.isFinite(imported) ? BigInt(imported) * 10n ** 15n : BigInt(row.rowid))
      return { photo, rowid: row.rowid, sortTime }
    })
    return photos
      .sort((a, b) => {
        if (a.photo.id === coverId) return -1
        if (b.photo.id === coverId) return 1
        if (a.photo.assetKind === 'derived' || b.photo.assetKind === 'derived') {
          if (a.photo.assetKind !== b.photo.assetKind)
            return a.photo.assetKind === 'derived' ? -1 : 1
          return b.photo.importedAt.localeCompare(a.photo.importedAt) || b.rowid - a.rowid
        }
        if (a.sortTime !== b.sortTime) return a.sortTime < b.sortTime ? -1 : 1
        return a.photo.importedAt.localeCompare(b.photo.importedAt) || a.rowid - b.rowid
      })
      .map((p) => p.photo.id)
  }
  private membership(id: string, ids: string[], coverId: string) {
    this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(id)
    for (const [position, photoId] of this.ordered(ids, coverId).entries())
      this.db.prepare('INSERT INTO stack_members VALUES (?, ?, ?)').run(photoId, id, position)
  }
  group(ids: string[], coverId: string, revision: number): StackSummary {
    return this.transaction(() => {
      if (!Number.isSafeInteger(revision) || revision !== this.overview().revision)
        throw new Error('Stale gallery revision. Reload the library.')
      if (
        !Array.isArray(ids) ||
        ids.length < 2 ||
        new Set(ids).size !== ids.length ||
        !ids.includes(coverId)
      )
        throw new Error('Select at least two ungrouped photos and a selected cover.')
      for (const id of ids)
        if (this.forPhoto(id)) throw new Error('Manual grouping requires ungrouped photos.')
      const id = randomUUID()
      this.db
        .prepare("INSERT INTO stacks (id, cover_id, origin, touched) VALUES (?, ?, 'manual', 1)")
        .run(id, coverId)
      this.membership(id, ids, coverId)
      this.remember(ids, 'manual-group')
      this.bump()
      return this.summary(this.row(id))
    })
  }
  ungroup(id: string, revision: number) {
    this.transaction(() => {
      this.expected(id, revision)
      this.remember(this.ids(id), 'ungroup')
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(id)
      this.db.prepare('DELETE FROM stacks WHERE id = ?').run(id)
      this.bump()
    })
  }
  remove(photoId: string, revision: number): StackSummary | null {
    return this.transaction(() => {
      const stack = this.forPhoto(photoId)
      if (!stack) throw new Error('This photo is not in a stack.')
      this.expected(stack.id, revision)
      this.remember(this.ids(stack.id), 'membership-change')
      this.db.prepare('UPDATE stacks SET touched = 1 WHERE id = ?').run(stack.id)
      this.repairRemoval(photoId)
      return this.forPhoto(this.ids(stack.id)[0] ?? photoId)
    })
  }
  setCover(id: string, photoId: string, revision: number): StackSummary {
    return this.transaction(() => {
      this.expected(id, revision)
      const ids = this.ids(id)
      if (!ids.includes(photoId)) throw new Error('The cover must belong to this stack.')
      if (this.row(id).cover_id !== photoId) {
        this.remember(ids, 'cover-change')
        this.membership(id, ids, photoId)
        this.db
          .prepare(
            'UPDATE stacks SET cover_id = ?, touched = 1, revision = revision + 1 WHERE id = ?',
          )
          .run(photoId, id)
        this.bump()
      }
      return this.summary(this.row(id))
    })
  }
  setExpanded(id: string, expanded: boolean, revision: number): StackSummary {
    return this.transaction(() => {
      const row = this.expected(id, revision)
      if (typeof expanded !== 'boolean') throw new Error('Invalid stack expansion.')
      if (!!row.expanded !== expanded) {
        this.db
          .prepare('UPDATE stacks SET expanded = ?, revision = revision + 1 WHERE id = ?')
          .run(Number(expanded), id)
        this.bump()
      }
      return this.summary(this.row(id))
    })
  }
  repairRemoval(photoId: string) {
    const member = this.db
      .prepare('SELECT stack_id FROM stack_members WHERE photo_id = ?')
      .get(photoId) as { stack_id: string } | undefined
    if (!member) return
    const row = this.row(member.stack_id)
    this.db.prepare('DELETE FROM stack_members WHERE photo_id = ?').run(photoId)
    const ids = this.ids(row.id)
    if (row.origin === 'capture') this.remember(ids, 'membership-change')
    if (ids.length < 2) {
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(row.id)
      this.db.prepare('DELETE FROM stacks WHERE id = ?').run(row.id)
    } else {
      const newestMerge = ids
        .map((id) => this.photo(id))
        .filter((p) => p.assetKind === 'derived')
        .sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0]
      const coverId = row.cover_id === photoId ? (newestMerge?.id ?? ids[0]) : row.cover_id
      this.membership(row.id, ids, coverId)
      this.db
        .prepare(
          'UPDATE stacks SET cover_id = ?, revision = revision + 1, touched = 1 WHERE id = ?',
        )
        .run(coverId, row.id)
    }
    this.bump()
  }
  attachMerge(manifest: MergeManifest) {
    const related = new Set([
      manifest.photo.id,
      ...manifest.recipe.sources
        .map((s) => s.id)
        .filter((id) => !!this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)),
    ])
    const groups = new Set<string>()
    for (const id of related) {
      const stack = this.forPhoto(id)
      if (stack) groups.add(stack.id)
    }
    for (const id of groups) for (const member of this.ids(id)) related.add(member)
    if (related.size < 2) return
    const id = groups.values().next().value ?? randomUUID()
    for (const group of groups) {
      this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(group)
      if (group !== id) this.db.prepare('DELETE FROM stacks WHERE id = ?').run(group)
    }
    if (!groups.size)
      this.db
        .prepare("INSERT INTO stacks (id, cover_id, origin, touched) VALUES (?, ?, 'merge', 1)")
        .run(id, manifest.photo.id)
    else
      this.db
        .prepare(
          "UPDATE stacks SET cover_id = ?, expanded = 0, origin = 'merge', automatic_key = NULL, touched = 1, revision = revision + 1 WHERE id = ?",
        )
        .run(manifest.photo.id, id)
    this.membership(id, [...related], manifest.photo.id)
    this.bump()
  }
  putCapture(photoId: string, metadata: CaptureMetadata) {
    this.db
      .prepare('INSERT OR REPLACE INTO capture_metadata VALUES (?, ?)')
      .run(photoId, JSON.stringify(metadata))
  }
  reconcileCaptures(): number {
    return this.transaction(() => {
      const captures = (
        this.db
          .prepare(
            'SELECT photo_id, data FROM capture_metadata JOIN photos ON photo_id = photos.id',
          )
          .all() as { photo_id: string; data: string }[]
      ).map((r) => ({ id: r.photo_id, metadata: JSON.parse(r.data) as CaptureMetadata }))
      let changed = 0
      for (const sequence of detectCaptureSequences(captures)) {
        if (
          sequence.ids.some(
            (id) => !!this.db.prepare('SELECT 1 FROM stack_overrides WHERE photo_id = ?').get(id),
          )
        )
          continue
        const groups = new Set(
          sequence.ids.map((id) => this.forPhoto(id)?.id).filter((id): id is string => !!id),
        )
        if (
          [...groups].some((id) => {
            const r = this.row(id)
            return (
              r.origin !== 'capture' ||
              r.touched ||
              this.ids(id).some((member) => !sequence.ids.includes(member))
            )
          })
        )
          continue
        // Keep the group containing the earliest already grouped frame. A refreshed
        // profile or newly imported start can change the key without changing intent.
        const id =
          sequence.ids.map((member) => this.forPhoto(member)?.id).find((id) => !!id) ?? randomUUID()
        if (groups.size) {
          const ids = this.ids(id)
          if (
            groups.size === 1 &&
            ids.length === sequence.ids.length &&
            this.row(id).automatic_key === sequence.key
          )
            continue
          for (const group of groups) {
            this.db.prepare('DELETE FROM stack_members WHERE stack_id = ?').run(group)
            if (group !== id) this.db.prepare('DELETE FROM stacks WHERE id = ?').run(group)
          }
          this.db
            .prepare('UPDATE stacks SET automatic_key = ?, revision = revision + 1 WHERE id = ?')
            .run(sequence.key, id)
        } else
          this.db
            .prepare(
              "INSERT INTO stacks (id, cover_id, origin, automatic_key) VALUES (?, ?, 'capture', ?)",
            )
            .run(id, sequence.ids[0], sequence.key)
        this.membership(id, sequence.ids, this.row(id).cover_id)
        this.bump()
        changed++
      }
      return changed
    })
  }
}
