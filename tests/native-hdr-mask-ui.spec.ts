import { writeFile } from 'node:fs/promises'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './electron.fixture'
import { activateButton } from './button.helpers'
import { importPhotos } from './import.helpers'
import { neutralAdjustments } from '../src/shared/adjustments'
import {
  emptyClippingOverlay,
  installAnalysisHashGate,
  observeAnalysisActivity,
  observeAnalysisMessages,
  observeGpuAnalysisOwners,
  settledHealthyPreview,
} from './hdr-analysis-cancel.helpers'

test.use({ hdrDisplay: true })

async function prepare(luma: { app: ElectronApplication; page: Page }) {
  const { app, page } = luma
  const activity = await observeAnalysisActivity(app)
  let messages: Awaited<ReturnType<typeof observeAnalysisMessages>> | undefined
  let owners: Awaited<ReturnType<typeof observeGpuAnalysisOwners>> | undefined
  let gate: Awaited<ReturnType<typeof installAnalysisHashGate>> | undefined
  try {
    messages = await observeAnalysisMessages(page)
    owners = await observeGpuAnalysisOwners(page)
    await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'keyboard')
    const before = await settledHealthyPreview(page)
    const actual = await messages.evaluate((control) => control.state())
    expect(actual.asset?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(actual.workerCount).toBe(1)
    expect(before.source).toContain(actual.asset!.sha256)
    expect(before.epoch).toBeTruthy()
    const matches = page
      .workers()
      .filter((worker) => /\/hdr-analysis-worker-[^/]+\.js(?:\?|$)/.test(worker.url()))
    expect(matches).toHaveLength(1)
    const worker = matches[0]
    expect(await page.evaluate(() => window.luma.getCpuPreviewBackend())).toBe('native')
    gate = await installAnalysisHashGate(worker, actual.asset!, true)
    const gpu = await owners.evaluate((control) => control.mark())
    expect(gpu.baselineTextures).toBeGreaterThan(0)
    const photos = await page.evaluate(() => window.luma.listPhotos())
    expect(photos.photos).toHaveLength(1)
    const photoId = photos.photos[0].id
    await expect
      .poll(async () => {
        const state = await activity.evaluate((control) => control.state())
        return state.events.filter((event) => event.photoId === photoId).at(-1)?.active
      })
      .toBe(false)
    return { page, activity, messages, owners, gate, worker, asset: actual.asset!, before, photoId }
  } catch (error) {
    await gate?.release().catch(() => undefined)
    await gate?.close().catch(() => undefined)
    await activateButton(page.getByRole('button', { name: 'Library', exact: true })).catch(
      () => undefined,
    )
    await messages?.evaluate((control) => control.close()).catch(() => undefined)
    await owners?.evaluate((control) => control.close()).catch(() => undefined)
    await activity.evaluate((control) => control.close()).catch(() => undefined)
    await Promise.allSettled([messages?.dispose(), owners?.dispose(), activity.dispose()])
    throw error
  }
}
type Prepared = Awaited<ReturnType<typeof prepare>>

async function finish(value: Prepared) {
  const { page, gate, worker, activity, messages, owners } = value
  const errors: unknown[] = []
  const cleanup = async (work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (error) {
      errors.push(error)
    }
  }
  // Release the test-only promise first, then stop the real source lifecycle.
  // No outstanding gate can make component or fixture cleanup wait on itself.
  if (page.workers().includes(worker)) {
    await cleanup(() => gate.release())
    await cleanup(() => gate.close())
  }
  await cleanup(() => activateButton(page.getByRole('button', { name: 'Library', exact: true })))
  await cleanup(() => expect.poll(() => page.workers().includes(worker)).toBe(false))
  await cleanup(() => messages.evaluate((control) => control.close()))
  await cleanup(() => owners.evaluate((control) => control.close()))
  await cleanup(() => activity.evaluate((control) => control.close()))
  await cleanup(() => messages.dispose())
  await cleanup(() => owners.dispose())
  await cleanup(() => activity.dispose())
  if (errors.length)
    throw new AggregateError(errors, 'Analysis cancellation fixture cleanup failed.')
}

