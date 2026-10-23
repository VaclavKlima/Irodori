import type { DatabaseSync } from 'node:sqlite'
import { CatalogMutations } from '../src/main/catalog/domain'
import type { ProcessingOptions } from '../src/shared/lens'

/** Fixture setup only: raw SQL insertion must also supply the current history invariant. */
export function seedFixtureEdits(db: DatabaseSync): void {
  const bootstrap = new CatalogMutations(db)
  for (const row of db
    .prepare('SELECT id, data FROM processing WHERE id NOT IN (SELECT id FROM edits)')
    .all() as { id: string; data: string }[])
    bootstrap.seedEdits(
      row.id,
      JSON.parse(row.data) as ProcessingOptions,
      '2026-10-20T00:00:00.000Z',
    )
}
