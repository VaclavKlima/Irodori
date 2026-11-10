/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { ExportProcess } from '../src/main/export/process'
import { ObjectSelectionProcess } from '../src/main/object-selection/process'
import { MaskEdgeProcess } from '../src/main/mask-edges/process'
import { OutputProofs } from '../src/main/export/proofs'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { cropAdmission } from './crop-frame.helpers'
import { hdrJpegFixture } from './hdr-jpeg.helpers'
import { defaultExportOptions } from '../src/shared/export'
import type { EditState } from '../src/shared/edits'
import type { EditorContextSnapshot } from '../src/shared/agent'
import type { InspectionResult } from '../src/shared/inspection'
import type { OutputProofInspection } from '../src/shared/export-proof'
import type { ObjectSelectionContext } from '../src/shared/object-selection'
import type { MaskEdgeSettings, MaskDescriptor } from '../src/shared/masks'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const renderer = () =>
  new ExportProcess(resolve('out/main/export-worker.js'), resolve('out/main/preview-worker.js'))
type ImageBlock = { type: string; data?: string; mimeType?: string }

async function fixture(input: string, root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'irodori-mask-edge-mcp-'))
  const bytes = await readFile(input),
    photoId = hash(bytes)
  const inspector = new PreviewProcess(resolve('out/main/preview-worker.js'))
  const metadata = await inspector.inspect(input, new AbortController().signal)
  await inspector.close(true)
  const dimensions = await sharp(input).metadata()
  const createLibrary = () =>
    new PhotoLibrary(
      join(root!, 'library'),
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
      renderer(),
      new PreviewProcess(resolve('out/main/preview-worker.js')),
    )
  let library = createLibrary(),
    endpoint: Awaited<ReturnType<typeof startEditorEndpoint>> | undefined,
    gate: AgentRequestGate | undefined,
    client: Client | undefined,
    requestId = '',
    modelRuns = 0
  const relocate = () => {
    library.cropAdmission = async () => cropAdmission()
    library.fullPreviews.installCropAdmission(async () => cropAdmission())
    ;(library.maskEdges as unknown as { runtime: MaskEdgeProcess }).runtime = new MaskEdgeProcess({
      workerPath: resolve('out/main/mask-edge-worker.js'),
    })
    const selection = new ObjectSelectionProcess({
      workerPath: resolve('out/main/object-selection-worker.js'),
      modelDirectory: resolve('out/main/object-selection-model'),
    })
    const selectionOwner = library.objectSelections as unknown as {
      runtime: Pick<ObjectSelectionProcess, 'run' | 'close'>
      decoder: PreviewProcess
    }
    selectionOwner.runtime = {
      run: (...args) => {
        modelRuns++
        return selection.run(...args)
      },
      close: () => selection.close(),
    }
    selectionOwner.decoder = new PreviewProcess(resolve('out/main/preview-worker.js'))
    ;(library.agentPreviews as unknown as { renderer: ExportProcess }).renderer = renderer()
    ;(library.outputProofs as unknown as { renderer: ExportProcess }).renderer = renderer()
    ;(
      library.outputProofs as unknown as {
        decode: NonNullable<ConstructorParameters<typeof OutputProofs>[7]>
      }
    ).decode = async (path, directory, job, signal) => {
      const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
      try {
        return await worker.decodeOutputProof(path, directory, job, signal)
      } finally {
        await worker.close(true)
      }
    }
  }
  const connect = async () => {
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
    endpoint = await startEditorEndpoint(root!, library, undefined, {
      agentGate: (supplied) => (supplied === token ? gate : undefined),
    })
    client = new Client({ name: 'mask-edge-managed-acceptance', version: '1' })
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
    requestId = (await gate.begin(randomUUID(), 'mask-edge-acceptance')).requestId
  }
  const disconnect = async () => {
    gate?.stop()
    await gate?.settled()
    await client?.close()
    await endpoint?.close()
    gate = undefined
    client = undefined
    endpoint = undefined
  }
  await library.open()
  relocate()
  const originalDirectory = join(root, 'library', 'originals', photoId)
  await mkdir(originalDirectory, { recursive: true })
  await writeFile(join(originalDirectory, 'original.jpg'), bytes)
  await library.catalogCommands.command({
    operation: 'original.publish',
    payload: {
      photo: {
        id: photoId,
        filename: 'mask-edge-input.jpg',
        format: 'JPEG',
        width: dimensions.width!,
        height: dimensions.height!,
        bytes: bytes.length,
        importedAt: '2026-11-08T00:00:00Z',
        previewSource: 'image',
        thumbnailUrl: '',
        previewUrl: '',
      },
      metadata,
      processingIdentity:
        metadata.hdrJpeg?.state === 'supported' ? 'hdr-v1' : 'display-referred-v1',
      createdAt: '2026-11-08T00:00:00Z',
    },
  })
  // Real canonical preparation also supplies the reusable working lease. Direct-TS
  // fixtures must not reach an unbundled default decoder through cold inspection.
  await library.getMaskContext(photoId, 0)
  await connect()
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client!.callTool({ name, arguments: { requestId, ...args } }, undefined, { timeout: 120000 })
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await raw(name, args)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return result.structuredContent as unknown as T
  }
  return {
    root,
    photoId,
    width: dimensions.width!,
    height: dimensions.height!,
    raw,
    call,
    get library() {
      return library
    },
    get modelRuns() {
      return modelRuns
    },
    get client() {
      return client!
    },
    async restart() {
      await disconnect()
      await library.close()
      library = createLibrary()
      await library.open()
      relocate()
      await connect()
    },
    async close() {
      await disconnect()
      await library.close()
      expect(await readFile(join(originalDirectory, 'original.jpg'))).toEqual(bytes)
      expect(await readFile(input)).toEqual(bytes)
      await rm(root!, { recursive: true, force: true })
    },
  }
}
const images = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as ImageBlock[]).filter((block) => block.type === 'image')
const pixels = (block: ImageBlock) =>
  sharp(Buffer.from(block.data!, 'base64')).toColourspace('srgb').ensureAlpha().raw().toBuffer()

