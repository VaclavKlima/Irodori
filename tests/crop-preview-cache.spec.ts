import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { cropGeometry, identityCrop } from '../src/shared/crop'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import { SDR_TARGET } from '../src/shared/hdr'
import { cropWorkingFrame } from '../src/main/processing/crop-frame'
import { workingSourceIdentity } from '../src/main/working-assets'
import { PREVIEW_VERSION } from '../src/main/full-previews'
import { cropAdmission } from './crop-frame.helpers'
import { cropPreviewFixture, gate } from './crop-preview.helpers'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import { noLensSettings } from '../src/shared/lens'
import { processingMetadata } from '../src/main/processing/metadata'

const previousBackend = process.env.IRODORI_PREVIEW_BACKEND
test.beforeEach(() => {
  process.env.IRODORI_PREVIEW_BACKEND = 'cpu'
})
test.afterEach(() => {
  if (previousBackend === undefined) delete process.env.IRODORI_PREVIEW_BACKEND
  else process.env.IRODORI_PREVIEW_BACKEND = previousBackend
})

test('the first color change reuses the decoded original in RAM without rereading its prepared file', async () => {
  const root = test.info().outputPath('warm-original'),
    source = join(root, 'source.png'),
    firstDirectory = join(root, 'first'),
    nextDirectory = join(root, 'next'),
    engine = new PreviewEngine()
  await mkdir(firstDirectory, { recursive: true })
  await mkdir(nextDirectory)
  await sharp({
    create: { width: 17, height: 13, channels: 4, background: { r: 73, g: 110, b: 152, alpha: 1 } },
  })
    .png()
    .toFile(source)
  const before = await readFile(source),
    options = {
      metadata: processingMetadata({}, []),
      settings: noLensSettings,
      revision: 0,
      prepareLinear: true,
    }
  try {
    const first = await engine.renderFull(source, firstDirectory, undefined, options),
      next = await engine.renderFull(source, nextDirectory, undefined, {
        ...options,
        prepareLinear: false,
        revision: 1,
        adjustments: { ...neutralAdjustments, exposureEv: 0.5 },
        workingAsset: {
          ...first.linear!,
          width: first.width,
          height: first.height,
          path: join(root, 'must-not-read-prepared.f32'),
        },
      })
    expect(next.diagnostics?.timings.reusedWorking).toBe(1)
    expect(next.sha256).not.toBe(first.sha256)
    expect([next.width, next.height]).toEqual([17, 13])
    expect(await readFile(source)).toEqual(before)
  } finally {
    await engine.close()
  }
})

test('a cached crop cannot stand in for the original or for different prepared pixels of the same size', async () => {
  const root = test.info().outputPath('variant-ram'),
    source = join(root, 'source.png'),
    engine = new PreviewEngine(),
    options = {
      metadata: processingMetadata({}, []),
      settings: noLensSettings,
      revision: 0,
    }
  await mkdir(root)
  await sharp({
    create: { width: 17, height: 13, channels: 4, background: { r: 73, g: 110, b: 152, alpha: 1 } },
  })
    .png()
    .toFile(source)
  try {
    const hashes: string[] = []
    for (const value of [0.2, 0.4]) {
      const directory = join(root, String(value)),
        data = new Float32Array(5 * 7 * 4).fill(value)
      for (let i = 3; i < data.length; i += 4) data[i] = 1
      await mkdir(directory)
      const path = join(directory, 'input.f32'),
        bytes = new Uint8Array(data.buffer)
      await writeFile(path, bytes)
      const rendered = await engine.renderFull(source, directory, undefined, {
        ...options,
        workingAsset: {
          path,
          width: 5,
          height: 7,
          byteLength: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          transform: srgbTransform,
        },
      })
      expect([rendered.width, rendered.height]).toEqual([5, 7])
      hashes.push(rendered.sha256)
    }
    expect(hashes[0]).not.toBe(hashes[1])
    const originalDirectory = join(root, 'original')
    await mkdir(originalDirectory)
    const original = await engine.renderFull(source, originalDirectory, undefined, options)
    expect([original.width, original.height]).toEqual([17, 13])
    expect(original.diagnostics?.timings.reusedWorking).toBeUndefined()
  } finally {
    await engine.close()
  }
})

