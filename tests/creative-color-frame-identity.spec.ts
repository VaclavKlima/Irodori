import { expect, test } from '@playwright/test'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import { colorRangeIds, neutralColorMixer } from '../src/shared/color-mixer'
import { gradingToneIds, neutralColorGrading } from '../src/shared/color-grading'
import { initialSettings, validatePatch, validateProcessingPatch } from '../src/shared/edits'
import { SDR_TARGET } from '../src/shared/hdr'
import {
  HDR_FIRST_SURFACE_VERSION,
  hdrFirstSurfaceRequestKey,
  validateHdrFirstSurfaceRequest,
  type HdrFirstSurfaceRequest,
} from '../src/shared/hdr-first-surface'
import {
  hdrPresentationIdentity,
  type HdrPresentationIdentityInput,
} from '../src/renderer/src/preview/hdr-presentation-cache'
import {
  HdrPipelineCache,
  type HdrPipelines,
  type HdrPipelineProfile,
} from '../src/renderer/src/preview/hdr-pipelines'
import { EditGestureCommits } from '../src/renderer/src/hooks/edit-gesture-commit'

const parameters = (): AdjustmentParameters => ({
  ...neutralAdjustments,
  colorMixer: structuredClone(neutralColorMixer),
  colorGrading: structuredClone(neutralColorGrading),
})
const first = (p: AdjustmentParameters): HdrFirstSurfaceRequest => ({
  version: HDR_FIRST_SURFACE_VERSION,
  generation: 2,
  settingsRevision: 7,
  parameters: p,
  target: { ...SDR_TARGET, generation: 3 },
  viewport: { width: 32, height: 16 },
  dpr: 1,
  view: { fit: true, scale: 1, x: 0, y: 0 },
  comparison: 'after',
  split: 0.5,
  hdrRanges: false,
  kernel: 'linear64',
  rendererReservation: { ramBytes: 0, vramBytes: 0 },
})
const presentation = (p: AdjustmentParameters): HdrPresentationIdentityInput => ({
  confirmed: true,
  sourceIdentity: 'small-color-reference',
  sourceSha256: 'a'.repeat(64),
  renderingPolicy: 'reference',
  settingsRevision: 7,
  adjustments: p,
  target: { ...SDR_TARGET, generation: 3 },
  comparison: 'after',
  split: 0.5,
  hdrRanges: false,
  image: { width: 32, height: 16 },
  viewport: { width: 32, height: 16 },
  view: { fit: true, scale: 1, x: 0, y: 0 },
  dpr: 1,
})

test('first-surface and completed-frame identities retain old defaults and every authored color control', () => {
  const keys = (p: AdjustmentParameters) => [
      hdrFirstSurfaceRequestKey(first(p)),
      hdrPresentationIdentity(presentation(p))!.key,
    ],
    original = keys({ ...neutralAdjustments })
  expect(keys(parameters())).toEqual(original)
  for (const id of colorRangeIds)
    for (const field of ['hue', 'saturation', 'luminance'] as const) {
      const p = parameters()
      Object.assign(p.colorMixer!.ranges[id], { [field]: 1 })
      keys(p).forEach((key, i) => expect(key, `${id}.${field}`).not.toBe(original[i]))
    }
  for (const id of gradingToneIds)
    for (const field of ['hue', 'saturation', 'luminance'] as const) {
      const p = parameters()
      Object.assign(p.colorGrading!.tones[id], { [field]: 1 })
      keys(p).forEach((key, i) => expect(key, `${id}.${field}`).not.toBe(original[i]))
    }
  for (const field of ['blending', 'balance']) {
    const p = parameters()
    Object.assign(p.colorGrading!, { [field]: 1 })
    keys(p).forEach((key, i) => expect(key, field).not.toBe(original[i]))
  }
  const p = parameters()
  Object.assign(p.colorMixer!.ranges.red, { hue: 4 })
  const reordered = structuredClone(p)
  Object.assign(reordered.colorMixer!, {
    ranges: Object.fromEntries(Object.entries(reordered.colorMixer!.ranges).reverse()),
  })
  expect(keys(reordered)).toEqual(keys(p))
})

test('processing requires complete color groups while edit patches can address individual controls', () => {
  const p = parameters()
  expect(() => validateProcessingPatch(p)).not.toThrow()
  expect(() => validateHdrFirstSurfaceRequest(first(p))).not.toThrow()
  expect(() => validatePatch({ colorMixer: p.colorMixer })).not.toThrow()
  expect(() => validatePatch({ colorGrading: p.colorGrading })).not.toThrow()
  expect(() => validatePatch({ colorMixer: { ranges: { red: { hue: 5 } } } })).not.toThrow()
  expect(() => validateProcessingPatch({ colorMixer: { ranges: { red: { hue: 5 } } } })).toThrow()
  const invalid: unknown[] = [
    { ...p, colorMixer: null },
    { ...p, colorMixer: { ...p.colorMixer, version: 2 } },
    { ...p, colorMixer: { version: 1, ranges: { red: neutralColorMixer.ranges.red } } },
    { ...p, colorGrading: { ...p.colorGrading, balance: NaN } },
    { ...p, colorGrading: { ...p.colorGrading, blending: 101 } },
    { ...p, colorGrading: { ...p.colorGrading, hidden: true } },
  ]
  for (const bad of invalid) {
    expect(() => validateProcessingPatch(bad)).toThrow()
    expect(() => validateHdrFirstSurfaceRequest(first(bad as AdjustmentParameters))).toThrow()
    expect(hdrPresentationIdentity(presentation(bad as AdjustmentParameters))).toBeNull()
  }
})

