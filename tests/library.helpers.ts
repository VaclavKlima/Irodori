import { expect } from '@playwright/test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewEngine } from '../src/main/preview-engine'
import { PreviewProcess } from '../src/main/preview-process'
import type { PreviewProcessor } from '../src/main/preview-types'
import type { DeviceDirectoryVisibility } from '../src/main/device-directory-visibility'
import type { ExportProcess } from '../src/main/export/process'

export async function setup(
  processor?: PreviewProcessor,
  directoryVisibility?: Pick<DeviceDirectoryVisibility, 'hiddenEntries' | 'close'>,
  exportRenderer?: Pick<ExportProcess, 'render'>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'irodori-library-')))
  const engine = new PreviewEngine()
  const service = new PhotoLibrary(
    join(root, 'library'),
    processor ?? engine,
    () => {},
    undefined,
    undefined,
    new PreviewProcess(resolve('out/main/preview-worker.js')),
    undefined,
    undefined,
    undefined,
    undefined,
    directoryVisibility,
    undefined,
    undefined,
    undefined,
    undefined,
    exportRenderer,
    new PreviewProcess(resolve('out/main/preview-worker.js')),
  )
  await service.open()
  return {
    root,
    service,
    close: async () => {
      await service.close()
      await engine.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export async function scan(service: PhotoLibrary, paths: string[], recursive = true) {
  const id = await service.scan(paths, recursive)
  await expect.poll(() => service.review(id).phase, { timeout: 30_000 }).toBe('review')
  return id
}
export async function commit(service: PhotoLibrary, id: string) {
  await service.importSelected(id)
  await expect.poll(() => service.review(id).phase).toBe('complete')
}
