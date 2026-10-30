import { test, expect } from '@playwright/test'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { PhotoLibrary } from './photo-library.helpers'
import { CatalogWriter, type CatalogWorkerFactory } from '../src/main/catalog/writer'
import { CatalogMutations } from '../src/main/catalog/domain'
import { PreviewProcess } from '../src/main/preview-process'
import { PreviewEngine } from '../src/main/preview-engine'
import { MergeReviews } from '../src/main/merge/reviews'
import { MergeProcess } from '../src/main/merge/process'
import { MERGE_VERSION, type MergeManifest } from '../src/shared/merge'
import { syntheticMerge } from './merge.helpers'
import { verifyMaster } from '../src/main/merge/store'
import { WorkScheduler } from '../src/main/work-scheduler'
import { PROCESSING_METADATA_VERSION, type ProcessingOptions } from '../src/shared/lens'
import type { ChildProcess } from 'node:child_process'
import type { Photo } from '../src/shared/contracts'
import sharp from 'sharp'
import { ExportProcess } from '../src/main/export/process'
import { defaultExportOptions } from '../src/shared/export'
import { noLensSettings } from '../src/shared/lens'
import { processingMetadata } from '../src/main/processing/metadata'

const progressEpoch = () => performance.timeOrigin + performance.now()

function processingService(library: PhotoLibrary) {
  return library as unknown as {
    processingOptions: (id: string) => Promise<ProcessingOptions>
    loadProcessingOptions: (id: string) => Promise<ProcessingOptions>
  }
}

test('an admitted actual merge child continues through activity but pauses until explicit processing drains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-merge-activity-'))
  const workerPath = join(root, 'pause-control.cjs')
  // A control-only IPC child reports its actual received pause state. It does
  // not decode images, invent merge results or stand in for benchmark progress.
  await writeFile(
    workerPath,
    `
let paused = false;
const progress = value => process.send({ ...value, producedAtEpochMs: performance.timeOrigin + performance.now() });
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message.type === 'pause') paused = true;
  if (message.type === 'resume') paused = false;
  if (message.type === 'run') progress({ phase: 'fixture-started', completed: 0, total: 1 });
  if (message.type === 'probe') progress({ phase: paused ? 'fixture-paused' : 'fixture-running', completed: message.sequence, total: 10 });
});
`,
  )
  const library = new PhotoLibrary(
    root,
    new PreviewEngine(),
    () => {},
    undefined,
    undefined,
    {
      inspect: async () => {
        throw new Error('No metadata requested by pause control.')
      },
      close: async () => {},
    },
    workerPath,
  )
  const controller = new AbortController()
  const replies = new Map<number, string>()
  let started = false
  const admitted = library.scheduler.run('operation', () =>
    library.merges.worker.run(
      {
        directory: root,
        output: join(root, 'unused'),
        paths: [],
        sources: [],
        settings: {
          mode: 'hdr',
          referenceId: 'a'.repeat(64),
          autoAlign: false,
          deghost: false,
          strength: 50,
          autoCrop: true,
        },
      },
      controller.signal,
      (phase, completed) => {
        if (phase === 'fixture-started') started = true
        else replies.set(completed, phase)
      },
    ),
  )
  // Attach rejection handling before an assertion can send this fixture to cleanup.
  const stopped = admitted.then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  )
  const held: (() => void)[] = []
  const processing: Promise<unknown>[] = []
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  try {
    await expect.poll(() => started).toBe(true)
    child = (library.merges.worker as unknown as { child?: ChildProcess }).child
    expect(child?.pid).toBeTruthy()
    closed = new Promise<void>((resolve) => child!.once('close', () => resolve()))
    const probe = async (sequence: number, phase: string) => {
      child!.send({ type: 'probe', sequence })
      await expect.poll(() => replies.get(sequence)).toBe(phase)
    }
    library.scheduler.activity('slider', true)
    await probe(1, 'fixture-running')
    const beginProcessing = () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      held.push(release)
      const work = library.scheduler.run('interactive', () => gate)
      processing.push(work)
      return release
    }
    const releaseFirst = beginProcessing()
    const releaseSecond = beginProcessing()
    // Main emits pause before a subsequent probe on the same actual IPC channel.
    await probe(2, 'fixture-paused')
    releaseFirst()
    await processing[0]
    await probe(3, 'fixture-paused')
    releaseSecond()
    await processing[1]
    // The slider is still active; only explicit processing has drained.
    expect(library.scheduler.waitingReason).toBe('foreground')
    await probe(4, 'fixture-running')
    library.scheduler.activity('slider', false)
    await probe(5, 'fixture-running')
    controller.abort()
    expect((await stopped).ok).toBe(false)
    await closed
    expect(child!.signalCode).toBe('SIGKILL')
  } finally {
    controller.abort()
    for (const release of held) release()
    library.scheduler.activity('slider', false)
    await Promise.allSettled([stopped, ...processing])
    await closed
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('closing a queued merge inspection cancels admission and releases source pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-merge-queued-'))
  const scheduler = new WorkScheduler()
  let inspected = false
  const reviews = new MergeReviews(
    root,
    async () => {
      inspected = true
      throw new Error('Queued inspection must not start')
    },
    undefined,
    scheduler,
  )
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  try {
    scheduler.activity('visible edit', true)
    const creating = reviews.create(ids, 'noise')
    const cancelled = expect(creating).rejects.toThrow()
    expect(reviews.leased(ids)).toBe(true)
    await reviews.close()
    await cancelled
    expect(inspected).toBe(false)
    expect(reviews.leased(ids)).toBe(false)
    expect(reviews.active()).toBeNull()
    scheduler.activity('visible edit', false)
    await scheduler.background(async () => {}, new AbortController().signal)
  } finally {
    scheduler.close()
    await reviews.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const version of [MERGE_VERSION] as const)
  test(`${version} journal recovery preserves derived master, neutral history, fixed lens and source-independent previews`, async () => {
    const f = await syntheticMerge([0.25, 1, 4]),
      root = await mkdtemp(join(tmpdir(), 'irodori-merge-library-')),
      id = 'a'.repeat(64),
      inspections: string[] = []
    const make = () =>
      new PhotoLibrary(
        root,
        new PreviewEngine(),
        () => {},
        undefined,
        async (path) => {
          await rename(path, join(root, 'test-trash'))
        },
        {
          inspect: async (path) => {
            inspections.push(path)
            throw new Error('Unexpected metadata worker invocation.')
          },
          close: async () => {},
        },
      )
    let library = make()
    try {
      await library.open()
      await library.close()
      const stage = join(root, 'merge-publications', id)
      await mkdir(stage, { recursive: true })
      for (const name of ['linear.f32', 'motion.mask', 'thumb.jpg', 'preview.jpg'])
        await cp(join(f.output, name), join(stage, name))
      const manifest: MergeManifest = {
        version,
        asset: f.result.asset,
        recipe: f.result.recipe,
        // Current merge format with separately versioned processing metadata.
        metadata: { ...f.sources[1].metadata, version: 3 },
        photo: {
          ...f.sources[1].photo,
          id,
          assetKind: 'derived',
          filename: 'Result.luminance',
          format: 'IRODORI HDR',
          bytes: f.result.asset.byteLength,
          importedAt: new Date().toISOString(),
        },
      }
      manifest.recipe.version = version
      manifest.asset.source.decoder = version
      const json = JSON.stringify(manifest),
        frozenManifest = Buffer.from(json),
        frozenMaster = await readFile(join(f.output, 'linear.f32'))
      await writeFile(join(stage, 'manifest.json'), json)
      const db = new DatabaseSync(join(root, 'catalog.sqlite'))
      db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run(
        id,
        createHash('sha256').update(json).digest('hex'),
      )
      db.close()
      library = make()
      await library.open()
      expect(library.list().photos[0].assetKind).toBe('derived')
      expect((await library.getMergeProvenance(id)).reproducible).toBe(false)
      expect((await library.getMergeProvenance(id)).manifest.metadata.version).toBe(3)
      const recovered = await processingService(library).processingOptions(id)
      expect(recovered.metadata.version).toBe(PROCESSING_METADATA_VERSION)
      expect(recovered.metadata.mergeMaster).toMatchObject({
        asset: { sha256: f.result.asset.sha256, source: { decoder: version } },
      })
      expect(recovered.workingAsset?.path).toBe(join(root, 'originals', id, 'linear.f32'))
      expect(await readFile(join(root, 'originals', id, 'manifest.json'))).toEqual(frozenManifest)
      expect(createHash('sha256').update(frozenMaster).digest('hex')).toBe(f.result.asset.sha256)
      const initial = await library.getEdits(id)
      expect(initial.settings).toMatchObject({
        processing: 'hdr-v1',
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
      })
      expect(initial.referenceWhiteBalance).toBe(true)
      await expect(library.updateEdits(id, { lens: { distortion: true } }, 0)).rejects.toThrow(
        'fixed',
      )
      await library.updateEdits(id, { exposureEv: 1 }, 0)
      await library.undoEdit(id, 1)
      await library.redoEdit(id, 2)
      expect((await library.getEdits(id)).settings.exposureEv).toBe(1)
      await library.undoEdit(id, 3)
      const history = await library.getEditHistory(id)
      expect(history).toMatchObject({ revision: 4, canRedo: true, cursor: 0 })
      expect(history.snapshots).toHaveLength(2)
      const cached = new DatabaseSync(join(root, 'catalog.sqlite'))
      try {
        const row = cached.prepare('SELECT data FROM processing WHERE id = ?').get(id) as {
            data: string
          },
          legacy = JSON.parse(row.data) as ProcessingOptions
        // Seed after open so startup migration cannot mask the cached-read contract.
        legacy.metadata.version = 3
        cached
          .prepare('UPDATE processing SET data = ? WHERE id = ?')
          .run(JSON.stringify(legacy), id)
        expect((await library.getEdits(id)).revision).toBe(4)
        expect(await library.getLensSettings(id)).toMatchObject({ fixed: true, revision: 4 })
        for (const options of [
          await processingService(library).processingOptions(id),
          await processingService(library).loadProcessingOptions(id),
        ]) {
          expect(options.metadata.version).toBe(3)
          expect(options.metadata.mergeMaster?.asset.sha256).toBe(f.result.asset.sha256)
          expect(options.workingAsset?.path).toBe(join(root, 'originals', id, 'linear.f32'))
        }
        for (const retiredVersion of ['sony-merge-v1', 'sony-merge-v2', 'sony-merge-v3']) {
          const retired = structuredClone(legacy)
          Object.assign(retired.metadata.mergeMaster!.recipe, { version: retiredVersion })
          cached
            .prepare('UPDATE processing SET data = ? WHERE id = ?')
            .run(JSON.stringify(retired), id)
          await expect(library.getEdits(id)).rejects.toThrow('Unsupported merge version.')
          await expect(processingService(library).processingOptions(id)).rejects.toThrow(
            'Unsupported merge version.',
          )
          await expect(processingService(library).loadProcessingOptions(id)).rejects.toThrow(
            'Unsupported merge version.',
          )
          await expect(library.fullPreviews.requestHdr(id, randomUUID())).rejects.toThrow(
            'Unsupported merge version.',
          )
          await expect(library.prepareExport([id])).rejects.toThrow('Unsupported merge version.')
        }
        cached
          .prepare('UPDATE processing SET data = ? WHERE id = ?')
          .run(JSON.stringify(legacy), id)
        const missing = structuredClone(legacy)
        missing.metadata.version = PROCESSING_METADATA_VERSION
        delete missing.metadata.mergeMaster
        cached
          .prepare('UPDATE processing SET data = ? WHERE id = ?')
          .run(JSON.stringify(missing), id)
        await expect(library.getEdits(id)).rejects.toThrow(
          'The merged working source is unavailable.',
        )
        await expect(processingService(library).loadProcessingOptions(id)).rejects.toThrow(
          'The merged working source is unavailable.',
        )
        expect(inspections).toEqual([])
        cached.prepare('UPDATE processing SET data = ? WHERE id = ?').run(row.data, id)
      } finally {
        cached.close()
      }
      const options = await processingService(library).processingOptions(id)
      const worker = new PreviewProcess(resolve('out/main/preview-worker.js')),
        output = join(root, 'test-preview')
      await mkdir(output)
      try {
        const result = await worker.renderFull(
          join(root, 'originals', id, 'linear.f32'),
          output,
          new AbortController().signal,
          options,
        )
        expect(result.width).toBe(f.result.asset.width)
        expect(result.height).toBe(f.result.asset.height)
      } finally {
        await worker.close()
      }
      await library.close()
      await rm(join(root, 'cache'), { recursive: true, force: true })
      library = make()
      await library.open()
      expect((await library.getEdits(id)).revision).toBe(4)
      expect(await library.getEditHistory(id)).toEqual(history)
      expect(inspections).toEqual([])
      expect((await processingService(library).processingOptions(id)).metadata.version).toBe(
        PROCESSING_METADATA_VERSION,
      )
      expect(await readFile(join(root, 'originals', id, 'linear.f32'))).toEqual(frozenMaster)
      expect(await readFile(join(root, 'originals', id, 'manifest.json'))).toEqual(frozenManifest)
      const task = library.deletePhotos([id])!
      await expect
        .poll(() => library.listTasks().find((t) => t.id === task)?.status)
        .toBe('completed')
      expect(library.list().total).toBe(0)
      expect((await readFile(join(root, 'test-trash', 'linear.f32'))).length).toBeGreaterThan(0)
    } finally {
      await library.close()
      await f.close()
      await rm(root, { recursive: true, force: true })
    }
  })