test('raster crop variants reuse the uncropped decode across grading, authoring locks, translation, reset and restart', async () => {
  const f = await cropPreviewFixture()
  try {
    const initial = structuredClone(f.options.crop!),
      first = await f.previews.requestEditing(f.id, randomUUID()),
      geometry = cropGeometry(f.native, initial)
    expect(first.crop).toEqual(geometry)
    expect([first.width, first.height]).toEqual([geometry.width, geometry.height])
    expect(f.counters.sources).toBe(1)
    expect(f.counters.crops).toBe(1)
    const { data, info } = await sharp(f.path)
        .autoOrient()
        .toColourspace('scrgb')
        .ensureAlpha()
        .raw({ depth: 'float' })
        .toBuffer({ resolveWithObject: true }),
      expected = await cropWorkingFrame(
        {
          data: new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
          width: info.width,
          height: info.height,
          transform: srgbTransform,
        },
        { settings: initial, admission: cropAdmission(), backend: 'cpu' },
        new AbortController().signal,
      ),
      lease = f.previews.acquire(new URL(first.linear!.url!))!
    try {
      expect(await readFile(lease.path)).toEqual(Buffer.from(expected.frame.data.buffer))
    } finally {
      lease.release()
    }
    f.change({ adjustments: { ...neutralAdjustments, exposureEv: 0.5, saturation: 35 } })
    const graded = await f.previews.requestEditing(f.id, randomUUID())
    expect(graded.linear!.url).toBe(first.linear!.url)
    expect(graded.linear!.sha256).toBe(first.linear!.sha256)
    expect(graded.renderId).not.toBe(first.renderId)
    expect(f.counters.crops).toBe(1)
    const locked = {
      ...initial,
      aspectRatio: (initial.width * f.native.width) / (initial.height * f.native.height),
    }
    f.change({ crop: locked })
    const lock = await f.previews.requestEditing(f.id, randomUUID())
    expect(lock.linear!.url).toBe(first.linear!.url)
    expect(f.counters.crops).toBe(1)
    f.change({ crop: { ...locked, centerX: 0.55 } })
    const translated = await f.previews.requestEditing(f.id, randomUUID())
    expect([translated.width, translated.height]).toEqual([first.width, first.height])
    expect(translated.linear!.url).not.toBe(first.linear!.url)
    expect(translated.crop!.outputToSource).not.toEqual(first.crop!.outputToSource)
    expect(f.counters.crops).toBe(2)
    expect(f.counters.sources).toBe(1)
    await f.restart()
    const cached = await f.previews.requestEditing(f.id, randomUUID())
    expect(cached.url).toBe(translated.url)
    expect(cached.crop).toEqual(translated.crop)
    expect(f.previews.getDiagnostics().cacheHit).toBe(true)
    expect(f.counters.crops).toBe(2)
    expect(f.counters.sources).toBe(1)
    f.change({ crop: { ...identityCrop } })
    const reset = await f.previews.requestEditing(f.id, randomUUID())
    expect(reset.crop).toBeUndefined()
    expect([reset.width, reset.height]).toEqual([f.native.width, f.native.height])
    expect(f.counters.sources).toBe(1)
    expect(f.counters.crops).toBe(2)
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    await f.close()
  }
})

