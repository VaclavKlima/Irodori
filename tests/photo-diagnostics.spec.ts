import { expect, test as base } from '@playwright/test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { PhotoDiagnostics } from '../src/main/agent/photo-diagnostics'
import { encodeDiagnosticOverlays } from '../src/main/mask-edges/diagnostic-overlays'
import type { DiagnosticOverlayMask } from '../src/main/mask-edges/types'
import { SDR_TARGET, type DisplayTarget } from '../src/shared/hdr'
import { hdrStatistics } from '../src/shared/hdr-statistics'
import type { PreviewPresentation } from '../src/shared/preview-diagnostics'
import {
  inspectionHdrCapability,
  INSPECTION_IMAGE_LIMIT,
  INSPECTION_PAIR_LIMIT,
  resolveInspection,
  type InspectionImage,
  type InspectionOptions,
  type PreviewContext,
} from '../src/shared/inspection'
import { emptyImageStatistics } from '../src/shared/statistics'
import { cropAdmission } from './crop-frame.helpers'
import { workingAsset } from './export.helpers'

const photoId = 'a'.repeat(64)
const revision = 4
const gridIdentity = 'committed-cropped-grid'
const region = {
  units: 'normalized' as const,
  gridIdentity,
  x: 0.25,
  y: 0.5,
  width: 0.125,
  height: 0.125,
}
const bounds = { x: 8, y: 12, width: 4, height: 3 }
const size = { width: 4, height: 3 }
const hdrBits = [1, 2, 4, 8, 1, 2, 4, 8, 1, 2, 4, 8]
const sdrBits = [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const currentRequest = () => ({
  photoId,
  expectedRevision: revision,
  target: 'current' as const,
  targetGeneration: 7,
  region: { ...region },
})
const sdrRequest = () => ({
  photoId,
  expectedRevision: revision,
  target: 'sdr' as const,
  region: { ...region },
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-photo-diagnostics-'))
  const directory = join(root, 'cache', 'photo-diagnostics')
  const context: PreviewContext = {
    photoId,
    revision,
    width: 32,
    height: 24,
    gridIdentity,
    coordinateSpace: 'oriented-lens-corrected-cropped-photo',
    sourceDynamicRange: 'hdr',
    formats: ['jpeg', 'png'],
    hdr: inspectionHdrCapability,
    limits: { imageBytes: INSPECTION_IMAGE_LIMIT, pairBytes: INSPECTION_PAIR_LIMIT },
  }
  const frame: PreviewPresentation = {
    photoId,
    revision,
    targetGeneration: 7,
    backend: 'webgpu-hdr',
    mode: 'hdr',
    stage: 'presented',
    reason: '',
    timings: {},
  }
  const target: DisplayTarget = {
    ...SDR_TARGET,
    generation: 7,
    requested: 'hdr',
    mode: 'hdr',
    colorSpace: 'display-p3',
    peak: 4,
    headroom: 2,
    presentation: frame,
  }
  const state = {
    reserved: 0,
    histogramError: '',
    beforeOverlay: async (signal: AbortSignal) => signal.throwIfAborted(),
    afterOverlay: () => {},
  }
  const calls: unknown[][] = []
  const overlays: DiagnosticOverlayMask[][] = []
  const renderingIdentity = 'committed-edit'
  const diagnostics = new PhotoDiagnostics(
    root,
    {
      context: async () => ({ ...context }),
      presentation: async () => ({
        photoId,
        revision,
        workspaceTarget: {
          targetGeneration: target.generation,
          requestedPreference: target.requested,
          mode: target.mode,
          colorSpace: target.colorSpace,
          headroom: target.headroom,
          reason: '',
          physicalOutputVerified: false,
        },
        frame: {
          status: frame.stage,
          mode: frame.mode,
          backend: frame.backend,
          reason: '',
        },
        inspectionHdr: inspectionHdrCapability,
      }),
      getDisplayTarget: () => ({ ...target }),
      hdrMap: async (id, rev, selected, area, output) => {
        calls.push(['hdr map', id, rev, selected, area, output])
        return {
          mask: Uint8Array.from(hdrBits),
          aboveWhite: 3,
          exceedingHeadroom: selected.headroom === null ? null : 3,
          outputClipped: 3,
          gamutLimited: 3,
        }
      },
      hdrStatistics: async (id, rev, selected, area) => {
        calls.push(['hdr histogram', id, rev, selected, area])
        if (state.histogramError) throw new Error(state.histogramError)
        const statistics = hdrStatistics('output', selected, workingAsset(Buffer.alloc(16), 1, 1))
        return { ...statistics, photoId: id, revision: rev, renderingIdentity }
      },
      sdrStatistics: async (id, rev, area, output) => {
        calls.push(['sdr statistics', id, rev, area, output])
        return {
          ...emptyImageStatistics(),
          visiblePixels: 12,
          shadowClipped: 1,
          highlightClipped: 1,
          photoId: id,
          revision: rev,
          renderingIdentity,
          mask: Uint8Array.from(sdrBits),
        }
      },
      photo: async (id, rev, options: InspectionOptions) => {
        calls.push(['sdr base', id, rev, options])
        const resolved = resolveInspection(options, context)
        const { width, height, photoBounds } = resolved
        const png = await sharp({ create: { width, height, channels: 3, background: '#314455' } })
          .png()
          .toBuffer()
        const member: InspectionImage = {
          label: 'after',
          photoId: id,
          revision: rev,
          renderingIdentity,
          gridIdentity: context.gridIdentity,
          width,
          height,
          native: 'photo-native',
          photoBounds,
          bounds: photoBounds,
          nativeGrid: { width: context.width, height: context.height },
          encoding: { format: 'png', lossless: true },
          mimeType: 'image/png',
          colorSpace: 'srgb',
          sourceDynamicRange: context.sourceDynamicRange,
          requestedRendition: 'sdr',
          effectiveRendition: 'sdr',
          hdr: inspectionHdrCapability,
          rendition: 'sRGB SDR rendition',
          comparison: 'current revision',
          byteLength: png.length,
          data: png.toString('base64'),
        }
        return { photoId: id, revision: rev, gridIdentity: context.gridIdentity, members: [member] }
      },
      admission: async () => cropAdmission(),
      reserve: async (bytes) => {
        state.reserved += bytes
        return Object.assign(() => (state.reserved -= bytes), { shrink: () => {} })
      },
    },
    {
      diagnosticOverlays: async (input, signal) => {
        overlays.push(input.masks)
        await state.beforeOverlay(signal)
        const output = await encodeDiagnosticOverlays(input)
        state.afterOverlay()
        return output
      },
      close: async () => {},
    },
  )
  return {
    context,
    target,
    frame,
    state,
    diagnostics,
    calls,
    overlays,
    directory,
    close: async () => {
      await diagnostics.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const test = base.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
  f: async ({}, use) => {
    const f = await fixture()
    try {
      await use(f)
    } finally {
      await f.close()
    }
  },
})

function readMasks(masks: DiagnosticOverlayMask[]) {
  return masks.map(({ label, targetMode, dataBase64 }) => [
    label,
    targetMode,
    ...Buffer.from(dataBase64, 'base64'),
  ])
}

test('pins the committed crop and presented HDR target', async ({ f }) => {
  const request = currentRequest()
  const work = f.diagnostics.get(request, new AbortController().signal)
  request.region.x = 0
  request.targetGeneration = 8
  const result = await work
  expect(result).toMatchObject({
    photoId,
    revision,
    gridIdentity,
    bounds,
    nativeGrid: { width: 32, height: 24 },
    target: {
      selection: 'current',
      mode: 'hdr',
      generation: 7,
      colorSpace: 'display-p3',
      headroom: 2,
    },
    histogram: {
      status: 'available',
      value: { domain: 'output-hdr', exact: true, statistics: { domain: 'output' } },
    },
    clipping: { status: 'available', value: { exact: true, counts: { output: 3 } } },
    aboveWhite: {
      status: 'available',
      value: { referenceWhite: 1, count: 3, exceedingHeadroom: 3, gamutLimited: 3 },
    },
  })
  expect(f.calls).toEqual([
    ['hdr map', photoId, revision, f.target, bounds, size],
    ['hdr histogram', photoId, revision, f.target, bounds],
    ['sdr base', photoId, revision, { region, encoding: { format: 'png' } }],
  ])
  expect(readMasks(f.overlays[0])).toEqual([
    ['clipping', 'hdr', ...hdrBits],
    ['above-white', 'hdr', ...hdrBits],
  ])
  expect(result.images).toMatchObject([
    { label: 'clipping', ...size, mimeType: 'image/png' },
    { label: 'above-white', ...size, mimeType: 'image/png' },
  ])
  expect(f.state.reserved).toBe(0)
  expect(await readdir(f.directory)).toEqual([])
})

test('uses SDR clipping and retains HDR source coverage', async ({ f }) => {
  f.frame.mode = 'sdr'
  const result = await f.diagnostics.get(currentRequest(), new AbortController().signal)
  expect(f.calls).toEqual([
    ['hdr map', photoId, revision, SDR_TARGET, bounds, size],
    ['sdr statistics', photoId, revision, bounds, size],
    ['sdr base', photoId, revision, { region, encoding: { format: 'png' } }],
  ])
  expect(readMasks(f.overlays[0])).toEqual([
    ['clipping', 'sdr', ...sdrBits],
    ['above-white', 'sdr', ...hdrBits],
  ])
  expect(result).toMatchObject({
    target: { selection: 'current', mode: 'sdr', generation: 7, colorSpace: 'srgb' },
    histogram: { status: 'available', value: { domain: 'output-sdr' } },
    clipping: { status: 'available', value: { counts: { highlights: 1, shadows: 1 } } },
    aboveWhite: {
      status: 'available',
      value: { count: 3, exceedingHeadroom: null, gamutLimited: null },
    },
  })

  f.context.sourceDynamicRange = 'sdr'
  const fixed = await f.diagnostics.get(sdrRequest(), new AbortController().signal)
  expect(fixed).toMatchObject({
    target: { selection: 'sdr', mode: 'sdr', generation: 0 },
    aboveWhite: { status: 'unavailable', reason: 'This photograph has an SDR source.' },
  })
  expect(fixed.images.map(({ label }) => label)).toEqual(['clipping'])
})

test('keeps diagnostic maps when the histogram fails', async ({ f }) => {
  f.state.histogramError = 'HDR statistics worker unavailable.'
  const result = await f.diagnostics.get(currentRequest(), new AbortController().signal)
  expect(result.histogram).toEqual({ status: 'unavailable', reason: f.state.histogramError })
  expect(result.clipping.status).toBe('available')
  expect(result.aboveWhite.status).toBe('available')
  expect(result.images.map(({ label }) => label)).toEqual(['clipping', 'above-white'])
})

test('refuses stale grids, display targets, and revisions', async ({ f }) => {
  const signal = new AbortController().signal
  await expect(
    f.diagnostics.get({ ...currentRequest(), targetGeneration: 6 }, signal),
  ).rejects.toThrow('display or photo revision changed')
  await expect(
    f.diagnostics.get(
      {
        ...currentRequest(),
        region: { ...region, gridIdentity: 'previous-crop' },
      },
      signal,
    ),
  ).rejects.toThrow('inspection grid changed')
  expect(f.calls).toEqual([])
  f.state.afterOverlay = () => {
    f.context.revision++
  }
  await expect(f.diagnostics.get(sdrRequest(), signal)).rejects.toThrow('revision changed')
  f.context.revision = revision
  f.state.afterOverlay = () => {
    f.target.generation++
  }
  await expect(f.diagnostics.get(currentRequest(), signal)).rejects.toThrow(
    'display or photo revision changed',
  )
  expect(f.state.reserved).toBe(0)
  expect(await readdir(f.directory)).toEqual([])
})

test('serializes diagnostics and drains owned overlays on removal', async ({ f }) => {
  const signal = new AbortController().signal
  let started = false,
    drained = false
  f.state.beforeOverlay = async (overlaySignal) => {
    try {
      overlaySignal.throwIfAborted()
      await new Promise<never>((_resolve, reject) => {
        overlaySignal.addEventListener('abort', () => reject(overlaySignal.reason), { once: true })
        started = true
      })
    } finally {
      drained = true
    }
  }
  const work = f.diagnostics.get(sdrRequest(), signal)
  void work.catch(() => {})
  await expect.poll(() => started).toBe(true)
  expect(() => f.diagnostics.get(sdrRequest(), signal)).toThrow('diagnostics are busy')
  expect(await readdir(f.directory)).toHaveLength(1)
  await f.diagnostics.beginRemoval(photoId)
  await expect(work).rejects.toThrow('photograph is being removed')
  expect(drained).toBe(true)
  expect(() => f.diagnostics.get(sdrRequest(), signal)).toThrow('being removed')
  expect(f.state.reserved).toBe(0)
  expect(await readdir(f.directory)).toEqual([])
  f.diagnostics.endRemoval(photoId)
  f.state.beforeOverlay = async () => {}
  expect((await f.diagnostics.get(sdrRequest(), signal)).clipping.status).toBe('available')
})
