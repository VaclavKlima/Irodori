import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import type { ExportRenderJob } from '../src/main/export/types'
import { exportGeometry } from '../src/shared/export'
import { OUTPUT_SHARPENING_STAGE, OUTPUT_SHARPENING_VERSION } from '../src/shared/output-sharpening'
import { sha } from './export.helpers'
import { proofFixture } from './export-proof.helpers'

for (const managed of [false, true])
  test(`${managed ? 'managed Console' : 'editing MCP'} discovers output sharpening, proofs and exports frozen settings with existing authorization`, async () => {
    const rendered: ExportRenderJob[] = []
    const f = await proofFixture({
        exportRender: async (job) => {
          rendered.push(structuredClone(job))
          const geometry = exportGeometry(
              job.source.photo.width!,
              job.source.photo.height!,
              job.options.size,
            ),
            path = join(job.directory, 'output.jpg')
          await sharp(job.source.path)
            .resize(geometry)
            .withIccProfile('srgb')
            .jpeg({ quality: job.options.quality, chromaSubsampling: '4:4:4' })
            .toFile(path)
          return { path, sha256: sha(await readFile(path)), geometry }
        },
      }),
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
      const registration = await client.listTools()
      for (const name of ['irodori_get_output_proof', 'irodori_start_export']) {
        const tool = registration.tools.find((tool) => tool.name === name)!
        const properties = tool.inputSchema.properties as Record<string, unknown>
        const optionsSchema = (
          name === 'irodori_get_output_proof'
            ? properties.options
            : (properties.exportRequest as { properties: Record<string, unknown> }).properties
                .options
        ) as { properties: Record<string, unknown>; required: string[] }
        expect(optionsSchema.properties.outputSharpening).toMatchObject({
          enum: ['off', 'low', 'standard', 'high'],
          default: 'off',
        })
        expect(optionsSchema.required).not.toContain('outputSharpening')
        expect(optionsSchema.required).toEqual([
          'version',
          'output',
          'quality',
          'size',
          'names',
          'metadata',
          'existing',
        ])
        if (managed) expect(tool.inputSchema.required).toContain('requestId')
      }
      const capabilities = await call('irodori_get_export_capabilities', {})
      expect(capabilities.isError, JSON.stringify(capabilities.content)).not.toBe(true)
      expect(capabilities.structuredContent).toMatchObject({
        outputSharpening: {
          modes: ['off', 'low', 'standard', 'high'],
          defaultMode: 'off',
          filter: OUTPUT_SHARPENING_VERSION,
          stage: OUTPUT_SHARPENING_STAGE,
        },
      })
      const prepared = await call('irodori_prepare_export', { ids: [f.photos[0].id] })
      expect(prepared.isError, JSON.stringify(prepared.content)).not.toBe(true)
      const preparationId = (prepared.structuredContent as { id: string }).id
      const prefs = await f.library.getExportPreferences(),
        history = await f.library.getEditHistory(f.photos[0].id)
      const options = {
        ...f.request().options,
        outputSharpening: 'standard',
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
        outputSharpening: string
        pipeline: { outputSharpening: { filter: string; stage: string } }
        overview: { width: number; height: number; byteLength: number; rendition: string }
      }
      expect(metadata.width).toBe(1400)
      expect(metadata.outputSharpening).toBe('standard')
      expect(metadata.pipeline.outputSharpening).toEqual({
        filter: OUTPUT_SHARPENING_VERSION,
        stage: OUTPUT_SHARPENING_STAGE,
      })
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
      const legacyOptions = structuredClone(f.request().options)
      delete legacyOptions.outputSharpening
      const legacy = await call('irodori_get_output_proof', {
        ...args,
        options: legacyOptions,
        proofToken: crypto.randomUUID(),
      })
      expect(legacy.isError, JSON.stringify(legacy.content)).not.toBe(true)
      expect(legacy.structuredContent).toMatchObject({ outputSharpening: 'off' })
      for (const outputSharpening of ['strong', null, 50]) {
        const invalidOptions = { ...options, outputSharpening }
        expect(
          (
            await call('irodori_get_output_proof', {
              ...args,
              options: invalidOptions,
              proofToken: crypto.randomUUID(),
            })
          ).isError,
        ).toBe(true)
        expect(
          (
            await call('irodori_start_export', {
              exportRequest: {
                preparationId,
                destinationId: 'ungranted',
                action: 'custom',
                options: invalidOptions,
              },
            })
          ).isError,
        ).toBe(true)
      }
      expect(await f.library.getExportPreferences()).toEqual(prefs)
      expect(await f.library.getEditHistory(f.photos[0].id)).toEqual(history)
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
      }
      expect(
        (
          await call('irodori_start_export', {
            exportRequest: {
              preparationId,
              destinationId: '/arbitrary/path',
              action: 'custom',
              options,
            },
          })
        ).isError,
      ).toBe(true)
      const grant = await f.library.exports.store.authorize(f.destination)
      const accepted = await call('irodori_start_export', {
        exportRequest: { preparationId, destinationId: grant.id, action: 'custom', options },
      })
      expect(accepted.isError, JSON.stringify(accepted.content)).not.toBe(true)
      const taskId = (accepted.structuredContent as { taskId: string }).taskId
      options.outputSharpening = 'high'
      const results = async () => {
        const result = await call('irodori_get_export_results', { taskId })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        return result.structuredContent as {
          outputSharpening: string
          outputSharpeningVersion: string | null
          results: { photoId: string; status: string }[]
        }
      }
      await expect.poll(async () => (await results()).results[0]?.status).toBe('exported')
      expect(await results()).toMatchObject({
        outputSharpening: 'standard',
        outputSharpeningVersion: OUTPUT_SHARPENING_VERSION,
        results: [{ photoId: f.photos[0].id, status: 'exported' }],
      })
      expect(rendered).toHaveLength(1)
      expect(rendered[0].options.outputSharpening).toBe('standard')
      expect((await f.library.getExportPreferences()).lastCustom?.outputSharpening).toBe('standard')
      expect(await f.library.getEditHistory(f.photos[0].id)).toEqual(history)
      expect(await sharp(join(f.destination, 'Photo-0.jpg')).metadata()).toMatchObject({
        width: metadata.width,
        height: metadata.height,
        format: 'jpeg',
      })
      if (managed) {
        const foreignTask = await call('irodori_get_export_results', {
          taskId: crypto.randomUUID(),
        })
        expect(foreignTask.isError).toBe(true)
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
