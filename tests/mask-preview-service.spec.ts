import { test, expect } from '@playwright/test'
import { mkdtemp, lstat, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { MaskPreviews, type MaskPreviewOwner } from '../src/main/agent/mask-previews'
import { identity } from '../src/main/export/files'
import {
  inspectionHdrCapability,
  type InspectionResult,
  type PreviewContext,
} from '../src/shared/inspection'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { type EditState } from '../src/shared/edits'
import { type ResolvedMask, neutralMaskLight } from '../src/shared/masks'
import { gradientMask } from './helpers/mask-gradients'
import { cropAdmission } from './crop-frame.helpers'
import { syntheticExportSource, sha } from './export.helpers'
import type { MaskEdgeProcess } from '../src/main/mask-edges/process'
import type { MaskEdgeWorkerRequest } from '../src/main/mask-edges/types'
import type { MaskCoverageRequest } from '../src/shared/mask-edges'
import { generatedMask } from './helpers/generated-mask'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'irodori-mask-preview-'))
  const source = await syntheticExportSource(root, 32, 24, () => [0.2, 0.3, 0.4])
  source.identity = identity(await lstat(source.path))
  let revision = source.processing.revision,
    reserved = 0,
    photoCalls = 0,
    closed = false
  let grid = 'grid'
  const mask = gradientMask({ kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } })
  mask.enabled = false
  mask.light = { ...neutralMaskLight }
  const inputs: Omit<MaskEdgeWorkerRequest, 'id'>[] = []
  const preparations: MaskCoverageRequest[] = []
  let gate: ((signal: AbortSignal) => Promise<void>) | undefined
  let afterRender: (() => void) | undefined
  const context = (): PreviewContext => ({
    photoId: source.photo.id,
    revision,
    width: 32,
    height: 24,
    gridIdentity: grid,
    geometry: identityMaskGeometry(32, 24),
    coordinateSpace: 'oriented-lens-corrected-cropped-photo',
    sourceDynamicRange: 'hdr',
    formats: ['jpeg', 'png'],
    hdr: inspectionHdrCapability,
    limits: { imageBytes: 8 * 1024 ** 2, pairBytes: 16 * 1024 ** 2 },
  })
  const png = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: '#203040' } })
      .png()
      .toBuffer()
  const owner: MaskPreviewOwner = {
    source: async () => source,
    edits: async () => ({ photoId: source.photo.id, revision }) as EditState,
    masks: () => [mask],
    context: async () => context(),
    admission: async () => cropAdmission(),
    reserve: async (bytes) => {
      reserved += bytes
      let held = bytes,
        released = false
      return Object.assign(
        () => {
          if (!released) {
            reserved -= held
            released = true
          }
        },
        {
          shrink(next: number) {
            if (released || next > held) throw new Error('Invalid shrink.')
            reserved -= held - next
            held = next
          },
        },
      )
    },
    prepareCoverage: async (request) => {
      preparations.push(request)
      const base = generatedMask(32, 24, () => 128)
      const asset = { ...base, version: 1 as const, key: '1'.repeat(64) }
      return {
        photoId: source.photo.id,
        revision,
        sourceIdentity: 'source',
        coverages: { [mask.id]: asset },
        rangeBases: { [mask.id]: asset },
      }
    },
    photo: async (_id, _revision, options) => {
      photoCalls++
      const { resolveInspection } = await import('../src/shared/inspection')
      const resolved = resolveInspection(options, context()),
        bytes = await png(resolved.width, resolved.height)
      return {
        photoId: source.photo.id,
        revision,
        gridIdentity: grid,
        members: [
          {
            label: 'after',
            width: resolved.width,
            height: resolved.height,
            photoId: source.photo.id,
            revision,
            gridIdentity: grid,
            native: 'photo-native',
            nativeGrid: { width: 32, height: 24 },
            mimeType: 'image/png',
            colorSpace: 'srgb',
            encoding: { format: 'png', lossless: true },
            effectiveRendition: 'sdr',
            photoBounds: resolved.photoBounds,
            bounds: resolved.bounds,
            data: bytes.toString('base64'),
            byteLength: bytes.byteLength,
            renderingIdentity: 'photo-render',
          },
        ],
      } as InspectionResult
    },
  }
  const runtime: Pick<MaskEdgeProcess, 'preview' | 'close'> = {
    preview: async (request, signal) => {
      inputs.push(structuredClone(request))
      await gate?.(signal)
      signal.throwIfAborted()
      const labels =
        request.inspection.view === 'coverage'
          ? (['coverage'] as const)
          : request.inspection.view === 'overlay'
            ? (['overlay'] as const)
            : (['coverage', 'overlay'] as const)
      const members = []
      for (const label of labels) {
        const path = `${request.outputPath}.${label}.png`,
          bytes = await png(request.width, request.height)
        await writeFile(path, bytes)
        members.push({
          label,
          path,
          width: request.width,
          height: request.height,
          key: request.key,
          hash: sha(bytes),
          encodedBytes: bytes.byteLength,
        })
      }
      afterRender?.()
      return { key: request.key, members }
    },
    close: async () => {
      closed = true
    },
  }
  const previews = new MaskPreviews(root, owner, runtime)
  return {
    root,
    source,
    mask,
    inputs,
    preparations,
    previews,
    owner,
    runtime,
    request: () => ({
      photoId: source.photo.id,
      expectedRevision: source.processing.revision,
      maskId: mask.id,
    }),
    reserved: () => reserved,
    photoCalls: () => photoCalls,
    closed: () => closed,
    gate: (value: typeof gate) => {
      gate = value
    },
    after: (value: typeof afterRender) => {
      afterRender = value
    },
    change: () => {
      revision++
    },
    grid: () => {
      grid = 'changed'
    },
    close: async () => {
      await previews.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('disabled neutral root still inspects stored shape, returns aligned pair and leaves history untouched', async () => {
  const f = await fixture()
  try {
    const before = JSON.stringify(f.source),
      result = await f.previews.get(f.request())
    expect(result).toMatchObject({
      enabled: false,
      adjustmentsNeutral: true,
      coverageSemantics: 'stored-mask-shape',
      revision: 4,
    })
    expect(
      result.members.map((member) => [
        member.label,
        member.width,
        member.height,
        member.colorSpace,
      ]),
    ).toEqual([
      ['coverage', 32, 24, 'coverage'],
      ['overlay', 32, 24, 'srgb'],
    ])
    expect(result.members[0].photoBounds).toEqual(result.members[1].photoBounds)
    expect(
      result.members.every((member) => sha(Buffer.from(member.data, 'base64')) === member.hash),
    ).toBe(true)
    expect(f.preparations).toHaveLength(0)
    expect(f.inputs[0].mask.preparedCoverage).toBeUndefined()
    expect(JSON.stringify(f.source)).toBe(before)
    expect(f.reserved()).toBe(0)
    expect(await readdir(join(f.root, 'cache', 'mask-previews'))).toEqual([])
  } finally {
    await f.close()
  }
})
test('only existing roots are accepted; edge/range nodes prepare without baking analytic root and disabled operands do not execute', async () => {
  const f = await fixture()
  try {
    const child: ResolvedMask = {
      ...f.mask,
      id: '00000000-0000-0000-0000-000000000002',
      enabled: false,
      edge: { featherPx: 3, shiftPx: 0 },
    }
    f.mask.operands = [{ ...child, operator: 'add' }]
    await expect(f.previews.get({ ...f.request(), maskId: child.id })).rejects.toThrow(
      'existing root',
    )
    await f.previews.get({ ...f.request(), view: 'coverage' })
    expect(f.preparations).toHaveLength(0)
    expect(f.photoCalls()).toBe(0)
    // Range replacement removes the mutually exclusive analytic primary.
    f.mask.gradient = undefined
    f.mask.range = { version: 1, kind: 'luminance', lower: 25, upper: 75, softness: 0 }
    await f.previews.get({ ...f.request(), view: 'coverage' })
    expect(f.preparations).toHaveLength(1)
    expect(f.inputs.at(-1)?.mask.preparedRangeBase).toBeDefined()
    expect(f.inputs.at(-1)?.mask.preparedCoverage).toBeUndefined()
    f.mask.edge.featherPx = 2
    await f.previews.get({ ...f.request(), view: 'coverage' })
    expect(f.inputs.at(-1)?.mask.preparedCoverage).toBeDefined()
  } finally {
    await f.close()
  }
})
test('stale revision and final grid changes refuse the entire result and release files/claims', async () => {
  const f = await fixture()
  try {
    f.after(f.grid)
    await expect(f.previews.get(f.request())).rejects.toThrow('grid changed')
    expect(f.reserved()).toBe(0)
    f.after(f.change)
    await expect(f.previews.get({ ...f.request(), view: 'coverage' })).rejects.toThrow(
      'revision changed',
    )
    expect(f.reserved()).toBe(0)
  } finally {
    await f.close()
  }
})
test('removal aborts owned work, drains cleanup and blocks requests until recovery; close retires worker', async () => {
  const f = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.gate(async (signal) => {
    entered()
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
    )
  })
  try {
    const work = f.previews.get(f.request())
    const rejected = expect(work).rejects.toThrow('cancelled')
    await started
    await f.previews.beginRemoval(f.source.photo.id)
    await rejected
    expect(f.reserved()).toBe(0)
    await expect(f.previews.get(f.request())).rejects.toThrow('being removed')
    f.previews.endRemoval(f.source.photo.id)
    f.gate(undefined)
    await f.previews.get({ ...f.request(), view: 'coverage' })
    await f.previews.close()
    expect(f.closed()).toBe(true)
    await expect(f.previews.get(f.request())).rejects.toThrow('closing')
  } finally {
    await f.close()
  }
})

test('memory and encoded payload refusals never silently reduce a request and leave no output claim', async () => {
  const f = await fixture()
  try {
    const admission = cropAdmission()
    Object.assign(admission.policy.ram, { effectiveBytes: 1 })
    f.owner.admission = async () => admission
    await expect(f.previews.get(f.request())).rejects.toThrow('image-memory budget')
    expect(f.inputs).toHaveLength(0)
    expect(f.reserved()).toBe(0)
    f.owner.admission = async () => cropAdmission()
    const render = f.runtime.preview
    f.runtime.preview = async (request, signal) => {
      const output = await render(request, signal)
      const member = output.members[0]
      const bytes = Buffer.alloc(8 * 1024 ** 2 + 1)
      await writeFile(member.path, bytes)
      member.encodedBytes = bytes.length
      member.hash = sha(bytes)
      return output
    }
    await expect(f.previews.get({ ...f.request(), view: 'coverage' })).rejects.toThrow(
      'image delivery limit',
    )
    expect(f.inputs.at(-1)).toMatchObject({ width: 32, height: 24 })
    expect(f.reserved()).toBe(0)
    expect(await readdir(join(f.root, 'cache', 'mask-previews'))).toEqual([])
  } finally {
    await f.close()
  }
})

test('a changed source and pre-aborted request refuse before publishing any member', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await expect(f.previews.get(f.request(), controller.signal)).rejects.toThrow('caller cancelled')
    expect(f.inputs).toHaveLength(0)
    f.after(() => {
      f.source.identity.mtimeMs++
    })
    await expect(f.previews.get({ ...f.request(), view: 'coverage' })).rejects.toThrow(
      'source changed',
    )
    expect(f.reserved()).toBe(0)
  } finally {
    await f.close()
  }
})
