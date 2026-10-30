import type { ElectronApplication, Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { importPhotos } from './import.helpers'

export async function browseSources(
  root: string,
  dates: (string | null)[],
  prefix = 'browse-photo',
) {
  const directory = join(root, `${prefix}-sources`)
  await mkdir(directory, { recursive: true })
  const paths: string[] = []
  for (const [index, date] of dates.entries()) {
    const path = join(directory, `${prefix}-${String(index).padStart(3, '0')}.jpg`)
    await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: { r: index % 256, g: Math.floor(index / 256) * 60, b: 100 },
      },
    })
      .withExif({
        IFD0: {
          Make: 'Irodori fixture',
          Model: 'Browse camera',
          ImageDescription: `Browser fixture ${index}`,
        },
        IFD2: { LensModel: 'Browse lens', ...(date ? { DateTimeOriginal: date } : {}) },
      })
      .jpeg({ quality: 95 })
      .toFile(path)
    paths.push(path)
  }
  return paths
}

/** Seed genuine, hash-addressed bundles only inside the fixture's verified temporary profile.
 * A real import supplies compatible processing metadata; restart performs index backfill.
 */
export async function seedLargeBrowser(
  app: ElectronApplication,
  page: Page,
  root: string,
  count: number,
) {
  const paths = await browseSources(root, Array<string>(count).fill('2026:10:04 12:30:00'))
  await importPhotos(app, page, paths.slice(0, 1))
  const first = (await page.evaluate(() => window.irodori.listPhotos())).photos[0]
  const inputs = await Promise.all(
    paths.slice(1).map(async (path) => {
      const bytes = await readFile(path)
      return {
        id: createHash('sha256').update(bytes).digest('hex'),
        filename: path.split('/').at(-1)!,
        bytes: bytes.toString('base64'),
      }
    }),
  )
  await app.evaluate(
    ({ app }, { root, first, inputs }) => {
      const fs = process.getBuiltinModule('fs')
      if (fs.realpathSync(app.getPath('userData')) !== fs.realpathSync(root))
        throw new Error('Fixture profile is not isolated.')
      const path = process.getBuiltinModule('path')
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
      const db = new DatabaseSync(path.join(root, 'library', 'catalog.sqlite'))
      const processing = db.prepare('SELECT data FROM processing WHERE id = ?').get(first.id) as
        { data: string } | undefined
      const history = db.prepare('SELECT data FROM edits WHERE id = ?').get(first.id) as
        { data: string } | undefined
      if (processing && !history) throw new Error('The source fixture has no confirmed history.')
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const input of inputs) {
          const bytes = Buffer.from(input.bytes, 'base64')
          const directory = path.join(root, 'library', 'originals', input.id)
          fs.mkdirSync(directory, { recursive: true })
          for (const filename of ['original.jpg', 'preview.jpg', 'thumb.jpg'])
            fs.writeFileSync(path.join(directory, filename), bytes)
          const photo = {
            ...first,
            id: input.id,
            filename: input.filename,
            bytes: bytes.length,
            thumbnailUrl: `irodori-photo://library/${input.id}/thumb`,
            previewUrl: `irodori-photo://library/${input.id}/preview`,
          }
          db.prepare(
            'INSERT INTO photos (id, imported_at, photo, processing_identity) VALUES (?, ?, ?, ?)',
          ).run(photo.id, photo.importedAt, JSON.stringify(photo), 'display-referred-v1')
          if (processing) {
            db.prepare('INSERT INTO processing (id, data) VALUES (?, ?)').run(
              photo.id,
              processing.data,
            )
            db.prepare('INSERT INTO edits (id, data) VALUES (?, ?)').run(
              photo.id,
              JSON.stringify({ ...JSON.parse(history!.data), photoId: photo.id }),
            )
          }
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        db.close()
      }
    },
    { root, first, inputs },
  )
  return paths
}

export async function holdBrowseSelections(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const channels = ['browse:range', 'browse:section']
    const originals = channels.map((channel) => handlers.get(channel)!)
    const calls: { channel: string; query: unknown; release: () => void }[] = []
    for (const [index, channel] of channels.entries()) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (...args) => {
        const result = await originals[index](...args)
        return new Promise((resolve) => {
          calls.push({ channel, query: args[1], release: () => resolve(result) })
        })
      })
    }
    return {
      calls,
      restore: () => {
        for (const call of calls) call.release()
        for (const [index, channel] of channels.entries()) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, originals[index])
        }
      },
    }
  })
}
