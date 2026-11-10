/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { ObjectSelectionProcess } from '../src/main/object-selection/process'
import { ExportProcess } from '../src/main/export/process'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { cropAdmission } from './crop-frame.helpers'
import { proofFixture } from './export-proof.helpers'
import { defaultExportOptions } from '../src/shared/export'
import { identityCrop } from '../src/shared/crop'
import type { EditState } from '../src/shared/edits'
import type { EditorContextSnapshot } from '../src/shared/agent'
import type { ObjectSelectionContext } from '../src/shared/object-selection'
import { DatabaseSync } from 'node:sqlite'
import { CATALOG_VERSION } from '../src/main/catalog/editing-migration'
import { transferFixture } from './edit-transfer.helpers'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('actual catalog 23 startup upgrades all brush history to 24 and rejects disguised future bases before recovery writes', async () => {
  const fixture = await transferFixture(1)
  const photoId = fixture.ids[0],
    maskId = randomUUID()
  // This case qualifies catalog migration only; no geometry rendering or inference is requested.
  fixture.library.fullPreviews.validateMaskEdit = async () => {}
  try {
    await fixture.library.mutateMasks(photoId, 0, {
      operations: [
        { kind: 'create', id: maskId, name: 'Pre-existing brush mask' },
        {
          kind: 'stroke',
          strokeTarget: 'primary',
          id: maskId,
          stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [{ x: 0.3, y: 0.4 }] },
        },
      ],
    })
    await fixture.library.mutateMasks(photoId, 1, {
      operations: [
        {
          kind: 'stroke',
          strokeTarget: 'primary',
          id: maskId,
          stroke: { mode: 'subtract', radius: 0.03, feather: 0.2, points: [{ x: 0.5, y: 0.6 }] },
        },
        { kind: 'update', id: maskId, light: { shadows: 13 } },
      ],
    })
    await fixture.library.undoEdit(photoId, 2)
    const expected = await fixture.library.getEditHistory(photoId)
    await fixture.library.close()
    const db = new DatabaseSync(join(fixture.root, 'library', 'catalog.sqlite'))
    try {
      const stored = JSON.parse(
        (db.prepare('SELECT data FROM edits WHERE id=?').get(photoId) as { data: string }).data,
      )
      for (const settings of [
        stored.settings,
        ...stored.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
      ]) {
        settings.version = 13
        for (const mask of settings.maskStack) {
          delete mask.edge
          delete mask.color
          delete mask.operands
          delete mask.resultHead
        }
      }
      db.prepare('UPDATE edits SET data=? WHERE id=?').run(JSON.stringify(stored), photoId)
      db.exec('DROP TABLE mask_base_content; PRAGMA user_version=23')
      const chunks = db.prepare('SELECT * FROM mask_content ORDER BY hash').all()
      await fixture.restart()
      expect(await fixture.library.getEditHistory(photoId)).toEqual(expected)
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({
        user_version: CATALOG_VERSION,
      })
      expect(db.prepare('SELECT * FROM mask_content ORDER BY hash').all()).toEqual(chunks)
      fixture.library.fullPreviews.validateMaskEdit = async () => {}
      const redone = await fixture.library.redoEdit(photoId, 3)
      expect(
        fixture.library
          .resolvedMasks(photoId, redone.settings.maskStack)[0]
          .strokes.map((stroke) => stroke.mode),
      ).toEqual(['add', 'subtract'])
      await fixture.library.close()
      const future = JSON.parse(
        (db.prepare('SELECT data FROM edits WHERE id=?').get(photoId) as { data: string }).data,
      )
      for (const settings of [
        future.settings,
        ...future.snapshots.map((snapshot: { settings: unknown }) => snapshot.settings),
      ]) {
        settings.version = 13
        for (const mask of settings.maskStack) {
          delete mask.edge
          delete mask.color
          delete mask.operands
          delete mask.resultHead
        }
      }
      future.settings.maskStack[0].base = { version: 1, hash: 'e'.repeat(64), width: 8, height: 6 }
      db.prepare('UPDATE edits SET data=? WHERE id=?').run(JSON.stringify(future), photoId)
      db.exec('PRAGMA user_version=23')
      const evidence = join(fixture.root, 'library', 'staging', 'must-survive-unsupported-startup')
      await mkdir(join(evidence, '..'), { recursive: true })
      await writeFile(evidence, 'preserved')
      const before = {
        schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
        edits: db.prepare('SELECT * FROM edits ORDER BY id').all(),
        chunks: db.prepare('SELECT * FROM mask_content ORDER BY hash').all(),
      }
      await expect(fixture.restart()).rejects.toThrow(/history format is unsupported/)
      expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(before.schema)
      expect(db.prepare('SELECT * FROM edits ORDER BY id').all()).toEqual(before.edits)
      expect(db.prepare('SELECT * FROM mask_content ORDER BY hash').all()).toEqual(before.chunks)
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 23 })
      expect(await readFile(evidence, 'utf8')).toBe('preserved')
      await fixture.originalsUnchanged()
    } finally {
      db.close()
    }
  } finally {
    await fixture.close()
  }
})