test('HDR preview, CPU recovery and statistics use cropped data while white-balance sampling and export lease the uncropped source', async () => {
  const f = await cropPreviewFixture(true),
    signal = new AbortController().signal
  try {
    const frame = (await f.previews.requestHdr(f.id, randomUUID()))!,
      geometry = cropGeometry(f.native, f.options.crop!)
    expect(frame.crop).toEqual(geometry)
    expect(frame.linear.hdr.width).toBe(geometry.width)
    const cpu = await f.previews.acquireCpuWorkingSource(
      { source: frame.cpuSource!, expectedSettingsRevision: 0 },
      signal,
    )
    try {
      expect(cpu.asset.width).toBe(geometry.width)
      expect(cpu.asset.height).toBe(geometry.height)
      await cpu.check(0, signal)
    } finally {
      await cpu.release()
    }
    const exported = (await f.previews.acquireWorkingAsset(f.id, f.options, signal))!
    try {
      expect(exported.identity).toBe(workingSourceIdentity(f.id, f.options))
      expect(exported.asset.width).toBe(f.native.width)
      expect(exported.asset.sha256).toBe(f.asset.sha256)
      expect(await readFile(exported.asset.path)).toEqual(f.bytes)
    } finally {
      exported.release()
    }
    await f.previews.hdrStatistics(f.id, 0, 'working-hdr', SDR_TARGET)
    expect(f.counters.statisticsWidth).toBe(geometry.width)
    const proposed = await f.previews.proposeWhiteBalance(f.id, 0, { x: 0.5, y: 0.5, diameter: 15 })
    expect(proposed.area.centerX).toBe(Math.floor(f.native.width * 0.5))
    expect(proposed.area.centerY).toBe(Math.floor(f.native.height * 0.5))
    expect(f.counters.sampleWidth).toBe(f.native.width)
    expect(f.counters.sampleHash).toBe(f.asset.sha256)
    const context = await f.previews.getCropContext(f.id, 0)
    expect(context.source).toEqual(f.native)
    expect(context.settings).toEqual(f.options.crop)
    expect(context.geometry).toEqual(geometry)
    expect(f.counters.sources).toBe(1)
    expect(f.counters.crops).toBe(1)
    f.change({ crop: { ...f.options.crop!, centerX: 0.55 } })
    await expect(
      f.previews.acquireCpuWorkingSource(
        { source: frame.cpuSource!, expectedSettingsRevision: 1 },
        signal,
      ),
    ).rejects.toThrow('identity changed')
    const moved = (await f.previews.requestHdr(f.id, randomUUID()))!
    expect(moved.linear.sha256).not.toBe(frame.linear.sha256)
    expect(f.counters.sources).toBe(1)
    expect(f.counters.crops).toBe(2)
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    await f.close()
  }
})

test('refused crop admission publishes no variant and a later retry reuses the completed base', async () => {
  const f = await cropPreviewFixture()
  try {
    const admission = cropAdmission()
    Object.assign(admission.policy.ram, { effectiveBytes: 1 })
    f.previews.installCropAdmission(async () => admission)
    await expect(f.previews.requestEditing(f.id, randomUUID())).rejects.toThrow(
      'managed image budgets',
    )
    const directories = await readdir(join(f.root, 'cache', PREVIEW_VERSION))
    expect(directories.some((name) => name.startsWith('.tmp-'))).toBe(false)
    expect(f.counters.sources).toBe(1)
    f.previews.installCropAdmission(async () => cropAdmission())
    const ready = await f.previews.requestEditing(f.id, randomUUID())
    expect(ready.crop).toBeTruthy()
    expect(f.counters.sources).toBe(1)
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    await f.close()
  }
})

