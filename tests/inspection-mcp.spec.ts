import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { startEditorEndpoint } from '../src/main/editor-endpoint'
import { AgentRequestGate } from '../src/main/agent/request-gate'
import { readAgentPresentationContext } from '../src/main/agent/presentation-context'
import { DisplayState } from '../src/main/display-state'
import { defaultExportOptions } from '../src/shared/export'
import { inspectionHdrCapability } from '../src/shared/inspection'
import type { PhotoLibrary } from '../src/main/library'
import type { PhotoDiagnosticsRequest } from '../src/shared/photo-diagnostics'

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
    const jpeg = (await sharp(Buffer.from(data, 'base64')).jpeg().toBuffer()).toString('base64')
    const display = new DisplayState(root, () => {})
    const target = display.report({
      hardware: true,
      extended: true,
      p3: true,
      headroomStops: 2,
      reason: 'Test HDR display.',
    })
    const present = (mode: 'hdr' | 'sdr', revision = 3) =>
      display.reportPresentation({
        photoId,
        revision,
        targetGeneration: target.generation,
        mode,
        backend: mode === 'hdr' ? 'webgpu-hdr' : 'canvas2d-hdr-sdr',
        stage: 'presented',
        reason: 'Test frame.',
        timings: {},
      })
    present('hdr')
    let displayAvailable = true
    const notice =
      'Irodori is displaying this photograph in HDR. The Console inspection image is SDR.'
    const displayMismatch = {
      frame: 'hdr',
      delivered: 'sdr',
      targetGeneration: target.generation,
      notice,
    }
    const calls: unknown[] = []
    const diagnosticCalls: PhotoDiagnosticsRequest[] = []
    const frozenRegion = { units: 'pixels', gridIdentity, x: 2, y: 1, width: 6, height: 4 } as const
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
      getPhotoDiagnostics: async (request: PhotoDiagnosticsRequest) => {
        diagnosticCalls.push(request)
        return {
          ...context,
          images: request.region
            ? [
                {
                  label: 'clipping',
                  mimeType: 'image/png',
                  byteLength: Buffer.from(data, 'base64').length,
                  width: 12,
                  height: 8,
                  data,
                },
              ]
            : [],
        }
      },
      getPhotoPresentationContext: (request: Parameters<typeof readAgentPresentationContext>[0]) =>
        readAgentPresentationContext(request, {
          currentRevision: async () => 3,
          readDisplayTarget: () => (displayAvailable ? display.get() : undefined),
          readPreviewDiagnostics: () => ({
            photoId,
            revision: 3,
            loadingStage: 'prepared',
            timings: {},
          }),
          inspectionHdr: inspectionHdrCapability,
        }),
      prepareExport: async () => ({ id: 'proof-preparation' }),
      getOutputProofOverview: async ({ options }: { options: { output: 'hdr' | 'sdr' } }) => ({
        photoId,
        revision: 3,
        output: options.output,
        overview: { rendition: 'SDR overview of decoded JPEG primary' },
        data: jpeg,
      }),
      agentPreviews: {
        context: async () => ({ ...context, geometry: { privateRendererMapping: 'lens-table' } }),
        get: async () => ({ photoId, revision: 3, mimeType: 'image/jpeg', data: jpeg }),
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
        inspection: { photoId, gridIdentity, region: frozenRegion },
      }),
      async () => 3,
      true,
    )
    const token = 'c'.repeat(64)
    const endpoint = await startEditorEndpoint(root, library, display, {
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
      const call = async (name: string, args: Record<string, unknown>) =>
        CallToolResultSchema.parse(
          await client.callTool({
            name,
            arguments: { ...args, ...(request ? { requestId: request.requestId } : {}) },
          }),
        )
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
        expect(images.every((image) => 'data' in image && image.data === data)).toBe(true)
        expect(JSON.stringify(result.structuredContent)).not.toContain(data)
        if (managed) {
          expect(result.structuredContent).toMatchObject({ displayMismatch })
          expect(result.content[0]).toMatchObject({
            type: 'text',
            text: expect.stringContaining(notice),
          })
        } else {
          expect(result.structuredContent).not.toHaveProperty('displayMismatch')
          expect(JSON.stringify(result.content)).not.toContain(notice)
        }
        if ('comparison' in inspection)
          expect(
            (result.structuredContent as { members: { label: string }[] }).members.map(
              (m) => m.label,
            ),
          ).toEqual(['before', 'after'])
      }
      const diagArgs = { photoId, expectedRevision: 3, target: 'sdr' }
      const initial = await call('irodori_get_photo_diagnostics', diagArgs)
      expect(initial.isError).not.toBe(true)
      expect(diagnosticCalls[0].region).toEqual(managed ? frozenRegion : undefined)
      expect(initial.content.filter(({ type }) => type === 'image')).toHaveLength(managed ? 1 : 0)
      const region = { ...frozenRegion, x: 3 }
      const overridden = await call('irodori_get_photo_diagnostics', { ...diagArgs, region })
      expect(overridden.isError, JSON.stringify(overridden.content)).not.toBe(true)
      expect(diagnosticCalls[1]).toMatchObject({ ...diagArgs, region })
      expect(overridden.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data })
      expect(JSON.stringify(overridden.structuredContent)).not.toContain(data)
      if (managed) {
        expect(
          (await call('irodori_get_photo_diagnostics', { ...diagArgs, photoId: 'd'.repeat(64) }))
            .isError,
        ).toBe(true)
        expect(
          (await call('irodori_get_photo_diagnostics', { ...diagArgs, expectedRevision: 2 }))
            .isError,
        ).toBe(true)
        expect(diagnosticCalls).toHaveLength(2)
      }
      expect(calls).toHaveLength(3)
      const legacy = await call('irodori_get_photo_preview', { photoId, expectedRevision: 3 })
      expect(legacy.isError).not.toBe(true)
      expect((legacy.content as { type: string }[]).filter((c) => c.type === 'image')).toHaveLength(
        1,
      )
      if (managed) expect(legacy.structuredContent).toMatchObject({ displayMismatch })
      else expect(legacy.structuredContent).not.toHaveProperty('displayMismatch')

      const prepared = await call('irodori_prepare_export', { ids: [photoId] })
      expect(prepared.isError).not.toBe(true)
      for (const output of ['hdr', 'sdr'] as const) {
        const proof = await call('irodori_get_output_proof', {
          preparationId: prepared.structuredContent!.id,
          photoId,
          options: { ...defaultExportOptions, output },
          proofToken: crypto.randomUUID(),
        })
        expect(proof.isError, JSON.stringify(proof.content)).not.toBe(true)
        expect(proof.structuredContent).toMatchObject({
          output,
          overview: { rendition: 'SDR overview of decoded JPEG primary' },
        })
        expect(proof.content[1]).toMatchObject({
          type: 'image',
          mimeType: 'image/jpeg',
          data: jpeg,
        })
        if (managed) {
          expect(proof.structuredContent).toMatchObject({ displayMismatch })
          expect(proof.content[0]).toMatchObject({
            type: 'text',
            text: expect.stringContaining(notice),
          })
        } else expect(proof.structuredContent).not.toHaveProperty('displayMismatch')
      }
      const hdr = await call('irodori_get_photo_preview', {
        photoId,
        expectedRevision: 3,
        inspection: { hdr: true },
      })
      expect(hdr.isError).toBe(true)
      expect(JSON.stringify(hdr.content)).toContain('unqualified')
      if (managed) {
        for (const state of ['sdr-frame', 'stale-frame', 'display-unavailable']) {
          present(state === 'sdr-frame' ? 'sdr' : 'hdr', state === 'stale-frame' ? 2 : 3)
          displayAvailable = state !== 'display-unavailable'
          const preview = await call('irodori_get_photo_preview', { photoId, expectedRevision: 3 })
          expect(preview.isError).not.toBe(true)
          expect(preview.structuredContent).not.toHaveProperty('displayMismatch')
        }
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
