import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { agentTools } from '../src/main/agent/policy'
import type { EditState } from '../src/shared/edits'
import type { EditorContextSnapshot } from '../src/shared/agent'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import type { MaskPoint } from '../src/shared/masks'
import { transferFixture } from './edit-transfer.helpers'

const session = '00000000-0000-0000-0000-000000000001'
interface MappedContext {
  photoId: string
  revision: number
  width: number
  height: number
  canonicalWidth: number
  canonicalHeight: number
  points: MaskPoint[]
  renderingIdentity: string
}

async function fixture() {
  const t = await transferFixture(2),
    snapshot: EditorContextSnapshot = {
      workspace: 'editor',
      activePhotoId: t.ids[0],
      selectedIds: [],
      transient: { crop: false, saving: false },
    },
    gate = new AgentRequestGate(
      async () => snapshot,
      async (id) => (await t.library.getEdits(id)).revision,
      false,
    ),
    token = randomBytes(32).toString('hex'),
    prepared = {
      ...identityMaskGeometry(8, 6),
      crop: cropGeometry({ width: 8, height: 6 }, { ...identityCrop, width: 0.5 }),
      correction: {
        width: 8,
        height: 6,
        left: 0,
        top: 0,
        distortion: Array.from({ length: 4096 }, () => 1),
      },
    }
  // This service target qualifies transport, authorization and persisted history.
  // Rendering targets qualify real source preparation and GPU geometry separately.
  t.library.fullPreviews.getMaskContext = async (photoId, revision) => {
    const state = await t.library.getEdits(photoId)
    if (state.revision !== revision) throw new Error('Mask context revision conflict.')
    return {
      photoId,
      revision,
      geometry: prepared,
      width: 4,
      height: 6,
      renderingIdentity: 'prepared-mask-context-fixture',
    }
  }
  t.library.fullPreviews.validateMaskEdit = async (id, revision) => {
    if ((await t.library.getEdits(id)).revision !== revision)
      throw new Error('Mask context revision conflict.')
  }
  const endpoint = await startEditorEndpoint(t.root, t.library, undefined, {
      agentGate: (supplied) => (supplied === token ? gate : undefined),
    }),
    client = new Client({ name: 'masks-managed-parity', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        IRODORI_AGENT_CONNECTION: JSON.stringify(endpoint.agentConnection(token)),
      },
    }),
    context = await gate.begin(session, 'mask-request')
  await client.connect(transport)
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: { requestId: context.requestId, ...args } })
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await raw(name, args)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return result.structuredContent as unknown as T
  }
  return {
    t,
    gate,
    snapshot,
    endpoint,
    token,
    context,
    client,
    raw,
    call,
    async close() {
      gate.stop()
      await gate.settled()
      await client.close()
      await endpoint.close()
      await t.close()
    },
  }
}