for (const reenable of [false, true]) {
  test(`native mask cancellation drains a genuine pending full-mask SHA${reenable ? ' and stale completion cannot release re-enabled work' : ''}`, async ({
    luma,
  }, info) => {
    test.setTimeout(90000)
    const value = await prepare(luma)
    const { page, gate, messages, activity, owners, photoId, before } = value
    const clipping = page.getByRole('button', { name: 'Canvas channel clipping', exact: true })
    let evidence: unknown
    try {
      const initialActivity = (await activity.evaluate((control) => control.state())).events.length
      const initialReplies = (await messages.evaluate((control) => control.state())).replies.length
      await gate.arm()
      await activateButton(clipping)
      await expect(clipping).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => (await gate.state()).held).toBe(true)
      const first = (await messages.evaluate((control) => control.state())).posts.at(-1)!
      expect(first.kind).toBe('request')
      expect(first.masks).toBe(true)
      await expect
        .poll(async () =>
          (await activity.evaluate((control) => control.state())).events
            .slice(initialActivity)
            .some((event) => event.photoId === photoId && event.active),
        )
        .toBe(true)
      await activateButton(clipping)
      await expect(clipping).toHaveAttribute('aria-pressed', 'false')
      const off = (await messages.evaluate((control) => control.state())).posts.at(-1)!
      expect(off.kind).toBe('cancel')
      expect(off.generation).toBeGreaterThan(first.generation)
      // The observed real signal abort proves the worker received cancellation,
      // while the genuine hash result is still owned behind the async gate.
      await expect.poll(async () => (await gate.state()).aborts).toBe(1)
      expect((await gate.state()).held).toBe(true)
      expect((await gate.state()).reads).toBe(1)
      expect(await emptyClippingOverlay(page)).toBe(true)
      expect(
        (await messages.evaluate((control) => control.state())).replies.some(
          (reply) => reply.generation === off.generation && reply.done,
        ),
      ).toBe(false)
      expect(
        (await activity.evaluate((control) => control.state())).events
          .slice(initialActivity)
          .filter((event) => event.photoId === photoId && !event.active),
      ).toHaveLength(0)

      let finalCancel = off
      if (reenable) {
        await activateButton(clipping)
        await expect(clipping).toHaveAttribute('aria-pressed', 'true')
        const next = (await messages.evaluate((control) => control.state())).posts.at(-1)!
        expect(next.kind).toBe('request')
        expect(next.generation).toBeGreaterThan(off.generation)
        await gate.holdNextAndRelease()
        await expect.poll(async () => (await gate.state()).holdCount).toBe(2)
        expect((await gate.state()).held).toBe(true)
        await expect
          .poll(async () =>
            (await messages.evaluate((control) => control.state())).replies.some(
              (reply) => reply.generation === first.generation && reply.done,
            ),
          )
          .toBe(true)
        expect(
          (await activity.evaluate((control) => control.state())).events
            .slice(initialActivity)
            .filter((event) => event.photoId === photoId && !event.active),
        ).toHaveLength(0)
        expect(
          (await messages.evaluate((control) => control.state())).replies.some(
            (reply) => reply.generation === next.generation && reply.done,
          ),
        ).toBe(false)
        await activateButton(clipping)
        await expect(clipping).toHaveAttribute('aria-pressed', 'false')
        finalCancel = (await messages.evaluate((control) => control.state())).posts.at(-1)!
        expect(finalCancel.kind).toBe('cancel')
        expect(finalCancel.generation).toBeGreaterThan(next.generation)
        await expect.poll(async () => (await gate.state()).aborts).toBe(2)
      }

      const readsBeforeDrain = (await gate.state()).reads
      await gate.release()
      await expect
        .poll(async () =>
          (await messages.evaluate((control) => control.state())).replies.some(
            (reply) => reply.generation === finalCancel.generation && reply.done && reply.canceled,
          ),
        )
        .toBe(true)
      await expect
        .poll(
          async () =>
            (await activity.evaluate((control) => control.state())).events
              .slice(initialActivity)
              .filter((event) => event.photoId === photoId && !event.active).length,
        )
        .toBe(1)
      const finalGate = await gate.state()
      expect(finalGate.held).toBe(false)
      expect(finalGate.expired).toBe(0)
      expect(finalGate.reads).toBe(readsBeforeDrain)
      const observed = await messages.evaluate((control) => control.state())
      expect(
        observed.replies.slice(initialReplies).filter((reply) => reply.mask || reply.error),
      ).toEqual([])
      expect(observed.workerCount).toBe(1)
      expect(await emptyClippingOverlay(page)).toBe(true)
      expect(await settledHealthyPreview(page)).toEqual(before)
      const gpu = await owners.evaluate((control) => control.state())
      expect(gpu.baselineTexturesStillOwned).toBe(gpu.baselineTextures)
      expect(gpu.devicesDestroyed).toBe(0)
      expect(gpu.contextsUnconfigured).toBe(0)
      expect(gpu.sameCanvas).toBe(true)
      expect((await activity.evaluate((control) => control.state())).omitted).toBe(0)
      evidence = {
        reenable,
        first,
        finalCancel,
        finalGate,
        gpu,
        before,
        observed,
        activity: await activity.evaluate((control) => control.state()),
        physicalTimingAcceptance: false,
      }
    } finally {
      try {
        evidence ??= {
          incomplete: true,
          reenable,
          gate: await gate.state(),
          observed: await messages.evaluate((control) => control.state()),
          activity: await activity.evaluate((control) => control.state()),
          gpu: await owners.evaluate((control) => control.state()),
          primitive: await value.worker.evaluate(() => {
            const view = new DataView(new ArrayBuffer(8))
            return [
              [-11.507243131689393, -6.353538344650907],
              [0, 0],
              [-0, 0],
              [0, -0],
              [-0, -0],
              [1, 1],
              [-1, 1],
              [1, -1],
              [-1, -1],
              [1, 0],
              [-1, 0],
              [0, 1],
              [-0, 1],
              [5e-324, 1],
              [1, 5e-324],
              [1e-300, -1],
              [-1, 1e-300],
            ].map(([y, x]) => {
              view.setFloat64(0, Math.atan2(y, x), false)
              return {
                y: String(y),
                x: String(x),
                yNegativeZero: Object.is(y, -0),
                xNegativeZero: Object.is(x, -0),
                bits: view.getBigUint64(0, false).toString(16).padStart(16, '0'),
              }
            })
          }),
          runtime: await luma.app.evaluate(() => process.versions),
          pageText: await page.locator('body').innerText(),
        }
        if (evidence)
          await writeFile(
            info.outputPath('actual-native-mask-cancel.json'),
            JSON.stringify(evidence, null, 2),
          )
      } finally {
        await finish(value)
      }
    }
  })
}

