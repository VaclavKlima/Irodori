import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { proofFixture } from './export-proof.helpers'

for (const managed of [false, true])
  test(`${managed ? 'managed Console' : 'editing MCP'} obtains the shared JPEG proof overview with frozen authorization and no retained assets`, async () => {
    const f = await proofFixture(),
      session = crypto.randomUUID(),
      managedToken = 'c'.repeat(64)
    const gate = new AgentRequestGate(
      async () => ({
        workspace: 'editor',
        activePhotoId: f.photos[0].id,
        selectedIds: [f.photos[0].id],
        transient: { crop: false, saving: false },
      }),
      async (id) => (await f.library.getEdits(id)).revision,
      true,
    )
    const endpoint = await startEditorEndpoint(f.root, f.library, undefined, {
      agentGate: (token) => (token === managedToken ? gate : undefined),
    })
    const connection = JSON.parse(await readFile(join(f.root, 'editor', 'connection.json'), 'utf8'))
    const client = new Client({ name: 'output-proof-test', version: '1' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/editor-mcp.mjs')],
      env: {
        ...(process.env as Record<string, string>),
        IRODORI_PROFILE: f.root,
        ...(managed
          ? { IRODORI_AGENT_CONNECTION: JSON.stringify({ ...connection, token: managedToken }) }
          : {}),
      },
    })
    try {
      const context = managed ? await gate.begin(session, 'proof-turn') : null
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({
          name,
          arguments: { ...args, ...(context ? { requestId: context.requestId } : {}) },
        })
      await client.connect(transport)
      const prepared = await call('irodori_prepare_export', { ids: [f.photos[0].id] })
      expect(prepared.isError, JSON.stringify(prepared.content)).not.toBe(true)
      const preparationId = (prepared.structuredContent as { id: string }).id
      const prefs = await f.library.getExportPreferences(),
        history = await f.library.getEditHistory(f.photos[0].id)
      const options = {
        ...f.request().options,
        size: { mode: 'longest', edge: 1400, allowEnlargement: true, method: 'lanczos3' },
      }
      const args = {
        preparationId,
        photoId: f.photos[0].id,
        options,
        proofToken: crypto.randomUUID(),
      }
      const result = await call('irodori_get_output_proof', args)
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const metadata = result.structuredContent as {
        width: number
        height: number
        overview: { width: number; height: number; byteLength: number; rendition: string }
      }
      expect(metadata.width).toBe(1400)
      expect(metadata.overview.width).toBe(1024)
      expect(metadata.overview.rendition).toContain('overview')
      const image = (result.content as { type: string; data?: string; mimeType?: string }[]).find(
        (item) => item.type === 'image',
      )!
      const bytes = Buffer.from(image.data!, 'base64')
      expect(bytes.length).toBe(metadata.overview.byteLength)
      expect(bytes.length).toBeLessThanOrEqual(1024 ** 2)
      expect(await sharp(bytes).metadata()).toMatchObject({
        width: metadata.overview.width,
        height: metadata.overview.height,
        format: 'jpeg',
      })
      expect(await f.library.getExportPreferences()).toEqual(prefs)
      expect(await f.library.getEditHistory(f.photos[0].id)).toEqual(history)
      expect(JSON.stringify(result)).not.toContain(f.root)
      expect(JSON.stringify(result)).not.toContain('irodori-photo:')
      expect(await readdir(join(f.root, 'library', 'cache', 'output-proofs'))).toEqual([])
      const outside = await call('irodori_get_output_proof', {
        ...args,
        photoId: f.photos[1].id,
        proofToken: crypto.randomUUID(),
      })
      expect(outside.isError).toBe(true)
      if (managed) {
        const foreign = await call('irodori_get_output_proof', {
          ...args,
          preparationId: f.prepared.id,
          proofToken: crypto.randomUUID(),
        })
        expect(foreign.isError).toBe(true)
        expect(JSON.stringify(foreign.content)).toContain('current request')
        gate.end(session, 'proof-turn')
        expect(
          (await call('irodori_get_output_proof', { ...args, proofToken: crypto.randomUUID() }))
            .isError,
        ).toBe(true)
      }
    } finally {
      await client.close()
      await transport.close()
      await endpoint.close()
      await f.close()
    }
  })
