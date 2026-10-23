import {
  ImportSourceRecords,
  validWitness,
  type ImportSourceWitness,
} from '../import-source-records'
const hashPattern = /^[a-f0-9]{64}$/

export class ImportSourceMutations extends ImportSourceRecords {
  record(key: string, witness: ImportSourceWitness, photoId: string): boolean {
    if (!hashPattern.test(key) || !hashPattern.test(photoId) || !validWitness(witness)) return false
    const result = this.db
      .prepare(
        "INSERT INTO source_imports (source_key, photo_id, witness) SELECT ?, id, ? FROM photos WHERE id = ? AND COALESCE(json_extract(photo, '$.assetKind'), 'original') = 'original' AND NOT EXISTS (SELECT 1 FROM removals WHERE removals.id = photos.id) ON CONFLICT(source_key) DO UPDATE SET photo_id = excluded.photo_id, witness = excluded.witness",
      )
      .run(key, JSON.stringify(witness), photoId)
    return Number(result.changes) > 0
  }
}
