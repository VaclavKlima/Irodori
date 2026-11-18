import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { transferFixture } from './edit-transfer.helpers'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { agentInstructions } from '../src/main/agent/policy'
import type { EditCheckpoint } from '../src/shared/edit-checkpoints'
import type {
  EditComparisonSession,
  PrepareEditComparisonRequest,
} from '../src/shared/edit-comparisons'
import { inspectionHdrCapability } from '../src/shared/inspection'
import type { PhotoLibrary } from '../src/main/library'

// Real catalog mutations; comparison image stand-ins isolate transport, schemas and request ownership.
// Numerical/native comparison fidelity is covered by the comparison rendering targets.
for (const managed of [false, true])
  test(`${managed ? 'Console' : 'external MCP'} checkpoints preserve history and deliver identified pairs`, async () => {
    const f = await transferFixture(2)
    const photoId = f.ids[0],
      sessions = new Map<string, EditComparisonSession>()
    const data = (
      await sharp({ create: { width: 8, height: 6, channels: 3, background: '#507080' } })
        .png()
        .toBuffer()
    ).toString('base64')
    const disposed: string[] = []
    const comparison = {
      async prepare(request: PrepareEditComparisonRequest) {
        const edits = await f.library.getEdits(request.photoId)
        const members = (await Promise.all(
          [request.baseline, request.target].map(async (source) => {
            const checkpoint =
              source.kind === 'checkpoint'
                ? await f.library.getEditCheckpoint(request.photoId, source.checkpointId)
                : undefined
            if (source.kind === 'current' && source.expectedRevision !== edits.revision)
              throw new Error('Current edits changed.')
            if (
              source.kind === 'checkpoint' &&
              checkpoint!.revision !== source.expectedCheckpointRevision
            )
              throw new Error('Checkpoint changed.')
            return {
              source,
              label: checkpoint?.name ?? 'Current edits',
              identity: checkpoint?.id ?? `current-${edits.revision}`,
              capturedFromRevision: checkpoint?.capturedFromRevision ?? edits.revision,
            }
          }),
        )) as unknown as EditComparisonSession['members']
        const session = {
          id: request.requestId,
          photoId: request.photoId,
          members,
          context: {
            photoId: request.photoId,
            revision: edits.revision,
            width: 8,
            height: 6,
            gridIdentity: 'b'.repeat(64),
            geometry: { privateRendererMapping: true },
            hdr: inspectionHdrCapability,
          },
        } as unknown as EditComparisonSession
        sessions.set(session.id, session)
        return session
      },
      async inspect(id: string, sessionId: string, inspection: { hdr?: boolean }) {
        const session = sessions.get(sessionId)
        if (!session || session.photoId !== id) throw new Error('Comparison unavailable.')
        if (inspection.hdr) throw new Error(inspectionHdrCapability.reason)
        return {
          photoId: id,
          sessionId,
          gridIdentity: session.context.gridIdentity,
          members: session.members.map((version, index) => ({
            label: index === 0 ? 'a' : 'b',
            version,
            revision: version.capturedFromRevision,
            gridIdentity: session.context.gridIdentity,
            width: 8,
            height: 6,
            photoBounds: { x: 0, y: 0, width: 8, height: 6 },
            bounds: { x: 0, y: 0, width: 8, height: 6 },
            native: 'photo-native',
            effectiveRendition: 'sdr',
            encoding: { format: 'png', lossless: true },
            mimeType: 'image/png',
            byteLength: Buffer.from(data, 'base64').length,
            data,
          })),
        }
      },
      async dispose(id: string, sessionId: string) {
        const session = sessions.get(sessionId)
        if (session && session.photoId !== id) throw new Error('Comparison photograph mismatch.')
        sessions.delete(sessionId)
        disposed.push(sessionId)
      },
    }
    const library = new Proxy(f.library, {
      get(target, key) {
        if (key === 'editComparisons') return comparison
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as PhotoLibrary
    const gate = new AgentRequestGate(
      async () => ({
        workspace: 'editor',
        activePhotoId: photoId,
        selectedIds: [],
        transient: { crop: false, saving: false },
      }),
      async (id) => (await f.library.getEdits(id)).revision,
      false,
    )
    const token = 'c'.repeat(64)
    const endpoint = await startEditorEndpoint(f.root, library, undefined, {
      agentGate: (supplied) => (supplied === token ? gate : undefined),
    })
    const request = managed ? await gate.begin(crypto.randomUUID(), 'versions') : undefined
    const client = new Client({ name: 'checkpoint-transport', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        IRODORI_PROFILE: f.root,
        ...(managed
          ? { IRODORI_AGENT_CONNECTION: JSON.stringify(endpoint.agentConnection(token)) }
          : {}),
      },
    })
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({
        name,
        arguments: { ...args, ...(request ? { requestId: request.requestId } : {}) },
      })
    try {
      await client.connect(transport)
      const tools = (await client.listTools()).tools
      const sourceSchema = tools.find(
        (tool) => tool.name === 'irodori_prepare_edit_comparison',
      )!.inputSchema
      const validator = new AjvJsonSchemaValidator().getValidator(sourceSchema as JsonSchemaType)
      const valid = {
        photoId,
        baseline: { kind: 'current', expectedRevision: 0 },
        target: { kind: 'current', expectedRevision: 0 },
        ...(request ? { requestId: request.requestId } : {}),
      }
      expect(validator(valid).valid).toBe(true)
      expect(validator({ ...valid, baseline: { kind: 'checkpoint' } }).valid).toBe(false)
      expect(
        validator({
          ...valid,
          target: { kind: 'current', expectedRevision: 0, checkpointId: crypto.randomUUID() },
        }).valid,
      ).toBe(false)
      const before = await f.library.getEditHistory(photoId)
      const saved = await call('irodori_create_edit_checkpoint', {
        photoId,
        name: 'Natural',
        expectedRevision: 0,
      })
      expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
      const natural = saved.structuredContent as unknown as EditCheckpoint
      expect(await f.library.getEditHistory(photoId)).toEqual(before)
      if (managed) expect(gate.context().active!.revision).toBe(0)
      const changed = await call('irodori_update_edits', {
        photoId,
        expectedRevision: 0,
        patch: { exposureEv: 0.75, detailSharpening: { amount: 25 } },
      })
      expect(changed.isError, JSON.stringify(changed.content)).not.toBe(true)
      const renamed = await call('irodori_rename_edit_checkpoint', {
        photoId,
        checkpointId: natural.id,
        expectedCheckpointRevision: 1,
        name: 'Natural first pass',
      })
      expect(renamed.isError).not.toBe(true)
      if (managed) expect(gate.context().active!.revision).toBe(1)
      const listed = await call('irodori_list_edit_checkpoints', { photoId })
      expect((listed.structuredContent as { total: number }).total).toBe(1)
      const frozenHistory = await f.library.getEditHistory(photoId)
      const prepared = await call('irodori_prepare_edit_comparison', {
        photoId,
        baseline: { kind: 'checkpoint', checkpointId: natural.id, expectedCheckpointRevision: 2 },
        target: { kind: 'current', expectedRevision: 1 },
      })
      expect(prepared.isError, JSON.stringify(prepared.content)).not.toBe(true)
      const session = prepared.structuredContent as unknown as EditComparisonSession
      expect(JSON.stringify(session)).not.toContain('privateRendererMapping')
      const images = await call('irodori_get_edit_comparison_preview', {
        photoId,
        comparisonId: session.id,
        inspection: { resolutionPercent: 100, encoding: { format: 'png' } },
      })
      expect(images.isError, JSON.stringify(images.content)).not.toBe(true)
      expect(
        (images.content as { type: string }[]).filter((block) => block.type === 'image'),
      ).toHaveLength(2)
      expect(
        (
          images.structuredContent as { members: { label: string; version: { label: string } }[] }
        ).members.map((member) => [member.label, member.version.label]),
      ).toEqual([
        ['a', 'Natural first pass'],
        ['b', 'Current edits'],
      ])
      expect(JSON.stringify(images.structuredContent)).not.toContain(data)
      expect(await f.library.getEditHistory(photoId)).toEqual(frozenHistory)
      expect(
        (
          await call('irodori_get_edit_comparison_preview', {
            photoId,
            comparisonId: session.id,
            inspection: { hdr: true },
          })
        ).isError,
      ).toBe(true)
      expect(
        (
          await call('irodori_get_edit_comparison_preview', {
            photoId: f.ids[1],
            comparisonId: session.id,
          })
        ).isError,
      ).toBe(true)
      if (managed)
        expect(
          (
            await call('irodori_dispose_edit_comparison', {
              photoId,
              comparisonId: crypto.randomUUID(),
            })
          ).isError,
        ).toBe(true)
      const restored = await call('irodori_restore_edit_checkpoint', {
        photoId,
        checkpointId: natural.id,
        expectedCheckpointRevision: 2,
        expectedRevision: 1,
      })
      expect(restored.isError, JSON.stringify(restored.content)).not.toBe(true)
      expect(restored.structuredContent).not.toHaveProperty('maskContent')
      expect(restored.structuredContent).not.toHaveProperty('maskBases')
      expect((await f.library.getEdits(photoId)).settings).toEqual(before.settings)
      expect(
        (
          await call('irodori_delete_edit_checkpoint', {
            photoId,
            checkpointId: natural.id,
            expectedCheckpointRevision: 1,
          })
        ).isError,
      ).toBe(true)
      expect(
        (
          await call('irodori_delete_edit_checkpoint', {
            photoId,
            checkpointId: natural.id,
            expectedCheckpointRevision: 2,
          })
        ).isError,
      ).not.toBe(true)
      expect((await f.library.getEdits(photoId)).settings).toEqual(before.settings)
      if (managed) {
        gate.end()
        await expect.poll(() => disposed.includes(session.id)).toBe(true)
        const next = await gate.begin(crypto.randomUUID(), 'next')
        const stale = await client.callTool({
          name: 'irodori_get_edit_comparison_preview',
          arguments: { requestId: next.requestId, photoId, comparisonId: session.id },
        })
        expect(stale.isError).toBe(true)
      } else
        expect(
          (await call('irodori_dispose_edit_comparison', { photoId, comparisonId: session.id }))
            .isError,
        ).not.toBe(true)
      expect(agentInstructions(false)).toContain('Use checkpoint tools with inspection guidance')
      expect(agentInstructions(false)).toContain('preset or checkpoint is authorized only')
    } finally {
      gate.stop()
      await client.close()
      await endpoint.close()
      await f.close()
    }
  })

test('owned comparison cleanup remains available after manual conflicts pause the request', async () => {
  const photoId = 'a'.repeat(64),
    comparisonId = crypto.randomUUID()
  let revision = 0
  const gate = new AgentRequestGate(
    async () => ({
      workspace: 'editor',
      activePhotoId: photoId,
      selectedIds: [],
      transient: { crop: false, saving: false },
    }),
    async () => revision,
    false,
  )
  const { requestId } = await gate.begin(crypto.randomUUID(), 'cleanup')
  const args = { requestId, photoId, comparisonId }
  await gate.run('irodori_prepare_edit_comparison', { requestId, photoId }, async () => ({
    id: comparisonId,
    photoId,
  }))
  revision = 1
  await expect(
    gate.run('irodori_get_edit_comparison_preview', args, async () => ({})),
  ).rejects.toThrow('Revision conflict')
  await gate.run('irodori_get_edits', { requestId, photoId }, async () => ({ photoId, revision }))
  revision = 2
  await expect(
    gate.run('irodori_get_edit_comparison_preview', args, async () => ({})),
  ).rejects.toThrow('Paused')
  await expect(
    gate.run(
      'irodori_dispose_edit_comparison',
      { ...args, comparisonId: crypto.randomUUID() },
      async () => ({}),
    ),
  ).rejects.toThrow('does not belong')
  await expect(
    gate.run('irodori_dispose_edit_comparison', args, async () => ({ disposed: true })),
  ).resolves.toEqual({ disposed: true })
  gate.stop()
})