async function createMask(f: Awaited<ReturnType<typeof fixture>>, edge: MaskEdgeSettings) {
  const id = randomUUID()
  const state = await f.call<EditState>('irodori_mutate_masks', {
    photoId: f.photoId,
    expectedRevision: 0,
    maskMutation: {
      operations: [
        { kind: 'create', id, name: 'Edge-corrected object' },
        {
          kind: 'stroke',
          id,
          stroke: {
            mode: 'add',
            radius: 0.08,
            feather: 0.4,
            points: [
              { x: 0.45, y: 0.4 },
              { x: 0.55, y: 0.6 },
            ],
          },
        },
        {
          kind: 'stroke',
          id,
          stroke: { mode: 'subtract', radius: 0.01, feather: 0.2, points: [{ x: 0.6, y: 0.6 }] },
        },
        { kind: 'update', id, edge, light: { exposureEv: 0.35, shadows: 7 } },
      ],
    },
  })
  return { id, state }
}

test('managed MCP exposes edge settings, refuses stale/invalid edits and preserves corrections through AI refinement and restart', async () => {
  test.setTimeout(180000)
  const f = await fixture(resolve('tests/fixtures/photos/alpine-lake.jpg'))
  try {
    const capabilities = await f.call<{
      masks: { edge: { order: string; featherPx: { max: number }; automaticMatting: boolean } }
    }>('irodori_get_edit_capabilities')
    expect(capabilities.masks.edge).toMatchObject({
      order: 'base-or-gradient-brush-invert-shift-feather',
      featherPx: { max: 64 },
      automaticMatting: false,
    })
    const registration = (await f.client.listTools()).tools.find(
      (tool) => tool.name === 'irodori_mutate_masks',
    )!
    expect(JSON.stringify(registration.inputSchema)).toContain('featherPx')
    const before = await f.raw('irodori_get_photo_preview', {
      photoId: f.photoId,
      expectedRevision: 0,
      inspection: { resolutionPercent: 25, encoding: { format: 'png' } },
    })
    expect(before.isError, JSON.stringify(before.content)).not.toBe(true)
    const { id, state } = await createMask(f, { featherPx: 4.5, shiftPx: -1 })
    expect(state.settings.maskStack[0].edge).toEqual({ featherPx: 4.5, shiftPx: -1 })
    expect(state.maskBases).toBeUndefined()
    expect(state.maskContent).toBeUndefined()
    const saved = await f.library.getEditHistory(f.photoId)
    for (const [revision, edge] of [
      [0, { featherPx: 1 }],
      [1, { featherPx: 65 }],
      [1, { shiftPx: 1.5 }],
    ] as const) {
      const refusal = await f.raw('irodori_mutate_masks', {
        photoId: f.photoId,
        expectedRevision: revision,
        maskMutation: { operations: [{ kind: 'update', id, edge }] },
      })
      expect(refusal.isError).toBe(true)
      expect(await f.library.getEditHistory(f.photoId)).toEqual(saved)
    }
    const pair = await f.raw('irodori_get_photo_preview', {
      photoId: f.photoId,
      expectedRevision: 1,
      inspection: { resolutionPercent: 25, encoding: { format: 'png' }, comparison: 'pair' },
    })
    expect(pair.isError, JSON.stringify(pair.content)).not.toBe(true)
    const paired = pair.structuredContent as unknown as InspectionResult
    expect(paired.members.map((member) => member.label)).toEqual(['before', 'after'])
    const blocks = images(pair)
    expect(blocks).toHaveLength(2)
    expect(await pixels(blocks[0])).toEqual(await pixels(images(before)[0]))
    expect(await pixels(blocks[1])).not.toEqual(await pixels(blocks[0]))
    const context = await f.call<Omit<ObjectSelectionContext, 'geometry'>>(
      'irodori_get_object_selection_context',
      { photoId: f.photoId, expectedRevision: 1 },
    )
    const generated = await f.raw('irodori_create_object_selection', {
      photoId: f.photoId,
      expectedRevision: 1,
      gridIdentity: context.gridIdentity,
      maskId: id,
      prompts: { box: [0.2, 0.15, 0.85, 0.8], positivePoints: [[0.5, 0.5]], negativePoints: [] },
    })
    expect(generated.isError, JSON.stringify(generated.content)).not.toBe(true)
    const proposal = generated.structuredContent as unknown as {
      id: string
      mask: MaskDescriptor
      manualStrokeCount: number
    }
    expect(proposal.mask.edge).toEqual(state.settings.maskStack[0].edge)
    expect(proposal.mask.head).toBe(state.settings.maskStack[0].head)
    expect(proposal.manualStrokeCount).toBe(2)
    const accepted = await f.call<EditState>('irodori_accept_object_selection', {
      photoId: f.photoId,
      expectedRevision: 1,
      proposalId: proposal.id,
    })
    expect(accepted.settings.maskStack[0]).toMatchObject({
      edge: state.settings.maskStack[0].edge,
      head: state.settings.maskStack[0].head,
      light: state.settings.maskStack[0].light,
    })
    expect(f.modelRuns).toBe(1)
    await f.call('irodori_undo_edit', { photoId: f.photoId, expectedRevision: 2 })
    expect((await f.library.getEdits(f.photoId)).settings.maskStack).toEqual(
      state.settings.maskStack,
    )
    await f.call('irodori_redo_edit', { photoId: f.photoId, expectedRevision: 3 })
    const confirmed = await f.library.getEdits(f.photoId)
    await f.restart()
    expect(await f.library.getEdits(f.photoId)).toEqual(confirmed)
    expect(f.modelRuns).toBe(1)
    const read = await f.call<EditState>('irodori_get_edits', { photoId: f.photoId })
    expect(read.settings.maskStack[0].edge).toEqual(state.settings.maskStack[0].edge)
    expect(JSON.stringify(read)).not.toMatch(/preparedCoverage|pngBase64|"path"/)
  } finally {
    await f.close()
  }
})

