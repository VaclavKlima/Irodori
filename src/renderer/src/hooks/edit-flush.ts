import type { EditFlushScope } from '../../../shared/edits'

/** Pending writes keep their photo ownership even after the active photo changes. */
export class EditFlushes {
  private pending = new Map<string, Set<Promise<void>>>()

  track(photoId: string, work: Promise<void>) {
    const writes = this.pending.get(photoId) ?? new Set<Promise<void>>()
    writes.add(work)
    this.pending.set(photoId, writes)
    const retire = () => {
      writes.delete(work)
      if (!writes.size && this.pending.get(photoId) === writes) this.pending.delete(photoId)
    }
    void work.then(retire, retire)
  }

  async flush(
    scope: EditFlushScope,
    activePhotoId: string | undefined,
    flushActive: () => Promise<void>,
  ) {
    const includes = (photoId: string) => scope.kind === 'all' || scope.photoIds.includes(photoId)
    const waiting = [...this.pending]
      .filter(([photoId]) => includes(photoId))
      .flatMap(([, writes]) => [...writes])
    if (scope.kind === 'all' || (activePhotoId && includes(activePhotoId)))
      waiting.push(flushActive())
    await Promise.all(waiting)
  }
}