test('actual managed MCP delivers a native proposal and preserves manual edits through accept, refine, history and restart/export', async ({}, info) => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'irodori-object-selection-mcp-'))
  const path = resolve('tests/fixtures/photos/alpine-lake.jpg')
  const original = await readFile(path),
    photoId = hash(original)
  const metadataWorker = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const metadata = await metadataWorker.inspect(path, new AbortController().signal)
  await metadataWorker.close(true)
  const dimensions = await sharp(path).metadata()
  let inferenceCount = 0
  const createLibrary = () =>
    new PhotoLibrary(
      join(root, 'library'),
      {
        process: async () => {
          throw new Error('Unexpected import decoding.')
        },
        close: async () => {},
      },
      () => {},
      undefined,
      undefined,
      new PreviewProcess(resolve('out/main/preview-worker.js')),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ),
      new PreviewProcess(resolve('out/main/preview-worker.js')),
    )
  let library = createLibrary()
  let client: Client | undefined
  let endpoint: Awaited<ReturnType<typeof startEditorEndpoint>> | undefined
  let gate: AgentRequestGate | undefined
  const relocateSelectionWorkers = () => {
    const runtime = new ObjectSelectionProcess({
      workerPath: resolve('out/main/object-selection-worker.js'),
      modelDirectory: resolve('out/main/object-selection-model'),
    })
    // Direct-TS fixtures relocate actual bundled workers; source preparation and inference are real.
    const dependencies = library.objectSelections as unknown as {
      runtime: Pick<ObjectSelectionProcess, 'run' | 'close'>
      decoder: PreviewProcess
    }
    dependencies.runtime = {
      run: (...args) => {
        inferenceCount++
        return runtime.run(...args)
      },
      close: () => runtime.close(),
    }
    dependencies.decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
  }
  try {
    await library.open()
    library.cropAdmission = async () => cropAdmission()
    relocateSelectionWorkers()
    const directory = join(root, 'library', 'originals', photoId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'original.jpg'), original)
    await library.catalogCommands.command({
      operation: 'original.publish',
      payload: {
        photo: {
          id: photoId,
          filename: 'alpine-lake.jpg',
          format: 'JPEG',
          width: dimensions.width!,
          height: dimensions.height!,
          bytes: original.length,
          importedAt: '2026-11-08T00:00:00Z',
          previewSource: 'image',
          thumbnailUrl: '',
          previewUrl: '',
        },
        metadata,
        processingIdentity: 'display-referred-v1',
        createdAt: '2026-11-08T00:00:00Z',
      },
    })
    const snapshot: EditorContextSnapshot = {
      workspace: 'editor',
      activePhotoId: photoId,
      selectedIds: [],
      transient: { crop: false, saving: false },
    }
    gate = new AgentRequestGate(
      async () => snapshot,
      async (id) => (await library.getEdits(id)).revision,
      false,
    )
    const token = randomBytes(32).toString('hex')
    endpoint = await startEditorEndpoint(root, library, undefined, {
      agentGate: (supplied) => (supplied === token ? gate : undefined),
    })
    client = new Client({ name: 'object-selection-native-acceptance', version: '1' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('out/main/editor-mcp.js')],
        env: {
          ...(process.env as Record<string, string>),
          IRODORI_AGENT_CONNECTION: JSON.stringify(endpoint.agentConnection(token)),
        },
      }),
    )
    const turn = await gate.begin('00000000-0000-0000-0000-000000000001', 'object-selection')
    const raw = (name: string, args: Record<string, unknown> = {}) =>
      client!.callTool({ name, arguments: { requestId: turn.requestId, ...args } }, undefined, {
        timeout: 120_000,
      })
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await raw(name, args)
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return result.structuredContent as unknown as T
    }
    for (const name of [
      'irodori_get_object_selection_context',
      'irodori_create_object_selection',
      'irodori_accept_object_selection',
      'irodori_cancel_object_selection',
    ])
      expect(
        (await client.listTools()).tools.find((tool) => tool.name === name)?.inputSchema.required,
      ).toContain('requestId')
    await call('irodori_update_edits', {
      photoId,
      expectedRevision: 0,
      patch: { crop: { ...identityCrop, width: 0.8 } },
    })
    type Context = Omit<ObjectSelectionContext, 'geometry'> & {
      canonicalWidth: number
      canonicalHeight: number
      box: [number, number, number, number]
      points: { x: number; y: number }[]
    }
    const context = await call<Context>('irodori_get_object_selection_context', {
      photoId,
      expectedRevision: 1,
      box: [0.2, 0.15, 0.85, 0.8],
      points: [{ x: 0.5, y: 0.5 }],
    })
    expect(context.canonicalWidth).toBe(dimensions.width)
    expect(context.canonicalHeight).toBe(dimensions.height)
    expect(context.width).toBeLessThan(context.canonicalWidth)
    const cropLeft = (context.canonicalWidth - context.width) / 2
    const cropTop = (context.canonicalHeight - context.height) / 2
    const expectedBox = [
      (cropLeft + 0.2 * context.width - 1) / context.canonicalWidth,
      (cropTop + 0.15 * context.height - 1) / context.canonicalHeight,
      (cropLeft + 0.85 * context.width + 1) / context.canonicalWidth,
      (cropTop + 0.8 * context.height + 1) / context.canonicalHeight,
    ]
    // The segmentation guide encloses the mapped perimeter plus one canonical native pixel.
    for (let index = 0; index < 4; index++)
      expect(context.box[index]).toBeCloseTo(expectedBox[index], 12)
    expect(context.points[0]).toEqual({ x: 0.5, y: 0.5 })
    expect(JSON.stringify(context)).not.toMatch(/"(?:path|geometry|correction|distortion)":/)
    type Proposal = {
      id: string
      photoId: string
      revision: number
      gridIdentity: string
      width: number
      height: number
      mimeType: string
      mask: {
        id: string
        head: string | null
        light: Record<string, number>
        base: { hash: string }
      }
      manualStrokeCount: number
    }
    const generate = async (revision: number, gridIdentity: string, maskId?: string) => {
      const result = await raw('irodori_create_object_selection', {
        photoId,
        expectedRevision: revision,
        gridIdentity,
        prompts: {
          box: context.box,
          positivePoints: maskId ? [[context.points[0].x, context.points[0].y]] : [],
          negativePoints: maskId ? [[0.1, 0.1]] : [],
        },
        ...(maskId ? { maskId } : {}),
      })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const proposal = result.structuredContent as unknown as Proposal
      const image = (result.content as { type: string; data?: string; mimeType?: string }[]).find(
        (block) => block.type === 'image',
      ) as {
        type: 'image'
        data: string
        mimeType: string
      }
      expect(image?.mimeType).toBe('image/png')
      expect(proposal).toMatchObject({
        photoId,
        revision,
        width: dimensions.width,
        height: dimensions.height,
        mimeType: 'image/png',
      })
      const bytes = Buffer.from(image.data, 'base64')
      expect(await sharp(bytes).metadata()).toMatchObject({
        format: 'png',
        channels: 1,
        width: dimensions.width,
        height: dimensions.height,
      })
      expect(hash(bytes)).toBe(proposal.mask.base.hash)
      expect(JSON.stringify(proposal)).not.toMatch(/pngBase64|"data"|"strokes"|"path"/)
      return proposal
    }
    const proposal = await generate(1, context.gridIdentity)
    expect((await library.getEdits(photoId)).revision).toBe(1)
    expect((await library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const foreign = await raw('irodori_accept_object_selection', {
      photoId,
      expectedRevision: 1,
      proposalId: randomUUID(),
    })
    expect(foreign.isError).toBe(true)
    expect(JSON.stringify(foreign.content)).toContain('current request')
    const accepted = await call<EditState>('irodori_accept_object_selection', {
      photoId,
      expectedRevision: 1,
      proposalId: proposal.id,
    })
    expect(accepted.revision).toBe(2)
    expect(accepted.maskBases).toBeUndefined()
    const maskId = proposal.mask.id
    const manual = await call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 2,
      maskMutation: {
        operations: [
          {
            kind: 'stroke',
            id: maskId,
            stroke: { mode: 'add', radius: 0.01, feather: 0.5, points: [{ x: 0.5, y: 0.5 }] },
          },
          {
            kind: 'stroke',
            id: maskId,
            stroke: { mode: 'subtract', radius: 0.006, feather: 0.3, points: [{ x: 0.6, y: 0.6 }] },
          },
          {
            kind: 'update',
            id: maskId,
            name: 'Boat repaired manually',
            light: { exposureEv: 0.35, shadows: 7 },
          },
        ],
      },
    })
    const before = library.resolvedMasks(
      photoId,
      (await library.getEdits(photoId)).settings.maskStack,
    )[0]
    const refreshed = await call<Context>('irodori_get_object_selection_context', {
      photoId,
      expectedRevision: 3,
    })
    const refined = await generate(3, refreshed.gridIdentity, maskId)
    expect(refined.manualStrokeCount).toBe(2)
    expect(refined.mask).toMatchObject({
      id: maskId,
      head: manual.settings.maskStack[0].head,
      light: manual.settings.maskStack[0].light,
    })
    await call('irodori_accept_object_selection', {
      photoId,
      expectedRevision: 3,
      proposalId: refined.id,
    })
    const after = library.resolvedMasks(
      photoId,
      (await library.getEdits(photoId)).settings.maskStack,
    )[0]
    expect(after.strokes).toEqual(before.strokes)
    expect(after.resultStrokes).toEqual(before.resultStrokes)
    expect(after.resultStrokes).toHaveLength(2)
    expect(after.light).toEqual(before.light)
    expect(after.head).toBe(before.head)
    await call('irodori_undo_edit', { photoId, expectedRevision: 4 })
    expect((await library.getEdits(photoId)).settings.maskStack).toEqual(manual.settings.maskStack)
    await call('irodori_redo_edit', { photoId, expectedRevision: 5 })
    const confirmed = await library.getEdits(photoId)
    expect(confirmed.settings.maskStack[0].base?.hash).toBe(refined.mask.base.hash)
    await call('irodori_cancel_object_selection', { photoId })
    expect((await library.getEdits(photoId)).settings).toEqual(confirmed.settings)
    gate.stop()
    await gate.settled()
    await client.close()
    client = undefined
    await endpoint.close()
    endpoint = undefined
    await library.close()
    library = createLibrary()
    await library.open()
    library.cropAdmission = async () => cropAdmission()
    ;(
      library.objectSelections as unknown as {
        runtime: { run: () => Promise<never>; close: () => Promise<void> }
      }
    ).runtime = {
      run: async () => {
        throw new Error('Restart/proof must never run the model.')
      },
      close: async () => {},
    }
    const restarted = await library.getEdits(photoId)
    expect(restarted).toEqual(confirmed)
    expect(library.resolvedMasks(photoId, restarted.settings.maskStack)[0]).toEqual(after)
    expect(inferenceCount).toBe(2)
    const preparation = await library.exports.prepare([photoId])
    const sourceLease = library.exports.acquireProofSource(preparation.id, photoId)
    const frozen = sourceLease.source
    sourceLease.release()
    library.exports.dispose(preparation.id)
    const proof = await proofFixture({ source: frozen, real: true })
    try {
      const options = {
        ...structuredClone(defaultExportOptions),
        output: 'sdr' as const,
        quality: 100,
      }
      const decoded = await proof.proofs.request('object-selection-mcp', {
        ...proof.request(),
        options,
      })
      const lease = proof.proofs.acquire(new URL(decoded.primary.url))!
      const reference = await readFile(lease.path)
      lease.release()
      const exportDirectory = info.outputPath('frozen-generated-mask')
      await mkdir(exportDirectory, { recursive: true })
      const admission = cropAdmission()
      const exported = await new ExportProcess(
        resolve('out/main/export-worker.js'),
        resolve('out/main/preview-worker.js'),
      ).render(
        {
          source: frozen,
          options,
          hdr: false,
          directory: exportDirectory,
          cropPolicy: decoded.pipeline.crop,
          detailPolicy: decoded.pipeline.detail,
          resizePolicy: decoded.pipeline.resize,
          outputSharpeningPolicy: decoded.pipeline.outputSharpening,
          cropAdmission: admission,
          detailAdmission: admission,
          resizeAdmission: admission,
          outputSharpeningAdmission: admission,
        },
        new AbortController().signal,
      )
      const pixels = await sharp(exported.path).toColourspace('srgb').ensureAlpha().raw().toBuffer()
      expect(pixels.length).toBe(reference.length)
      let maximum = 0
      for (let index = 0; index < pixels.length; index++)
        maximum = Math.max(maximum, Math.abs(pixels[index] - reference[index]))
      expect(maximum).toBeLessThanOrEqual(2)
      expect(exported.diagnostics?.renderer).toBe('gpu')
      expect(inferenceCount).toBe(2)
      await proof.proofs.release('object-selection-mcp', decoded.id)
    } finally {
      await proof.close()
    }
    expect(await readFile(join(directory, 'original.jpg'))).toEqual(original)
    expect(await readFile(path)).toEqual(original)
  } finally {
    gate?.stop()
    await gate?.settled()
    await client?.close()
    await endpoint?.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})
