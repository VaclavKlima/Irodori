import type { Photo } from '../../shared/contracts'
import type { ProcessingMetadata } from '../../shared/lens'
import type { MergeManifest } from '../../shared/merge'
import type { CaptureMetadata } from '../../shared/capture-sequence'
import { validatedCaptureDate, type CaptureDateOrigin } from '../../shared/browse'
import { BrowseStore } from '../browse'

export class BrowseMutations extends BrowseStore {
  put(
    photo: Photo,
    metadata?: ProcessingMetadata,
    manifest?: MergeManifest,
    capture?: CaptureMetadata,
  ) {
    let capturedAt =
      [capture?.preciseTime, capture?.dateTimeOriginal, metadata?.capturedAt, photo.capturedAt]
        .map(validatedCaptureDate)
        .find((date) => date !== null) ?? null
    let origin: CaptureDateOrigin = capturedAt ? { kind: 'camera' } : { kind: 'unknown' }
    if (photo.assetKind === 'derived') {
      const recipe = manifest?.recipe ?? metadata?.mergeMaster?.recipe
      const referenceId =
        photo.captureDateOrigin?.kind === 'merge-reference'
          ? photo.captureDateOrigin.photoId
          : recipe?.settings?.referenceId
      const source = recipe?.sources?.find((s) => s.id === referenceId)
      if (referenceId) {
        origin = photo.captureDateOrigin ?? {
          kind: 'merge-reference',
          photoId: referenceId,
          filename: source?.filename ?? 'Unknown reference',
        }
        // Once recovered, keep the date independently of source deletion and immutable manifests.
        const existing = this.db
          .prepare('SELECT captured_at FROM photo_browse WHERE id = ?')
          .get(photo.id) as { captured_at: string | null } | undefined
        const reference = this.db
          .prepare('SELECT captured_at FROM photo_browse WHERE id = ?')
          .get(referenceId) as { captured_at: string | null } | undefined
        capturedAt =
          photo.captureDateOrigin?.kind === 'merge-reference'
            ? validatedCaptureDate(photo.capturedAt ?? metadata?.capturedAt)
            : (existing?.captured_at ?? reference?.captured_at ?? null)
      } else capturedAt = null
    }
    const search = [
      photo.filename,
      photo.camera,
      metadata?.make,
      metadata?.model,
      photo.lens,
      metadata?.lens,
      photo.format,
      photo.capturedAt,
      capturedAt?.replace(/\.0+$/, ''),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    const importedAt =
      typeof photo.importedAt === 'string'
        ? photo.importedAt
        : ((
            this.db.prepare('SELECT imported_at FROM photos WHERE id = ?').get(photo.id) as
              { imported_at: string | null } | undefined
          )?.imported_at ?? '')
    this.db
      .prepare(
        `INSERT INTO photo_browse VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, imported_at=excluded.imported_at, captured_at=excluded.captured_at, origin=excluded.origin, search_text=excluded.search_text
      WHERE filename != excluded.filename OR imported_at != excluded.imported_at OR captured_at IS NOT excluded.captured_at OR origin != excluded.origin OR search_text != excluded.search_text`,
      )
      .run(photo.id, photo.filename, importedAt, capturedAt, JSON.stringify(origin), search)
  }
}
