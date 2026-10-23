import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import type { Photo } from '../src/shared/contracts'
import type { PreviewProcessor } from '../src/main/preview-types'
import type { CaptureMetadata } from '../src/shared/capture-sequence'
import { StackMutations as StackStore } from '../src/main/catalog/stack-mutations'
import { expect } from '@playwright/test'
import { CatalogMutations } from '../src/main/catalog/domain'

const processor: PreviewProcessor = {
  process: async () => {
    throw new Error('No preview processing is expected.')
  },
  close: async () => {},
}
export async function stackFixture(count = 5) {
  const root = await mkdtemp(join(tmpdir(), 'luma-stacks-'))
  await mkdir(join(root, 'trash'))
  const move = async (path: string) => {
    await rename(path, join(root, 'trash', basename(path)))
  }
  const make = (trash = move) =>
    new PhotoLibrary(join(root, 'library'), processor, () => {}, undefined, trash)
  let library = make()
  await library.open()
  const db = new DatabaseSync(join(root, 'library', 'catalog.sqlite'))
  const store = new StackStore(db)
  const mutations = new CatalogMutations(db)
  const photos: Photo[] = []
  for (let i = 0; i < count; i++) {
    const id = (i + 1).toString(16).padStart(64, '0')
    const photo: Photo = {
      id,
      filename: `photo-${i}.jpg`,
      width: 10,
      height: 10,
      bytes: 1,
      format: 'JPG',
      importedAt: `2026-10-04T12:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      thumbnailUrl: `luma-photo://library/${id}/thumb`,
      previewUrl: `luma-photo://library/${id}/preview`,
      previewSource: 'image',
    }
    photos.push(photo)
    await mkdir(join(root, 'library', 'originals', id))
    await writeFile(join(root, 'library', 'originals', id, 'original.jpg'), `original-${i}`)
    mutations.execute({
      operation: 'original.publish',
      payload: { photo, processingIdentity: 'display-referred-v1', createdAt: photo.importedAt },
    })
  }
  return {
    root,
    db,
    store,
    photos,
    get library() {
      return library
    },
    capture: (index: number, metadata: CaptureMetadata) =>
      mutations.execute({
        operation: 'capture.publish',
        payload: { photoId: photos[index].id, metadata },
      }),
    restart: async (trash = move) => {
      await library.close()
      library = make(trash)
      await library.open()
      return library
    },
    close: async () => {
      await library.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
export async function finishTask(library: PhotoLibrary, id: string) {
  await expect.poll(() => library.listTasks().find((t) => t.id === id)?.finishedAt).toBeTruthy()
  return library.listTasks().find((t) => t.id === id)!
}
