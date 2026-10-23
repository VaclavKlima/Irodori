import type { DatabaseSync } from 'node:sqlite'

export class CatalogConnectionError extends Error {}

/** A failed rollback cannot certify a rejected transaction, so that writer is retired. */
export function catalogTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollback) {
      throw new CatalogConnectionError('Catalog rollback failed.', { cause: rollback })
    }
    throw error
  }
}
