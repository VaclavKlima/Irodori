import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from './electron.fixture'
import type {
  CpuPreviewPair,
  CpuPreviewRequest,
  CpuPreviewOutcome,
  CpuPreviewMemoryLimit,
} from '../src/shared/native-cpu-preview'
import { NATIVE_CPU_PREVIEW_VERSION } from '../src/shared/native-cpu-preview'
import { encodeHdr } from '../src/shared/hdr'

/** Observe existing real handlers. No CPU reply, capability, hash or child result is fabricated. */
export async function observeNativeCpuReplies(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }, version) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const originals = new Map(handlers)
    const wrappers = new Map<string, Handler>()
    const requests: CpuPreviewRequest[] = [],
      pairs: CpuPreviewPair[] = []
    const limits: CpuPreviewMemoryLimit[] = []
    const events: {
      phase: string
      channel: string
      requestId?: string
      pairId?: string
      error?: string
    }[] = []
    const pending = new Set<Promise<unknown>>()
    let omitted = 0,
      armed: 'draft' | 'normal' | undefined
    let held: { pair: CpuPreviewPair; release: () => void } | undefined
    const note = (event: (typeof events)[number]) => {
      if (events.length < 128) events.push(event)
      else omitted++
    }
    const release = () => {
      const current = held
      held = undefined
      current?.release()
    }
    for (const [channel, original] of originals) {
      const wrapped: Handler = (...args) => {
        const request = args[1] as CpuPreviewRequest | undefined
        if (request?.version !== version) return original(...args)
        if (requests.length >= 32) throw new Error('Native UI request observation exceeded 32.')
        requests.push(structuredClone(request))
        note({ phase: 'request', channel, requestId: request.requestId })
        const work = (async () => {
          try {
            const outcome = (await original(...args)) as CpuPreviewOutcome
            if (outcome?.version !== version)
              throw new Error('The real CPU handler returned no outcome.')
            if ('kind' in outcome) {
              if (outcome.kind === 'cancelled') {
                note({ phase: 'cancelled', channel, requestId: outcome.requestId })
                return outcome
              }
              if (outcome.kind !== 'memory-limit')
                throw new Error('Unknown native CPU outcome kind.')
              limits.push(structuredClone(outcome))
              note({ phase: 'memory-limit', channel, requestId: outcome.requestId })
              return outcome
            }
            const pair = outcome
            pairs.push(structuredClone(pair))
            note({ phase: 'constructed', channel, requestId: pair.requestId, pairId: pair.pairId })
            if (armed === pair.quality) {
              armed = undefined
              await new Promise<void>((resolve) => {
                held = { pair, release: resolve }
              })
            }
            note({ phase: 'delivered', channel, requestId: pair.requestId, pairId: pair.pairId })
            return pair
          } catch (error) {
            note({ phase: 'error', channel, requestId: request.requestId, error: String(error) })
            throw error
          }
        })()
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => undefined)
        return work
      }
      wrappers.set(channel, wrapped)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, wrapped)
    }
    const state = () => ({ requests, pairs, limits, events, omitted, held: held?.pair ?? null })
    return {
      state,
      arm: (quality: 'draft' | 'normal') => {
        if (armed || held) throw new Error('A real CPU reply gate is already armed or held.')
        armed = quality
      },
      release,
      close: async () => {
        armed = undefined
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          for (const [channel, original] of originals) {
            if (handlers.get(channel) !== wrappers.get(channel)) continue
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, original)
          }
        }
        return state()
      },
    }
  }, NATIVE_CPU_PREVIEW_VERSION)
}

