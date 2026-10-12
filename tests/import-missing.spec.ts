import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { copyOriginal } from '../src/main/copy-original'
import { DeviceUnavailableError, type DeviceSource } from '../src/main/import-devices'
import { hashImportSource, inspectImportSource } from '../src/main/import-source-records'
import type { PreviewProcessor } from '../src/main/preview-types'
import type { ReviewThumbnailInput } from '../src/main/review-thumbnails'
import { RemovalStore } from '../src/main/removal-store'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function mounted(path: string, deviceId = 'isolated-missing-device'): Promise<DeviceSource> {
  const info = await stat(path, { bigint: true })
  return {
    deviceId,
    displayName: 'Isolated test card',
    roots: [
      {
        path,
        identity: 'isolated-volume',
        filesystemDevice: info.dev.toString(),
        filesystemIdentity: `${info.dev}:${info.ino}`,
        nestedMounts: [],
      },
    ],
  }
}

async function setup(
  options: {
    prepare?: PreviewProcessor['process']
    transfer?: typeof copyOriginal
    trash?: (path: string) => Promise<void>
    sourceInspection?: typeof inspectImportSource
    sourceHash?: typeof hashImportSource
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'luma-missing-service-'))
  const card = join(root, 'card')
  await mkdir(card)
  await mkdir(join(root, 'trash'))
  const copies: string[] = []
  const thumbnailRequests: ReviewThumbnailInput[] = []
  const prepared: string[] = []
  const processor: PreviewProcessor = {
    process: async (path, output, signal) => {
      prepared.push(path)
      if (options.prepare) return options.prepare(path, output, signal)
      signal.throwIfAborted()
      await writeFile(join(output, 'thumb.jpg'), 'cached managed thumbnail')
      await writeFile(join(output, 'preview.jpg'), 'cached managed preview')
      return { metadata: { width: 16, height: 12 }, source: 'image' }
    },
    close: async () => {},
  }
  const construct = () =>
    new PhotoLibrary(
      join(root, 'library'),
      processor,
      () => {},
      async (...args) => {
        copies.push(args[0])
        return (options.transfer ?? copyOriginal)(...args)
      },
      options.trash ??
        (async (path) => {
          await rename(path, join(root, 'trash', basename(path)))
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (onState) => ({
        request: (inputs) => {
          thumbnailRequests.push(...inputs)
          for (const input of inputs) onState(input.id, { state: 'ready', source: 'image' })
        },
        cancel: async () => {},
      }),
      undefined,
      undefined,
      options.sourceInspection,
      options.sourceHash,
    )
  let service = construct()
  await service.open()
  return {
    root,
    card,
    copies,
    prepared,
    thumbnailRequests,
    get service() {
      return service
    },
    restart: async () => {
      await service.close()
      service = construct()
      await service.open()
    },
    close: async () => {
      await service.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function sources(card: string, count: number, prefix = 'photo') {
  const paths: string[] = []
  for (let index = 0; index < count; index++) {
    const path = join(card, `${prefix}-${String(index).padStart(3, '0')}.jpg`)
    await writeFile(path, `${prefix} original ${index}`)
    paths.push(path)
  }
  return paths
}

async function review(
  service: PhotoLibrary,
  paths: string[],
  source?: DeviceSource,
  validate: () => Promise<void> = async () => {},
) {
  const id = await service.scan(
    paths,
    true,
    source ? { source, validate } : undefined,
    true,
    'full',
  )
  await expect.poll(() => service.review(id).phase).toBe('review')
  return id
}

async function finished(service: PhotoLibrary, id: string) {
  await expect
    .poll(() => service.listTasks().find((task) => task.id === id)?.status)
    .toMatch(/^(completed|cancelled|failed)$/)
  return service.listTasks().find((task) => task.id === id)!
}

async function commit(service: PhotoLibrary, id: string) {
  await Promise.resolve(service.importSelected(id))
  return finished(service, id)
}

async function allCandidates(service: PhotoLibrary, id: string) {
  const total = service.review(id).total
  return Array.from(
    { length: Math.ceil(total / 60) },
    (_, index) => service.review(id, index * 60).candidates,
  ).flat()
}

function provenanceCount(root: string) {
  const db = new DatabaseSync(join(root, 'library', 'catalog.sqlite'))
  try {
    return (db.prepare('SELECT COUNT(*) AS total FROM source_imports').get() as { total: number })
      .total
  } finally {
    db.close()
  }
}

async function weakInspection(path: string) {
  const inspection = await inspectImportSource(path)
  return {
    reusable: false,
    witness: {
      ...inspection.witness,
      mtimeNs: '1704067200000000000',
      ctimeNs: '0',
      birthtimeNs: '0',
    },
  }
}

test('repeat device review and restart skip complete paginated sources and use managed thumbnails', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 65)
    expect((await inspectImportSource(paths[0])).reusable).toBe(true)
    const source = await mounted(t.card)
    const first = await review(t.service, [t.card], source)
    expect(t.service.review(first)).toMatchObject({
      onlyMissing: true,
      alreadyImported: 0,
      selected: 65,
    })
    expect(await commit(t.service, first)).toMatchObject({
      status: 'completed',
      outcomes: { imported: 65, duplicates: 0 },
      transfer: { copied: 65 },
    })
    expect(provenanceCount(t.root)).toBe(65)
    const bytes = (await Promise.all(paths.map((path) => stat(path)))).reduce(
      (sum, info) => sum + info.size,
      0,
    )
    const originals = t.service.list(0).photos.concat(t.service.list(60).photos)
    const thumbs = new Map(originals.map((photo) => [photo.filename, photo.thumbnailUrl]))
    for (const restarted of [false, true]) {
      if (restarted) await t.restart()
      const id = await review(t.service, [t.card], source)
      expect(t.service.review(id)).toMatchObject({
        total: 65,
        onlyMissing: true,
        alreadyImported: 65,
        alreadyImportedBytes: bytes,
        selected: 0,
        selectedBytes: 0,
        duplicates: 0,
      })
      const candidates = await allCandidates(t.service, id)
      expect(candidates).toHaveLength(65)
      expect(
        candidates.every((candidate) => candidate.alreadyImported && !candidate.selected),
      ).toBe(true)
      for (let offset = 0; offset < 65; offset += 60)
        t.service.requestReviewThumbnails(
          id,
          candidates.slice(offset, offset + 60).map((c) => c.id),
        )
      for (const candidate of candidates) {
        expect(candidate.thumbnailUrl).toBe(thumbs.get(candidate.filename))
        expect(t.service.imagePath(candidate.thumbnailUrl!)).toContain(
          join(t.root, 'library', 'originals'),
        )
      }
      expect(t.thumbnailRequests).toEqual([])
      expect(t.copies).toHaveLength(65)
      expect(t.prepared).toHaveLength(65)
      expect(() => t.service.importSelected(id)).toThrow('Select at least one')
    }
    await sources(t.card, 1, 'new')
    const next = await review(t.service, [t.card], source)
    expect(t.service.review(next)).toMatchObject({ total: 66, alreadyImported: 65, selected: 1 })
    expect(await commit(t.service, next)).toMatchObject({
      progress: { total: 1 },
      outcomes: { imported: 1, duplicates: 0 },
      transfer: { copied: 1 },
    })
    expect(t.copies).toHaveLength(66)
    expect(t.service.list().total).toBe(66)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    await t.close()
  }
})

test('only-missing masks known choices while mode changes and bulk selection preserve explicit choices', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 3)
    const source = await mounted(t.card)
    const first = await review(t.service, paths.slice(0, 2), source)
    await commit(t.service, first)
    const id = await review(t.service, paths, source)
    expect(t.service.review(id)).toMatchObject({
      onlyMissing: true,
      alreadyImported: 2,
      selected: 1,
    })
    t.service.setImportOnlyMissing(id, false)
    expect(t.service.review(id)).toMatchObject({ onlyMissing: false, selected: 3 })
    const known = t.service.review(id).candidates.find((c) => c.alreadyImported)!
    t.service.select(id, [known.id], false)
    t.service.setImportOnlyMissing(id, true)
    expect(t.service.review(id).selected).toBe(1)
    t.service.setImportOnlyMissing(id, false)
    expect(t.service.review(id).selected).toBe(2)
    expect(t.service.review(id).candidates.find((c) => c.id === known.id)?.selected).toBe(false)
    t.service.setImportOnlyMissing(id, true)
    t.service.select(id, null, false)
    t.service.setImportOnlyMissing(id, false)
    expect(t.service.review(id).selected).toBe(1)
    expect(t.service.review(id).candidates.find((c) => c.id === known.id)?.selected).toBe(false)
    expect(t.service.review(id).candidates.find((c) => !c.alreadyImported)?.selected).toBe(false)
    t.service.select(id, null, true)
    t.service.setImportOnlyMissing(id, true)
    expect(t.service.review(id).selected).toBe(1)
    expect(() => t.service.setImportOnlyMissing(id, 'yes' as unknown as boolean)).toThrow()
    expect(await commit(t.service, id)).toMatchObject({
      status: 'completed',
      items: { total: 1 },
      outcomes: { imported: 1, duplicates: 0 },
    })
    expect(t.copies).toHaveLength(3)
  } finally {
    await t.close()
  }
})