test('review leases, strict compatibility and stale revisions are enforced before worker preparation', async () => {
  const f = await syntheticMerge([1, 1]),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  try {
    const ids = f.sources.map((s) => s.photo.id),
      r = await reviews.create(ids, 'noise')
    expect(reviews.leased(ids)).toBe(true)
    await expect(reviews.update(r.id, 1, r.settings)).rejects.toThrow('Stale')
    expect(() => reviews.accept(r.id, 0)).toThrow('Wait')
    const next = await reviews.update(r.id, 0, { ...r.settings, strength: 0 })
    expect(next.revision).toBe(1)
    await expect(reviews.preview(r.id, 0)).rejects.toThrow('Stale')
    await reviews.dispose(r.id)
    expect(reviews.leased(ids)).toBe(false)
    await expect(reviews.create([ids[0], ids[0]], 'noise')).rejects.toThrow('Duplicate')
  } finally {
    await reviews.close()
    await f.close()
  }
})

for (const retiredVersion of ['hdr-source-v1', 'sony-merge-v1', 'sony-merge-v2', 'sony-merge-v3'])
  test(`verified unsupported ${retiredVersion} journals retain staged/final bundles while current photos preview, edit, export and reopen`, async () => {
    const unsupportedReason =
      retiredVersion === 'hdr-source-v1'
        ? 'Unsupported HDR capture source version.'
        : 'Unsupported merge version.'
    const f = await syntheticMerge([1, 1], { width: 24, height: 65 })
    const root = await mkdtemp(join(tmpdir(), 'irodori-retained-unsupported-'))
    const previousPreview = process.env.IRODORI_PREVIEW_BACKEND
    const previousExport = process.env.IRODORI_EXPORT_BACKEND
    // This service gate uses actual CPU workers and JPEG encoding, with no GPU
    // or presentation claim. It exercises the production library admission path.
    process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
    process.env.IRODORI_EXPORT_BACKEND = 'cpu'
    const make = () => {
      const args: ConstructorParameters<typeof PhotoLibrary> = [root, new PreviewEngine(), () => {}]
      args[15] = new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      )
      args[16] = new PreviewProcess(resolve('out/main/preview-worker.js'))
      return new PhotoLibrary(...args)
    }
    let library = make()
    let db: DatabaseSync | undefined
    try {
      await library.open()
      await library.close()
      db = new DatabaseSync(join(root, 'catalog.sqlite'))
      const original = await sharp({
        create: {
          width: 17,
          height: 11,
          channels: 4,
          background: { r: 70, g: 90, b: 110, alpha: 1 },
        },
      })
        .png()
        .toBuffer()
      const photo: Photo = {
        id: createHash('sha256').update(original).digest('hex'),
        filename: 'Current.png',
        format: 'PNG',
        width: 17,
        height: 11,
        bytes: original.length,
        importedAt: '2026-10-20T12:00:00.000Z',
        previewSource: 'image',
        previewUrl: '',
        thumbnailUrl: '',
      }
      const originalPath = join(root, 'originals', photo.id, 'original.png')
      await mkdir(join(root, 'originals', photo.id))
      await writeFile(originalPath, original)
      db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'display-referred-v1')").run(
        photo.id,
        photo.importedAt,
        JSON.stringify(photo),
      )
      db.prepare('INSERT INTO processing VALUES (?, ?)').run(
        photo.id,
        JSON.stringify({
          processing: 'display-referred-v1',
          metadata: processingMetadata({}, []),
          settings: noLensSettings,
          revision: 0,
        }),
      )
      const names = ['linear.f32', 'motion.mask', 'thumb.jpg', 'preview.jpg', 'manifest.json']
      const build = async (
        id: string,
        version: 'current' | 'retired',
        location: 'staged' | 'final',
      ) => {
        const manifest: MergeManifest = {
          version: MERGE_VERSION,
          asset: structuredClone(f.result.asset),
          recipe: structuredClone(f.result.recipe),
          metadata: structuredClone(f.sources[0].metadata),
          photo: {
            ...f.sources[0].photo,
            id,
            filename: `${id[0]}-Result.luminance`,
            assetKind: 'derived',
            format: 'IRODORI HDR',
            bytes: f.result.asset.byteLength,
            importedAt: '2026-10-20T12:00:00.000Z',
          },
        }
        if (version === 'retired') {
          if (retiredVersion === 'hdr-source-v1')
            Object.assign(manifest.asset.source, { version: retiredVersion })
          else {
            Object.assign(manifest, { version: retiredVersion })
            Object.assign(manifest.recipe, { version: retiredVersion })
          }
        }
        const directory = join(root, location === 'staged' ? 'merge-publications' : 'originals', id)
        await mkdir(directory, { recursive: true })
        for (const name of names.slice(0, -1)) await cp(join(f.output, name), join(directory, name))
        const bytes = Buffer.from(JSON.stringify(manifest))
        await writeFile(join(directory, 'manifest.json'), bytes)
        return { manifest, directory, hash: createHash('sha256').update(bytes).digest('hex') }
      }
      const published = await build('a'.repeat(64), 'retired', 'final')
      db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
        published.manifest.photo.id,
        published.manifest.photo.importedAt,
        JSON.stringify(published.manifest.photo),
      )
      db.prepare('INSERT INTO derived_assets VALUES (?, ?)').run(
        published.manifest.photo.id,
        JSON.stringify(published.manifest),
      )
      db.prepare('INSERT INTO processing VALUES (?, ?)').run(
        published.manifest.photo.id,
        JSON.stringify({
          processing: 'hdr-v1',
          metadata: {
            ...published.manifest.metadata,
            mergeMaster: { asset: published.manifest.asset, recipe: published.manifest.recipe },
          },
          settings: noLensSettings,
          revision: 0,
        }),
      )
      const staged = await build('b'.repeat(64), 'retired', 'staged')
      const renamed = await build('c'.repeat(64), 'retired', 'final')
      const current = await build('d'.repeat(64), 'current', 'staged')
      for (const item of [staged, renamed, current])
        db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run(
          item.manifest.photo.id,
          item.hash,
        )
      const protectedPaths = [
        originalPath,
        ...[published, staged, renamed].flatMap((item) =>
          names.map((name) => join(item.directory, name)),
        ),
      ]
      const before = await Promise.all(protectedPaths.map((path) => readFile(path)))
      const currentBefore = await Promise.all(
        names.map((name) => readFile(join(current.directory, name))),
      )
      const expectedRows = [staged, renamed].map((item) => ({
        id: item.manifest.photo.id,
        manifest_sha256: item.hash,
      }))
      await mkdir(join(root, 'destination'))
      const verifyCurrentPreview = async () => {
        const preview = await library.fullPreviews.request(photo.id, randomUUID())
        const held = library.fullPreviews.acquire(new URL(preview.url))
        try {
          expect(held).toBeTruthy()
          const bytes = await readFile(held!.path)
          expect(bytes.length).toBe(photo.width! * photo.height! * 4)
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(preview.sha256)
        } finally {
          held?.release()
        }
        const working = await library.fullPreviews.requestHdr(
          current.manifest.photo.id,
          randomUUID(),
        )
        expect(working?.linear.sha256).toBe(f.result.asset.sha256)
      }
      for (let reopen = 0; reopen < 2; reopen++) {
        library = make()
        await library.open()
        expect(
          library
            .list()
            .photos.map((item) => item.id)
            .sort(),
        ).toEqual([photo.id, published.manifest.photo.id, current.manifest.photo.id].sort())
        expect(
          db.prepare('SELECT id, manifest_sha256 FROM merge_publications ORDER BY id').all(),
        ).toEqual(expectedRows)
        expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before)
        expect(
          await Promise.all(
            names.map((name) => readFile(join(root, 'originals', current.manifest.photo.id, name))),
          ),
        ).toEqual(currentBefore)
        const errors = library
          .listTasks()
          .filter((task) => task.title === 'Merged photo unsupported')
        expect(errors).toHaveLength(2)
        for (const task of errors) {
          expect(task).toMatchObject({
            kind: 'merge',
            status: 'failed',
            errorCount: 1,
            phase: 'Publication retained',
          })
          expect(library.taskErrors(task.id).errors).toEqual([
            {
              filename: task.detail,
              message: expect.stringContaining(unsupportedReason),
            },
          ])
        }
        await expect(
          library.fullPreviews.requestHdr(published.manifest.photo.id, randomUUID()),
        ).rejects.toThrow(unsupportedReason)
        if (retiredVersion !== 'hdr-source-v1')
          await expect(library.prepareExport([published.manifest.photo.id])).rejects.toThrow(
            unsupportedReason,
          )
        const provenance = await library.getMergeProvenance(published.manifest.photo.id)
        expect(provenance.manifest.version).toBe(published.manifest.version)
        expect(provenance.reproducible).toBe(false)
        await verifyCurrentPreview()
        const edits = await library.getEdits(photo.id)
        expect(edits.revision).toBe(reopen)
        if (reopen === 0) {
          await library.updateEdits(photo.id, { exposureEv: 0.25 }, 0)
          expect((await library.getEdits(photo.id)).revision).toBe(1)
          // A row changed after verification must not inherit the retained status.
          db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
            'e'.repeat(64),
            staged.manifest.photo.id,
          )
          try {
            await expect(library.getEdits(photo.id)).rejects.toThrow(
              'An interrupted merge publication needs recovery.',
            )
          } finally {
            db.prepare('UPDATE merge_publications SET manifest_sha256 = ? WHERE id = ?').run(
              staged.hash,
              staged.manifest.photo.id,
            )
          }
          await library.dismissTask(errors[0].id)
          expect((await library.getEdits(photo.id)).revision).toBe(1)
          const preparation = await library.prepareExport([photo.id])
          const destination = await library.exports.store.authorize(join(root, 'destination'))
          const job = await library.startExport({
            preparationId: preparation.id,
            destinationId: destination.id,
            action: 'custom',
            options: { ...defaultExportOptions, output: 'sdr', metadata: 'none' },
          })
          await expect
            .poll(() => library.listTasks().find((task) => task.id === job)?.finishedAt, {
              timeout: 20000,
            })
            .toBeTruthy()
          expect(library.listTasks().find((task) => task.id === job)).toMatchObject({
            status: 'completed',
            export: { exported: 1, failed: 0 },
          })
          const exported = await readFile(join(root, 'destination', 'Current.jpg'))
          expect(await sharp(exported).metadata()).toMatchObject({
            format: 'jpeg',
            width: 17,
            height: 11,
          })
          expect(library.exports.leased([photo.id])).toBe(false)
        }
        await library.close()
        expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before)
      }
      // The unsupported classifications never excuse a damaged current journal.
      const damaged = await build('f'.repeat(64), 'current', 'staged')
      const damagedPath = join(damaged.directory, 'linear.f32')
      const damagedBytes = await readFile(damagedPath)
      damagedBytes[damagedBytes.length - 1] ^= 0xff
      await writeFile(damagedPath, damagedBytes)
      db.prepare('INSERT INTO merge_publications VALUES (?, ?)').run(
        damaged.manifest.photo.id,
        damaged.hash,
      )
      library = make()
      await expect(library.open()).rejects.toThrow('Damaged master strip.')
      await library.close()
      expect(await readFile(damagedPath)).toEqual(damagedBytes)
      expect(
        db
          .prepare('SELECT manifest_sha256 FROM merge_publications WHERE id = ?')
          .get(damaged.manifest.photo.id),
      ).toEqual({ manifest_sha256: damaged.hash })
      expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before)
      expect(await readFile(originalPath)).toEqual(original)
    } finally {
      try {
        await library.close()
      } finally {
        try {
          db?.close()
          await f.close()
          await rm(root, { recursive: true, force: true })
        } finally {
          if (previousPreview === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
          else process.env.IRODORI_PREVIEW_BACKEND = previousPreview
          if (previousExport === undefined) delete process.env.IRODORI_EXPORT_BACKEND
          else process.env.IRODORI_EXPORT_BACKEND = previousExport
        }
      }
    }
  })
