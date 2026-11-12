import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { agentInstructions, agentTools } from '../src/main/agent/policy'
import { getEditingGuidance } from '../src/shared/agent-guidance'
import type { EditingPreset } from '../src/shared/presets'
import type { PresetApplicationPreparation } from '../src/shared/edit-transfer'
import { transferFixture } from './edit-transfer.helpers'
import { initialSettings, SETTINGS_VERSION } from '../src/shared/edits'
import { presetGroupKeys } from '../src/shared/presets'
import { presetColors, presetIcons } from '../src/shared/preset-appearance'

test('agent-facing preset schemas expose concrete complete groups and save a creative look without changing photos', async () => {
  const t = await transferFixture(1)
  const gate = new AgentRequestGate(
    async () => ({
      workspace: 'editor',
      activePhotoId: t.ids[0],
      selectedIds: [],
      transient: { crop: false, saving: false },
    }),
    async (id) => (await t.library.getEdits(id)).revision,
    false,
  )
  const token = randomBytes(32).toString('hex')
  const endpoint = await startEditorEndpoint(t.root, t.library, undefined, {
    agentGate: (supplied) => (supplied === token ? gate : undefined),
  })
  const client = new Client({ name: 'preset-schema-regression', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: {
      ...(process.env as Record<string, string>),
      IRODORI_AGENT_CONNECTION: JSON.stringify(endpoint.agentConnection(token)),
    },
  })
  const { requestId } = await gate.begin('00000000-0000-0000-0000-000000000001', 'creative-preset')
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    const create = tools.find((tool) => tool.name === 'irodori_create_preset')!
    const update = tools.find((tool) => tool.name === 'irodori_update_preset')!
    const properties = (schema: unknown) =>
      (schema as { properties: Record<string, JsonSchemaType> }).properties
    const source = properties(properties(create.inputSchema).presetRequest).source
    // Code-mode clients must see the actual source fields rather than an opaque object union.
    expect(source.type).toBe('object')
    expect(source.oneOf).toBeUndefined()
    expect(properties(source).mode).toMatchObject({ type: 'string', enum: ['photo', 'explicit'] })
    expect(properties(source).settingsVersion).toMatchObject({
      type: 'integer',
      enum: [12, 13, 14, 15, 16, 17, 18, SETTINGS_VERSION],
    })
    expect(properties(properties(update.inputSchema).presetRequest).source).toEqual(source)
    const appearance = properties(properties(create.inputSchema).presetRequest).appearance
    expect(appearance.type).toBe('object')
    expect(appearance.oneOf).toBeUndefined()
    expect(properties(appearance).icon.enum).toEqual(presetIcons.map((icon) => icon.id))
    expect(properties(appearance).color.enum).toEqual(presetColors.map((color) => color.id))
    expect(properties(properties(update.inputSchema).presetRequest).appearance).toEqual(appearance)
    const guidance = getEditingGuidance({ topic: 'presets' }).workflow.join('\n')
    expect(guidance).toContain('sunset/amber for Golden Hour')
    expect(guidance).toContain('Preserve appearance during updates')
    const values = properties(source).values
    expect(properties(values).colorGrading.required).toEqual([
      'version',
      'tones',
      'blending',
      'balance',
    ])
    expect(properties(properties(values).colorGrading).tones.required).toEqual([
      'shadows',
      'midtones',
      'highlights',
    ])
    expect(properties(values).curves.required).toEqual([
      'version',
      'master',
      'red',
      'green',
      'blue',
    ])
    const validator = new AjvJsonSchemaValidator(),
      validCreate = validator.getValidator(create.inputSchema as JsonSchemaType),
      validUpdate = validator.getValidator(update.inputSchema as JsonSchemaType)
    const look = {
      name: 'Your Name — Golden Hour',
      appearance: { icon: 'sunset', color: 'amber' },
      source: {
        mode: 'explicit',
        settingsVersion: 12,
        groups: ['color', 'grading'],
        values: {
          saturation: 5,
          vibrance: 22,
          colorGrading: {
            version: 1,
            tones: {
              shadows: { hue: 235, saturation: 12, luminance: 0 },
              midtones: { hue: 32, saturation: 8, luminance: 0 },
              highlights: { hue: 42, saturation: 22, luminance: 0 },
            },
            blending: 65,
            balance: 15,
          },
        },
      },
    }
    expect(validCreate({ requestId, presetRequest: look }).valid).toBe(true)
    for (const appearance of [
      {},
      { icon: 'custom.svg' },
      { color: '#123456' },
      { icon: 'sunset', url: 'https://example.com' },
    ])
      expect(validCreate({ requestId, presetRequest: { ...look, appearance } }).valid).toBe(false)
    const malformed = {
      name: look.name,
      source: { type: 'explicit', groups: look.source.groups, settings: look.source.values },
    }
    expect(validCreate({ requestId, presetRequest: malformed }).valid).toBe(false)
    const failure = await client.callTool({
      name: create.name,
      arguments: { requestId, presetRequest: malformed },
    })
    expect(failure.isError).toBe(true)
    expect(JSON.stringify(failure.content)).toContain('source.mode')
    expect(JSON.stringify(failure.content)).toContain('groups and values')
    const before = await t.library.getEditHistory(t.ids[0])
    const saved = await client.callTool({
      name: create.name,
      arguments: { requestId, presetRequest: look },
    })
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    const p = saved.structuredContent as unknown as EditingPreset
    expect(p.definition.values).toEqual(look.source.values)
    expect(p.appearance).toEqual(look.appearance)
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(before)
    const replacement = {
      requestId,
      presetRequest: { presetId: p.id, expectedPresetRevision: 1, source: look.source },
    }
    expect(validUpdate(replacement).valid).toBe(true)
    expect((await client.callTool({ name: update.name, arguments: replacement })).isError).not.toBe(
      true,
    )
    expect(t.library.getPreset(p.id).appearance).toEqual(look.appearance)
    const marker = {
      requestId,
      presetRequest: { presetId: p.id, expectedPresetRevision: 2, appearance: { color: 'rose' } },
    }
    expect(validUpdate(marker).valid).toBe(true)
    expect((await client.callTool({ name: update.name, arguments: marker })).isError).not.toBe(true)
    expect(t.library.getPreset(p.id)).toMatchObject({
      revision: 3,
      appearance: { icon: 'sunset', color: 'rose' },
      definition: p.definition,
    })
    expect(
      (await client.callTool({ name: 'irodori_list_presets', arguments: { requestId } }))
        .structuredContent,
    ).toMatchObject({ presets: [{ id: p.id, appearance: { icon: 'sunset', color: 'rose' } }] })
    expect(
      (
        await client.callTool({
          name: 'irodori_get_preset',
          arguments: { requestId, presetId: p.id },
        })
      ).structuredContent,
    ).toMatchObject({ id: p.id, appearance: { icon: 'sunset', color: 'rose' } })
    expect((await client.callTool({ name: update.name, arguments: marker })).isError).toBe(true)
    const invalidMarker = {
      requestId,
      presetRequest: {
        presetId: p.id,
        expectedPresetRevision: 3,
        appearance: { icon: 'upload.svg' },
      },
    }
    expect(validUpdate(invalidMarker).valid).toBe(false)
    expect((await client.callTool({ name: update.name, arguments: invalidMarker })).isError).toBe(
      true,
    )
    for (const mode of ['type', 'kind'])
      expect(
        validCreate({
          requestId,
          presetRequest: {
            name: 'Invalid',
            source: {
              [mode]: 'explicit',
              settingsVersion: 12,
              groups: ['color'],
              values: { saturation: 0, vibrance: 0 },
            },
          },
        }).valid,
      ).toBe(false)
    const defaults = initialSettings()
    for (const [group, keys] of Object.entries(presetGroupKeys)) {
      if (group === 'white-balance' || group === 'lens') continue
      const values = Object.fromEntries(keys.map((key) => [key, defaults[key]]))
      const request = {
        requestId,
        presetRequest: {
          name: group,
          source: { mode: 'explicit', settingsVersion: 12, groups: [group], values },
        },
      }
      expect(validCreate(request).valid, group).toBe(true)
      const partial = structuredClone(request)
      const first = keys[0]
      if (typeof partial.presetRequest.source.values[first] === 'object')
        delete (partial.presetRequest.source.values[first] as Record<string, unknown>).version
      else delete partial.presetRequest.source.values[first]
      expect(validCreate(partial).valid, `incomplete ${group}`).toBe(false)
    }
    const base = {
      mode: 'explicit',
      settingsVersion: 12,
      groups: ['color'],
      values: { saturation: 0, vibrance: 0 },
    }
    for (const source of [
      { ...base, values: { saturation: 0 } },
      { ...base, values: { ...base.values, exposureEv: 1 } },
      { ...base, settingsVersion: 11 },
      { ...base, groups: ['white-balance'], values: { whiteBalance: { mode: 'as-shot' } } },
    ])
      expect(validCreate({ requestId, presetRequest: { name: 'Invalid', source } }).valid).toBe(
        false,
      )
    expect(
      validCreate({
        requestId,
        presetRequest: {
          name: 'Capture',
          source: { mode: 'photo', photoId: t.ids[0], groups: ['light'] },
        },
      }).valid,
    ).toBe(true)
    expect(
      validCreate({
        requestId,
        presetRequest: { name: 'Missing photo', source: { mode: 'photo', groups: ['light'] } },
      }).valid,
    ).toBe(false)
    await t.restart()
    expect(t.library.getPreset(p.id).definition.values).toEqual(look.source.values)
    expect(t.library.getPreset(p.id).appearance).toEqual({ icon: 'sunset', color: 'rose' })
    expect(await t.library.getEditHistory(t.ids[0])).toEqual(before)
  } finally {
    gate.stop()
    await client.close()
    await endpoint.close()
    await t.close()
  }
})