test('same-size edits with restored modification time and atomic replacement are full-hashed again', async () => {
  const t = await setup()
  try {
    const [path] = await sources(t.card, 1)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, [path], source))
    const old = await stat(path)
    const original = await readFile(path)
    const modified = Buffer.from(original)
    modified[0] ^= 0xff
    await writeFile(path, modified)
    await utimes(path, old.atime, old.mtime)
    const changed = await review(t.service, [path], source)
    expect(t.service.review(changed)).toMatchObject({ alreadyImported: 0, selected: 1 })
    await commit(t.service, changed)
    expect(t.service.list().total).toBe(2)
    const next = join(t.card, 'replacement.tmp')
    const replaced = Buffer.from(modified)
    replaced[1] ^= 0xff
    await writeFile(next, replaced)
    await utimes(next, old.atime, old.mtime)
    await rename(next, path)
    const replacement = await review(t.service, [path], source)
    expect(t.service.review(replacement)).toMatchObject({ alreadyImported: 0, selected: 1 })
    await commit(t.service, replacement)
    const hash = createHash('sha256').update(replaced).digest('hex')
    expect(t.service.list().photos.some((photo) => photo.id === hash)).toBe(true)
    expect(await readFile(join(t.root, 'library', 'originals', hash, 'original.jpg'))).toEqual(
      replaced,
    )
    expect(t.copies).toHaveLength(3)
    expect(t.service.review(await review(t.service, [path], source)).alreadyImported).toBe(1)
  } finally {
    await t.close()
  }
})