/** Forward real scope releases and worker messages without replacing outcomes.
 * Only the one deliberate sentinel ErrorEvent has its default report prevented;
 * production onerror still receives that trusted uncaught-error event. */
async function observeNativeMaskErrorDrain(page: Page, sentinel: string) {
  return page.evaluateHandle((sentinel) => {
    type Bytes = { ramBytes: number; vramBytes: number }
    type Scope = {
      existingOwners: Bytes
      additionalReservation: Bytes
      policy: unknown
      release(): void
    }
    type Entry = { additional: Bytes; releases: number; releaseOrder?: number }
    const originalFreeze = Object.freeze,
      originalPost = Worker.prototype.postMessage,
      entries: Entry[] = [],
      events: { kind: string; generation?: number; order: number; additional?: Bytes }[] = [],
      errors: { message: string; trusted: boolean; prevented: boolean }[] = [],
      workers = new Map<
        Worker,
        { message: (event: MessageEvent) => void; error: (event: ErrorEvent) => void }
      >()
    let order = 0,
      overflow = 0
    const record = (kind: string, generation?: number, additional?: Bytes) => {
      if (events.length >= 128) {
        overflow++
        return
      }
      events.push({ kind, generation, order: ++order, additional })
    }
    const freeze = function (value: unknown) {
      if (
        value &&
        typeof value === 'object' &&
        Object.hasOwn(value, 'existingOwners') &&
        Object.hasOwn(value, 'additionalReservation') &&
        Object.hasOwn(value, 'policy') &&
        Object.hasOwn(value, 'release') &&
        Object.keys(value).sort().join(',') ===
          'additionalReservation,existingOwners,policy,release'
      ) {
        const scope = value as Scope
        if (typeof scope.release === 'function') {
          if (entries.length >= 8) throw new Error('Unexpected native mask reservation count.')
          const originalRelease = scope.release,
            entry: Entry = { additional: { ...scope.additionalReservation }, releases: 0 },
            descriptor = Object.getOwnPropertyDescriptor(scope, 'release')!
          entries.push(entry)
          Object.defineProperty(scope, 'release', {
            ...descriptor,
            value: function (this: Scope) {
              entry.releases++
              entry.releaseOrder = ++order
              return Reflect.apply(originalRelease, this, [])
            },
          })
        }
      }
      return Reflect.apply(originalFreeze, Object, [value])
    } as typeof Object.freeze
    const observe = (worker: Worker) => {
      if (workers.has(worker)) return
      if (workers.size >= 4) throw new Error('Unexpected native mask analysis worker count.')
      const message = ({ data }: MessageEvent) => {
        if (data.nativeStart) record('native-start', data.nativeStart.generation)
        if (data.nativeDrained) record('native-drained', data.nativeDrained.generation)
      }
      const error = (event: ErrorEvent) => {
        if (!event.message.includes(sentinel)) return
        event.preventDefault()
        errors.push({
          message: event.message,
          trusted: event.isTrusted,
          prevented: event.defaultPrevented,
        })
      }
      workers.set(worker, { message, error })
      worker.addEventListener('message', message)
      worker.addEventListener('error', error)
    }
    const post = function (this: Worker, ...args: unknown[]) {
      const data = args[0] as {
        request?: { nativeMask?: { generation: number } }
        nativeReply?: {
          generation: number
          result?: { kind?: string; additionalReservation?: Bytes }
        }
        nativeReleased?: { generation: number }
      }
      if (data?.request?.nativeMask) observe(this)
      if (data?.nativeReply?.result?.kind === 'mask')
        record(
          'native-reply',
          data.nativeReply.generation,
          data.nativeReply.result.additionalReservation,
        )
      if (data?.nativeReleased) record('native-released', data.nativeReleased.generation)
      return Reflect.apply(originalPost, this, args)
    } as typeof originalPost
    Object.freeze = freeze
    Worker.prototype.postMessage = post
    return {
      state: () => ({ entries, events, errors, workerCount: workers.size, overflow }),
      close: () => {
        for (const [worker, listeners] of workers) {
          worker.removeEventListener('message', listeners.message)
          worker.removeEventListener('error', listeners.error)
        }
        if (Worker.prototype.postMessage === post) Worker.prototype.postMessage = originalPost
        if (Object.freeze === freeze) Object.freeze = originalFreeze
        workers.clear()
      },
    }
  }, sentinel)
}

