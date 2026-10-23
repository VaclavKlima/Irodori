import { parentPort, workerData } from 'node:worker_threads'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CatalogMutations } from './catalog/domain'
import { serveCatalog } from './catalog/serve'

if (
  !parentPort ||
  !workerData ||
  Object.keys(workerData).length !== 1 ||
  typeof workerData.databasePath !== 'string' ||
  !isAbsolute(workerData.databasePath)
)
  throw new Error('Invalid catalog writer owner.')
const db = new DatabaseSync(workerData.databasePath)
try {
  // The schema and WAL mode are established during the explicit main bootstrap phase.
  // Every runtime connection keeps FULL durability; there is no busy-wait loop.
  db.exec('PRAGMA synchronous = FULL;')
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  if (mode.journal_mode !== 'wal') throw new Error('The catalog writer requires WAL mode.')
  const domain = new CatalogMutations(db)
  domain.camera.prepare()
  serveCatalog(parentPort, domain)
} catch (error) {
  if (db.isOpen) db.close()
  throw error
}