test('changed device, volume or root requires a validated duplicate copy before learning the new source', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 1)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths, source))
    const otherRoot = join(t.root, 'other-card')
    await mkdir(otherRoot)
    const otherPath = join(otherRoot, basename(paths[0]))
    await copyFile(paths[0], otherPath)
    const variants: { paths: string[]; source: DeviceSource }[] = [
      { paths, source: { ...source, deviceId: 'replacement-device' } },
      {
        paths,
        source: {
          ...source,
          roots: source.roots.map((root) => ({ ...root, identity: 'replacement-volume' })),
        },
      },
      { paths: [otherPath], source: await mounted(otherRoot) },
    ]
    for (const variant of variants) {
      const id = await review(t.service, variant.paths, variant.source)
      expect(t.service.review(id)).toMatchObject({ alreadyImported: 0, selected: 1 })
      expect(await commit(t.service, id)).toMatchObject({
        status: 'completed',
        transfer: { copied: 1, prepared: 0 },
        outcomes: { imported: 0, duplicates: 1 },
      })
      expect(
        t.service.review(await review(t.service, variant.paths, variant.source)),
      ).toMatchObject({
        alreadyImported: 1,
        selected: 0,
      })
    }
    expect(t.copies).toHaveLength(4)
    expect(t.prepared).toHaveLength(1)
    expect(t.service.list().total).toBe(1)
  } finally {
    await t.close()
  }
})