test('managed MCP maps bounded points, freezes targets and shares mask operations with the application API and history', async () => {
  const f = await fixture(),
    [photoId, otherId] = f.t.ids,
    a = randomUUID(),
    b = randomUUID()
  try {
    const tools = (await f.client.listTools()).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([...agentTools].sort())
    for (const name of ['irodori_get_mask_context', 'irodori_mutate_masks'])
      expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain('requestId')
    const mutationSchema = tools.find((tool) => tool.name === 'irodori_mutate_masks')!
      .inputSchema as unknown as {
      properties: {
        maskMutation: {
          properties: {
            operations: {
              items: {
                oneOf: {
                  properties: Record<string, { const?: string }>
                  required: string[]
                  additionalProperties: boolean
                }[]
              }
            }
          }
        }
      }
    }
    const duplicateSchema =
      mutationSchema.properties.maskMutation.properties.operations.items.oneOf.find(
        (operation) => operation.properties.kind.const === 'duplicate',
      )!
    expect(duplicateSchema.required).toEqual(['kind', 'id', 'newId', 'name'])
    expect(Object.keys(duplicateSchema.properties)).toEqual(['kind', 'id', 'newId', 'name'])
    expect(duplicateSchema.additionalProperties).toBe(false)
    f.snapshot.activePhotoId = otherId
    const frozen = await f.call<{ active: { photoId: string } }>('irodori_get_editor_context')
    expect(frozen.active.photoId).toBe(photoId)
    const outside = await f.raw('irodori_get_mask_context', {
      photoId: otherId,
      expectedRevision: 0,
    })
    expect(outside.isError).toBe(true)
    expect(JSON.stringify(outside.content)).toContain('frozen targets')
    const context = await f.call<MappedContext>('irodori_get_mask_context', {
      photoId,
      expectedRevision: 0,
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ],
    })
    expect(context).toMatchObject({
      photoId,
      revision: 0,
      width: 4,
      height: 6,
      canonicalWidth: 8,
      canonicalHeight: 6,
      points: [
        { x: 0.25, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 0.75, y: 1 },
      ],
    })
    for (const key of ['geometry', 'distortion', 'correction', 'path'])
      expect(JSON.stringify(context)).not.toContain(`"${key}"`)
    expect(JSON.stringify(context).length).toBeLessThan(1024)
    const first = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 0,
      maskMutation: {
        operations: [
          { kind: 'create', id: a, name: 'Trunk' },
          {
            kind: 'stroke',
            id: a,
            stroke: { mode: 'add', radius: 0.05, feather: 0.7, points: [context.points[1]] },
          },
          {
            kind: 'update',
            id: a,
            light: {
              exposureEv: 0.6,
              contrast: 5,
              highlights: -10,
              shadows: 15,
              whites: 2,
              blacks: -3,
            },
            color: { temperature: 14, tint: 3, saturation: -8 },
          },
          { kind: 'create', id: b, name: 'Reflection' },
          {
            kind: 'stroke',
            id: b,
            stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [context.points[0]] },
          },
          { kind: 'update', id: b, color: { temperature: -12, saturation: -15 } },
        ],
      },
    })
    expect(first.revision).toBe(1)
    expect(first.maskContent).toBeUndefined()
    expect(first.settings.maskStack.map((mask) => mask.id)).toEqual([b, a])
    expect(first.settings.maskStack[0].color).toEqual({
      temperature: -12,
      tint: 0,
      saturation: -15,
    })
    expect(first.settings.maskStack[1].color).toEqual({
      temperature: 14,
      tint: 3,
      saturation: -8,
    })
    const uiState = await f.t.library.getEdits(photoId)
    expect(uiState.settings).toEqual(first.settings)
    expect(uiState.maskContent).toHaveLength(2)
    expect(
      f.t.library.resolvedMasks(photoId, uiState.settings.maskStack)[1].strokes[0].points,
    ).toEqual([context.points[1]])
    expect((await f.t.library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const reordered = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 1,
      maskMutation: { operations: [{ kind: 'reorder', ids: [a, b] }] },
    })
    expect(reordered.settings.maskStack.map((mask) => mask.id)).toEqual([a, b])
    expect(reordered.maskContent).toBeUndefined()
    const global = await f.call<EditState>('irodori_update_edits', {
      photoId,
      expectedRevision: 2,
      patch: { exposureEv: 0.25 },
    })
    expect(global.revision).toBe(3)
    expect(global.maskContent).toBeUndefined()
    const undone = await f.call<EditState>('irodori_undo_edit', { photoId, expectedRevision: 3 })
    expect(undone.settings.maskStack).toEqual(reordered.settings.maskStack)
    expect(undone.settings.exposureEv).toBe(0)
    expect(undone.maskContent).toBeUndefined()
    const redone = await f.call<EditState>('irodori_redo_edit', { photoId, expectedRevision: 4 })
    expect(redone.settings).toEqual(global.settings)
    expect(redone.maskContent).toBeUndefined()
    const read = await f.call<EditState>('irodori_get_edits', { photoId })
    expect(read.maskContent).toBeUndefined()
    expect(read.settings).toEqual((await f.t.library.getEdits(photoId)).settings)
    expect(JSON.stringify(read)).not.toContain('"points"')
    expect((await f.t.library.getEdits(otherId)).revision).toBe(0)
    await f.t.originalsUnchanged()
  } finally {
    await f.close()
  }
})