/** The pair ID ties a draw to a trusted response, rather than a backend label alone. */
export async function observeCpuPublications(page: Page) {
  return page.evaluateHandle(() => {
    const publications: {
      pairId: string
      source: string
      renderingIdentity: string
      revision: number
      quality: string
      label: string | null
      visibility: string
    }[] = []
    let omitted = 0,
      previous = ''
    const read = () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      if (!canvas?.dataset.nativeCpuPair) return
      if (canvas.dataset.editing !== 'ready' || getComputedStyle(canvas).visibility !== 'visible')
        return
      const record = {
        pairId: canvas.dataset.nativeCpuPair,
        source: canvas.dataset.presentedSourceIdentity ?? '',
        renderingIdentity: canvas.dataset.cpuRenderingIdentity ?? '',
        revision: Number(canvas.dataset.presentedSettingsRevision),
        quality: canvas.dataset.quality ?? '',
        label: canvas.getAttribute('aria-label'),
        visibility: getComputedStyle(canvas).visibility,
      }
      const key = JSON.stringify(record)
      if (key === previous) return
      previous = key
      if (publications.length < 128) publications.push(record)
      else omitted++
    }
    const observer = new MutationObserver(read)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'data-native-cpu-pair',
        'data-cpu-rendering-identity',
        'data-quality',
        'data-presented-source-identity',
        'data-presented-settings-revision',
        'style',
        'aria-label',
      ],
    })
    read()
    return {
      state: () => ({ publications, omitted }),
      close: () => {
        observer.disconnect()
        read()
      },
    }
  })
}

export async function requireTrustedNativeBridge(page: Page) {
  const result = await page.evaluate(async () => {
    const api = window.luma as typeof window.luma &
      Partial<import('../src/shared/native-cpu-preview').NativeCpuPreviewBridge>
    const available = [
      'getCpuPreviewBackend',
      'renderCpuPreview',
      'cancelCpuPreview',
      'acknowledgeCpuPreview',
      'releaseCpuPreview',
    ].every((name) => typeof Reflect.get(api, name) === 'function')
    if (!available) throw new Error('Native CPU application bridge integration is missing.')
    return api.getCpuPreviewBackend!()
  })
  expect(result, 'The platform policy must select the trusted native owner.').toBe('native')
}

export async function expectCpuPair(page: Page, pair: CpuPreviewPair) {
  expect(pair.diagnostics).toMatchObject({
    implementation: 'float64-ctl-cpu-strip-v1',
    sourceAttestedByMain: true,
    outputValidatedAfterChildClose: true,
  })
  expect(pair.diagnostics.managedRamPeakBytes).toBeLessThanOrEqual(pair.policy.ram.effectiveBytes)
  expect(pair.diagnostics.managedGpuPeakBytes).toBeLessThanOrEqual(pair.policy.vram.effectiveBytes)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'canvas2d-hdr-sdr')
  await expect(canvas).toHaveAttribute('data-native-cpu-pair', pair.pairId)
  await expect(canvas).toHaveAttribute('data-quality', pair.quality)
  await expect(canvas).toHaveAttribute('data-cpu-rendering-identity', pair.source.renderingIdentity)
  const frameIdentity = await canvas.getAttribute('data-presented-source-identity')
  expect(frameIdentity).toContain(`luma-photo://library/${pair.source.photoId}/linear/`)
  expect(frameIdentity).toContain(pair.source.workingSha256)
  await expect(canvas).toHaveAttribute(
    'data-presented-settings-revision',
    String(pair.settingsRevision),
  )
  await expect(canvas).toHaveAttribute('data-editing', 'ready')
  await expect(canvas).toBeVisible()
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute(
    'data-image-width',
    String(pair.sourceDimensions.width),
  )
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute(
    'data-image-height',
    String(pair.sourceDimensions.height),
  )
}

