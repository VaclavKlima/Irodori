/* eslint-disable no-empty-pattern -- Playwright requires destructured fixture arguments. */
import { expect, test, type TestInfo } from '@playwright/test'
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { FullPreviews, PREVIEW_VERSION } from '../src/main/full-previews'
import { PreviewProcess } from '../src/main/preview-process'
import type { FullPreviewProcessor } from '../src/main/preview-types'
import type { MaskStackPreparationJob } from '../src/main/processing/mask-stack-preparation'
import { prepareMaskMutation } from '../src/main/mask-store'
import { hasMaskAdjustments, neutralMaskEdge, resolveMasks } from '../src/shared/masks'
import { defaultLuminanceMaskRange } from '../src/shared/mask-ranges'
import { mapMaskCoverage } from '../src/shared/masks-gpu'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { ProcessingOptions } from '../src/shared/lens'
import { identityCrop, fitCrop } from '../src/shared/crop'
import { detailPreviewFixture } from './detail-preview.helpers'
import { generatedMask } from './helpers/generated-mask'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture(hdr = false, authored = false, budget?: number) {
  const source = await detailPreviewFixture(hdr, authored),
    root = join(source.root, 'texture-cache'),
    id = sha(source.originalBytes)
  const first = randomUUID(),
    second = randomUUID()
  const masks = prepareMaskMutation([], {
    operations: [
      {
        kind: 'create',
        id: second,
        name: 'Earlier Light',
        gradient: { kind: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      },
      { kind: 'update', id: second, light: { contrast: 10 } },
      {
        kind: 'create',
        id: first,
        name: 'Texture',
        gradient: {
          kind: 'radial',
          center: { x: 0.55, y: 0.43 },
          radiusX: 0.32,
          radiusY: 0.3,
          rotation: 0,
          feather: 45,
        },
      },
      { kind: 'update', id: first, texture: 25, light: { shadows: 12 }, color: { saturation: 8 } },
    ],
  })
  let options: ProcessingOptions = {
    ...structuredClone(source.job.options),
    crop: { ...identityCrop },
    adjustments: {
      ...structuredClone(source.job.options.adjustments!),
      localMasks: resolveMasks(masks.stack, masks.chunks),
    },
  }
  const counters = { sources: 0, texture: 0, crops: 0, proofs: 0 }
  const adapters: string[] = []
  let beforeTexture: (
    job: MaskStackPreparationJob,
    signal: AbortSignal,
  ) => Promise<void> = async () => {}
  const create = async () => {
    const worker = new PreviewProcess(resolve('out/main/preview-worker.js'))
    const processor: FullPreviewProcessor = {
      async renderFull(path, output, signal, selected) {
        if (selected?.workingAsset) {
          counters.proofs++
          return worker.renderPreparedFull(output, selected, signal, 'gpu')
        }
        counters.sources++
        if (!hdr || (authored && !selected?.workingOnly))
          return worker.renderFull(path, output, signal, selected)
        signal.throwIfAborted()
        await copyFile(source.job.asset.path, join(output, 'linear.f32'))
        return {
          width: source.frame.width,
          height: source.frame.height,
          format: 'hdr-working',
          byteLength: 0,
          placeholderBytes: 0,
          sha256: source.job.asset.sha256,
          renderId: `synthetic-texture-parent-${source.job.asset.sha256}`,
          linear: {
            byteLength: source.job.asset.byteLength,
            sha256: source.job.asset.sha256,
            hdr: structuredClone(source.job.asset.hdr),
            transform: structuredClone(source.job.asset.transform),
          },
          adjustments: selected?.adjustments,
          settingsRevision: selected?.revision,
        }
      },
      async prepareMaskStack(output, job, signal) {
        counters.texture++
        await beforeTexture(job, signal)
        signal.throwIfAborted()
        const result = await worker.prepareMaskStack(output, job, signal)
        if (result.adapter) adapters.push(result.adapter)
        return result
      },
      async renderPreparedFull(output, selected, signal, backend, prepared) {
        counters.proofs++
        return worker.renderPreparedFull(output, selected, signal, backend, prepared)
      },
      async prepareCropPreview(path, output, job, signal) {
        counters.crops++
        return worker.prepareCropPreview(path, output, job, signal)
      },
      async prepareDetailPreview(path, output, job, signal) {
        return worker.prepareDetailPreview(path, output, job, signal)
      },
      close: () => worker.close(true),
      releaseFrame: () => worker.releaseFrame(),
    }
    const previews = new FullPreviews(
      root,
      (photoId) => (photoId === id ? source.original : undefined),
      processor,
      budget,
      async () => structuredClone(options),
    )
    const admission = async () =>
      structuredClone({ policy: source.job.policy, reservation: source.job.reservation })
    previews.installDetailAdmission(admission)
    previews.installCropAdmission(admission)
    await previews.open()
    return previews
  }
  let previews = await create()
  return {
    source,
    root,
    id,
    first,
    second,
    counters,
    adapters,
    get options() {
      return options
    },
    get previews() {
      return previews
    },
    change(patch: Partial<ProcessingOptions>) {
      options = { ...options, ...structuredClone(patch), revision: options.revision + 1 }
      previews.settingsChanged(id)
    },
    changePoint(patch: Partial<AdjustmentParameters>) {
      options = {
        ...options,
        adjustments: { ...options.adjustments!, ...structuredClone(patch) },
        revision: options.revision + 1,
      }
      previews.settingsChanged(id)
    },
    beforeTexture(work: typeof beforeTexture) {
      beforeTexture = work
    },
    async entries() {
      return Promise.all(
        (await readdir(join(root, PREVIEW_VERSION)))
          .filter((name) => !name.startsWith('.tmp-'))
          .map(async (name) => {
            const path = join(root, PREVIEW_VERSION, name)
            return { path, metadata: JSON.parse(await readFile(join(path, 'entry.json'), 'utf8')) }
          }),
      )
    },
    async restart() {
      await previews.close()
      previews = await create()
    },
    async close() {
      await previews.close()
      await source.close()
    },
  }
}
async function leasedBytes(previews: FullPreviews, url: string) {
  const lease = previews.acquire(new URL(url))
  expect(lease).toBeDefined()
  try {
    return await readFile(lease!.path)
  } finally {
    lease!.release()
  }
}
async function hdrFiles(
  previews: FullPreviews,
  descriptor: NonNullable<import('../src/shared/hdr').HdrWorkingAsset['preparedMasks']>,
  width: number,
) {
  for (const [name, file, channels] of [
    ['candidate', descriptor.candidate, 4],
    ['union', descriptor.union, 1],
  ] as const) {
    const bytes = await leasedBytes(previews, file.url)
    expect(bytes.length).toBe(file.byteLength)
    expect(sha(bytes)).toBe(file.sha256)
    for (const [index, strip] of file.strips.entries()) {
      const part = bytes.subarray(
        index * 64 * width * channels * 4,
        (index + 1) * 64 * width * channels * 4,
      )
      expect(part.length, `${name} strip${index}`).toBe(strip.byteLength)
      expect(sha(part)).toBe(strip.sha256)
    }
  }
}

test('cold frozen versions prepare each saved Texture stack after its own source-stage Detail', async () => {
  test.setTimeout(180000)
  for (const hdr of [false, true]) {
    const f = await fixture(hdr, hdr),
      tokens = [randomUUID(), randomUUID()]
    try {
      const current = structuredClone(f.options),
        a: ProcessingOptions = {
          ...structuredClone(current),
          revision: 11,
          noiseReduction: { ...f.source.job.noiseReduction, luminance: 8 },
          detailSharpening: { ...f.source.job.detailSharpening, amount: 10 },
          adjustments: {
            ...current.adjustments!,
            exposureEv: 0.15,
            localMasks: current.adjustments!.localMasks!.map((mask) => ({
              ...mask,
              texture: mask.texture ? 8 : 0,
            })),
          },
        },
        b: ProcessingOptions = {
          ...structuredClone(a),
          revision: 17,
          detailSharpening: { ...a.detailSharpening!, amount: 30 },
          adjustments: {
            ...a.adjustments!,
            exposureEv: 0.4,
            localMasks: a.adjustments!.localMasks!.map((mask) => ({
              ...mask,
              texture: mask.texture ? 25 : 0,
            })),
          },
        },
        first = await f.previews.requestFrozen(f.id, tokens[0], a, hdr ? 'hdr' : 'sdr'),
        second = await f.previews.requestFrozen(f.id, tokens[1], b, hdr ? 'hdr' : 'sdr')
      expect(f.counters.texture).toBe(2)
      expect(first.linear!.preparedMasks!.key).toMatch(/^[a-f0-9]{64}$/)
      expect(second.linear!.preparedMasks!.key).toMatch(/^[a-f0-9]{64}$/)
      expect(first.linear!.preparedMasks!.key).not.toBe(second.linear!.preparedMasks!.key)
      if (hdr) {
        expect(first.linear!.hdr!.preparedMasks).toEqual(first.linear!.preparedMasks)
        expect(second.linear!.hdr!.preparedMasks).toEqual(second.linear!.preparedMasks)
        await hdrFiles(f.previews, first.linear!.hdr!.preparedMasks!, first.width)
        await hdrFiles(f.previews, second.linear!.hdr!.preparedMasks!, second.width)
      }
      expect(f.options).toEqual(current)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
    } finally {
      await Promise.all(tokens.map((token) => f.previews.release(token)))
      await f.close()
    }
  }
})

test('Texture preview reclaims idle versions of the same photo after hiding a mask', async ({}, info) => {
  const budget = 8 * 1024 ** 2
  const f = await fixture(true, false, budget)
  const request = () => f.previews.requestHdr(f.id, randomUUID(), false, 'sdr')
  let idleLease: ReturnType<FullPreviews['acquire']>
  let displayedLease: ReturnType<FullPreviews['acquire']>
  let releaseStorage: (() => void) | undefined
  try {
    const rangePart = {
      id: randomUUID(),
      name: 'Luminance part',
      operator: 'intersect' as const,
      enabled: true,
      inverted: false,
      head: null,
      edge: neutralMaskEdge,
      strokes: [],
      range: defaultLuminanceMaskRange,
    }
    f.changePoint({
      localMasks: f.options.adjustments!.localMasks!.map((mask) =>
        mask.id === f.second ? { ...mask, operands: [rangePart] } : mask,
      ),
    })
    const { width, height } = f.source.frame
    const rangeCoverage = { ...generatedMask(width, height, () => 192), key: 'a'.repeat(64) }
    f.previews.configureMaskRanges(async (_id, _options, masks) =>
      masks.map((mask) =>
        mask.enabled && hasMaskAdjustments(mask)
          ? mapMaskCoverage(mask, (node) =>
              node.range ? { ...node, preparedRangeBase: rangeCoverage } : node,
            )
          : mask,
      ),
    )
    const idle = (await request())!
    f.changePoint({ exposureEv: 0.25 })
    const displayed = (await request())!
    const idleCandidate = idle.linear.hdr.preparedMasks!.candidate
    const displayedCandidate = displayed.linear.hdr.preparedMasks!.candidate
    idleLease = f.previews.acquire(new URL(idleCandidate.url))
    displayedLease = f.previews.acquire(new URL(displayedCandidate.url))
    expect(idleLease).toBeDefined()
    expect(displayedLease).toBeDefined()

    const retainedBytes = (await f.entries()).reduce(
      (total, entry) => total + entry.metadata.bytes,
      0,
    )
    const requestedBytes = displayed.width * displayed.height * 24 + 128 * 1024
    releaseStorage = await f.previews.reserveRangeCoverageBytes(
      budget - retainedBytes - requestedBytes + idleCandidate.byteLength,
    )
    const localMasks = f.options.adjustments!.localMasks!.map((mask) =>
      mask.id === f.second ? { ...mask, enabled: false } : mask,
    )
    f.changePoint({ localMasks })

    await expect(request()).rejects.toThrow('Texture preview exceeds the preview storage limit')
    idleLease!.release()
    idleLease = undefined

    const rebuilt = (await request())!
    expect(rebuilt.settingsRevision).toBe(f.options.revision)
    expect(rebuilt.adjustments?.localMasks?.find((mask) => mask.id === f.second)).toMatchObject({
      enabled: false,
      operands: [{ id: rangePart.id, enabled: true, range: defaultLuminanceMaskRange }],
    })
    expect(rebuilt.linear.sha256).toBe(displayed.linear.sha256)
    expect(rebuilt.linear.hdr.preparedMasks!.key).not.toBe(displayed.linear.hdr.preparedMasks!.key)
    expect(f.previews.acquire(new URL(idleCandidate.url))).toBeUndefined()
    expect(sha(await readFile(displayedLease!.path))).toBe(displayedCandidate.sha256)
    expect(f.counters.texture).toBe(3)
    await info.attach('texture-adapter', {
      body: JSON.stringify([...new Set(f.adapters)]),
      contentType: 'application/json',
    })
  } finally {
    idleLease?.release()
    displayedLease?.release()
    releaseStorage?.()
    await f.close()
  }
})

test('production Texture preview variants retain parent lineage, native HDR file leases and cache identity across edits and restart', async ({}, info: TestInfo) => {
  test.setTimeout(180000)
  const evidence = []
  for (const [hdr, authored] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const f = await fixture(hdr, authored)
    try {
      const after = await f.previews.requestEditing(f.id, randomUUID())
      expect(after.preparedMaskStack?.key).toMatch(/^[a-f0-9]{64}$/)
      expect(after.requiresUnfilteredComparison).toBe(true)
      expect(after.workingSource).toBeDefined()
      const parent = await leasedBytes(f.previews, after.linear!.url!)
      expect(sha(parent)).toBe(after.linear!.sha256)
      const count = f.counters.texture,
        cached = await f.previews.requestEditing(f.id, randomUUID())
      expect(cached.url).toBe(after.url)
      expect(cached.preparedMaskStack?.key).toBe(after.preparedMaskStack?.key)
      expect(f.counters.texture).toBe(count)
      if (hdr) {
        const hdrFrame = (await f.previews.requestHdr(f.id, randomUUID()))!
        expect(hdrFrame.linear.hdr.preparedMasks).toBeDefined()
        expect(hdrFrame.linear.sha256).toBe(f.source.job.asset.sha256)
        expect(await leasedBytes(f.previews, hdrFrame.linear.url!)).toEqual(
          await readFile(f.source.job.asset.path),
        )
        await hdrFiles(f.previews, hdrFrame.linear.hdr.preparedMasks!, hdrFrame.width)
        if (authored) expect(hdrFrame.preparedMaskStack?.key).not.toBe(after.preparedMaskStack?.key)
      }
      const beforeToken = randomUUID(),
        before = await f.previews.requestComparison(
          after.workingSource!,
          beforeToken,
          f.options.revision,
        )
      expect(before.preparedMaskStack).toBeUndefined()
      expect(before.linear?.hdr?.preparedMasks).toBeUndefined()
      expect(before.adjustments).toEqual(neutralAdjustments)
      await f.previews.release(beforeToken)
      const prior = f.counters.texture
      await f.restart()
      const reopened = await f.previews.requestEditing(f.id, randomUUID())
      expect(reopened.url).toBe(after.url)
      expect(reopened.preparedMaskStack?.key).toBe(after.preparedMaskStack?.key)
      expect(f.counters.texture).toBe(prior)
      f.changePoint({ exposureEv: 0.5 })
      const changed = await f.previews.requestEditing(f.id, randomUUID())
      expect(changed.preparedMaskStack?.key).not.toBe(after.preparedMaskStack?.key)
      expect(f.counters.texture).toBe(prior + 1)
      if (!hdr) {
        const local = structuredClone(f.options.adjustments!.localMasks!)
        local[1].light.contrast = 11
        f.changePoint({ localMasks: local })
        const earlier = await f.previews.requestEditing(f.id, randomUUID())
        expect(earlier.preparedMaskStack?.key).not.toBe(changed.preparedMaskStack?.key)
        f.changePoint({ localMasks: [...local].reverse() })
        const reordered = await f.previews.requestEditing(f.id, randomUUID())
        expect(reordered.preparedMaskStack?.key).not.toBe(earlier.preparedMaskStack?.key)
        f.change({ crop: fitCrop(f.source.frame, { ...identityCrop, width: 0.8, height: 0.8 }) })
        const cropped = await f.previews.requestEditing(f.id, randomUUID())
        expect(cropped.preparedMaskStack?.key).not.toBe(reordered.preparedMaskStack?.key)
        expect(cropped.width).toBeLessThan(after.width)
      }
      const settingsBeforeFraming = structuredClone(f.options),
        beforeFraming = f.counters.texture,
        framingToken = randomUUID()
      const framing = await f.previews.requestCropSource(f.id, framingToken, f.options.revision)
      expect(framing.sourceSpace).toBe('uncropped')
      expect([framing.width, framing.height]).toEqual([f.source.frame.width, f.source.frame.height])
      expect(framing.preparedMaskStack).toBeUndefined()
      expect(framing.linear?.hdr?.preparedMasks).toBeUndefined()
      expect(framing.adjustments?.localMasks?.every((mask) => (mask.texture ?? 0) === 0)).toBe(true)
      expect(
        framing.adjustments?.localMasks?.map(({ light, color }) => ({ light, color })),
      ).toEqual(
        settingsBeforeFraming.adjustments!.localMasks!.map(({ light, color }) => ({
          light,
          color,
        })),
      )
      expect(f.counters.texture).toBe(beforeFraming)
      expect(f.options).toEqual(settingsBeforeFraming)
      await f.previews.release(framingToken)
      expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
      expect(f.adapters.length).toBeGreaterThan(0)
      for (const adapter of new Set(f.adapters))
        info.annotations.push({ type: 'adapter', description: adapter })
      expect(sha(await readFile(f.source.job.asset.path))).toBe(f.source.job.asset.sha256)
      evidence.push({
        hdr,
        authored,
        counters: { ...f.counters },
        initialKey: after.preparedMaskStack!.key,
        parentSha256: sha(parent),
      })
    } finally {
      await f.close()
    }
  }
  await writeFile(info.outputPath('preview-cases.json'), JSON.stringify(evidence, null, 2) + '\n')
})

test('damaged and cancelled Texture cache attempts preserve the immutable source and the last complete prepared result', async () => {
  test.setTimeout(120000)
  const f = await fixture()
  try {
    const after = await f.previews.requestEditing(f.id, randomUUID())
    const entries = await f.entries(),
      entry = entries.find(
        (entry) => entry.metadata.preparedMaskStack?.key === after.preparedMaskStack?.key,
      )!
    expect(entry).toBeDefined()
    await f.previews.close()
    const path = join(entry.path, 'mask-stack.f32'),
      original = await readFile(path)
    // Main cache reopening checks completeness; same-size hash corruption is caught by strip consumers.
    await writeFile(path, original.subarray(0, original.length - 4))
    const prior = f.counters.texture
    await f.restart()
    const repaired = await f.previews.requestEditing(f.id, randomUUID())
    expect(repaired.preparedMaskStack?.key).toBe(after.preparedMaskStack?.key)
    expect(f.counters.texture).toBe(prior + 1)
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.beforeTexture(async (_job, signal) => {
      entered()
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('Cancelled synthetic Texture gate.'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    })
    f.changePoint({ exposureEv: 0.6 })
    const token = randomUUID(),
      pending = f.previews.requestEditing(f.id, token)
    const rejected = expect(pending).rejects.toThrow(/cancel/i)
    await started
    await f.previews.release(token)
    await rejected
    f.beforeTexture(async () => {})
    f.changePoint({ exposureEv: 0.4 })
    const kept = await f.previews.requestEditing(f.id, randomUUID())
    expect(kept.preparedMaskStack?.key).toBe(repaired.preparedMaskStack?.key)
    expect(
      (await readdir(join(f.root, PREVIEW_VERSION))).filter((name) => name.startsWith('.tmp-')),
    ).toEqual([])
    expect(await readFile(f.source.original)).toEqual(f.source.originalBytes)
  } finally {
    await f.close()
  }
  const hdr = await fixture(true)
  try {
    const before = (await hdr.previews.requestHdr(hdr.id, randomUUID()))!
    const descriptor = before.linear.hdr.preparedMasks!
    const entries = await hdr.entries(),
      entry = entries.find((entry) => entry.metadata.preparedMaskStack?.key === descriptor.key)!
    const path = join(entry.path, 'mask-stack.f32'),
      bytes = await readFile(path),
      changed = Buffer.from(bytes)
    changed[0] ^= 1
    await writeFile(path, changed)
    const previous = hdr.counters.texture
    // HDR acquisition hashes the candidate on use, even if its size/metadata still match.
    const repaired = (await hdr.previews.requestHdr(hdr.id, randomUUID()))!
    expect(hdr.counters.texture).toBe(previous + 1)
    expect(repaired.linear.hdr.preparedMasks!.key).toBe(descriptor.key)
    expect(repaired.linear.hdr.preparedMasks!.parentSha256).toBe(before.linear.sha256)
    await hdrFiles(hdr.previews, repaired.linear.hdr.preparedMasks!, repaired.width)
    const candidateLease = hdr.previews.acquire(
      new URL(repaired.linear.hdr.preparedMasks!.candidate.url),
    )!
    const metadataPath = join(dirname(candidateLease.path), 'entry.json')
    candidateLease.release()
    await hdr.previews.close()
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    metadata.maskStackFiles.pointKey = 'wrong-effective-point-context'
    await writeFile(metadataPath, JSON.stringify(metadata))
    const beforeContextRepair = hdr.counters.texture
    await hdr.restart()
    const contextRepaired = (await hdr.previews.requestHdr(hdr.id, randomUUID()))!
    expect(hdr.counters.texture).toBe(beforeContextRepair + 1)
    expect(contextRepaired.linear.hdr.preparedMasks!.key).toBe(descriptor.key)
    expect(contextRepaired.linear.hdr.preparedMasks!.pointKey).toBe(
      repaired.linear.hdr.preparedMasks!.pointKey,
    )
    await hdrFiles(hdr.previews, contextRepaired.linear.hdr.preparedMasks!, contextRepaired.width)
    expect(await readFile(hdr.source.original)).toEqual(hdr.source.originalBytes)
  } finally {
    await hdr.close()
  }
})