test('native review renders once per revision and publishes the exact reviewed master', async () => {
  const f = await syntheticMerge([1, 1], { comparisons: true }),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  let calls = 0,
    release!: () => void
  const callbacks: Parameters<typeof reviews.worker.run>[2][] = []
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  reviews.worker.run = async (job, _signal, progress) => {
    calls++
    callbacks.push(progress)
    progress('Preparing originals', 0, job.sources.length, progressEpoch())
    expect(job.comparisons).toBe(true)
    expect(job).not.toHaveProperty('preview')
    await wait
    await cp(f.output, job.output, { recursive: true })
    return structuredClone(f.result)
  }
  try {
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    const requests = [reviews.preview(review.id, 0), reviews.preview(review.id, 0)]
    await expect.poll(() => calls).toBe(1)
    expect(reviews.diagnostics(review.id, 0).status).toBe('pending')
    const progress = callbacks[0]
    expect(reviews.diagnostics(review.id, 0).workerProgress).toEqual({
      sequence: 1,
      phase: 'Preparing originals',
      completed: 0,
      total: 2,
      producedAtEpochMs: expect.any(Number),
    })
    progress('Preparing originals', 1, 2, progressEpoch())
    const completedSource = reviews.diagnostics(review.id, 0).workerProgress!
    expect(completedSource.sequence).toBe(2)
    expect(Number.isFinite(completedSource.producedAtEpochMs)).toBe(true)
    expect(completedSource.producedAtEpochMs).toBeGreaterThan(0)
    for (const invalidTimestamp of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      completedSource.producedAtEpochMs - 1,
    ]) {
      // The counter and phase are otherwise valid: only the producer clock is rejected.
      progress('Preparing originals', 2, 2, invalidTimestamp as number)
      progress('Aligning and checking exposures', 0, 2, invalidTimestamp as number)
      expect(reviews.diagnostics(review.id, 0).workerProgress).toEqual(completedSource)
    }
    for (const [phase, completed, total] of [
      ['Preparing originals', 1, 2],
      ['Preparing originals', 0, 2],
      ['Preparing originals', 2, 3],
      ['', 1, 2],
      [' '.repeat(129), 1, 2],
      ['Preparing originals', NaN, 2],
      ['Preparing originals', 1, Infinity],
      ['Preparing originals', -1, 2],
      ['Preparing originals', 3, 2],
      ['Preparing originals', 0, 0],
      ['Preparing originals', 0.5, 2],
      ['Preparing originals', 1, 2.5],
    ] as const)
      progress(phase, completed, total, progressEpoch())
    expect(reviews.diagnostics(review.id, 0).workerProgress).toEqual(completedSource)
    Object.assign(completedSource, { completed: 2, phase: 'mutated detached diagnostics' })
    expect(reviews.diagnostics(review.id, 0).workerProgress).toMatchObject({
      sequence: 2,
      phase: 'Preparing originals',
      completed: 1,
    })
    // Coarsened clocks can give successive actual events the same timestamp.
    progress('Preparing originals', 2, 2, completedSource.producedAtEpochMs)
    progress('Aligning and checking exposures', 0, 2, completedSource.producedAtEpochMs)
    const lastProgress = reviews.diagnostics(review.id, 0).workerProgress
    expect(lastProgress).toEqual({
      sequence: 4,
      phase: 'Aligning and checking exposures',
      completed: 0,
      total: 2,
      producedAtEpochMs: completedSource.producedAtEpochMs,
    })
    expect(() => reviews.accept(review.id, 0)).toThrow('Wait')
    release()
    const [preview, same] = await Promise.all(requests)
    progress('Combining linear samples', 96, 96, progressEpoch())
    expect(reviews.diagnostics(review.id, 0)).toMatchObject({
      status: 'ready',
      workerProgress: lastProgress,
    })
    expect(same).toEqual(preview)
    expect(preview.width).toBe(f.result.asset.width)
    expect(preview.height).toBe(f.result.asset.height)
    expect(Object.keys(preview).sort()).toEqual([
      'height',
      'overlayUrl',
      'recipe',
      'referenceUrl',
      'resultUrl',
      'reviewId',
      'revision',
      'width',
    ])
    const sharp = (await import('sharp')).default
    for (const name of ['result', 'reference', 'overlay']) {
      const path = reviews.imagePath([review.id, '0', name])!
      expect(await sharp(path).metadata()).toMatchObject({
        width: preview.width,
        height: preview.height,
      })
    }
    for (const name of ['native-result', 'final-result', '../result'])
      expect(reviews.imagePath([review.id, '0', name])).toBeUndefined()
    await reviews.preview(review.id, 0)
    expect(calls).toBe(1)
    const next = await reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    progress('Preparing originals', 2, 2, progressEpoch())
    expect(reviews.diagnostics(review.id, next.revision).workerProgress).toBeUndefined()
    expect(reviews.imagePath([review.id, '0', 'result'])).toBeUndefined()
    await expect(reviews.preview(review.id, 0)).rejects.toThrow('Stale')
    const updated = await reviews.preview(review.id, next.revision)
    expect(calls).toBe(2)
    expect(reviews.diagnostics(review.id, next.revision).workerProgress).toEqual({
      sequence: 1,
      phase: 'Preparing originals',
      completed: 0,
      total: 2,
      producedAtEpochMs: expect.any(Number),
    })
    expect(updated.recipe.resolution).toBe('native')
    const accepted = reviews.accept(review.id, next.revision)
    const { result, output } = await accepted.render(new AbortController().signal)
    expect(result.asset.sha256).toBe(f.result.asset.sha256)
    expect(await readFile(join(output, 'linear.f32'))).toEqual(
      await readFile(join(f.output, 'linear.f32')),
    )
    expect(calls).toBe(2)
    const abort = new AbortController()
    abort.abort()
    await expect(accepted.render(abort.signal)).rejects.toThrow()
    await reviews.dispose(review.id, true)
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(false)
  } finally {
    release()
    await reviews.close()
    await f.close()
  }
})

