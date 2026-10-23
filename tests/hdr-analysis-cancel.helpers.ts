import {
  expect,
  type ElectronApplication,
  type Page,
  type Worker as BrowserWorker,
} from '@playwright/test'
import type { HdrWorkingAsset } from '../src/shared/hdr'

/** Observe the real bridge handler without replacing its outcome or scheduler. */
export async function observeAnalysisActivity(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const channel = 'foreground:activity'
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error('Missing real foreground activity handler.')
    const events: { photoId?: string; activityId: string; sequence: number; active: boolean }[] = []
    let omitted = 0
    const wrapped: Handler = (...args) => {
      const value = args[1] as (typeof events)[number]
      if (events.length < 256) events.push(structuredClone(value))
      else omitted++
      return original(...args)
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, wrapped)
    return {
      state: () => ({ events, omitted }),
      close: () => {
        if (handlers.get(channel) === wrapped) {
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, original)
        }
        return { events, omitted }
      },
    }
  })
}

/** Capture only actual asset/request/completion metadata; do not retain mask planes. */
export async function observeAnalysisMessages(page: Page) {
  return page.evaluateHandle(() => {
    const original = Worker.prototype.postMessage
    const workers = new Map<
      Worker,
      { analysis: boolean; listener: (event: MessageEvent) => void }
    >()
    let asset: HdrWorkingAsset | undefined
    const posts: { kind: 'request' | 'cancel'; generation: number; masks?: boolean }[] = []
    const replies: {
      generation?: number
      done: boolean
      canceled: boolean
      mask: boolean
      error?: string
    }[] = []
    const post = function (this: Worker, ...args: unknown[]) {
      const data = args[0] as {
        asset?: HdrWorkingAsset
        request?: { generation: number; masks: boolean }
        cancel?: { generation: number }
      }
      if (!data || typeof data !== 'object') return Reflect.apply(original, this, args)
      if (data.asset?.kind === 'hdr-working-v1' && !workers.has(this)) {
        if (workers.size >= 4) throw new Error('Unexpected analysis-worker recreation.')
        asset = structuredClone(data.asset)
        const context: { analysis: boolean; listener: (event: MessageEvent) => void } = {
          analysis: false,
          listener: () => {},
        }
        const listener = ({ data: value }: MessageEvent) => {
          if (!context.analysis) return
          if (replies.length >= 128) throw new Error('Analysis reply observation exceeded128.')
          replies.push({
            generation: value.generation,
            done: !!value.done,
            canceled: !!value.canceled,
            mask: !!value.mask,
            error: value.error,
          })
        }
        context.listener = listener
        workers.set(this, context)
        this.addEventListener('message', listener)
      }
      if (workers.has(this) && (data.request || data.cancel)) {
        workers.get(this)!.analysis = true
        if (posts.length >= 128) throw new Error('Analysis request observation exceeded128.')
        posts.push(
          data.cancel
            ? { kind: 'cancel', generation: data.cancel.generation }
            : { kind: 'request', generation: data.request!.generation, masks: data.request!.masks },
        )
      }
      return Reflect.apply(original, this, args)
    } as typeof original
    Worker.prototype.postMessage = post
    return {
      state: () => ({
        asset,
        posts,
        replies,
        workerCount: [...workers.values()].filter((value) => value.analysis).length,
      }),
      close: () => {
        for (const [worker, context] of workers)
          worker.removeEventListener('message', context.listener)
        if (Worker.prototype.postMessage === post) Worker.prototype.postMessage = original
        workers.clear()
      },
    }
  })
}

interface GateState {
  held: boolean
  holdCount: number
  reads: number
  aborts: number
  digestResults: number
  releasedResults: number
  expired: number
}
interface GateControl {
  arm(): void
  holdNextAndRelease(): void
  release(): void
  state(): GateState
  close(): void
}
type GateGlobal = typeof globalThis & { __hdrAnalysisCancelGate?: GateControl }