for (const hdr of [false, true])
  test(`the transient ${hdr ? 'HDR' : 'raster'} crop source reuses native pixels and restores committed geometry without decoding`, async () => {
    const f = await cropPreviewFixture(hdr),
      token = randomUUID(),
      signal = new AbortController().signal
    try {
      const before = structuredClone(f.options),
        source = await f.previews.requestCropSource(f.id, token, 0)
      expect(source.sourceSpace).toBe('uncropped')
      expect(source.crop).toBeUndefined()
      expect({ width: source.width, height: source.height }).toEqual(f.native)
      expect(source.linear?.url).toBeTruthy()
      expect(f.counters.crops).toBe(0)
      expect(f.options).toEqual(before)
      if (hdr) {
        const cpu = await f.previews.acquireCpuWorkingSource(
          { source: source.cpuSource!, expectedSettingsRevision: 0 },
          signal,
        )
        try {
          expect({ width: cpu.asset.width, height: cpu.asset.height }).toEqual(f.native)
          await cpu.check(0, signal)
          await f.previews.release(token)
          await expect(cpu.check(0, signal)).rejects.toThrow('identity changed')
          await expect(
            f.previews.acquireCpuWorkingSource(
              { source: source.cpuSource!, expectedSettingsRevision: 0 },
              signal,
            ),
          ).rejects.toThrow('identity changed')
        } finally {
          await cpu.release()
        }
      }
      const committed = hdr
        ? await f.previews.requestHdr(f.id, randomUUID())
        : await f.previews.requestEditing(f.id, randomUUID())
      expect(committed?.crop).toEqual(cropGeometry(f.native, before.crop!))
      expect(committed?.sourceSpace).toBeUndefined()
      const again = await f.previews.requestCropSource(f.id, randomUUID(), 0)
      expect(again.linear!.sha256).toBe(source.linear!.sha256)
      expect(f.counters.sources).toBe(1)
      expect(f.counters.crops).toBe(1)
      await expect(f.previews.requestCropSource(f.id, randomUUID(), 1)).rejects.toThrow(
        'revision conflict',
      )
      expect(f.options).toEqual(before)
      expect(await readFile(f.path)).toEqual(f.original)
    } finally {
      await f.close()
    }
  })

test('removal waits for crop-worker retirement before releasing the protected source or unpublished directory', async () => {
  const f = await cropPreviewFixture(),
    entered = gate(),
    retired = gate()
  let sourcePath = '',
    stopped = false
  try {
    f.beforeCrop(async (job, signal) => {
      sourcePath = job.asset.path
      entered.resolve()
      await new Promise<void>((done) =>
        signal.addEventListener('abort', () => done(), { once: true }),
      )
      await retired.promise
      stopped = true
      signal.throwIfAborted()
    })
    const pending = f.previews.requestEditing(f.id, randomUUID())
    void pending.catch(() => {})
    await entered.promise
    let removed = false
    const removing = f.previews.beginRemoval(f.id).then(() => {
      removed = true
    })
    await new Promise((done) => setImmediate(done))
    expect(removed).toBe(false)
    expect(stopped).toBe(false)
    expect((await stat(sourcePath)).isFile()).toBe(true)
    retired.resolve()
    await removing
    await expect(pending).rejects.toThrow('cancelled')
    expect(stopped).toBe(true)
    f.previews.endRemoval(f.id, false)
    expect(await readFile(f.path)).toEqual(f.original)
  } finally {
    retired.resolve()
    await f.close()
  }
})

for (const framingSource of [false, true])
  test(`native crop ${framingSource ? 'source' : 'context'} rejects stale revisions before and after asynchronous preparation`, async () => {
    const f = await cropPreviewFixture(),
      entered = gate(),
      ready = gate()
    try {
      const request = (revision: number) =>
        framingSource
          ? f.previews.requestCropSource(f.id, randomUUID(), revision)
          : f.previews.getCropContext(f.id, revision)
      await expect(request(-1)).rejects.toThrow('Invalid crop context')
      expect(f.counters.sources).toBe(0)
      f.beforeSource(async () => {
        entered.resolve()
        await ready.promise
      })
      const pending = request(0)
      void pending.catch(() => {})
      await entered.promise
      f.change({ adjustments: { ...neutralAdjustments, saturation: 35 } }, false)
      ready.resolve()
      await expect(pending).rejects.toThrow('revision conflict')
      const current = await request(1)
      if ('source' in current) {
        expect(current.source).toEqual(f.native)
        expect(current.revision).toBe(1)
      } else {
        expect({ width: current.width, height: current.height }).toEqual(f.native)
        expect(current.settingsRevision).toBe(1)
      }
      expect(f.counters.crops).toBe(0)
      expect(f.counters.sources).toBe(1)
    } finally {
      ready.resolve()
      await f.close()
    }
  })
