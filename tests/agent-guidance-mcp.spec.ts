import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { readAgentPresentationContext } from '../src/main/agent/presentation-context'
import type { PhotoLibrary } from '../src/main/library'
import { editingGuidanceTopics, getEditingGuidance } from '../src/shared/agent-guidance'
import { SDR_TARGET } from '../src/shared/hdr'
import { inspectionHdrCapability } from '../src/shared/inspection'

for (const managed of [false, true])
  test(`${managed ? 'Console' : 'standalone'} guidance and presentation preserve schemas and request ownership`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-agent-guidance-'))
    const photoId = 'a'.repeat(64)
    let revision = 3
    let displayReads = 0
    const library = {
      getEdits: async () => ({ photoId, revision }),
      getEditingGuidance,
      getPhotoPresentationContext: (request: Parameters<typeof readAgentPresentationContext>[0]) =>
        readAgentPresentationContext(request, {
          currentRevision: async () => revision,
          readDisplayTarget: () => {
            displayReads++
            return SDR_TARGET
          },
          readPreviewDiagnostics: () => ({ loadingStage: 'idle', timings: {} }),
          inspectionHdr: inspectionHdrCapability,
        }),
    } as unknown as PhotoLibrary
    const gate = new AgentRequestGate(
      async () => ({
        workspace: 'editor',
        activePhotoId: photoId,
        selectedIds: [photoId],
        transient: { crop: false, saving: false },
      }),
      async () => revision,
      false,
    )
    const token = 'c'.repeat(64)
    const endpoint = await startEditorEndpoint(root, library, undefined, {
      agentGate: (value) => (value === token ? gate : undefined),
    })
    const connection = JSON.parse(await readFile(join(root, 'editor', 'connection.json'), 'utf8'))
    const client = new Client({ name: 'agent-guidance-test', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        IRODORI_PROFILE: root,
        ...(managed ? { IRODORI_AGENT_CONNECTION: JSON.stringify({ ...connection, token }) } : {}),
      },
    })
    try {
      const request = managed ? await gate.begin(crypto.randomUUID(), 'guidance') : undefined
      await client.connect(transport)
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({
          name,
          arguments: { ...args, ...(request ? { requestId: request.requestId } : {}) },
        })
      const listed = (await client.listTools()).tools
      const validator = new AjvJsonSchemaValidator()
      for (const topic of editingGuidanceTopics)
        for (const example of getEditingGuidance({ topic }).examples) {
          const schema = listed.find((tool) => tool.name === example.tool)!.inputSchema
          const valid = validator.getValidator(schema as JsonSchemaType)({
            ...example.args,
            ...(request ? { requestId: request.requestId } : {}),
          })
          expect(valid.valid, `${topic}/${example.tool}: ${JSON.stringify(valid)}`).toBe(true)
        }
      const guidanceSchema = listed.find(
        (t) => t.name === 'irodori_get_editing_guidance',
      )!.inputSchema
      expect(guidanceSchema.properties?.topic).toEqual({ enum: [...editingGuidanceTopics] })
      expect(guidanceSchema.additionalProperties).toBe(false)
      expect(guidanceSchema.required).toEqual(managed ? ['topic', 'requestId'] : ['topic'])
      expect(listed.find((t) => t.name === 'irodori_get_photo_presentation_context')).toBeTruthy()
      for (const topic of editingGuidanceTopics) {
        const result = await call('irodori_get_editing_guidance', { topic })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        expect(result.structuredContent).toEqual(getEditingGuidance({ topic }))
      }
      expect((await call('irodori_get_editing_guidance', { topic: 'missing' })).isError).toBe(true)
      expect(
        (await call('irodori_get_editing_guidance', { topic: 'tone', extra: true })).isError,
      ).toBe(true)
      const args = { photoId, expectedRevision: 3 }
      const result = await call('irodori_get_photo_presentation_context', args)
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        photoId,
        revision: 3,
        frame: { status: 'not-current' },
        workspaceTarget: { physicalOutputVerified: false },
        inspectionHdr: inspectionHdrCapability,
      })
      const reads = displayReads
      expect(
        (await call('irodori_get_photo_presentation_context', { ...args, extra: true })).isError,
      ).toBe(true)
      expect(displayReads).toBe(reads)
      if (managed) {
        expect(
          (
            await call('irodori_get_photo_presentation_context', {
              ...args,
              photoId: 'd'.repeat(64),
            })
          ).isError,
        ).toBe(true)
        expect(displayReads).toBe(reads)
        revision = 4
        expect((await call('irodori_get_photo_presentation_context', args)).isError).toBe(true)
        expect(displayReads).toBe(reads)
        gate.end()
        expect((await call('irodori_get_editing_guidance', { topic: 'tone' })).isError).toBe(true)
      } else {
        revision = 4
        expect((await call('irodori_get_photo_presentation_context', args)).isError).toBe(true)
      }
    } finally {
      await client.close()
      await transport.close()
      await endpoint.close()
      await rm(root, { recursive: true, force: true })
    }
  })
