import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import type { PhotoLibrary } from '../src/main/library'

// This transport test isolates MCP member ordering, metadata and request fencing;
// real source rendering and decoded proof fidelity belong to the GPU/service suites.
for (const managed of [false, true])
  test(`${managed ? 'Console' : 'external MCP'} delivers labelled whole/region/pair images and refuses strict HDR`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'irodori-inspection-mcp-'))
    const photoId = 'a'.repeat(64),
      gridIdentity = 'b'.repeat(64)
    const data = (
      await sharp({ create: { width: 12, height: 8, channels: 3, background: '#607080' } })
        .png()
        .toBuffer()
    ).toString('base64')
    const calls: unknown[] = []
    const context = {
      photoId,
      revision: 3,
      gridIdentity,
      width: 12,
      height: 8,
      hdr: { available: false, reason: 'Unqualified client.' },
    }
    const library = {
      getEdits: async () => ({ revision: 3 }),
      agentPreviews: {
        context: async () => ({ ...context, geometry: { privateRendererMapping: 'lens-table' } }),
        get: async () => ({ photoId, revision: 3, mimeType: 'image/jpeg', data }),
        inspect: async (
          _id: string,
          _revision: number,
          inspection: { hdr?: boolean; comparison?: string },
        ) => {
          calls.push(structuredClone(inspection))
          if (inspection.hdr) throw new Error('HDR image delivery unavailable: unqualified client.')
          return {
            ...context,
            members: (inspection.comparison === 'pair'
              ? ['before', 'after']
              : [inspection.comparison ?? 'after']
            ).map((label) => ({
              label,
              mimeType: 'image/png',
              byteLength: Buffer.from(data, 'base64').length,
              width: 12,
              height: 8,
              data,
            })),
          }
        },
      },
    } as unknown as PhotoLibrary
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
    const token = 'c'.repeat(64)
    const endpoint = await startEditorEndpoint(root, library, undefined, {
      agentGate: (value) => (value === token ? gate : undefined),
    })
    const connection = JSON.parse(await readFile(join(root, 'editor', 'connection.json'), 'utf8'))
    const client = new Client({ name: 'inspection-transport', version: '1' })
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
      const request = managed ? await gate.begin(crypto.randomUUID(), 'inspection') : undefined
      await client.connect(transport)
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({
          name,
          arguments: { ...args, ...(request ? { requestId: request.requestId } : {}) },
        })
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toContain('irodori_get_preview_context')
      expect(
        JSON.stringify(
          (await call('irodori_get_preview_context', { photoId, expectedRevision: 3 }))
            .structuredContent,
        ),
      ).not.toContain('privateRendererMapping')
      expect(
        (await call('irodori_get_preview_context', { photoId, expectedRevision: 3 }))
          .structuredContent,
      ).toMatchObject(context)
      for (const inspection of [
        {},
        {
          region: { units: 'pixels', gridIdentity, x: 2, y: 1, width: 6, height: 4 },
          resolutionPercent: 100,
          encoding: { format: 'png' },
        },
        { comparison: 'pair' },
      ]) {
        const result = await call('irodori_get_photo_preview', {
          photoId,
          expectedRevision: 3,
          inspection,
        })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        const images = (result.content as { type: string }[]).filter((c) => c.type === 'image')
        expect(images).toHaveLength('comparison' in inspection ? 2 : 1)
        expect(JSON.stringify(result.structuredContent)).not.toContain(data)
        if ('comparison' in inspection)
          expect(
            (result.structuredContent as { members: { label: string }[] }).members.map(
              (m) => m.label,
            ),
          ).toEqual(['before', 'after'])
      }
      expect(calls).toHaveLength(3)
      const legacy = await call('irodori_get_photo_preview', { photoId, expectedRevision: 3 })
      expect(legacy.isError).not.toBe(true)
      expect((legacy.content as { type: string }[]).filter((c) => c.type === 'image')).toHaveLength(
        1,
      )
      const hdr = await call('irodori_get_photo_preview', {
        photoId,
        expectedRevision: 3,
        inspection: { hdr: true },
      })
      expect(hdr.isError).toBe(true)
      expect(JSON.stringify(hdr.content)).toContain('unqualified')
      if (managed) {
        const outside = await call('irodori_get_preview_context', {
          photoId: 'd'.repeat(64),
          expectedRevision: 3,
        })
        expect(outside.isError).toBe(true)
        gate.end()
        expect(
          (
            await call('irodori_get_photo_preview', {
              photoId,
              expectedRevision: 3,
              inspection: {},
            })
          ).isError,
        ).toBe(true)
      }
    } finally {
      await client.close()
      await transport.close()
      await endpoint.close()
      await rm(root, { recursive: true, force: true })
    }
  })