test('local Color partial updates, validation and reset share manual history without changing global white balance', async () => {
  const f = await fixture(),
    photoId = f.t.ids[0],
    id = randomUUID()
  try {
    const before = await f.t.library.getEdits(photoId)
    const created = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: before.revision,
      maskMutation: { operations: [{ kind: 'create', id, name: 'Foliage' }] },
    })
    for (const color of [{ temperature: 101 }, { tint: 0.5 }, { kelvin: 5500 }]) {
      const refused = await f.raw('irodori_mutate_masks', {
        photoId,
        expectedRevision: created.revision,
        maskMutation: { operations: [{ kind: 'update', id, color }] },
      })
      expect(refused.isError).toBe(true)
      expect((await f.t.library.getEdits(photoId)).revision).toBe(created.revision)
    }
    const colored = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: created.revision,
      maskMutation: {
        operations: [{ kind: 'update', id, color: { temperature: -20, saturation: -12 } }],
      },
    })
    const manual = await f.t.library.mutateMasks(photoId, colored.revision, {
      operations: [{ kind: 'update', id, color: { tint: 4 } }],
    })
    expect(manual.settings.maskStack[0].color).toEqual({
      temperature: -20,
      tint: 4,
      saturation: -12,
    })
    expect(manual.settings.whiteBalance).toEqual(before.settings.whiteBalance)
    const refreshed = await f.call<EditState>('irodori_get_edits', { photoId })
    expect(refreshed.settings).toEqual(manual.settings)
    const reset = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: manual.revision,
      maskMutation: {
        operations: [{ kind: 'update', id, color: { temperature: 0, tint: 0, saturation: 0 } }],
      },
    })
    expect(reset.revision).toBe(manual.revision + 1)
    expect(reset.settings.maskStack[0].color).toEqual({ temperature: 0, tint: 0, saturation: 0 })
    const undone = await f.call<EditState>('irodori_undo_edit', {
      photoId,
      expectedRevision: reset.revision,
    })
    expect(undone.settings).toEqual(manual.settings)
    const redone = await f.call<EditState>('irodori_redo_edit', {
      photoId,
      expectedRevision: undone.revision,
    })
    expect(redone.settings).toEqual(reset.settings)
    expect((await f.t.library.getEditHistory(photoId)).snapshots).toHaveLength(5)
    await f.t.originalsUnchanged()
  } finally {
    await f.close()
  }
})

test('mask MCP enforces point bounds, exact-instance credentials and one-refresh conflict protection', async () => {
  const f = await fixture(),
    photoId = f.t.ids[0],
    id = randomUUID()
  try {
    const invalidPoints = await f.raw('irodori_get_mask_context', {
      photoId,
      expectedRevision: 0,
      points: Array.from({ length: 129 }, () => ({ x: 0.5, y: 0.5 })),
    })
    expect(invalidPoints.isError).toBe(true)
    expect(JSON.stringify(invalidPoints.content)).toContain('128')
    const connection = f.endpoint.agentConnection(f.token)
    const unauthenticated = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
      body: JSON.stringify({
        operation: 'irodori_mutate_masks',
        photoId,
        expectedRevision: 0,
        requestId: f.context.requestId,
        maskMutation: { operations: [{ kind: 'create', id, name: 'Wrong instance' }] },
      }),
    })
    expect(unauthenticated.status).toBe(403)
    const stale = await f.raw('irodori_mutate_masks', {
      photoId,
      expectedRevision: 0,
      requestId: randomUUID(),
      maskMutation: { operations: [{ kind: 'create', id, name: 'Stale' }] },
    })
    expect(stale.isError).toBe(true)
    expect((await f.t.library.getEdits(photoId)).revision).toBe(0)
    await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 0,
      maskMutation: { operations: [{ kind: 'create', id, name: 'Subject' }] },
    })
    await f.t.library.updateEdits(photoId, { contrast: 5 }, 1)
    const conflicted = await f.raw('irodori_mutate_masks', {
      photoId,
      expectedRevision: 1,
      maskMutation: { operations: [{ kind: 'update', id, light: { exposureEv: 0.4 } }] },
    })
    expect(conflicted.isError).toBe(true)
    expect(JSON.stringify(conflicted.content)).toContain('Refresh')
    const refreshed = await f.call<EditState>('irodori_get_edits', { photoId })
    expect(refreshed.revision).toBe(2)
    const applied = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 2,
      maskMutation: { operations: [{ kind: 'update', id, light: { exposureEv: 0.4 } }] },
    })
    expect(applied.revision).toBe(3)
    await f.t.library.updateEdits(photoId, { contrast: 10 }, 3)
    const paused = await f.raw('irodori_mutate_masks', {
      photoId,
      expectedRevision: 3,
      maskMutation: { operations: [{ kind: 'delete', id }] },
    })
    expect(paused.isError).toBe(true)
    expect(JSON.stringify(paused.content)).toContain('Paused')
    expect((await f.raw('irodori_get_edits', { photoId })).isError).toBe(true)
    const preserved = await f.t.library.getEdits(photoId)
    expect(preserved.revision).toBe(4)
    expect(preserved.settings.maskStack[0]).toMatchObject({ id, light: { exposureEv: 0.4 } })
    expect((await f.t.library.getEditHistory(photoId)).snapshots).toHaveLength(5)
  } finally {
    await f.close()
  }
})