test('an unrelated uncaught worker error retains the actual mask receiver, activity and source until genuine digest drain', async ({
  luma,
}, info) => {
  test.setTimeout(90000)
  const value = await prepare(luma),
    { page, gate, worker, messages, activity, owners, photoId } = value,
    sentinel = 'Luma native mask worker error drain control',
    lifetime = await observeNativeMaskErrorDrain(page, sentinel),
    clipping = page.getByRole('button', { name: 'Canvas channel clipping', exact: true })
  let evidence: unknown
  let activityStart = 0
  try {
    activityStart = (await activity.evaluate((control) => control.state())).events.length
    await gate.arm()
    await activateButton(clipping)
    await expect.poll(async () => (await gate.state()).held).toBe(true)
    const admitted = await lifetime.evaluate((control) => control.state()),
      nativeStart = admitted.events.find((event) => event.kind === 'native-start'),
      reply = admitted.events.find((event) => event.kind === 'native-reply')
    expect(nativeStart).toBeDefined()
    expect(reply?.generation).toBe(nativeStart!.generation)
    expect(admitted.entries).toHaveLength(1)
    expect(admitted.entries[0].additional).toEqual(reply!.additional)
    expect(admitted.entries[0].additional.ramBytes).toBeGreaterThan(0)
    expect(admitted.entries[0].releases).toBe(0)
    const ownerActivity = (await activity.evaluate((control) => control.state())).events
      .slice(activityStart)
      .find((event) => event.photoId === photoId && event.active)
    expect(ownerActivity).toBeDefined()
    const gpuBefore = await owners.evaluate((control) => control.state()),
      histogramBefore = await page
        .getByRole('slider', { name: 'Histogram tonal value' })
        .locator('path')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')))
    expect(histogramBefore).toHaveLength(3)
    expect(histogramBefore.every((path) => !!path && path.length > 100)).toBe(true)
    // This is a real uncaught asynchronous error in the existing Worker. The
    // completed WebCrypto result remains held by the independent SHA gate.
    await worker.evaluate((message) => {
      setTimeout(() => {
        throw new Error(message)
      }, 0)
    }, sentinel)
    await expect
      .poll(async () => (await lifetime.evaluate((control) => control.state())).errors.length)
      .toBe(1)
    await expect.poll(async () => (await gate.state()).aborts).toBe(1)
    expect(page.workers()).toContain(worker)
    expect((await gate.state()).held).toBe(true)
    const failed = await lifetime.evaluate((control) => control.state())
    expect(failed.errors[0]).toMatchObject({ trusted: true, prevented: true })
    const clippingStatus = page.getByRole('status', { name: 'Clipping overlay status' })
    await expect(clippingStatus).toHaveText('Clipping overlay unavailable.')
    await expect(clipping).toHaveAttribute(
      'aria-describedby',
      (await clippingStatus.getAttribute('id'))!,
    )
    await expect(page.getByText('Histogram unavailable', { exact: true })).toBeHidden()
    expect(
      await page
        .getByRole('slider', { name: 'Histogram tonal value' })
        .locator('path')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d'))),
    ).toEqual(histogramBefore)
    await expect(page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready')
    expect(failed.entries[0].releases).toBe(0)
    expect(
      failed.events.filter(
        (event) => event.kind === 'native-drained' || event.kind === 'native-released',
      ),
    ).toEqual([])
    expect(
      (await activity.evaluate((control) => control.state())).events
        .slice(activityStart)
        .filter((event) => event.activityId === ownerActivity!.activityId && !event.active),
    ).toEqual([])
    expect(await owners.evaluate((control) => control.state())).toEqual(gpuBefore)

    // Exercise actual component retirement and request the same photograph
    // again. Its full-source admission must wait behind the existing receiver.
    await activateButton(
      page
        .getByRole('navigation', { name: 'Workspaces' })
        .getByRole('button', { name: 'Library', exact: true }),
    )
    await activateButton(
      page
        .getByRole('navigation', { name: 'Workspaces' })
        .getByRole('button', { name: 'Editor', exact: true }),
    )
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveCount(1)
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    expect(await canvas.getAttribute('data-editing')).not.toBe('ready')
    const blocked = await lifetime.evaluate((control) => control.state()),
      blockedGpu = await owners.evaluate((control) => control.state())
    expect(blocked.entries).toHaveLength(1)
    expect(blocked.entries[0].releases).toBe(0)
    expect(blocked.events.filter((event) => event.kind === 'native-start')).toHaveLength(1)
    expect(
      blocked.events.filter(
        (event) => event.kind === 'native-drained' || event.kind === 'native-released',
      ),
    ).toEqual([])
    // Suspension may retire the unused tile cache. The exact uploaded source
    // and its receiver reservation remain owned until the genuine digest drains.
    expect(blockedGpu.baselineFullSourceTextures).toBe(1)
    expect(blockedGpu.baselineFullSourceTexturesStillOwned).toBe(1)
    expect(blockedGpu.sourceTexturesCreated).toBe(gpuBefore.sourceTexturesCreated)
    expect(blockedGpu.devicesDestroyed).toBe(0)
    expect(blockedGpu.contextsUnconfigured).toBe(0)
    // Workspace suspension intentionally clears foreground activity; resource
    // ownership is proved by the unchanged source, reservation and drain above.
    expect(
      (await activity.evaluate((control) => control.state())).events
        .slice(activityStart)
        .filter((event) => event.activityId === ownerActivity!.activityId && !event.active),
    ).toHaveLength(1)
    const held = await gate.state()
    expect(held.held).toBe(true)
    expect(held.expired).toBe(0)
    // Restore the test wrapper and release its completed genuine hash result in
    // one worker turn; the production error handler may now terminate it.
    await gate.close()
    await expect.poll(() => page.workers().includes(worker)).toBe(false)
    await settledHealthyPreview(page)
    const drained = await lifetime.evaluate((control) => control.state()),
      actualDrain = drained.events.find(
        (event) => event.kind === 'native-drained' && event.generation === nativeStart!.generation,
      ),
      actualRelease = drained.events.find(
        (event) => event.kind === 'native-released' && event.generation === nativeStart!.generation,
      )
    expect(actualDrain).toBeDefined()
    expect(actualRelease).toBeDefined()
    expect(drained.entries[0].releases).toBe(1)
    expect(drained.entries[0].releaseOrder).toBeGreaterThan(actualDrain!.order)
    expect(actualRelease!.order).toBeGreaterThan(drained.entries[0].releaseOrder!)
    expect(
      (await activity.evaluate((control) => control.state())).events
        .slice(activityStart)
        .filter((event) => event.activityId === ownerActivity!.activityId && !event.active),
    ).toHaveLength(1)
    expect(drained.overflow).toBe(0)
    expect((await activity.evaluate((control) => control.state())).omitted).toBe(0)
    evidence = {
      admitted,
      failed,
      blocked,
      blockedGpu,
      held,
      drained,
      messages: await messages.evaluate((control) => control.state()),
      activity: await activity.evaluate((control) => control.state()),
      physicalTimingAcceptance: false,
    }
  } finally {
    try {
      if (!evidence)
        await writeFile(
          info.outputPath('actual-native-mask-worker-error-failure.json'),
          JSON.stringify(
            {
              activityStart,
              activity: await activity.evaluate((control) => control.state()),
              lifetime: await lifetime.evaluate((control) => control.state()),
              gate: page.workers().includes(worker) ? await gate.state() : undefined,
            },
            null,
            2,
          ),
        )
      // Dispose the new preview before unwinding the forwarding wrappers in
      // reverse installation order. The original failed worker may be gone.
      if (page.workers().includes(worker)) await gate.release()
      await activateButton(
        page
          .getByRole('navigation', { name: 'Workspaces' })
          .getByRole('button', { name: 'Library', exact: true }),
      )
      await expect
        .poll(
          () =>
            page
              .workers()
              .filter((value) => /\/hdr-analysis-worker-[^/]+\.js(?:\?|$)/.test(value.url()))
              .length,
        )
        .toBe(0)
      if (evidence)
        await writeFile(
          info.outputPath('actual-native-mask-worker-error-drain.json'),
          JSON.stringify(evidence, null, 2),
        )
    } finally {
      await lifetime.evaluate((control) => control.close())
      await lifetime.dispose()
      await finish(value)
    }
  }
})

test('the actual analysis worker acknowledges cancellation before source samples arrive', async ({
  luma,
}) => {
  test.setTimeout(90000)
  const value = await prepare(luma)
  const { page, asset } = value
  let closeProtocol: (() => Promise<void>) | undefined
  let protocolGate: Awaited<ReturnType<typeof installAnalysisHashGate>> | undefined
  try {
    const created = page.waitForEvent('worker', {
      predicate: (worker) => worker.url() === value.worker.url(),
      timeout: 10000,
    })
    const handle = await page.evaluateHandle((url) => {
      const worker = new Worker(url, { type: 'module' })
      const replies: {
        generation?: number
        done?: boolean
        canceled?: boolean
        mask: boolean
        error?: string
      }[] = []
      worker.addEventListener('message', ({ data }) => {
        if (replies.length >= 16) throw new Error('Protocol reply observation exceeded16.')
        replies.push({
          generation: data.generation,
          done: data.done,
          canceled: data.canceled,
          mask: !!data.mask,
          error: data.error,
        })
      })
      return {
        post: (data: unknown) => worker.postMessage(data),
        state: () => replies,
        close: () => worker.terminate(),
      }
    }, value.worker.url())
    closeProtocol = async () => {
      try {
        await handle.evaluate((control) => control.close())
      } finally {
        await handle.dispose()
      }
    }
    const worker = await created
    protocolGate = await installAnalysisHashGate(worker, asset)
    const target = await page.evaluate(() => window.luma.getDisplayState())
    await handle.evaluate(
      (control, input) => {
        control.post({ asset: input.asset })
        control.post({
          request: {
            generation: 1,
            parameters: input.parameters,
            target: input.target,
            domain: 'content-hdr',
            masks: true,
            sampleStatistics: false,
            sampleCount: 65536,
          },
        })
        control.post({ cancel: { generation: 2 } })
      },
      { asset, target, parameters: neutralAdjustments },
    )
    await expect
      .poll(async () =>
        (await handle.evaluate((control) => control.state())).some(
          (reply) => reply.generation === 2 && reply.done && reply.canceled,
        ),
      )
      .toBe(true)
    const replies = await handle.evaluate((control) => control.state())
    expect(replies).toEqual([
      { generation: 2, done: true, canceled: true, mask: false, error: undefined },
    ])
    expect((await protocolGate.state()).reads).toBe(0)
    expect((await protocolGate.state()).digestResults).toBe(0)
    expect(await settledHealthyPreview(page)).toEqual(value.before)
  } finally {
    try {
      await protocolGate?.release()
      await protocolGate?.close()
    } finally {
      try {
        await closeProtocol?.()
      } finally {
        await finish(value)
      }
    }
  }
})
