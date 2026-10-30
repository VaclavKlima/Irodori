import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { expect } from '@playwright/test'
import type { LibraryEvent } from '../src/shared/contracts'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'

export async function transferFixture(count = 4) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-edit-transfer-'))
  const events: LibraryEvent[] = [],
    ids: string[] = [],
    originals = new Map<string, Buffer>()
  let listener: (event: LibraryEvent) => void = () => {}
  const create = () =>
    new PhotoLibrary(
      join(root, 'library'),
      {
        async process() {
          throw new Error('Edit transfer must not decode originals.')
        },
        async close() {},
      },
      (event) => {
        events.push(event)
        listener(event)
      },
    )
  let library = create()
  await library.open()
  for (let index = 0; index < count; index++) {
    const bytes = await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 40 + index, g: 100, b: 140 } },
    })
      .png()
      .toBuffer()
    const id = createHash('sha256').update(bytes).digest('hex')
    ids.push(id)
    originals.set(id, bytes)
    const directory = join(root, 'library', 'originals', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'original.png'), bytes)
    await library.catalogCommands.command({
      operation: 'original.publish',
      payload: {
        photo: {
          id,
          filename: `Photo-${index}.png`,
          format: 'PNG',
          width: 8,
          height: 6,
          bytes: bytes.length,
          importedAt: '2026-10-29T00:00:00.000Z',
          thumbnailUrl: '',
          previewUrl: '',
          previewSource: 'image',
        },
        processingIdentity: 'display-referred-v1',
        metadata: processingMetadata({}, []),
        createdAt: '2026-10-29T00:00:00.000Z',
      },
    })
  }
  return {
    root,
    ids,
    events,
    get library() {
      return library
    },
    listen(next: typeof listener) {
      listener = next
    },
    async restart() {
      await library.close()
      library = create()
      await library.open()
    },
    async finished(id: string) {
      await expect
        .poll(() => library.listTasks().find((task) => task.id === id)?.status)
        .not.toMatch(/^(running|cancelling)$/)
      return library.listTasks().find((task) => task.id === id)!
    },
    async originalsUnchanged() {
      for (const [id, bytes] of originals)
        expect(await readFile(join(root, 'library', 'originals', id, 'original.png'))).toEqual(
          bytes,
        )
    },
    async close() {
      listener = () => {}
      await library.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