/** Hold a genuine completed SHA result in the actual worker, preserving its bytes. */
export async function installAnalysisHashGate(
  worker: BrowserWorker,
  asset: HdrWorkingAsset,
  nativeMask = false,
) {
  await worker.evaluate(
    ({ url, stripBytes, nativeMask }) => {
      const scope = globalThis as GateGlobal
      if (scope.__hdrAnalysisCancelGate) throw new Error('Hash gate already installed.')
      const originalDigest = crypto.subtle.digest
      const originalFetch = fetch
      const state: GateState = {
        held: false,
        holdCount: 0,
        reads: 0,
        aborts: 0,
        digestResults: 0,
        releasedResults: 0,
        expired: 0,
      }
      let armed = false
      let release: (() => void) | undefined
      const signals = new Map<AbortSignal, () => void>()
      const digest: SubtleCrypto['digest'] = async function (algorithm, bytes) {
        const value = await Reflect.apply(originalDigest, crypto.subtle, [algorithm, bytes])
        state.digestResults++
        if (armed && bytes.byteLength === stripBytes) {
          armed = false
          state.held = true
          state.holdCount++
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              state.expired++
              resolve()
            }, 15000)
            release = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          state.held = false
          release = undefined
        }
        state.releasedResults++
        return value
      }
      const fetcher: typeof fetch = (input, init) => {
        const requested = input instanceof Request ? input.url : String(input)
        if (
          nativeMask
            ? /^luma-photo:\/\/library\/[a-f0-9]{64}\/mask\/[a-f0-9-]{36}$/.test(requested)
            : requested === url
        ) {
          state.reads++
          const signal = init?.signal
          if (signal && !signals.has(signal)) {
            const aborted = () => {
              state.aborts++
            }
            signals.set(signal, aborted)
            signal.addEventListener('abort', aborted, { once: true })
          }
        }
        return Reflect.apply(originalFetch, globalThis, [input, init])
      }
      crypto.subtle.digest = digest
      globalThis.fetch = fetcher
      scope.__hdrAnalysisCancelGate = {
        arm: () => {
          if (armed || state.held) throw new Error('Cannot re-arm an outstanding real hash.')
          armed = true
        },
        holdNextAndRelease: () => {
          if (!state.held || armed) throw new Error('No single held hash to advance.')
          armed = true
          release?.()
        },
        release: () => release?.(),
        state: () => ({ ...state }),
        close: () => {
          armed = false
          release?.()
          for (const [signal, listener] of signals) signal.removeEventListener('abort', listener)
          if (crypto.subtle.digest === digest) crypto.subtle.digest = originalDigest
          if (globalThis.fetch === fetcher) globalThis.fetch = originalFetch
          delete scope.__hdrAnalysisCancelGate
        },
      }
    },
    {
      url: asset.url!,
      stripBytes: nativeMask ? asset.width * asset.height : asset.strips[0].byteLength,
      nativeMask,
    },
  )
  return {
    arm: () => worker.evaluate(() => (globalThis as GateGlobal).__hdrAnalysisCancelGate!.arm()),
    holdNextAndRelease: () =>
      worker.evaluate(() =>
        (globalThis as GateGlobal).__hdrAnalysisCancelGate!.holdNextAndRelease(),
      ),
    release: () =>
      worker.evaluate(() => (globalThis as GateGlobal).__hdrAnalysisCancelGate?.release()),
    state: () => worker.evaluate(() => (globalThis as GateGlobal).__hdrAnalysisCancelGate!.state()),
    close: () => worker.evaluate(() => (globalThis as GateGlobal).__hdrAnalysisCancelGate?.close()),
  }
}