for (const kind of ['raster', 'authored-hdr'] as const)
  test(`${kind}: actual MCP decoded output proof agrees with a frozen edge-aware GPU export`, async ({}, info) => {
    test.setTimeout(120000)
    const root = await mkdtemp(join(tmpdir(), 'irodori-mask-edge-output-'))
    const input =
      kind === 'raster'
        ? resolve('tests/fixtures/photos/alpine-lake.jpg')
        : (await hdrJpegFixture(root)).path
    const f = await fixture(input, root)
    try {
      const { id, state } = await createMask(f, { featherPx: 3.5, shiftPx: 1 })
      const prepared = await f.call<{ id: string }>('irodori_prepare_export', { ids: [f.photoId] })
      const sourceLease = f.library.exports.acquireProofSource(prepared.id, f.photoId)
      const frozen = structuredClone(sourceLease.source)
      sourceLease.release()
      const options = {
        ...structuredClone(defaultExportOptions),
        output: kind === 'raster' ? ('sdr' as const) : ('hdr' as const),
        quality: 100,
      }
      const result = await f.raw('irodori_get_output_proof', {
        photoId: f.photoId,
        preparationId: prepared.id,
        proofToken: randomUUID(),
        options,
        inspection: { resolutionPercent: 100, encoding: { format: 'png' } },
      })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const proof = result.structuredContent as unknown as OutputProofInspection
      expect(proof.export.output).toBe(options.output)
      expect(proof.members[0]).toMatchObject({
        revision: 1,
        effectiveRendition: 'sdr',
        sourceDynamicRange: kind === 'raster' ? 'sdr' : 'hdr',
      })
      expect(images(result)).toHaveLength(1)
      const reference = await pixels(images(result)[0])
      await f.call('irodori_mutate_masks', {
        photoId: f.photoId,
        expectedRevision: 1,
        maskMutation: { operations: [{ kind: 'update', id, edge: { featherPx: 0, shiftPx: 0 } }] },
      })
      expect(frozen.processing.adjustments?.localMasks?.[0].edge).toEqual(
        state.settings.maskStack[0].edge,
      )
      const directory = info.outputPath('frozen-export')
      await mkdir(directory, { recursive: true })
      const admission = cropAdmission()
      const exported = await renderer().render(
        {
          source: frozen,
          options,
          hdr: options.output === 'hdr',
          directory,
          cropPolicy: proof.export.pipeline.crop,
          detailPolicy: proof.export.pipeline.detail,
          resizePolicy: proof.export.pipeline.resize,
          outputSharpeningPolicy: proof.export.pipeline.outputSharpening,
          cropAdmission: admission,
          detailAdmission: admission,
          resizeAdmission: admission,
          outputSharpeningAdmission: admission,
        },
        new AbortController().signal,
      )
      const decoded = await sharp(exported.path)
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer()
      expect(decoded.length).toBe(reference.length)
      let maximum = 0
      for (let index = 0; index < decoded.length; index++)
        maximum = Math.max(maximum, Math.abs(decoded[index] - reference[index]))
      expect(maximum).toBeLessThanOrEqual(2)
      expect(exported.diagnostics?.renderer).toBe('gpu')
      expect(f.modelRuns).toBe(0)
      await info.attach('frozen-edge-output', {
        contentType: 'application/json',
        body: JSON.stringify({
          kind,
          output: options.output,
          width: proof.export.width,
          height: proof.export.height,
          edge: state.settings.maskStack[0].edge,
          maximumCodeDifference: maximum,
          adapter: exported.diagnostics?.adapter,
        }),
      })
    } finally {
      await f.close()
    }
  })