test('managed MCP maps extended gradient points explicitly and commits complete gradient geometry atomically', async () => {
  const f = await fixture(),
    photoId = f.t.ids[0],
    id = randomUUID()
  try {
    const tools = (await f.client.listTools()).tools
    const contextSchema = tools.find(
      (tool) => tool.name === 'irodori_get_mask_context',
    )!.inputSchema
    expect(contextSchema.properties).toHaveProperty('allowOutsidePhoto')
    const args = {
      photoId,
      expectedRevision: 0,
      points: [
        { x: -1, y: 0.2 },
        { x: 2, y: 0.8 },
      ],
    }
    expect((await f.raw('irodori_get_mask_context', args)).isError).toBe(true)
    const context = await f.call<MappedContext>('irodori_get_mask_context', {
      ...args,
      allowOutsidePhoto: true,
    })
    expect(context.points).toEqual([
      { x: expect.closeTo(-0.25, 12), y: expect.closeTo(0.2, 12) },
      { x: expect.closeTo(1.25, 12), y: expect.closeTo(0.8, 12) },
    ])
    expect(
      (await f.raw('irodori_get_mask_context', { ...args, allowOutsidePhoto: 'true' })).isError,
    ).toBe(true)
    const gradient = { kind: 'linear', start: context.points[0], end: context.points[1] }
    const created = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 0,
      maskMutation: { operations: [{ kind: 'create', id, name: 'Sky gradient', gradient }] },
    })
    expect(created.revision).toBe(1)
    expect(created.settings.maskStack[0].gradient).toEqual(gradient)
    expect((await f.t.library.getEditHistory(photoId)).snapshots).toHaveLength(2)
    const next = {
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radiusX: 0.4,
      radiusY: 0.4,
      rotation: 30,
      feather: 50,
    }
    const changed = await f.call<EditState>('irodori_mutate_masks', {
      photoId,
      expectedRevision: 1,
      maskMutation: { operations: [{ kind: 'update', id, gradient: next }] },
    })
    expect(changed.settings.maskStack[0].gradient).toEqual(next)
    const partial = await f.raw('irodori_mutate_masks', {
      photoId,
      expectedRevision: 2,
      maskMutation: {
        operations: [{ kind: 'update', id, gradient: { kind: 'radial', feather: 10 } }],
      },
    })
    expect(partial.isError).toBe(true)
    const brush = await f.raw('irodori_mutate_masks', {
      photoId,
      expectedRevision: 2,
      maskMutation: {
        operations: [
          {
            kind: 'stroke',
            id,
            stroke: { mode: 'add', radius: 0.1, feather: 0.5, points: [context.points[0]] },
          },
        ],
      },
    })
    expect(brush.isError).toBe(true)
    expect((await f.t.library.getEdits(photoId)).revision).toBe(2)
    const undone = await f.call<EditState>('irodori_undo_edit', { photoId, expectedRevision: 2 })
    expect(undone.settings.maskStack[0].gradient).toEqual(gradient)
  } finally {
    await f.close()
  }
})