/** Existing unchanged application pixel API is the normal SDR numerical reference. */
export async function canonicalAfterPixels(page: Page, pair: CpuPreviewPair) {
  await page.getByLabel('Preview zoom', { exact: true }).selectOption('1')
  await expect
    .poll(() =>
      page.getByTestId('main-preview').evaluate((element) => {
        const pose = element.dataset.presentedView
        return pose ? JSON.parse(pose).scale : null
      }),
    )
    .toBe(1)
  const samples = await page.getByTestId('main-preview').evaluate((element) => {
    const canvas = element as HTMLCanvasElement,
      context = canvas.getContext('2d')!
    const viewport = canvas.parentElement!,
      bounds = viewport.getBoundingClientRect(),
      dpr = devicePixelRatio
    const left =
      (bounds.width - Number(viewport.dataset.imageWidth)) / 2 + Number(viewport.dataset.panX)
    const top =
      (bounds.height - Number(viewport.dataset.imageHeight)) / 2 + Number(viewport.dataset.panY)
    return [-48, 0, 48].flatMap((dy) =>
      [-64, 0, 64].map((dx) => {
        const px = Math.floor(canvas.width / 2 + dx * dpr),
          py = Math.floor(canvas.height / 2 + dy * dpr)
        return {
          x: Math.floor((px + 0.5) / dpr - left),
          y: Math.floor((py + 0.5) / dpr - top),
          rgba: Array.from(context.getImageData(px, py, 1, 1).data),
        }
      }),
    )
  })
  for (const sample of samples) {
    const reference = await page.evaluate(
      ({ pair, sample }) =>
        window.luma.getPhotoPixel(pair.source.photoId, pair.settingsRevision, sample.x, sample.y, {
          domain: 'output',
          target: 'sdr',
        }),
      { pair, sample },
    )
    expect(reference.renderingIdentity).toBe(pair.source.renderingIdentity)
    expect(reference.alpha).toBe(1)
    expect(sample.rgba[3]).toBe(255)
    expect(
      Math.max(
        ...reference.rgb.map((v, c) => Math.abs(Math.round(encodeHdr(v) * 255) - sample.rgba[c])),
      ),
      `CPU pixel ${sample.x},${sample.y}: actual ${sample.rgba}; expected ${reference.rgb.map((v) => Math.round(encodeHdr(v) * 255))}`,
    ).toBeLessThanOrEqual(1)
  }
  return samples
}

// Append to tests/native-cpu-preview-ui.helpers.ts. It already imports Page.

/** Delay delivery of one genuine full-size bitmap after its browser operation
 * completes. The application still owns closing that ImageBitmap after abort.
 * No pixels, renderer response or GPU operation are replaced with test output. */
