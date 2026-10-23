import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CatalogCommands } from './catalog/contracts'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Keeps filesystem moves recoverable across failed Trash calls and interrupted database writes. */
export class RemovalStore {
  constructor(
    private root: string,
    private db: DatabaseSync,
    private trash: (path: string) => Promise<void>,
    private writer: CatalogCommands,
  ) {}

  private paths(id: string, staged: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(staged))
      throw new Error('Invalid removal journal entry.')
    return {
      original: join(this.root, 'originals', id),
      removed: join(this.root, 'removed', staged),
    }
  }

  private finish(id: string): Promise<void> {
    return this.writer.command({ operation: 'removal.finish', payload: { id } })
  }

  async recover(): Promise<void> {
    await mkdir(join(this.root, 'removed'), { recursive: true })
    const pending = this.db.prepare('SELECT id, staged FROM removals').all() as {
      id: string
      staged: string
    }[]
    for (const { id, staged } of pending) {
      const paths = this.paths(id, staged)
      if (await exists(paths.removed)) {
        if (await exists(paths.original))
          throw new Error(
            'Both original and removal staging exist. Recovery requires checking the library files.',
          )
        await rename(paths.removed, paths.original)
        await this.writer.command({ operation: 'removal.clear', payload: { id } })
      } else if (await exists(paths.original)) {
        await this.writer.command({ operation: 'removal.clear', payload: { id } })
      } else await this.finish(id)
    }
    // Unjournaled directories may have been restored from OS Trash. Never erase them.
  }

  async remove(id: string): Promise<void> {
    const staged = `${id}-${randomUUID()}`
    const paths = this.paths(id, staged)
    await this.writer.command({ operation: 'removal.journal', payload: { id, staged } })
    try {
      await rename(paths.original, paths.removed)
      await this.trash(paths.removed)
    } catch (error) {
      try {
        if (await exists(paths.removed)) await rename(paths.removed, paths.original)
        if (await exists(paths.original))
          await this.writer.command({ operation: 'removal.clear', payload: { id } })
      } catch (restoreError) {
        throw new Error(
          `Trash failed and the photo needs recovery on restart: ${String(error)}; ${String(restoreError)}`,
          { cause: restoreError },
        )
      }
      throw error
    }
    await this.finish(id)
  }

  stagedPath(id: string): string | undefined {
    const row = this.db.prepare('SELECT staged FROM removals WHERE id = ?').get(id) as
      { staged: string } | undefined
    return row ? this.paths(id, row.staged).removed : undefined
  }
}