test('file imports and legacy catalogs without provenance retain content-hash duplicate validation', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 1)
    const source = await mounted(t.card)
    const fileReview = await review(t.service, paths)
    expect(t.service.review(fileReview).onlyMissing).toBeUndefined()
    expect(() => t.service.setImportOnlyMissing(fileReview, true)).toThrow()
    await commit(t.service, fileReview)
    expect(provenanceCount(t.root)).toBe(0)
    const deviceReview = await review(t.service, paths, source)
    expect(t.service.review(deviceReview)).toMatchObject({ alreadyImported: 0, selected: 1 })
    expect(await commit(t.service, deviceReview)).toMatchObject({
      outcomes: { imported: 0, duplicates: 1 },
    })
    expect(provenanceCount(t.root)).toBe(1)
    await t.service.close()
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    db.exec('DROP TRIGGER remove_source_imports; DROP TABLE source_imports;')
    db.close()
    await t.restart()
    const legacy = await review(t.service, paths, source)
    expect(t.service.review(legacy)).toMatchObject({ alreadyImported: 0, selected: 1 })
    expect(await commit(t.service, legacy)).toMatchObject({
      status: 'completed',
      transfer: { copied: 1, prepared: 0 },
      outcomes: { imported: 0, duplicates: 1 },
    })
    expect(t.service.review(await review(t.service, paths, source)).alreadyImported).toBe(1)
    expect(t.copies).toHaveLength(3)
  } finally {
    await t.close()
  }
})

test('failed preparation and cancelled staging never learn an unpublished original', async () => {
  const entered = gate()
  const release = gate()
  let mode: 'fail' | 'cancel' | 'complete' = 'fail'
  const t = await setup({
    prepare: async (_path, output, signal) => {
      if (mode === 'fail') throw new Error('Isolated preparation failure')
      if (mode === 'cancel') {
        entered.release()
        await release.promise
        signal.throwIfAborted()
      }
      await writeFile(join(output, 'thumb.jpg'), 'cached managed thumbnail')
      await writeFile(join(output, 'preview.jpg'), 'cached managed preview')
      return { metadata: { width: 16, height: 12 }, source: 'image' }
    },
  })
  try {
    const paths = await sources(t.card, 1)
    const source = await mounted(t.card)
    const failed = await review(t.service, paths, source)
    expect(await commit(t.service, failed)).toMatchObject({
      status: 'failed',
      outcomes: { imported: 0, failed: 1 },
    })
    expect(provenanceCount(t.root)).toBe(0)
    mode = 'cancel'
    const cancelled = await review(t.service, paths, source)
    expect(t.service.review(cancelled)).toMatchObject({ alreadyImported: 0, selected: 1 })
    await Promise.resolve(t.service.importSelected(cancelled))
    await entered.promise
    const cancel = t.service.cancelTask(cancelled)
    release.release()
    await cancel
    expect(await finished(t.service, cancelled)).toMatchObject({
      status: 'cancelled',
      outcomes: { imported: 0 },
    })
    expect(provenanceCount(t.root)).toBe(0)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
    mode = 'complete'
    const retry = await review(t.service, paths, source)
    expect(t.service.review(retry)).toMatchObject({ alreadyImported: 0, selected: 1 })
    await commit(t.service, retry)
    expect(provenanceCount(t.root)).toBe(1)
    expect(t.service.review(await review(t.service, paths, source)).alreadyImported).toBe(1)
  } finally {
    release.release()
    await t.close()
  }
})

test('a failed Trash move keeps provenance; successful deletion and restart allow a fresh import', async () => {
  let allowTrash = false
  let root = ''
  const t = await setup({
    trash: async (path) => {
      if (!allowTrash) throw new Error('Isolated Trash unavailable')
      await rename(path, join(root, 'trash', basename(path)))
    },
  })
  root = t.root
  try {
    const paths = await sources(t.card, 1)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths, source))
    const photo = t.service.list().photos[0]
    const failed = t.service.deletePhotos([photo.id])!
    expect(await finished(t.service, failed)).toMatchObject({
      status: 'failed',
      items: { completed: 0 },
    })
    expect(provenanceCount(t.root)).toBe(1)
    expect(t.service.review(await review(t.service, paths, source))).toMatchObject({
      alreadyImported: 1,
      selected: 0,
    })
    allowTrash = true
    expect(await finished(t.service, t.service.deletePhotos([photo.id])!)).toMatchObject({
      status: 'completed',
    })
    expect(provenanceCount(t.root)).toBe(0)
    await t.restart()
    const retry = await review(t.service, paths, source)
    expect(t.service.review(retry)).toMatchObject({ alreadyImported: 0, selected: 1 })
    expect(await commit(t.service, retry)).toMatchObject({
      outcomes: { imported: 1, duplicates: 0 },
      transfer: { copied: 1 },
    })
    expect(await readFile(paths[0], 'utf8')).toBe('photo original 0')
    expect(t.copies).toHaveLength(2)
  } finally {
    await t.close()
  }
})