export async function holdNativeCpuBitmapReceiver(
  page: Page,
  dimensions: { width: number; height: number },
) {
  return page.evaluateHandle(({ width, height }) => {
    const originalBitmap = window.createImageBitmap,
      originalClose = ImageBitmap.prototype.close,
      originalBuffer = GPUDevice.prototype.createBuffer,
      originalTexture = GPUDevice.prototype.createTexture
    const events: {
      sequence: number
      kind: string
      receiverClosed: boolean
      format?: string
      width?: number
      height?: number
      bytes?: number
    }[] = []
    const pending = new Set<Promise<unknown>>()
    let omitted = 0,
      sequence = 0,
      armed = true,
      monitoring = false,
      held = false,
      completed = false,
      receiverClosed = false,
      heldImage: ImageBitmap | undefined,
      releaseHeld: (() => void) | undefined
    const note = (kind: string, detail: Partial<(typeof events)[number]> = {}) => {
      const event = { sequence: ++sequence, kind, receiverClosed, ...detail }
      if (events.length < 256) events.push(event)
      else omitted++
    }
    const release = () => {
      const resolve = releaseHeld
      releaseHeld = undefined
      if (!resolve) return
      held = false
      note('receiver-released')
      resolve()
    }
    const bitmap = (async (...args: unknown[]) => {
      const work = (async () => {
        const image = (await Reflect.apply(originalBitmap, window, args)) as ImageBitmap
        const input = args[0]
        const canvas = document.querySelector<HTMLElement>('[data-testid="main-preview"]')
        if (
          armed &&
          input instanceof ImageData &&
          input.width === width &&
          input.height === height &&
          image.width === width &&
          image.height === height &&
          canvas?.dataset.cpuRenderer === 'native'
        ) {
          armed = false
          completed = true
          held = true
          heldImage = image
          note('real-bitmap-completed', { width: image.width, height: image.height })
          await new Promise<void>((resolve) => {
            releaseHeld = resolve
          })
        }
        return image
      })()
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }) as typeof window.createImageBitmap
    const close = function (this: ImageBitmap) {
      originalClose.call(this)
      if (this === heldImage) {
        receiverClosed = true
        note('held-bitmap-closed-by-application')
      }
    }
    const buffer: typeof originalBuffer = function (this: GPUDevice, descriptor) {
      const value = originalBuffer.call(this, descriptor)
      if (monitoring) note('gpu-buffer', { bytes: descriptor.size })
      return value
    }
    const texture: typeof originalTexture = function (this: GPUDevice, descriptor) {
      const value = originalTexture.call(this, descriptor)
      if (monitoring) {
        const size =
          Symbol.iterator in Object(descriptor.size)
            ? Array.from(descriptor.size as Iterable<number>)
            : [
                (descriptor.size as GPUExtent3DDict).width,
                (descriptor.size as GPUExtent3DDict).height ?? 1,
              ]
        note('gpu-texture', {
          format: descriptor.format,
          width: size[0],
          height: size[1] ?? 1,
        })
      }
      return value
    }
    window.createImageBitmap = bitmap
    ImageBitmap.prototype.close = close
    GPUDevice.prototype.createBuffer = buffer
    GPUDevice.prototype.createTexture = texture
    return {
      state: () => ({ completed, held, receiverClosed, monitoring, events, omitted }),
      beginSwitch: () => {
        if (!held || !completed || receiverClosed)
          throw new Error('The real native receiver must still own its completed bitmap.')
        monitoring = true
        note('photo-switch-started')
      },
      release,
      close: async () => {
        armed = false
        release()
        try {
          // Release before waiting. Otherwise this diagnostic could wait on its
          // own held operation during test cleanup.
          await Promise.allSettled([...pending])
        } finally {
          if (window.createImageBitmap === bitmap) window.createImageBitmap = originalBitmap
          if (ImageBitmap.prototype.close === close) ImageBitmap.prototype.close = originalClose
          if (GPUDevice.prototype.createBuffer === buffer)
            GPUDevice.prototype.createBuffer = originalBuffer
          if (GPUDevice.prototype.createTexture === texture)
            GPUDevice.prototype.createTexture = originalTexture
        }
        return { completed, held, receiverClosed, monitoring, events, omitted }
      },
    }
  }, dimensions)
}

interface NativeAnalysisRequest {
  phase: string
  generation: number
  sourceSha256: string
  sampleCount: number
  sampleStatistics: boolean
  masks: boolean
  domain: string
  parameters: unknown
  target: unknown
  postedAt: number
}
interface NativeAnalysisLevel {
  width: number
  height: number
  data: Uint8Array<ArrayBuffer>
}

/** Passive observation of genuine analysis-worker replies and the actual
 * overlay draw. It forwards every original call and never supplies results. */