test('color gesture snapshots freeze nested settings and conflicting powerless hues invalidate acceptance', () => {
  const commits = new EditGestureCommits(),
    scope = { photoId: 'color-photo', enabled: true },
    base = {
      photoId: scope.photoId,
      revision: 4,
      settings: initialSettings(),
      canUndo: true,
      canRedo: false,
    },
    p = parameters()
  Object.assign(p.colorGrading!.tones.shadows, { hue: 230.5 })
  Object.assign(p.colorMixer!.ranges.blue, { saturation: -10 })
  commits.enter(scope)
  const commit = commits.begin(scope, base, 12, p)!,
    accepted = { ...base, revision: 5, settings: { ...base.settings, ...structuredClone(p) } }
  expect(Object.isFrozen(commit.parameters.colorMixer!.ranges.blue)).toBe(true)
  expect(Object.isFrozen(commit.parameters.colorGrading!.tones.shadows)).toBe(true)
  expect(Object.isFrozen(commit.parameters.colorMixer!.ranges)).toBe(true)
  expect(Object.isFrozen(commit.parameters.colorGrading!.tones)).toBe(true)
  Object.assign(p.colorMixer!.ranges.blue, { saturation: 80 })
  Object.assign(p.colorGrading!.tones.shadows, { hue: 180 })
  expect(commit.parameters.colorMixer!.ranges.blue.saturation).toBe(-10)
  expect(commit.parameters.colorGrading!.tones.shadows.hue).toBe(230.5)
  const conflicting = structuredClone(accepted)
  Object.assign(conflicting.settings.colorGrading!.tones.shadows, { hue: 230.6 })
  commits.observe(conflicting)
  expect(commits.snapshot).toBeNull()
  commits.succeeded(scope, commit.id, accepted)
  expect(commits.snapshot).toBeNull()
})

function device() {
  let lose!: () => void
  return {
    value: {
      lost: new Promise<GPUDeviceLostInfo>((resolve) => {
        lose = () =>
          resolve({ reason: 'destroyed', message: 'Synthetic retirement.' } as GPUDeviceLostInfo)
      }),
    } as GPUDevice,
    lose: () => lose(),
  }
}

test('grading programs are lazy, share pending base preparation and retry without rebuilding ready base programs', async () => {
  const d = device(),
    base = { mip: { label: 'base' } } as HdrPipelines,
    advanced = { mip: base.mip } as HdrPipelines,
    calls: { profile: HdrPipelineProfile; base?: HdrPipelines }[] = []
  let finish!: (p: HdrPipelines) => void,
    attempts = 0
  const cache = new HdrPipelineCache(async (_device, profile, previous) => {
    calls.push({ profile, base: previous })
    if (!profile.creative)
      return new Promise<HdrPipelines>((resolve) => {
        finish = resolve
      })
    expect(previous).toBe(base)
    if (++attempts === 1) throw new Error('Synthetic grading compiler failure.')
    return advanced
  })
  const old = cache.acquire(d.value, { interactive: true })
  await Promise.resolve()
  expect(calls).toHaveLength(1)
  const profile = { interactive: true, creative: true },
    pending = cache.acquire(d.value, profile),
    shared = cache.acquire(d.value, profile)
  profile.creative = false
  expect(pending.pipelines).toBe(shared.pipelines)
  await Promise.resolve()
  expect(calls).toHaveLength(1)
  finish(base)
  expect(await old.pipelines).toBe(base)
  await expect(pending.pipelines).rejects.toThrow('Synthetic grading compiler failure')
  const retry = cache.acquire(d.value, { interactive: true, creative: true })
  expect(retry.state).toBe('cold')
  expect(await retry.pipelines).toBe(advanced)
  expect(calls.map((call) => call.profile)).toEqual([
    { interactive: true },
    { interactive: true, creative: true },
    { interactive: true, creative: true },
  ])
  expect(calls.every((call) => Object.isFrozen(call.profile))).toBe(true)
  expect(cache.acquire(d.value, { interactive: true }).pipelines).toBe(old.pipelines)
  expect(cache.acquire(d.value, { interactive: true, creative: true }).state).toBe('ready')
})

test('device loss during pending grading compilation rejects its result and prevents reuse', async () => {
  const d = device()
  let finish!: (p: HdrPipelines) => void, entered!: () => void
  const compiling = new Promise<void>((resolve) => {
    entered = resolve
  })
  const cache = new HdrPipelineCache(async (_device, profile) =>
    profile.creative
      ? new Promise<HdrPipelines>((resolve) => {
          finish = resolve
          entered()
        })
      : ({} as HdrPipelines),
  )
  const pending = cache.acquire(d.value, { interactive: false, creative: true })
  // Wait for the base promise and the dependent compiler, without a wall-clock sleep.
  await compiling
  d.lose()
  await Promise.resolve()
  finish({} as HdrPipelines)
  await expect(pending.pipelines).rejects.toThrow('device was lost')
  expect(() => cache.acquire(d.value, { interactive: false, creative: true })).toThrow(
    'device was lost',
  )
})