test('deletion during review re-admits the formerly known source before freezing accepted totals', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source))
    const photo = t.service.list().photos[0]
    const id = await review(t.service, paths, source)
    expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
    await finished(t.service, t.service.deletePhotos([photo.id])!)
    expect(() => t.service.review(id)).toThrow('expired')
    expect(() => t.service.importSelected(id)).toThrow('expired')
    const restarted = await review(t.service, paths, source)
    expect(t.service.review(restarted)).toMatchObject({ alreadyImported: 0, selected: 2 })
    expect(await commit(t.service, restarted)).toMatchObject({
      status: 'completed',
      items: { total: 2, completed: 2 },
      progress: { total: 2 },
      outcomes: { imported: 2, duplicates: 0 },
      transfer: { copied: 2 },
    })
    expect(t.service.list().total).toBe(2)
    expect(t.copies).toHaveLength(3)
  } finally {
    await t.close()
  }
})

test('a completed removal between review and acceptance re-admits the missing live target', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source))
    const photo = t.service.list().photos[0]
    const id = await review(t.service, paths, source)
    expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
    // Exercise a completed catalog writer through the real removal journal while
    // preserving this displayed review, unlike the UI's intentional disposal.
    const db = new DatabaseSync(join(t.root, 'library', 'catalog.sqlite'))
    try {
      const removal = new RemovalStore(join(t.root, 'library'), db, async (path) => {
        await rename(path, join(t.root, 'trash', basename(path)))
      })
      await removal.remove(photo.id)
    } finally {
      db.close()
    }
    expect(provenanceCount(t.root)).toBe(0)
    expect(await commit(t.service, id)).toMatchObject({
      status: 'completed',
      items: { total: 2, completed: 2 },
      progress: { total: 2 },
      outcomes: { imported: 2, duplicates: 0 },
      transfer: { copied: 2 },
    })
    expect(t.service.list().total).toBe(2)
    expect(t.copies).toHaveLength(3)
    expect(await readdir(join(t.root, 'library', 'removed'))).toEqual([])
    expect(await readdir(join(t.root, 'trash'))).toHaveLength(1)
    expect(await readFile(paths[0], 'utf8')).toBe('photo original 0')
  } finally {
    await t.close()
  }
})

test('symlink replacement is never reused as a known source or read as an external photograph', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source))
    const external = join(t.root, 'external.jpg')
    await writeFile(external, 'external untouched bytes')
    const id = await review(t.service, paths, source)
    expect(t.service.review(id).alreadyImported).toBe(1)
    await rm(paths[0])
    await symlink(external, paths[0])
    await expect(Promise.resolve().then(() => t.service.importSelected(id))).rejects.toThrow()
    expect(t.service.list().total).toBe(1)
    expect(t.copies).toHaveLength(1)
    const next = await review(t.service, [t.card], source)
    expect(t.service.review(next)).toMatchObject({
      total: 1,
      alreadyImported: 0,
      selected: 1,
      skipped: 1,
    })
    await commit(t.service, next)
    expect(t.service.list().total).toBe(2)
    expect(await readFile(external, 'utf8')).toBe('external untouched bytes')
  } finally {
    await t.close()
  }
})

test('a known source edited after review rejects acceptance before creating a task or copying', async () => {
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source))
    const id = await review(t.service, paths, source)
    expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
    const previous = await stat(paths[0])
    const bytes = await readFile(paths[0])
    bytes[0] ^= 0xff
    await writeFile(paths[0], bytes)
    await utimes(paths[0], previous.atime, previous.mtime)
    await expect(Promise.resolve().then(() => t.service.importSelected(id))).rejects.toThrow(
      'changed',
    )
    expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
    expect(t.copies).toHaveLength(1)
    expect(t.service.list().total).toBe(1)
    const restart = await review(t.service, paths, source)
    expect(t.service.review(restart)).toMatchObject({ alreadyImported: 0, selected: 2 })
    expect(await commit(t.service, restart)).toMatchObject({
      status: 'completed',
      progress: { total: 2 },
      outcomes: { imported: 2, duplicates: 0 },
    })
  } finally {
    await t.close()
  }
})

