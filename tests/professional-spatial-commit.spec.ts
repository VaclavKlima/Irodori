import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { HdrPreview } from '../src/shared/contracts'
import type { EditHistory } from '../src/shared/edits'
import type { DetailPreviewIdentity } from '../src/main/processing/detail-preview'
import { PREVIEW_ASSET_VERSION } from '../src/shared/preview-frame'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { sampleEditorMemory } from './editor-memory.helpers'
import { expectReferenceHdrPreview } from './hdr-test-policy.helpers'
import {
  nativeOriginalHash,
  nativeSensorSource,
  readyNativeEditor,
} from './professional-editor-native.helpers'

const run = promisify(execFile)
const fixture = {
  path: 'assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW',
  sha256: 'dead1a70a02909faf8458119fcc8f7067733b756978fd26921710e3008364605',
} as const
const noiseReduction = { version: 1, luminance: 0, chroma: 0 } as const
const sharp = { version: 1, amount: 50, radius: 1, threshold: 50 } as const

test('the first sharpening variant supports late-reply supersession and a matching retry while preserving the Sony original and exact photo history', async ({
  irodori,
}, info) => {
  // A harness timeout is not a cold-processing speed acceptance threshold.
  test.setTimeout(900000)
  const { app, page, userDataDir } = irodori,
    source = resolve(fixture.path),
    evidence: Record<string, unknown> = {
      version: 'professional-spatial-commit-v1',
      fixture,
      recipe: { noiseReduction, detailSharpening: sharp },
      scope:
        'Hidden functional check with an explicitly SDR display target and a native HDR RAW working source. Upstream decoding is warm before the first sharpening variant. One real preview reply is delivery-held while a newer edit supersedes it; this does not prove in-flight GPU shader cancellation. Retry may reuse a completed variant. Durations are diagnostic, not cold speed acceptance; memory snapshots are not peaks or a physical RAM/VRAM total. No native-input, sustained-cadence, photographic-quality or concurrent import/export claim.',
    },
    memories: Awaited<ReturnType<typeof sampleEditorMemory>>[] = [],
    histories: { phase: string; history: EditHistory }[] = []
  await run('git', ['ls-files', '--error-unmatch', '--', fixture.path])
  await run('git', ['diff', '--quiet', 'HEAD', '--', fixture.path])
  expect(await nativeOriginalHash(source)).toBe(fixture.sha256)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(app, page, [source], false, 'keyboard')
  const photos = await page.evaluate(() => window.irodori.listPhotos())
  expect(photos.total).toBe(1)
  const id = photos.photos[0].id,
    managedOriginal = join(userDataDir, 'library', 'originals', id, 'original.arw'),
    history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
    view = () =>
      page.getByTestId('preview-viewport').evaluate((element) => ({
        mode: element.getAttribute('data-mode'),
        scale: element.getAttribute('data-scale'),
        panX: element.getAttribute('data-pan-x'),
        panY: element.getAttribute('data-pan-y'),
        width: element.getAttribute('data-image-width'),
        height: element.getAttribute('data-image-height'),
      }))
  expect(id).toBe(fixture.sha256)
  expect(await nativeOriginalHash(managedOriginal)).toBe(fixture.sha256)

  async function observedFrame(revision: number) {
    const frame = await readyNativeEditor(page, id, revision)
    await expectReferenceHdrPreview(page)
    const sensor = await nativeSensorSource(userDataDir, id, frame.sourceUrl!),
      url = new URL(frame.sourceUrl!),
      variant = url.pathname.split('/').filter(Boolean)[3],
      directory = join(
        userDataDir,
        'library',
        'cache',
        'previews',
        PREVIEW_ASSET_VERSION,
        `${id}-${variant}`,
      ),
      metadata = JSON.parse(await readFile(join(directory, 'entry.json'), 'utf8')) as {
        sourceKey?: string
        detail?: DetailPreviewIdentity
      }
    return {
      frame,
      sensor,
      directory,
      metadata,
      diagnostics: await page.evaluate(() => window.irodori.getPreviewDiagnostics()),
    }
  }

  const initial = await history(),
    upstream = await observedFrame(0),
    initialView = await view(),
    upstreamFile = join(upstream.directory, 'linear.f32'),
    upstreamHash = await nativeOriginalHash(upstreamFile)
  histories.push({ phase: 'neutral upstream ready', history: initial })
  evidence.initial = { upstream, initialView, upstreamHash }
  expect(initial).toMatchObject({
    revision: 0,
    cursor: 0,
    settings: { processing: 'hdr-v1', noiseReduction, detailSharpening: { amount: 0 } },
  })
  expect(initial.snapshots).toHaveLength(1)
  expect(upstream.sensor.detailSource).toBeUndefined()
  expect(upstreamHash).toBe(upstream.sensor.asset.sha256)
  expect(upstream.sensor.dimensions.width).toBeGreaterThan(5000)
  expect(upstream.sensor.dimensions.height).toBeGreaterThan(3000)

  // Only reply delivery is held. The original handler, cancellation and worker remain real.
  const gate = await app.evaluateHandle(({ ipcMain }, photoId) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers,
      original = handlers.get('preview:hdr'),
      diagnostics = handlers.get('preview:diagnostics')
    if (!original || !diagnostics) throw new Error('The real HDR preview handlers are unavailable.')
    let armed = false,
      release: (() => void) | undefined
    const trace: {
      enteredAt?: number
      settledAt?: number
      deliveredAt?: number
      requestToken?: unknown
      initialDiagnostics?: unknown
      result?: { error?: string; preview?: HdrPreview | null }
      thrown?: string
    } = {}
    const wrapper: Handler = async (...args) => {
      if (!armed || args[1] !== photoId) return original(...args)
      armed = false
      trace.enteredAt = Date.now()
      trace.requestToken = args[2]
      const delivery = new Promise<void>((done) => {
          release = done
        }),
        work = Promise.resolve(original(...args)).then(
          (result) => ({ result: result as { error?: string; preview?: HdrPreview | null } }),
          (error: unknown) => ({ thrown: String(error) }),
        )
      trace.initialDiagnostics = await diagnostics(args[0])
      const outcome = await work
      Object.assign(trace, outcome, { settledAt: Date.now() })
      await delivery
      trace.deliveredAt = Date.now()
      if ('thrown' in outcome) throw new Error(outcome.thrown)
      return outcome.result
    }
    ipcMain.removeHandler('preview:hdr')
    ipcMain.handle('preview:hdr', wrapper)
    return {
      arm() {
        armed = true
      },
      snapshot() {
        return { ...trace }
      },
      release() {
        release?.()
      },
      close() {
        release?.()
        if (handlers.get('preview:hdr') === wrapper) {
          ipcMain.removeHandler('preview:hdr')
          ipcMain.handle('preview:hdr', original)
        }
      },
    }
  }, id)
  let failure: string | undefined
  try {
    memories.push(await sampleEditorMemory(app, 'warm RAW before first sharpening variant'))
    await gate.evaluate((control) => control.arm())
    const coldCommittedAt = Date.now(),
      first = await page.evaluate(
        ({ id, noiseReduction, sharp }) =>
          window.irodori.updateEdits(id, { noiseReduction, detailSharpening: sharp }, 0),
        { id, noiseReduction, sharp },
      )
    evidence.coldCommit = { startedAt: coldCommittedAt, acknowledgedAt: Date.now(), first }
    await expect
      .poll(() => gate.evaluate((control) => control.snapshot().initialDiagnostics), {
        timeout: 120000,
      })
      .toMatchObject({ photoId: id, loadingStage: 'preparing' })
    histories.push({ phase: 'first sharpening commit', history: await history() })
    expect(first.revision).toBe(1)
    expect(first.settings).toEqual({ ...initial.settings, noiseReduction, detailSharpening: sharp })
    const supersededAt = Date.now(),
      second = await page.evaluate(
        ({ id, noiseReduction }) =>
          window.irodori.updateEdits(id, { noiseReduction, detailSharpening: { amount: 0 } }, 1),
        { id, noiseReduction },
      ),
      neutral = await observedFrame(2)
    evidence.supersession = {
      committedAt: supersededAt,
      neutralPresentedAt: Date.now(),
      second,
      neutral,
    }
    histories.push({ phase: 'neutral supersession presented', history: await history() })
    expect(second.settings).toEqual({
      ...first.settings,
      detailSharpening: { ...sharp, amount: 0 },
    })
    expect(neutral.frame.sourceUrl).toBe(upstream.frame.sourceUrl)
    expect(neutral.sensor.asset.sha256).toBe(upstreamHash)
    expect(neutral.sensor.detailSource).toBeUndefined()
    await expect
      .poll(() => gate.evaluate((control) => Boolean(control.snapshot().settledAt)), {
        timeout: 120000,
      })
      .toBe(true)
    const heldReply = await gate.evaluate((control) => control.snapshot())
    evidence.heldReply = {
      ...heldReply,
      outcome: heldReply.thrown
        ? 'thrown error'
        : heldReply.result?.error
          ? 'error reply'
          : heldReply.result?.preview
            ? 'completed asset reply'
            : 'empty reply',
    }
    expect(heldReply.thrown, 'Preparation must return its typed reply.').toBeUndefined()
    if (heldReply.result?.error)
      expect(heldReply.result.error, 'Supersession must not hide an unrelated failure.').toMatch(
        /cancelled/i,
      )
    else expect(heldReply.result?.preview, 'A completed reply must contain its asset.').toBeTruthy()
    await gate.evaluate((control) => control.release())
    await expect
      .poll(() => gate.evaluate((control) => Boolean(control.snapshot().deliveredAt)))
      .toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    )
    const afterLateReply = await observedFrame(2)
    evidence.afterLateReply = afterLateReply
    expect(afterLateReply.frame.sourceUrl).toBe(neutral.frame.sourceUrl)
    expect(afterLateReply.frame.sourceIdentity).toBe(neutral.frame.sourceIdentity)
    expect(afterLateReply.sensor.asset.sha256).toBe(upstreamHash)
    expect(await history()).toEqual(histories[2].history)
    expect(await view()).toEqual(initialView)
    memories.push(await sampleEditorMemory(app, 'superseded reply retired and neutral presented'))

    const retryCommittedAt = Date.now(),
      third = await page.evaluate(
        ({ id, sharp }) => window.irodori.updateEdits(id, { detailSharpening: sharp }, 2),
        { id, sharp },
      ),
      filtered = await observedFrame(3),
      finalHistory = await history()
    histories.push({ phase: 'matching sharpening retry presented', history: finalHistory })
    evidence.retry = {
      committedAt: retryCommittedAt,
      matchingPresentedAt: Date.now(),
      third,
      filtered,
    }
    expect(third.settings).toEqual(first.settings)
    expect(filtered.frame.sourceUrl).not.toBe(upstream.frame.sourceUrl)
    expect(filtered.sensor.detailSource).toEqual({
      sourceIdentity: upstream.metadata.sourceKey,
      asset: {
        width: upstream.sensor.asset.width,
        height: upstream.sensor.asset.height,
        sha256: upstreamHash,
        source: upstream.sensor.asset.source,
        whiteBalance: upstream.sensor.asset.whiteBalance,
      },
      noiseReduction,
      detailSharpening: sharp,
    })
    expect(filtered.metadata.detail).toMatchObject({
      backend: 'gpu',
      cpuTiles: 0,
      precisionRecoveryTiles: 0,
      sourceSha256: upstreamHash,
      noiseReduction,
      detailSharpening: sharp,
    })
    expect(filtered.metadata.detail!.gpuTiles).toBeGreaterThan(0)
    expect(filtered.metadata.detail!.adapter).toBeTruthy()
    expect(filtered.metadata.detail!.fallback).toBeUndefined()
    expect(finalHistory).toMatchObject({
      photoId: id,
      revision: 3,
      cursor: 3,
      settings: first.settings,
      canUndo: true,
      canRedo: false,
    })
    expect(finalHistory.snapshots.map((snapshot) => snapshot.settings)).toEqual([
      initial.settings,
      first.settings,
      second.settings,
      third.settings,
    ])
    expect(finalHistory.snapshots.slice(0, 3)).toEqual(histories[2].history.snapshots)
    expect(finalHistory.snapshots[0]).toEqual(initial.snapshots[0])
    expect(await view()).toEqual(initialView)
    memories.push(await sampleEditorMemory(app, 'matching GPU sharpening retry presented'))
    const preserved = {
      original: await nativeOriginalHash(source),
      managed: await nativeOriginalHash(managedOriginal),
      upstream: await nativeOriginalHash(upstreamFile),
    }
    evidence.preserved = preserved
    expect(preserved).toEqual({
      original: fixture.sha256,
      managed: fixture.sha256,
      upstream: upstreamHash,
    })
    await run('git', ['diff', '--quiet', 'HEAD', '--', fixture.path])
  } catch (error) {
    failure = String(error)
    throw error
  } finally {
    evidence.failure = failure
    evidence.histories = histories
    evidence.memorySnapshots = memories
    evidence.gate = await gate
      .evaluate((control) => {
        control.close()
        return control.snapshot()
      })
      .catch((error: unknown) => ({ unavailable: String(error) }))
    evidence.endingDiagnostics = await page
      .evaluate(() => window.irodori.getPreviewDiagnostics())
      .catch((error: unknown) => ({ unavailable: String(error) }))
    evidence.endingHistory = await history().catch((error: unknown) => ({
      unavailable: String(error),
    }))
    const path = info.outputPath('spatial-commit.json')
    await writeFile(path, JSON.stringify(evidence, null, 2) + '\n')
    await info.attach('spatial-commit', { path, contentType: 'application/json' })
    await gate.dispose()
  }
})