export async function observeNativeCpuAnalysisBaseline(
  page: Page,
  expected: { sha256: string; width: number; height: number },
) {
  return page.evaluateHandle((expected) => {
    interface WorkerContext {
      requests: Map<number, NativeAnalysisRequest>
      listener: (event: MessageEvent) => void
    }
    const originalPost = Worker.prototype.postMessage,
      originalDraw = CanvasRenderingContext2D.prototype.drawImage
    const workers = new Map<Worker, WorkerContext>()
    const requests: NativeAnalysisRequest[] = [],
      statistics: {
        request: NativeAnalysisRequest
        receivedAt: number
        elapsedMs: number
        visiblePixels: number
      }[] = [],
      histogramDom: { phase: string; samples: number; at: number; nativePairId: string }[] = []
    const nativeEvents: { kind: string; generation: number; at: number; error?: string }[] = []
    const recordNative = (kind: string, generation: number, error?: string) => {
      if (nativeEvents.length < 128)
        nativeEvents.push({ kind, generation, at: performance.now(), error })
      else omitted++
    }
    let phase = 'setup',
      omitted = 0,
      previousHistogram = ''
    let mask:
      | {
          request: NativeAnalysisRequest
          receivedAt: number
          elapsedMs: number
          drawnAt?: number
          levels: NativeAnalysisLevel[]
        }
      | undefined
    const readHistogram = () => {
      const histogram = document.getElementById('histogram')
      const canvas = document.querySelector<HTMLElement>('[data-testid="main-preview"]')
      if (!histogram || canvas?.dataset.cpuRenderer !== 'native' || !canvas.dataset.nativeCpuPair)
        return
      const samples = Number(histogram.dataset.samples)
      if (![8192, 65536].includes(samples)) return
      const key = `${samples}:${canvas.dataset.nativeCpuPair}`
      if (key === previousHistogram) return
      previousHistogram = key
      const value = {
        phase,
        samples,
        at: performance.now(),
        nativePairId: canvas.dataset.nativeCpuPair,
      }
      if (histogramDom.length < 64) histogramDom.push(value)
      else omitted++
    }
    const mutation = new MutationObserver(readHistogram)
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-samples', 'data-native-cpu-pair', 'data-cpu-renderer'],
    })
    const post = function (this: Worker, ...args: unknown[]) {
      const data = args[0] as
        | {
            asset?: { kind?: string; sha256?: string; width?: number; height?: number }
            request?: Omit<NativeAnalysisRequest, 'phase' | 'sourceSha256' | 'postedAt'>
            nativeReply?: { generation: number; error?: string; result?: { kind: string } }
            nativeReleased?: { generation: number; error?: string }
          }
        | undefined
      if (
        data?.asset?.kind === 'hdr-working-v1' &&
        data.asset.sha256 === expected.sha256 &&
        data.asset.width === expected.width &&
        data.asset.height === expected.height &&
        !workers.has(this)
      ) {
        if (workers.size >= 8) throw new Error('Analysis observation exceeds eight source workers.')
        const context: WorkerContext = {
          requests: new Map<number, NativeAnalysisRequest>(),
          listener: ({
            data: result,
          }: MessageEvent<{
            generation?: number
            statistics?: { visiblePixels: number }
            mask?: { levels: NativeAnalysisLevel[] }
            nativeStart?: { generation: number }
            nativeCancel?: { generation: number }
            nativeDrained?: { generation: number }
            error?: string
          }>) => {
            for (const kind of ['nativeStart', 'nativeCancel', 'nativeDrained'] as const)
              if (result[kind]) recordNative(kind, result[kind].generation)
            if (result.error && result.generation !== undefined)
              recordNative('workerError', result.generation, result.error)
            const request =
              result.generation === undefined ? undefined : context.requests.get(result.generation)
            if (!request) return
            const receivedAt = performance.now()
            if (result.statistics) {
              const value = {
                request,
                receivedAt,
                elapsedMs: receivedAt - request.postedAt,
                visiblePixels: result.statistics.visiblePixels,
              }
              if (statistics.length < 64) statistics.push(value)
              else omitted++
            }
            if (result.mask) {
              let width = expected.width,
                height = expected.height,
                bytes = 0
              for (const level of result.mask.levels) {
                if (
                  level.width !== width ||
                  level.height !== height ||
                  level.data.byteLength !== width * height
                )
                  throw new Error('The actual analysis mask has invalid pyramid geometry.')
                bytes += level.data.byteLength
                width = Math.ceil(width / 2)
                height = Math.ceil(height / 2)
              }
              const last = result.mask.levels.at(-1)
              if (!last || last.width !== 1 || last.height !== 1 || bytes > 64 * 1024 ** 2)
                throw new Error('Analysis observation exceeds its 64 MiB retained-mask allowance.')
              // Retain references to the one genuine transferred result. Hashes
              // and bit scans run only after the timed consumer draw, on demand.
              mask = {
                request,
                receivedAt,
                elapsedMs: receivedAt - request.postedAt,
                levels: result.mask.levels,
              }
            }
          },
        }
        workers.set(this, context)
        this.addEventListener('message', context.listener)
      }
      const context = workers.get(this)
      if (context && data?.nativeReply)
        recordNative(
          `nativeReply:${data.nativeReply.result?.kind ?? 'error'}`,
          data.nativeReply.generation,
          data.nativeReply.error,
        )
      if (context && data?.nativeReleased)
        recordNative('nativeReleased', data.nativeReleased.generation, data.nativeReleased.error)
      const value = data?.request
      if (
        context &&
        value &&
        Number.isSafeInteger(value.generation) &&
        value.generation >= 0 &&
        [8192, 65536].includes(value.sampleCount) &&
        typeof value.sampleStatistics === 'boolean' &&
        typeof value.masks === 'boolean' &&
        ['working-hdr', 'content-hdr', 'output'].includes(value.domain)
      ) {
        const request: NativeAnalysisRequest = structuredClone({
          ...value,
          phase,
          sourceSha256: expected.sha256,
          postedAt: performance.now(),
        })
        if (requests.length >= 64) throw new Error('Analysis observation exceeds 64 requests.')
        requests.push(request)
        context.requests.set(request.generation, request)
      }
      return Reflect.apply(originalPost, this, args)
    } as typeof originalPost
    const draw = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      Reflect.apply(originalDraw, this, args)
      if (
        mask &&
        mask.drawnAt === undefined &&
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.dataset.testid === 'clipping-overlay'
      )
        mask.drawnAt = performance.now()
    } as typeof originalDraw
    Worker.prototype.postMessage = post
    CanvasRenderingContext2D.prototype.drawImage = draw
    const state = () => ({
      expected,
      phase,
      omitted,
      requests,
      statistics,
      histogramDom,
      nativeEvents,
      mask: mask
        ? {
            request: mask.request,
            receivedAt: mask.receivedAt,
            elapsedMs: mask.elapsedMs,
            drawnAt: mask.drawnAt ?? null,
            requestToDrawMs:
              mask.drawnAt === undefined ? null : mask.drawnAt - mask.request.postedAt,
            levels: mask.levels.map(({ width, height, data }) => ({
              width,
              height,
              bytes: data.byteLength,
            })),
          }
        : null,
    })
    return {
      state,
      mark: (next: string) => {
        phase = next
      },
      hashMask: async () => {
        const actual = mask
        if (!actual || actual.drawnAt === undefined)
          throw new Error('No genuine mask consumer draw exists.')
        const levels = []
        const bitCounts = [0, 0, 0, 0]
        let nonzero = 0
        for (const value of actual.levels[0].data) {
          if (value) nonzero++
          for (let bit = 0; bit < 4; bit++) bitCounts[bit] += Number(!!(value & (1 << bit)))
        }
        for (const level of actual.levels) {
          const digest = await crypto.subtle.digest('SHA-256', level.data)
          levels.push({
            width: level.width,
            height: level.height,
            bytes: level.data.byteLength,
            sha256: Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join(''),
          })
        }
        return { levels, bitCounts, nonzero }
      },
      close: () => {
        readHistogram()
        const observed = state()
        mutation.disconnect()
        for (const [worker, context] of workers)
          worker.removeEventListener('message', context.listener)
        workers.clear()
        mask = undefined
        if (Worker.prototype.postMessage === post) Worker.prototype.postMessage = originalPost
        if (CanvasRenderingContext2D.prototype.drawImage === draw)
          CanvasRenderingContext2D.prototype.drawImage = originalDraw
        return observed
      },
    }
  }, expected)
}

export async function readNativeCpuClippingCanvas(page: Page) {
  return page.getByTestId('clipping-overlay').evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    if (canvas.width * canvas.height * 4 > 32 * 1024 ** 2)
      throw new Error('Clipping canvas observation exceeds its 32 MiB readback allowance.')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The real clipping canvas has no 2D context.')
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data
    let visible = 0,
      amber = 0
    for (let i = 0; i < rgba.length; i += 4) {
      if (!rgba[i + 3]) continue
      visible++
      if (rgba[i] > 200 && rgba[i + 1] > 80 && rgba[i + 2] < 30) amber++
    }
    return { width: canvas.width, height: canvas.height, visible, amber }
  })
}