test('confirmed device loss during acceptance latches the review until an explicit source restart', async () => {
  let disconnected = false
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    const validate = async () => {
      if (disconnected) throw new DeviceUnavailableError()
    }
    await commit(t.service, await review(t.service, paths.slice(0, 1), source, validate))
    const id = await review(t.service, paths, source, validate)
    expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
    disconnected = true
    await expect(Promise.resolve().then(() => t.service.importSelected(id))).rejects.toThrow(
      'disconnected or changed',
    )
    const invalidated = t.service.review(id)
    expect(invalidated.phase).not.toBe('importing')
    expect(invalidated.sourceError).toContain('disconnected or changed')
    expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
    expect(t.copies).toHaveLength(1)
    expect(provenanceCount(t.root)).toBe(1)
    disconnected = false
    await t.service.validateDeviceReview()
    expect(t.service.review(id)).toMatchObject({
      phase: invalidated.phase,
      sourceError: invalidated.sourceError,
    })
    expect(() => t.service.importSelected(id)).toThrow('Select at least one')
    expect(() => t.service.select(id, null, true)).toThrow('no longer selectable')
    expect(() => t.service.setImportOnlyMissing(id, false)).toThrow('no longer selectable')
    expect(t.copies).toHaveLength(1)
    const restarted = await review(t.service, paths, source, validate)
    expect(t.service.review(restarted)).toMatchObject({
      sourceError: undefined,
      alreadyImported: 1,
      selected: 1,
    })
    expect(await commit(t.service, restarted)).toMatchObject({
      status: 'completed',
      items: { total: 1 },
      outcomes: { imported: 1, duplicates: 0 },
      transfer: { copied: 1 },
    })
    expect(t.copies).toHaveLength(2)
    expect(t.service.list().total).toBe(2)
  } finally {
    await t.close()
  }
})

test('pending acceptance freezes review mutations and rejects repeated activation before any source copies', async () => {
  const entered = gate()
  const release = gate()
  let delay = false
  const validate = async () => {
    if (delay) {
      entered.release()
      await release.promise
    }
  }
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source, validate))
    const id = await review(t.service, paths, source, validate)
    const count = t.copies.length
    delay = true
    const accepting = Promise.resolve(t.service.importSelected(id))
    await entered.promise
    expect(t.copies).toHaveLength(count)
    expect(() => t.service.select(id, null, false)).toThrow()
    expect(() => t.service.setImportOnlyMissing(id, false)).toThrow()
    expect(() => t.service.importSelected(id)).toThrow()
    release.release()
    await accepting
    expect(await finished(t.service, id)).toMatchObject({
      status: 'completed',
      items: { total: 1 },
      outcomes: { imported: 1, duplicates: 0 },
      transfer: { copied: 1 },
    })
    expect(t.copies).toHaveLength(count + 1)
    expect(t.service.listTasks().filter((task) => task.id === id)).toHaveLength(1)
  } finally {
    release.release()
    await t.close()
  }
})

test('disposing a delayed acceptance prevents late task publication and source copies', async () => {
  const entered = gate()
  const release = gate()
  let delay = false
  const t = await setup()
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    const validate = async () => {
      if (delay) {
        entered.release()
        await release.promise
      }
    }
    await commit(t.service, await review(t.service, paths.slice(0, 1), source, validate))
    const id = await review(t.service, paths, source, validate)
    delay = true
    const accepting = Promise.resolve(t.service.importSelected(id))
    const outcome = accepting.then(
      () => 'accepted',
      () => 'cancelled',
    )
    await entered.promise
    const disposal = t.service.dispose(id)
    release.release()
    await disposal
    expect(await outcome).toBe('cancelled')
    expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
    expect(t.copies).toHaveLength(1)
    expect(t.service.list().total).toBe(1)
    expect(provenanceCount(t.root)).toBe(1)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    release.release()
    await t.close()
  }
})