test('revision changes and closing cancel pending native work without publishing stale assets', async () => {
  const f = await syntheticMerge([1, 1]),
    reviews = new MergeReviews(f.directory, async (id) => ({
      source: f.sources.find((s) => s.photo.id === id)!,
      path: 'unused',
    }))
  let calls = 0,
    cancelled = 0,
    deferCancellation = true
  const callbacks: Parameters<typeof reviews.worker.run>[2][] = []
  const finishCancellation: (() => void)[] = []
  reviews.worker.run = (_job, signal, progress) => {
    calls++
    callbacks.push(progress)
    progress('Preparing originals', 0, 2, progressEpoch())
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled++
          progress('Preparing originals', 2, 2, progressEpoch())
          const finish = () => reject(new Error('Native work cancelled.'))
          if (deferCancellation) finishCancellation.push(finish)
          else finish()
        },
        { once: true },
      )
    })
  }
  try {
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    const first = expect(reviews.preview(review.id, 0)).rejects.toThrow('cancelled')
    await expect.poll(() => calls).toBe(1)
    callbacks[0]('Preparing originals', 1, 2, progressEpoch())
    expect(reviews.diagnostics(review.id, 0).workerProgress?.completed).toBe(1)
    const updating = reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    expect(cancelled).toBe(1)
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(true)
    expect(() => reviews.diagnostics(review.id, 1)).toThrow('updating or closing')
    finishCancellation[0]()
    const next = await updating
    await first
    expect(cancelled).toBe(1)
    expect(reviews.diagnostics(review.id, next.revision).status).toBe('pending')
    callbacks[0]('Preparing originals', 2, 2, progressEpoch())
    expect(reviews.diagnostics(review.id, next.revision).workerProgress).toBeUndefined()
    const second = expect(reviews.preview(review.id, next.revision)).rejects.toThrow('cancelled')
    await expect.poll(() => calls).toBe(2)
    expect(reviews.diagnostics(review.id, next.revision).workerProgress?.sequence).toBe(1)
    const disposing = reviews.dispose(review.id)
    expect(cancelled).toBe(2)
    expect(reviews.leased(f.sources.map((s) => s.photo.id))).toBe(true)
    expect(() => reviews.diagnostics(review.id, next.revision)).toThrow('updating or closing')
    finishCancellation[1]()
    await disposing
    await second
    expect(cancelled).toBe(2)
    expect(reviews.active()).toBeNull()
    expect(reviews.imagePath([review.id, String(next.revision), 'result'])).toBeUndefined()
    const replacement = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    callbacks[1]('Combining linear samples', 96, 96, progressEpoch())
    expect(reviews.diagnostics(replacement.id, replacement.revision).workerProgress).toBeUndefined()
    await reviews.dispose(replacement.id)
  } finally {
    deferCancellation = false
    for (const finish of finishCancellation) finish()
    await reviews.close()
    await f.close()
  }
})
test('actual progress emission timestamps survive child IPC without replacement by receipt time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'irodori-merge-progress-clock-'))
  const workerPath = join(root, 'progress-clock.cjs'),
    receiptPath = join(root, 'emitted.json')
  await writeFile(
    workerPath,
    `
const fs = require('node:fs');
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message.type !== 'run') return;
  const sent = [];
  const send = completed => {
    const producedAtEpochMs = performance.timeOrigin + performance.now();
    sent.push(producedAtEpochMs);
    process.send({phase:'fixture-progress',completed,total:2,producedAtEpochMs});
  };
  send(0);
  setImmediate(() => {
    send(1);
    fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(sent));
    process.send({error:{code:'processing',message:'Clock fixture finished.',filenames:[],diagnostics:[]}});
  });
});
`,
  )
  const worker = new MergeProcess(workerPath)
  const events: { producedAtEpochMs: number; observedAtEpochMs: number }[] = []
  try {
    await expect(
      worker.run(
        {
          directory: root,
          output: join(root, 'unused'),
          paths: [],
          sources: [],
          settings: {
            mode: 'hdr',
            referenceId: 'a'.repeat(64),
            autoAlign: false,
            deghost: false,
            strength: 50,
            autoCrop: true,
          },
        },
        new AbortController().signal,
        (_phase, _completed, _total, producedAtEpochMs) => {
          events.push({ producedAtEpochMs, observedAtEpochMs: progressEpoch() })
        },
      ),
    ).rejects.toThrow('Clock fixture finished.')
    const emitted: number[] = JSON.parse(await readFile(receiptPath, 'utf8'))
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.producedAtEpochMs)).toEqual(emitted)
    for (const event of events) {
      expect(Number.isFinite(event.producedAtEpochMs)).toBe(true)
      expect(event.producedAtEpochMs).toBeGreaterThan(0)
      expect(event.producedAtEpochMs).toBeLessThanOrEqual(event.observedAtEpochMs)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worker progress counts validated reference-first sources and completed CPU rows', async () => {
  const previousBackend = process.env.IRODORI_MERGE_BACKEND
  process.env.IRODORI_MERGE_BACKEND = 'cpu'
  try {
    const f = await syntheticMerge([1, 1, 1], { reference: 2, width: 24, height: 65 })
    try {
      const events: {
        phase: string
        completed: number
        total: number
        producedAtEpochMs: number
        observedAtEpochMs: number
      }[] = []
      const counters = () =>
        events.map(({ phase, completed, total }) => ({ phase, completed, total }))
      const checkClocks = () => {
        let previous = 0
        for (const event of events) {
          expect(Number.isFinite(event.producedAtEpochMs)).toBe(true)
          expect(event.producedAtEpochMs).toBeGreaterThan(0)
          expect(event.producedAtEpochMs).toBeGreaterThanOrEqual(previous)
          expect(event.producedAtEpochMs).toBeLessThanOrEqual(event.observedAtEpochMs)
          previous = event.producedAtEpochMs
        }
      }
      const worker = new MergeProcess(resolve('out/main/merge-worker.js'))
      const result = await worker.run(
        { ...f.job, output: join(f.directory, 'progress-complete') },
        new AbortController().signal,
        (phase, completed, total, producedAtEpochMs) =>
          events.push({
            phase,
            completed,
            total,
            producedAtEpochMs,
            observedAtEpochMs: progressEpoch(),
          }),
      )
      expect(result.measurements.accumulation.backend).toBe('cpu')
      expect(result.measurements.timeline?.preparation.map((source) => source.sourceId)).toEqual([
        f.sources[2].photo.id,
        f.sources[0].photo.id,
        f.sources[1].photo.id,
      ])
      checkClocks()
      expect(counters().filter((event) => event.phase === 'Preparing originals')).toEqual(
        [0, 1, 2, 3].map((completed) => ({ phase: 'Preparing originals', completed, total: 3 })),
      )
      expect(counters().filter((event) => event.phase === 'Combining linear samples')).toEqual(
        [0, 64, 65].map((completed) => ({
          phase: 'Combining linear samples',
          completed,
          total: 65,
        })),
      )
      const path = join(f.directory, 'source-0.json'),
        invalid = JSON.parse(await readFile(path, 'utf8'))
      invalid.source.plane.data[0] = 'not-finite'
      await writeFile(path, JSON.stringify(invalid))
      events.length = 0
      await expect(
        worker.run(
          { ...f.job, output: join(f.directory, 'progress-invalid') },
          new AbortController().signal,
          (phase, completed, total, producedAtEpochMs) =>
            events.push({
              phase,
              completed,
              total,
              producedAtEpochMs,
              observedAtEpochMs: progressEpoch(),
            }),
        ),
      ).rejects.toThrow('Invalid source preparation.')
      checkClocks()
      expect(counters()).toEqual([
        { phase: 'Preparing originals', completed: 0, total: 3 },
        { phase: 'Preparing originals', completed: 1, total: 3 },
      ])
    } finally {
      await f.close()
    }
  } finally {
    if (previousBackend === undefined) delete process.env.IRODORI_MERGE_BACKEND
    else process.env.IRODORI_MERGE_BACKEND = previousBackend
  }
})
test('damaged masters and masks fail validation before publication', async () => {
  const f = await syntheticMerge([1, 1])
  try {
    const manifest: MergeManifest = {
      version: MERGE_VERSION,
      asset: f.result.asset,
      recipe: f.result.recipe,
      metadata: f.sources[0].metadata,
      photo: { ...f.sources[0].photo, assetKind: 'derived' },
    }
    await verifyMaster(f.output, manifest)
    const original = await readFile(join(f.output, 'linear.f32')),
      updatePixels = async (bytes: Buffer) => {
        await writeFile(join(f.output, 'linear.f32'), bytes)
        manifest.asset.sha256 = createHash('sha256').update(bytes).digest('hex')
        let offset = 0
        for (const strip of manifest.asset.strips) {
          strip.sha256 = createHash('sha256')
            .update(bytes.subarray(offset, offset + strip.byteLength))
            .digest('hex')
          offset += strip.byteLength
        }
      }
    // Recompute valid checksums so pixel validation must independently reject these values.
    for (const [channel, value] of [
      [0, NaN],
      [1, Infinity],
      [2, -Infinity],
      [3, NaN],
      [3, -0.1],
      [3, 1.1],
    ]) {
      const bytes = Buffer.from(original)
      bytes.writeFloatLE(value, channel * 4)
      await updatePixels(bytes)
      await expect(verifyMaster(f.output, manifest)).rejects.toThrow('Invalid master pixels')
    }
    const signed = Buffer.from(original)
    signed.writeFloatLE(-0.25, 0)
    signed.writeFloatLE(4, 4)
    signed.writeFloatLE(-0, 12)
    await updatePixels(signed)
    await verifyMaster(f.output, manifest)
    await updatePixels(original)
    await writeFile(join(f.output, 'motion.mask'), Buffer.from([0]))
    await expect(verifyMaster(f.output, manifest)).rejects.toThrow('Damaged merge mask')
  } finally {
    await f.close()
  }
})