test('authenticated managed preset tools share storage/history and enforce source, reference, destination and preparation ownership', async () => {
  const t = await transferFixture(3)
  const gate = new AgentRequestGate(
    async () => ({
      workspace: 'editor',
      activePhotoId: t.ids[0],
      selectedIds: t.ids.slice(0, 2),
      transient: { crop: false, saving: false },
    }),
    async (id) => (await t.library.getEdits(id)).revision,
    false,
  )
  const token = randomBytes(32).toString('hex'),
    session = '00000000-0000-0000-0000-000000000001'
  const endpoint = await startEditorEndpoint(t.root, t.library, undefined, {
    agentGate: (supplied) => (supplied === token ? gate : undefined),
  })
  const client = new Client({ name: 'managed-presets-test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/editor-mcp.mjs')],
    env: {
      ...(process.env as Record<string, string>),
      IRODORI_AGENT_CONNECTION: JSON.stringify(endpoint.agentConnection(token)),
    },
  })
  let requestId = (await gate.begin(session, 'one')).requestId
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: { ...args, requestId } })
  try {
    await client.connect(transport)
    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual([...agentTools].sort())
    expect(tools.every((t) => t.inputSchema.required?.includes('requestId'))).toBe(true)
    const deletion = tools.find((t) => t.name === 'irodori_delete_preset')!.description!
    expect(deletion).toContain('wait for agreement')
    expect(deletion).toContain('no deletion permission')
    expect(agentInstructions(false)).toContain(
      'Deleting an identified preset is authorized only by an explicit user deletion request',
    )
    const source = { mode: 'photo', photoId: t.ids[2], groups: ['light'] }
    expect(
      (await call('irodori_create_preset', { presetRequest: { name: 'Outside', source } })).isError,
    ).toBe(true)
    expect(
      (
        await call('irodori_create_preset', {
          presetRequest: {
            name: 'Reference outside',
            source: {
              mode: 'explicit',
              settingsVersion: 12,
              groups: ['color'],
              values: { saturation: 10, vibrance: 0 },
              referencePhotoId: t.ids[2],
            },
          },
        })
      ).isError,
    ).toBe(true)
    const partial = await call('irodori_create_preset', {
      presetRequest: {
        name: 'Partial',
        source: {
          mode: 'explicit',
          settingsVersion: 12,
          groups: ['light'],
          values: { exposureEv: 1 },
        },
      },
    })
    expect(partial.isError).toBe(true)
    const created = await call('irodori_create_preset', {
      presetRequest: {
        name: 'MCP look',
        source: {
          mode: 'explicit',
          settingsVersion: 12,
          groups: ['color'],
          values: { saturation: 35, vibrance: 0 },
        },
      },
    })
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true)
    const preset = created.structuredContent as unknown as EditingPreset
    expect(t.library.getPreset(preset.id)).toEqual(preset)
    expect(
      (await call('irodori_list_presets', { presetQuery: { search: 'mcp' } })).structuredContent,
    ).toMatchObject({ total: 1, presets: [{ id: preset.id }] })
    expect((await call('irodori_get_preset', { presetId: preset.id })).structuredContent).toEqual(
      preset,
    )
    expect(
      (
        await call('irodori_prepare_preset_application', {
          presetApplication: {
            presetId: preset.id,
            expectedPresetRevision: 1,
            photoIds: [t.ids[2]],
          },
        })
      ).isError,
    ).toBe(true)
    const prepared = await call('irodori_prepare_preset_application', {
      presetApplication: { presetId: preset.id, expectedPresetRevision: 1, photoIds: [t.ids[1]] },
    })
    expect(prepared.isError, JSON.stringify(prepared.content)).not.toBe(true)
    const preparation = prepared.structuredContent as unknown as PresetApplicationPreparation
    expect(
      (await call('irodori_start_paste_edits', { preparationId: preparation.id })).isError,
    ).toBe(true)
    // Preset revision 1 and photo revision 0 are separate domains.
    expect(
      (
        await call('irodori_update_preset', {
          presetRequest: { presetId: preset.id, expectedPresetRevision: 1, name: 'Updated look' },
        })
      ).isError,
    ).not.toBe(true)
    expect(
      (await call('irodori_delete_preset', { presetId: preset.id, expectedPresetRevision: 1 }))
        .isError,
    ).toBe(true)
    // An explicit instruction names this exact preset; the server checks identity and revision.
    expect(
      (await call('irodori_delete_preset', { presetId: preset.id, expectedPresetRevision: 2 }))
        .isError,
    ).not.toBe(true)
    const started = await call('irodori_start_preset_application', {
      preparationId: preparation.id,
    })
    expect(started.isError, JSON.stringify(started.content)).not.toBe(true)
    const taskId = (started.structuredContent as { taskId: string }).taskId
    await t.finished(taskId)
    expect(
      (await call('irodori_get_edit_application_results', { taskId })).structuredContent,
    ).toMatchObject({ results: [{ outcome: 'applied' }] })
    expect((await t.library.getEdits(t.ids[1])).settings.saturation).toBe(35)
    expect((await t.library.getEditHistory(t.ids[1])).snapshots).toHaveLength(2)
    const captured = await call('irodori_create_preset', {
      presetRequest: {
        name: 'Captured',
        appearance: { icon: 'high-noise' },
        source: { mode: 'photo', photoId: t.ids[0], groups: ['light'] },
      },
    })
    expect(captured.isError).not.toBe(true)
    const p = captured.structuredContent as unknown as EditingPreset
    expect(p.appearance).toEqual({ icon: 'high-noise', color: 'neutral' })
    const grant = await call('irodori_prepare_preset_application', {
      presetApplication: { presetId: p.id, expectedPresetRevision: 1, photoIds: [t.ids[0]] },
    })
    const grantId = (grant.structuredContent as unknown as PresetApplicationPreparation).id
    expect(
      (await call('irodori_dispose_preset_preparation', { preparationId: grantId })).isError,
    ).not.toBe(true)
    expect(
      (await call('irodori_start_preset_application', { preparationId: grantId })).isError,
    ).toBe(true)
    // Proposal does not mutate storage. A later permission prompt has a new frozen request.
    const proposed = await call('irodori_get_preset', { presetId: p.id })
    expect(proposed.structuredContent).toMatchObject({ id: p.id, name: 'Captured' })
    expect(t.library.listPresets().total).toBe(1)
    requestId = (await gate.begin(session, 'permission-granted')).requestId
    expect(
      (await call('irodori_start_preset_application', { preparationId: grantId })).isError,
    ).toBe(true)
    expect(
      (await call('irodori_delete_preset', { presetId: p.id, expectedPresetRevision: 1 })).isError,
    ).not.toBe(true)
    expect(t.library.listPresets().total).toBe(0)
    expect((await t.library.getEdits(t.ids[0])).revision).toBe(0)
    await t.originalsUnchanged()
  } finally {
    gate.stop()
    await client.close()
    await endpoint.close()
    await t.close()
  }
})