test('weak filesystem repeats verify full source hashes without copying or staging known originals', async () => {
  const hashes: string[] = []
  const t = await setup({
    sourceInspection: weakInspection,
    sourceHash: async (...args) => {
      hashes.push(args[0])
      return hashImportSource(...args)
    },
  })
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, paths.slice(0, 1), source))
    expect(provenanceCount(t.root)).toBe(1)
    expect(hashes).toEqual([])
    await t.restart()
    const id = await review(t.service, paths, source)
    expect(t.service.review(id)).toMatchObject({
      onlyMissing: true,
      alreadyImported: 1,
      alreadyImportedBytes: (await stat(paths[0])).size,
      selected: 1,
      selectedBytes: (await stat(paths[1])).size,
    })
    expect(hashes).toEqual([paths[0]])
    expect(t.copies).toEqual([paths[0]])
    expect(t.prepared).toHaveLength(1)
    expect(await readdir(join(t.root, 'library', 'staging', id)).catch(() => [])).toEqual([])
    const known = t.service.review(id).candidates.find((candidate) => candidate.alreadyImported)!
    t.service.requestReviewThumbnails(id, [known.id])
    expect(t.thumbnailRequests).toEqual([])
    expect(t.service.imagePath(known.thumbnailUrl!)).toContain(join(t.root, 'library', 'originals'))
    expect(hashes).toEqual([paths[0]])
    expect(await commit(t.service, id)).toMatchObject({
      status: 'completed',
      progress: { total: 1 },
      outcomes: { imported: 1, duplicates: 0 },
      transfer: { copied: 1, prepared: 1 },
    })
    expect(hashes).toEqual([paths[0], paths[0]])
    expect(t.copies).toEqual(paths)
    expect(t.prepared).toHaveLength(2)
    expect(provenanceCount(t.root)).toBe(2)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
  } finally {
    await t.close()
  }
})

test('a weak unchanged witness still detects middle-byte edits and rejects changes after review', async () => {
  const hashes: string[] = []
  const t = await setup({
    sourceInspection: weakInspection,
    sourceHash: async (...args) => {
      hashes.push(args[0])
      return hashImportSource(...args)
    },
  })
  try {
    const [path] = await sources(t.card, 1)
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    await writeFile(path, bytes)
    const source = await mounted(t.card)
    await commit(t.service, await review(t.service, [path], source))
    const previous = await stat(path)
    const before = (await weakInspection(path)).witness
    bytes[Math.floor(bytes.length / 2)] ^= 0xff
    await writeFile(path, bytes)
    await utimes(path, previous.atime, previous.mtime)
    expect((await weakInspection(path)).witness).toEqual(before)
    const changed = await review(t.service, [path], source)
    expect(hashes).toEqual([path])
    expect(t.service.review(changed)).toMatchObject({ alreadyImported: 0, selected: 1 })
    expect(t.copies).toHaveLength(1)
    expect(await commit(t.service, changed)).toMatchObject({
      outcomes: { imported: 1, duplicates: 0 },
    })
    const changedId = createHash('sha256').update(bytes).digest('hex')
    expect(await readFile(join(t.root, 'library', 'originals', changedId, 'original.jpg'))).toEqual(
      bytes,
    )
    const [newPath] = await sources(t.card, 1, 'new')
    const id = await review(t.service, [path, newPath], source)
    expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
    const reviewed = await stat(path)
    bytes[Math.floor(bytes.length / 2) + 1] ^= 0xff
    await writeFile(path, bytes)
    await utimes(path, reviewed.atime, reviewed.mtime)
    expect((await weakInspection(path)).witness).toEqual(before)
    await expect(Promise.resolve().then(() => t.service.importSelected(id))).rejects.toThrow(
      'changed',
    )
    expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
    expect(t.copies).toHaveLength(2)
    expect(t.service.list().total).toBe(2)
    const retry = await review(t.service, [path, newPath], source)
    expect(t.service.review(retry)).toMatchObject({ alreadyImported: 0, selected: 2 })
    expect(await commit(t.service, retry)).toMatchObject({
      status: 'completed',
      progress: { total: 2 },
      outcomes: { imported: 2, duplicates: 0 },
      transfer: { copied: 2 },
    })
    expect(t.service.list().total).toBe(4)
  } finally {
    await t.close()
  }
})