for (const boundary of ['staged', 'journaled', 'published', 'committed'] as const)
  test(`interrupted merge publication at ${boundary} recovers complete masters without source loss`, async () => {
    const f = await syntheticMerge([1, 1]),
      root = await mkdtemp(join(tmpdir(), 'irodori-merge-boundary-'))
    let fail = true
    const make = () =>
      new PhotoLibrary(
        root,
        new PreviewEngine(),
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        async (stage) => {
          if (fail && stage === boundary)
            throw new Error(
              boundary === 'staged'
                ? 'ENOSPC injected before publication'
                : 'Injected publication interruption',
            )
        },
        {
          inspectCapture: async (path) => ({
            version: 2,
            format: 'ARW',
            dateTimeOriginal: path.includes(f.sources[1].photo.id)
              ? '2026:10:01 00:05:00+1400'
              : '2025:09:30 23:55:00-1200',
          }),
          close: async () => {},
        },
      )
    let library = make()
    try {
      await library.open()
      const db = new DatabaseSync(join(root, 'catalog.sqlite'))
      for (const source of f.sources) {
        const directory = join(root, 'originals', source.photo.id)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'original.arw'), 'isolated synthetic test source')
        db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
          source.photo.id,
          '2026',
          JSON.stringify(source.photo),
        )
        const options: ProcessingOptions = {
          metadata: { ...source.metadata, capture: source.capture },
          settings: { distortion: false, vignetting: false, chromaticAberration: false },
          revision: 0,
        }
        db.prepare('INSERT INTO processing VALUES (?, ?)').run(
          source.photo.id,
          JSON.stringify(options),
        )
        new CatalogMutations(db).seedEdits(source.photo.id, options, new Date().toISOString())
      }
      db.close()
      library.merges.worker.run = async (job) => {
        await cp(f.output, job.output, { recursive: true })
        return f.result
      }
      const ids = f.sources.map((s) => s.photo.id),
        review = await library.createMergeReview(ids, 'noise')
      expect(() => library.deletePhotos(ids)).toThrow('merge review')
      await library.requestMergePreview(review.id, 0)
      const task = library.startMerge(review.id, 0)
      await expect
        .poll(() => library.listTasks().find((t) => t.id === task)?.finishedAt)
        .toBeTruthy()
      expect(library.listTasks().find((t) => t.id === task)?.status).toBe('failed')
      const publication = library.listTasks().find((t) => t.id === task)!.mergeMeasurements!
        .publication!
      expect(publication.clock).toBe('main-performance')
      expect(publication.cleanupMs).toBeGreaterThanOrEqual(0)
      const durations = [
        publication.operationQueueMs,
        publication.reviewHandoffMs,
        publication.copyingMs,
        publication.fileSyncMs,
        publication.manifestMs,
        publication.directorySyncMs,
        publication.mutationQueueMs,
        publication.journalMs,
        publication.renameMs,
        publication.catalogCommitMs,
        publication.cleanupMs,
        ...Object.values(publication.sourceVerification!),
        ...Object.values(publication.destinationVerification!),
      ]
      expect(durations.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true)
      expect(durations.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(publication.runtimeMs)
      expect(publication.sourceVerification!.hashingMs).toBeGreaterThan(0)
      expect(publication.destinationVerification!.hashingMs).toBeGreaterThan(0)
      await library.close()
      fail = false
      library = make()
      await library.open()
      expect(library.list().total).toBe(boundary === 'staged' ? 2 : 3)
      for (const id of ids)
        expect(await readFile(join(root, 'originals', id, 'original.arw'), 'utf8')).toBe(
          'isolated synthetic test source',
        )
      if (boundary !== 'staged') {
        const result = library.list().photos.find((p) => p.assetKind === 'derived')!
        expect(result.capturedAt).toBe('2026-10-01T00:05:00.000000000000000000')
        expect(result.captureDateOrigin).toEqual({
          kind: 'merge-reference',
          photoId: ids[1],
          filename: f.sources[1].photo.filename,
        })
        expect(
          library.locateBrowsePhoto({ search: '', grouping: 'date' }, result.id)?.photo,
        ).toMatchObject({ captureDate: result.capturedAt, dateOrigin: result.captureDateOrigin })
        const frozen = (await library.getMergeProvenance(result.id)).manifest
        expect(frozen.photo.capturedAt).toBe(result.capturedAt)
        expect(frozen.metadata.capturedAt).toBe(result.capturedAt)
        expect(library.getPhotoStack(result.id)).toMatchObject({
          coverId: result.id,
          count: 3,
          expanded: false,
          origin: 'merge',
        })
        expect(library.listGallery()).toMatchObject({ total: 1, storedTotal: 3 })
        expect((await library.getMergeProvenance(result.id)).manifest.asset.sha256).toBe(
          f.result.asset.sha256,
        )
      }
    } finally {
      await library.close()
      await f.close()
      await rm(root, { recursive: true, force: true })
    }
  })