export async function settledHealthyPreview(page: Page) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-quality', 'normal')
  await expect
    .poll(() =>
      canvas.evaluate(
        (node) =>
          node.dataset.completedEditSerial === node.dataset.requestedSerial &&
          node.dataset.analysisPending === 'false',
      ),
    )
    .toBe(true)
  return canvas.evaluate((node) => ({
    source: node.dataset.presentedSourceIdentity,
    epoch: node.dataset.presentedEpoch,
    uploads: node.dataset.sourceUploads,
    target: node.dataset.targetGeneration,
    backend: node.dataset.backend,
  }))
}

/** Track actual source textures/devices and context retirement, forwarding every call. */
export async function observeGpuAnalysisOwners(page: Page) {
  return page.evaluateHandle(() => {
    const create = GPUDevice.prototype.createTexture
    const destroy = GPUTexture.prototype.destroy
    const destroyDevice = GPUDevice.prototype.destroy
    const unconfigure = GPUCanvasContext.prototype.unconfigure
    const sources = new Set<GPUTexture>()
    const fullSources = new Set<GPUTexture>()
    const retired = new Set<GPUTexture>()
    let devicesDestroyed = 0,
      contextsUnconfigured = 0
    let canvas: Element | null = null
    let baseline: GPUTexture[] = []
    const created: typeof create = function (this: GPUDevice, descriptor) {
      const texture = Reflect.apply(create, this, [descriptor])
      if (descriptor.format === 'rgba32float') {
        sources.add(texture)
        // The uploaded full source owns COPY_DST; Float32 tile caches do not.
        if (descriptor.usage & GPUTextureUsage.COPY_DST) fullSources.add(texture)
      }
      return texture
    }
    const destroyed: typeof destroy = function (this: GPUTexture) {
      if (sources.has(this)) retired.add(this)
      return Reflect.apply(destroy, this, [])
    }
    const deviceDestroyed: typeof destroyDevice = function (this: GPUDevice) {
      devicesDestroyed++
      return Reflect.apply(destroyDevice, this, [])
    }
    const unconfigured: typeof unconfigure = function (this: GPUCanvasContext) {
      contextsUnconfigured++
      return Reflect.apply(unconfigure, this, [])
    }
    GPUDevice.prototype.createTexture = created
    GPUTexture.prototype.destroy = destroyed
    GPUDevice.prototype.destroy = deviceDestroyed
    GPUCanvasContext.prototype.unconfigure = unconfigured
    const state = () => ({
      baselineTextures: baseline.length,
      sourceTexturesCreated: sources.size,
      baselineTexturesStillOwned: baseline.filter((texture) => !retired.has(texture)).length,
      baselineFullSourceTextures: baseline.filter((texture) => fullSources.has(texture)).length,
      baselineFullSourceTexturesStillOwned: baseline.filter(
        (texture) => fullSources.has(texture) && !retired.has(texture),
      ).length,
      devicesDestroyed,
      contextsUnconfigured,
      sameCanvas: canvas === document.querySelector('[data-testid="main-preview"]'),
    })
    return {
      mark: () => {
        baseline = [...sources].filter((texture) => !retired.has(texture))
        devicesDestroyed = 0
        contextsUnconfigured = 0
        canvas = document.querySelector('[data-testid="main-preview"]')
        return state()
      },
      state,
      close: () => {
        if (GPUDevice.prototype.createTexture === created)
          GPUDevice.prototype.createTexture = create
        if (GPUTexture.prototype.destroy === destroyed) GPUTexture.prototype.destroy = destroy
        if (GPUDevice.prototype.destroy === deviceDestroyed)
          GPUDevice.prototype.destroy = destroyDevice
        if (GPUCanvasContext.prototype.unconfigure === unconfigured)
          GPUCanvasContext.prototype.unconfigure = unconfigure
        sources.clear()
        fullSources.clear()
        retired.clear()
        baseline = []
      },
    }
  })
}

export async function emptyClippingOverlay(page: Page) {
  return page.getByTestId('clipping-overlay').evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    return context
      .getImageData(0, 0, canvas.width, canvas.height)
      .data.every((byte, index) => index % 4 !== 3 || byte === 0)
  })
}
