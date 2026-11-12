import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import type { PhotoLibrary } from '../src/main/library'
import { validateMaskPreviewRequest, type MaskPreviewRequest } from '../src/shared/mask-preview'

for (const managed of [false, true])
  test(`${managed ? 'Console' : 'standalone MCP'} exposes typed root-only read-only mask inspection and labelled PNG members`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-mask-preview-mcp-'))
    const photoId = 'a'.repeat(64),
      maskId = randomUUID(),
      gridIdentity = 'b'.repeat(64),
      token = 'c'.repeat(64)
    const data = (
      await sharp({ create: { width: 12, height: 8, channels: 3, background: '#607080' } })
        .png()
        .toBuffer()
    ).toString('base64')
    const calls: MaskPreviewRequest[] = []
    const gate = new AgentRequestGate(
      async () => ({
        workspace: 'editor',
        activePhotoId: photoId,
        selectedIds: [photoId],
        transient: { crop: false, saving: false },
      }),
      async () => 3,
      true,
    )
    const library = {
      getEdits: async () => ({ revision: 3 }),
      getMaskPreview: async (value: MaskPreviewRequest) => {
        const request = validateMaskPreviewRequest(value)
        if (request.maskId !== maskId) throw new Error('Choose an existing root mask ID.')
        calls.push(request)
        return {
          photoId,
          revision: 3,
          maskId,
          enabled: false,
          adjustmentsNeutral: true,
          gridIdentity,
          coverageSemantics: 'stored-mask-shape',
          members: (request.view === 'coverage'
            ? ['coverage']
            : request.view === 'overlay'
              ? ['overlay']
              : ['coverage', 'overlay']
          ).map((label) => ({
            label,
            mimeType: 'image/png',
            width: 12,
            height: 8,
            data,
            byteLength: Buffer.from(data, 'base64').byteLength,
          })),
        }
      },
    } as unknown as PhotoLibrary
    const endpoint = await startEditorEndpoint(root, library, undefined, {
      agentGate: (value) => (value === token ? gate : undefined),
    })
    const connection = JSON.parse(await readFile(join(root, 'editor', 'connection.json'), 'utf8'))
    const client = new Client({ name: 'mask-inspection-transport', version: '1' })
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
      const request = managed ? await gate.begin(randomUUID(), 'mask-inspection') : undefined
      await client.connect(transport)
      const call = (args: Record<string, unknown>) =>
        client.callTool({
          name: 'irodori_get_mask_preview',
          arguments: {
            photoId,
            expectedRevision: 3,
            maskId,
            ...args,
            ...(request ? { requestId: request.requestId } : {}),
          },
        })
      const listed = (await client.listTools()).tools.find(
        (tool) => tool.name === 'irodori_get_mask_preview',
      )
      expect(listed?.inputSchema.required).toEqual(
        expect.arrayContaining(['photoId', 'expectedRevision', 'maskId']),
      )
      expect(JSON.stringify(listed?.inputSchema)).toContain('resolutionPercent')
      for (const args of [
        {},
        { view: 'coverage' },
        {
          view: 'overlay',
          inspection: {
            resolutionPercent: 100,
            region: { units: 'pixels', gridIdentity, x: 1, y: 2, width: 6, height: 4 },
          },
        },
      ]) {
        const result = await call(args)
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        const expected = Object.keys(args).length ? 1 : 2
        expect(
          (result.content as { type: string }[]).filter((item) => item.type === 'image'),
        ).toHaveLength(expected)
        expect(JSON.stringify(result.structuredContent)).not.toContain(data)
        expect(result.structuredContent).toMatchObject({
          enabled: false,
          adjustmentsNeutral: true,
          coverageSemantics: 'stored-mask-shape',
        })
      }
      expect(calls).toHaveLength(3)
      for (const args of [
        { maskId: randomUUID() },
        { view: 'before' },
        { mutation: {} },
        { inspection: { hdr: true } },
        { inspection: { encoding: { format: 'jpeg' } } },
      ])
        expect((await call(args)).isError).toBe(true)
      if (managed) {
        expect((await call({ photoId: 'd'.repeat(64) })).isError).toBe(true)
        gate.end()
        expect((await call({})).isError).toBe(true)
      }
      expect(calls).toHaveLength(3)
    } finally {
      await client.close()
      await transport.close()
      await endpoint.close()
      await rm(root, { recursive: true, force: true })
    }
  })