test('a committed merge journal with lost ACK and failed readback retains all publication bytes until exactly one recovery', async () => {
  const f = await syntheticMerge([1, 1], { width: 24, height: 65 })
  const root = await mkdtemp(join(tmpdir(), 'irodori-merge-journal-unknown-'))
  const owners: CatalogWriter[] = []
  const committed = new Int32Array(new SharedArrayBuffer(4))
  const names = ['linear.f32', 'manifest.json', 'motion.mask', 'preview.jpg', 'thumb.jpg']
  const phases: string[] = []
  let library: PhotoLibrary | undefined
  let observer: DatabaseSync | undefined
  let restoreReadback: (() => void) | undefined
  let actualExit: number | undefined
  let readbackAttempts = 0
  let readbackAfterExit = false
  let stagedDirectory = ''
  let manifest: MergeManifest | undefined
  type FileSnapshot = { bytes: Buffer; sha256: string; dev: number; ino: number; mtimeMs: number }
  let staged = new Map<string, FileSnapshot>()
  const originals = new Map(
    f.sources.map((source, index) => [
      source.photo.id,
      Buffer.from(`isolated source ${index}; retained across unknown journal outcome`),
    ]),
  )
  const snapshot = async (directory: string) => {
    expect((await readdir(directory)).sort()).toEqual(names)
    const files = new Map<string, FileSnapshot>()
    for (const name of names) {
      const bytes = await readFile(join(directory, name)),
        info = await stat(join(directory, name))
      expect(info.isFile()).toBe(true)
      files.set(name, {
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        dev: info.dev,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
      })
    }
    return files
  }
  const assertOriginals = async () => {
    for (const [id, bytes] of originals)
      expect(await readFile(join(root, 'originals', id, 'original.arw'))).toEqual(bytes)
  }
  const make = (loseJournalAck: boolean) => {
    const args: ConstructorParameters<typeof PhotoLibrary> = [root, new PreviewEngine(), () => {}]
    args[7] = async (phase) => {
      phases.push(phase)
      if (phase !== 'staged') return
      const ids = await readdir(join(root, 'merge-publications'))
      expect(ids).toHaveLength(1)
      stagedDirectory = join(root, 'merge-publications', ids[0])
      staged = await snapshot(stagedDirectory)
      manifest = JSON.parse(staged.get('manifest.json')!.bytes.toString()) as MergeManifest
      expect(manifest.photo.id).toBe(ids[0])
      // Fail only the actual post-exit unknown-ACK readback on this reader. Every
      // other query still reaches the same real, query-only SQLite connection.
      const reader = (library as unknown as { db: DatabaseSync }).db
      const descriptor = Object.getOwnPropertyDescriptor(reader, 'prepare'),
        prepare = reader.prepare
      Object.defineProperty(reader, 'prepare', {
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? false,
        value: function (this: DatabaseSync, ...values: Parameters<DatabaseSync['prepare']>) {
          if (values[0] === 'SELECT 1 FROM merge_publications WHERE id = ?') {
            readbackAttempts++
            readbackAfterExit = actualExit === 47 && Atomics.load(committed, 0) === 1
            throw new Error('Injected catalog readback failure after actual writer exit.')
          }
          return Reflect.apply(prepare, this, values)
        },
      })
      restoreReadback = () => {
        if (descriptor) Object.defineProperty(reader, 'prepare', descriptor)
        else if (!Reflect.deleteProperty(reader, 'prepare'))
          throw new Error('Could not restore SQLite reader.')
      }
    }
    args[8] = {
      inspectCapture: async (path) => ({
        version: 2,
        format: 'ARW',
        dateTimeOriginal: path.includes(f.sources[1].photo.id)
          ? '2026:10:01 00:05:00+1400'
          : '2025:09:30 23:55:00-1200',
      }),
      close: async () => {},
    }
    args[17] = (databasePath) => {
      const create: CatalogWorkerFactory | undefined = loseJournalAck
        ? (_entry, options) => {
            const actual = new Worker(join(root, 'lost-journal-ack.mjs'), {
              ...options,
              workerData: { ...options.workerData, committed: committed.buffer },
            })
            actual.once('exit', (code) => {
              actualExit = code
            })
            return actual
          }
        : undefined
      const owner = new CatalogWriter(databasePath, create, resolve('out/main/catalog-worker.js'))
      owners.push(owner)
      return owner
    }
    return new PhotoLibrary(...args)
  }
  try {
    // The control wraps the real mutation domain and transport; it exits only
    // after SQLite confirms the exact journal row, before transport can ACK it.
    await build({
      stdin: {
        contents: `
      import { parentPort, workerData } from 'node:worker_threads'
      import { DatabaseSync } from 'node:sqlite'
      import { CatalogMutations } from ${JSON.stringify(resolve('src/main/catalog/domain.ts'))}
      import { serveCatalog } from ${JSON.stringify(resolve('src/main/catalog/serve.ts'))}
      const db = new DatabaseSync(workerData.databasePath)
      db.exec('PRAGMA synchronous=FULL')
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('Expected WAL.')
      const domain = new CatalogMutations(db)
      domain.camera.initialize()
      const execute = domain.execute.bind(domain)
      domain.execute = command => {
        const result = execute(command)
        if (command.operation === 'merge.journal') {
          const row = db.prepare('SELECT manifest_sha256 FROM merge_publications WHERE id = ?').get(command.payload.id)
          if (db.isTransaction || row?.manifest_sha256 !== command.payload.manifestSha256)
            throw new Error('Journal was not committed before ACK loss.')
          Atomics.store(new Int32Array(workerData.committed), 0, 1)
          process.exit(47)
        }
        return result
      }
      serveCatalog(parentPort, domain)
    `,
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      packages: 'external',
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: join(root, 'lost-journal-ack.mjs'),
      logLevel: 'silent',
    })
    library = make(true)
    await library.open()
    for (const source of f.sources) {
      const directory = join(root, 'originals', source.photo.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'original.arw'), originals.get(source.photo.id)!)
      await library.catalogCommands.command({
        operation: 'original.publish',
        payload: {
          photo: source.photo,
          processingIdentity: 'hdr-v1',
          metadata: { ...source.metadata, capture: source.capture },
          createdAt: new Date().toISOString(),
        },
      })
    }
    library.merges.worker.run = async (job) => {
      await cp(f.output, job.output, { recursive: true })
      return structuredClone(f.result)
    }
    const review = await library.createMergeReview(
      f.sources.map((source) => source.photo.id),
      'noise',
    )
    await library.requestMergePreview(review.id, 0)
    const taskId = library.startMerge(review.id, 0)
    await expect
      .poll(() => library!.listTasks().find((task) => task.id === taskId)?.finishedAt)
      .toBeTruthy()
    expect(library.listTasks().find((task) => task.id === taskId)?.status).toBe('failed')
    expect(library.taskErrors(taskId)).toEqual({
      total: 1,
      errors: [
        {
          filename: 'Merge',
          message:
            'Merge journal acknowledgement and readback failed; publication bytes were retained.',
        },
      ],
    })
    expect(Atomics.load(committed, 0)).toBe(1)
    expect(actualExit).toBe(47)
    expect(owners[0].isClosed).toBe(true)
    expect(owners[0].failure).toBeTruthy()
    expect(readbackAttempts).toBe(1)
    expect(readbackAfterExit).toBe(true)
    expect(phases).toEqual(['staged'])
    expect(staged.size).toBe(5)
    expect(await snapshot(stagedDirectory)).toEqual(staged)
    await assertOriginals()
    expect(library.list().total).toBe(2)
    expect((await readdir(join(root, 'originals'))).sort()).toEqual([...originals.keys()].sort())
    observer = new DatabaseSync(join(root, 'catalog.sqlite'), { readOnly: true })
    expect(observer.prepare('SELECT id, manifest_sha256 FROM merge_publications').all()).toEqual([
      { id: manifest!.photo.id, manifest_sha256: staged.get('manifest.json')!.sha256 },
    ])
    expect(observer.prepare('SELECT COUNT(*) AS count FROM derived_assets').get()).toEqual({
      count: 0,
    })
    observer.close()
    observer = undefined
    expect(restoreReadback).toBeDefined()
    restoreReadback?.()
    restoreReadback = undefined
    await library.close()
    for (let reopen = 0; reopen < 2; reopen++) {
      library = make(false)
      await library.open()
      const derived = library.list().photos.filter((photo) => photo.assetKind === 'derived')
      expect(library.list().total).toBe(3)
      expect(derived.map((photo) => photo.id)).toEqual([manifest!.photo.id])
      const final = join(root, 'originals', manifest!.photo.id)
      expect(await snapshot(final)).toEqual(staged)
      await verifyMaster(final, manifest!)
      await assertOriginals()
      expect(await readdir(join(root, 'merge-publications'))).toEqual([])
      observer = new DatabaseSync(join(root, 'catalog.sqlite'), { readOnly: true })
      expect(observer.prepare('SELECT id FROM merge_publications').all()).toEqual([])
      expect(observer.prepare('SELECT id FROM derived_assets').all()).toEqual([
        { id: manifest!.photo.id },
      ])
      const history = await library.getEditHistory(manifest!.photo.id)
      expect(history).toMatchObject({ revision: 0, cursor: 0, canUndo: false, canRedo: false })
      expect(history.snapshots).toHaveLength(1)
      observer.close()
      observer = undefined
      await library.close()
    }
    expect(readbackAttempts).toBe(1)
  } finally {
    try {
      restoreReadback?.()
    } finally {
      try {
        await library?.close()
      } finally {
        await Promise.all(owners.map((owner) => owner.close()))
        if (observer?.isOpen) observer.close()
        await f.close()
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

test('read-only review diagnostics retain structured worker failure without rerunning and reject stale revisions', async () => {
  const f = await syntheticMerge([1, 1])
  const failure = {
    code: 'alignment',
    message: 'source-1.ARW: insufficient static support.',
    filenames: ['source-1.ARW'],
    diagnostics: [],
  }
  const worker = join(f.directory, 'failure.cjs'),
    counter = join(f.directory, 'calls')
  await writeFile(
    worker,
    `process.on('disconnect',()=>process.exit());process.on('message',m=>{if(m.type==='run'){require('node:fs').appendFileSync(${JSON.stringify(counter)},'1');process.send({phase:'Preparing originals',completed:0,total:2,producedAtEpochMs:performance.timeOrigin+performance.now()});process.send({phase:'Preparing originals',completed:1,total:2,producedAtEpochMs:performance.timeOrigin+performance.now()});process.send({error:${JSON.stringify(failure)}})}})`,
  )
  const reviews = new MergeReviews(
    f.directory,
    async (id) => ({ source: f.sources.find((s) => s.photo.id === id)!, path: 'unused' }),
    worker,
  )
  try {
    expect(reviews.active()).toBeNull()
    const review = await reviews.create(
      f.sources.map((s) => s.photo.id),
      'noise',
    )
    expect(reviews.active()).toEqual(review)
    expect(reviews.diagnostics(review.id, 0).status).toBe('pending')
    await expect(reviews.preview(review.id, 0)).rejects.toMatchObject({
      message: failure.message,
      failure,
    })
    for (let i = 0; i < 2; i++)
      expect(reviews.diagnostics(review.id, 0)).toMatchObject({
        status: 'failed',
        error: failure,
        workerProgress: { sequence: 2, phase: 'Preparing originals', completed: 1, total: 2 },
      })
    await expect(reviews.preview(review.id, 0)).rejects.toMatchObject({ failure })
    expect(await readFile(counter, 'utf8')).toBe('1')
    expect(JSON.stringify(reviews.diagnostics(review.id, 0))).not.toContain(f.directory)
    await reviews.update(review.id, 0, { ...review.settings, strength: 25 })
    expect(() => reviews.diagnostics(review.id, 0)).toThrow('Stale')
    expect(reviews.diagnostics(review.id, 1).status).toBe('pending')
    expect(reviews.diagnostics(review.id, 1).workerProgress).toBeUndefined()
    await writeFile(
      worker,
      `process.on('message',m=>{if(m.type==='run'){process.send({phase:'Preparing originals',completed:0,total:2,producedAtEpochMs:performance.timeOrigin+performance.now()});process.send({phase:'Preparing originals',completed:1,total:2,producedAtEpochMs:performance.timeOrigin+performance.now()},()=>process.exit(0))}})`,
    )
    await expect(reviews.preview(review.id, 1)).rejects.toThrow('The merge worker stopped.')
    expect(reviews.diagnostics(review.id, 1)).toMatchObject({
      status: 'failed',
      workerProgress: { sequence: 2, phase: 'Preparing originals', completed: 1, total: 2 },
    })
    await reviews.update(review.id, 1, { ...review.settings, strength: 50 })
    expect(reviews.diagnostics(review.id, 2).workerProgress).toBeUndefined()
    await reviews.dispose(review.id)
    expect(reviews.active()).toBeNull()
  } finally {
    await reviews.close()
    await f.close()
  }
})

test('available originals do not make unsupported or malformed HDR provenance reproducible', async () => {
  const f = await syntheticMerge([1, 1]),
    root = await mkdtemp(join(tmpdir(), 'irodori-merge-provenance-source-')),
    id = 'f'.repeat(64),
    sourceBytes = Buffer.from('isolated source-existence fixture; never decoded')
  let library = new PhotoLibrary(root, new PreviewEngine(), () => {}),
    db: DatabaseSync | undefined
  try {
    await library.open()
    await library.close()
    db = new DatabaseSync(join(root, 'catalog.sqlite'))
    const originalPaths: string[] = []
    for (const source of f.sources) {
      // getMergeProvenance's existing originals check is existence-only. These
      // explicit synthetic bytes test that contract, not RAW decoding quality.
      const directory = join(root, 'originals', source.photo.id),
        path = join(directory, 'original.arw')
      await mkdir(directory, { recursive: true })
      await writeFile(path, sourceBytes)
      originalPaths.push(path)
      db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
        source.photo.id,
        source.photo.importedAt,
        JSON.stringify(source.photo),
      )
    }
    const manifest: MergeManifest = {
      version: MERGE_VERSION,
      asset: structuredClone(f.result.asset),
      recipe: structuredClone(f.result.recipe),
      photo: {
        ...f.sources[0].photo,
        id,
        assetKind: 'derived',
        filename: 'Provenance.luminance',
        format: 'IRODORI HDR',
      },
      metadata: structuredClone(f.sources[0].metadata),
    }
    db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
      id,
      manifest.photo.importedAt,
      JSON.stringify(manifest.photo),
    )
    db.prepare('INSERT INTO derived_assets VALUES (?, ?)').run(id, JSON.stringify(manifest))
    library = new PhotoLibrary(root, new PreviewEngine(), () => {})
    await library.open()
    const current = await library.getMergeProvenance(id)
    expect(current.reproducible).toBe(true)
    const retired = structuredClone(manifest)
    Object.assign(retired.asset.source, { version: 'hdr-source-v1' })
    db.prepare('UPDATE derived_assets SET manifest = ? WHERE id = ?').run(
      JSON.stringify(retired),
      id,
    )
    const unsupported = await library.getMergeProvenance(id)
    expect(unsupported.manifest).toEqual(retired)
    expect(unsupported.reproducible).toBe(false)
    const malformed = structuredClone(manifest)
    malformed.asset.source.normalization.referenceWhite = 0
    db.prepare('UPDATE derived_assets SET manifest = ? WHERE id = ?').run(
      JSON.stringify(malformed),
      id,
    )
    const invalid = await library.getMergeProvenance(id)
    expect(invalid.manifest).toEqual(malformed)
    expect(invalid.reproducible).toBe(false)
    db.prepare('UPDATE derived_assets SET manifest = ? WHERE id = ?').run(
      JSON.stringify(manifest),
      id,
    )
    expect((await library.getMergeProvenance(id)).reproducible).toBe(true)
    expect(await Promise.all(originalPaths.map((path) => readFile(path)))).toEqual(
      originalPaths.map(() => sourceBytes),
    )
  } finally {
    await library.close()
    db?.close()
    await f.close()
    await rm(root, { recursive: true, force: true })
  }
})