test('weak hash resumes validate the device before reading another chunk while foreground work takes priority', async () => {
  const waiting = gate()
  const activity = 'isolated-weak-hash-foreground'
  let reads = 0
  let disconnected = false
  const t = await setup({
    sourceInspection: weakInspection,
    sourceHash: async (path, signal, control) => {
      scheduler.activity(activity, true)
      return hashImportSource(path, signal, {
        ...control,
        chunk: (work) => {
          waiting.release()
          if (!control?.chunk) throw new Error('Expected the background hash scheduler.')
          return control.chunk(async () => {
            reads++
            return work()
          })
        },
      })
    },
  })
  const scheduler = t.service.scheduler
  try {
    const paths = await sources(t.card, 2)
    const source = await mounted(t.card)
    const validate = async () => {
      if (disconnected) throw new DeviceUnavailableError()
    }
    await commit(t.service, await review(t.service, paths.slice(0, 1), source, validate))
    const id = await t.service.scan(paths, true, { source, validate }, true, 'full')
    await waiting.promise
    expect(t.service.review(id)).toMatchObject({
      phase: 'scanning',
      checkingPrevious: basename(paths[0]),
    })
    expect(scheduler.waitingReason).toBe('foreground')
    expect(reads).toBe(0)
    let foregroundCompleted = false
    await scheduler.run('interactive', async () => {
      foregroundCompleted = true
    })
    expect(foregroundCompleted).toBe(true)
    expect(reads).toBe(0)
    disconnected = true
    scheduler.activity(activity, false)
    await expect.poll(() => t.service.review(id).phase).toBe('cancelled')
    expect(t.service.review(id).sourceError).toContain('disconnected or changed')
    expect(reads).toBe(0)
    expect(t.copies).toHaveLength(1)
    expect(t.service.list().total).toBe(1)
    expect(provenanceCount(t.root)).toBe(1)
    expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
    expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
    expect(await readFile(paths[0], 'utf8')).toBe('photo original 0')
  } finally {
    scheduler.activity(activity, false)
    await t.close()
  }
})

for (const stage of ['scan', 'acceptance'] as const) {
  test(`cancellation during weak source hashing in ${stage} prevents late publication`, async () => {
    const entered = gate()
    const release = gate()
    let delay = false
    const t = await setup({
      sourceInspection: weakInspection,
      sourceHash: async (...args) => {
        if (delay) {
          entered.release()
          await release.promise
        }
        return hashImportSource(...args)
      },
    })
    try {
      const paths = await sources(t.card, 2)
      const source = await mounted(t.card)
      await commit(t.service, await review(t.service, paths.slice(0, 1), source))
      let id: string
      let accepting: Promise<'accepted' | 'cancelled'> | undefined
      if (stage === 'scan') {
        delay = true
        id = await t.service.scan(paths, true, { source, validate: async () => {} }, true, 'full')
      } else {
        id = await review(t.service, paths, source)
        expect(t.service.review(id)).toMatchObject({ alreadyImported: 1, selected: 1 })
        delay = true
        accepting = Promise.resolve(t.service.importSelected(id)).then(
          () => 'accepted',
          () => 'cancelled',
        )
      }
      await entered.promise
      if (stage === 'scan') {
        const pending = t.service.review(id)
        expect(pending.phase).toBe('scanning')
        expect(pending.candidates.map((candidate) => candidate.filename)).toContain(
          basename(paths[0]),
        )
        t.service.requestReviewThumbnails(
          id,
          pending.candidates.map((candidate) => candidate.id),
        )
        expect(t.thumbnailRequests).toEqual([])
      }
      expect(t.copies).toHaveLength(1)
      const cancelled = t.service.cancel(id)
      release.release()
      await cancelled
      if (accepting) expect(await accepting).toBe('cancelled')
      expect(t.service.review(id).phase).toBe('cancelled')
      expect(t.service.listTasks().some((task) => task.id === id)).toBe(false)
      expect(t.service.list().total).toBe(1)
      expect(t.copies).toHaveLength(1)
      expect(provenanceCount(t.root)).toBe(1)
      expect(await readdir(join(t.root, 'library', 'staging'))).toEqual([])
      expect(await readFile(paths[1], 'utf8')).toBe('photo original 1')
    } finally {
      release.release()
      await t.close()
    }
  })
}
