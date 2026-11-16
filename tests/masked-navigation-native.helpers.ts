import { expect, type ElectronApplication, type Page } from '@playwright/test'

export function coverageRequestWitness(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('masks:coverage')!
    let calls = 0
    ipcMain.removeHandler('masks:coverage')
    ipcMain.handle('masks:coverage', (...args) => {
      calls++
      return original(...args)
    })
    return {
      read: () => calls,
      close: () => {
        ipcMain.removeHandler('masks:coverage')
        ipcMain.handle('masks:coverage', original)
      },
    }
  })
}

/** Wait for the actual photo, rather than merely its edit/geometry notification. */
export async function navigationReady(page: Page, photoId: string, revision: number) {
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', String(revision), {
    timeout: 60000,
  })
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-resolution', 'full')
  await expect(canvas).toBeVisible()
  await expect(page.getByTestId('mask-edge-pending')).toHaveCount(0)
  await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ photoId, revision }) => {
            const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
            const target = await window.irodori.getDisplayState()
            const context = await window.irodori.getPhotoPresentationContext({
              photoId,
              expectedRevision: revision,
            })
            const d = c.dataset
            return (
              context.frame.status === 'presented' &&
              context.photoId === photoId &&
              context.revision === revision &&
              context.workspaceTarget.targetGeneration === target.generation &&
              (!d.maskedTextureKey ||
                (d.maskedTextureKey === d.preparedMaskKey && d.preparedMaskState === 'ready')) &&
              (d.backend !== 'webgpu-hdr' ||
                (!!d.requestedSerial &&
                  d.requestedSerial === d.completedEditSerial &&
                  d.requestedSourceIdentity === d.presentedSourceIdentity &&
                  d.presentedSettingsRevision === String(revision) &&
                  d.targetGeneration === String(target.generation) &&
                  d.quality === 'normal' &&
                  d.presentedPolicy === 'reference'))
            )
          },
          { photoId, revision },
        ),
      { timeout: 60000 },
    )
    .toBe(true)
}

/** Renderer-local clocks exclude Playwright transport. No presenter or input owner is replaced. */
export async function navigationObserver(page: Page) {
  return page.evaluateHandle(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
    const hdr = c.dataset.backend === 'webgpu-hdr'
    const gl = hdr ? null : c.getContext('webgl2')
    if (!hdr && !gl) throw new Error('Qualification requires the ordinary GPU presenter')
    const pose = () => ({
      scale: Number(viewport.dataset.scale),
      x: Number(viewport.dataset.panX),
      y: Number(viewport.dataset.panY),
      fit: viewport.dataset.mode === 'fit',
    })
    const snapshot = () => ({
      pose: pose(),
      presented: c.dataset.presentedView,
      requestedSerial: Number(c.dataset.requestedSerial ?? c.dataset.presentationSerial),
      completedSerial: Number(c.dataset.completedEditSerial ?? c.dataset.presentationSerial),
      presentationSerial: Number(c.dataset.presentationSerial),
      source: c.dataset.presentedSourceIdentity ?? c.dataset.src,
      requestedSource: c.dataset.requestedSourceIdentity ?? c.dataset.src,
      revision: c.dataset.presentedSettingsRevision ?? c.dataset.frameGeometryRevision,
      target: c.dataset.targetGeneration ?? null,
      quality: c.dataset.quality ?? 'normal',
      policy: c.dataset.presentedPolicy ?? 'reference',
      prepared: c.dataset.preparedMaskKey ?? null,
      texture: c.dataset.maskedTextureKey ?? null,
      tiles: Number(c.dataset.renderedTiles ?? 0),
      uploads: Number(c.dataset.sourceUploads ?? 0),
      analysis: c.dataset.analysisSerial ?? c.dataset.histogramSamples ?? null,
      backing: { width: c.width, height: c.height },
    })
    type Snapshot = ReturnType<typeof snapshot>
    const matches = () => {
      const d = c.dataset
      const v = pose()
      const shown = JSON.parse(d.presentedView ?? 'null') as typeof v | null
      return (
        c.style.visibility !== 'hidden' &&
        d.editing === 'ready' &&
        !!shown &&
        shown.scale === v.scale &&
        shown.x === v.x &&
        shown.y === v.y &&
        shown.fit === v.fit &&
        (!hdr ||
          (!!d.requestedSerial &&
            d.completedEditSerial === d.requestedSerial &&
            d.presentedSourceIdentity === d.requestedSourceIdentity &&
            d.presentedEpoch === d.requestedEpoch &&
            d.quality === 'normal' &&
            d.presentedPolicy === 'reference')) &&
        (!d.maskedTextureKey ||
          (d.maskedTextureKey === d.preparedMaskKey && d.preparedMaskState === 'ready'))
      )
    }
    const changes: { at: number; state: Snapshot }[] = []
    let recording = false
    const waits = new Set<() => void>()
    const observer = new MutationObserver(() => {
      if (recording && changes.length < 2048)
        changes.push({ at: performance.now(), state: snapshot() })
      for (const wake of waits) wake()
    })
    observer.observe(c, { attributes: true })
    observer.observe(viewport, { attributes: true })
    const waitFor = (condition: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waits.delete(check)
          reject(new Error(`Navigation did not present: ${JSON.stringify(snapshot())}`))
        }, 15000)
        const check = () => {
          if (!condition()) return
          clearTimeout(timer)
          waits.delete(check)
          resolve()
        }
        waits.add(check)
        check()
      })
    const fence = async () => {
      if (hdr) await c.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
      else {
        const sync = gl!.fenceSync(gl!.SYNC_GPU_COMMANDS_COMPLETE, 0)
        if (!sync) throw new Error('WebGL completion fence unavailable')
        gl!.flush()
        try {
          await new Promise<void>((resolve, reject) => {
            const started = performance.now()
            const poll = () => {
              const result = gl!.clientWaitSync(sync, 0, 0)
              if (result === gl!.WAIT_FAILED || gl!.isContextLost())
                reject(new Error('WebGL completion failed'))
              else if (result !== gl!.TIMEOUT_EXPIRED) resolve()
              else if (performance.now() - started > 15000) reject(new Error('WebGL fence timeout'))
              else setTimeout(poll, 0)
            }
            poll()
          })
        } finally {
          gl!.deleteSync(sync)
        }
      }
    }
    const observation = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    let capturedAt = 0
    let capturedPoint = { x: 0, y: 0 }
    const inputs: { at: number; type: string; deltaX: number; deltaY: number; ctrl: boolean }[] = []
    const capture = (event: Event) => {
      capturedAt = performance.now()
      const e = event as WheelEvent
      const box = viewport.getBoundingClientRect()
      capturedPoint = {
        x: e.clientX - box.left - box.width / 2,
        y: e.clientY - box.top - box.height / 2,
      }
      if (recording)
        inputs.push({
          at: capturedAt,
          type: e.type,
          deltaX: e.deltaX ?? 0,
          deltaY: e.deltaY ?? 0,
          ctrl: e.ctrlKey,
        })
    }
    for (const type of ['wheel', 'pointerdown', 'mousemove', 'pointerup'])
      viewport.addEventListener(type, capture, true)
    const originalJson = JSON.stringify,
      originalClone = window.structuredClone
    const probe = { serializations: 0, bytes: 0, clones: 0, glUploads: 0, histogramReads: 0 }
    const encoded = (value: unknown, seen = new Set<unknown>()): boolean => {
      if (!value || typeof value !== 'object' || seen.has(value)) return false
      seen.add(value)
      if ('pngBase64' in value) return true
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false
      return Object.values(value).some((child) => encoded(child, seen))
    }
    const json: typeof JSON.stringify = ((...args: unknown[]) => {
      const result = Reflect.apply(originalJson, JSON, args) as string | undefined
      if (recording && result?.includes('pngBase64')) {
        probe.serializations++
        probe.bytes += result.length
      }
      return result
    }) as typeof JSON.stringify
    const clone: typeof structuredClone = (value, options) => {
      if (recording && encoded(value)) probe.clones++
      return originalClone(value, options)
    }
    const originalUpload = WebGL2RenderingContext.prototype.texImage2D
    const originalSubUpload = WebGL2RenderingContext.prototype.texSubImage2D
    const originalRead = WebGL2RenderingContext.prototype.readPixels
    WebGL2RenderingContext.prototype.texImage2D = function (...args: unknown[]) {
      if (recording) probe.glUploads++
      return Reflect.apply(originalUpload, this, args)
    }
    WebGL2RenderingContext.prototype.texSubImage2D = function (...args: unknown[]) {
      if (recording) probe.glUploads++
      return Reflect.apply(originalSubUpload, this, args)
    }
    WebGL2RenderingContext.prototype.readPixels = function (...args: unknown[]) {
      if (recording) probe.histogramReads++
      return Reflect.apply(originalRead, this, args)
    }
    JSON.stringify = json
    window.structuredClone = clone
    let measureStart = 0
    const wheel = (kind: 'pan' | 'zoom' | 'large', sign: number) => {
      const box = viewport.getBoundingClientRect()
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: 0,
          deltaX: kind === 'pan' ? sign * 6 : kind === 'large' ? sign * 600 : 0,
          deltaY: kind === 'zoom' ? sign * 12 : 0,
          ctrlKey: kind === 'zoom',
          clientX: box.x + box.width * 0.62,
          clientY: box.y + box.height * 0.43,
        }),
      )
    }
    const finish = async (before: Snapshot, started: number) => {
      let completedAt: number, requestedAt: number, gpuAt: number, observedAt: number
      let supersededObservations = 0
      let frameTimings: Record<string, number> | null
      // A coalesced request can replace a completion before its following paint.
      // Measure through the matching final observation, retaining the extra latency.
      for (;;) {
        await waitFor(() => snapshot().presentationSerial > before.presentationSerial && matches())
        const candidate = snapshot()
        completedAt = performance.now()
        requestedAt = Number(c.dataset.requestedAt ?? started)
        frameTimings = JSON.parse(c.dataset.frameTimings ?? 'null') as Record<string, number> | null
        await fence()
        gpuAt = performance.now()
        await observation()
        observedAt = performance.now()
        if (matches() && snapshot().completedSerial === candidate.completedSerial) break
        supersededObservations++
        if (observedAt - started > 15000)
          throw new Error('Navigation did not reach a stable presentation observation')
      }
      return {
        before,
        after: snapshot(),
        started,
        completedAt,
        gpuAt,
        observedAt,
        completionMs: completedAt - started,
        gpuMs: gpuAt - started,
        observedMs: observedAt - started,
        point: { ...capturedPoint },
        requestDelayMs: requestedAt - started,
        frameTimings,
        supersededObservations,
      }
    }
    const update = async (kind: 'pan' | 'zoom' | 'large', sign: number) => {
      const before = snapshot()
      wheel(kind, sign)
      return finish(before, capturedAt)
    }
    return {
      snapshot,
      settle: async () => {
        await waitFor(matches)
        await fence()
        await observation()
        return snapshot()
      },
      warm: async () => {
        for (let n = 0; n < 5; n++)
          for (const kind of ['pan', 'zoom'] as const) {
            await update(kind, 1)
            await update(kind, -1)
          }
      },
      start: () => {
        for (const key of Object.keys(probe) as (keyof typeof probe)[]) probe[key] = 0
        changes.length = 0
        inputs.length = 0
        measureStart = performance.getEntriesByName('irodori.preview.presentation').length
        recording = true
        return snapshot()
      },
      batch: async (kind: 'pan' | 'zoom' | 'large', count: number) => {
        const samples = []
        for (let n = 0; n < count; n++) samples.push(await update(kind, n % 2 ? -1 : 1))
        return samples
      },
      reversal: async () => {
        const before = snapshot(),
          started = performance.now()
        for (let n = 0; n < 17; n++) wheel(n % 3 ? 'pan' : 'zoom', n % 2 ? -1 : 1)
        return finish(before, started)
      },
      nativeFinish: (before: Snapshot) => finish(before, capturedAt),
      stop: () => {
        recording = false
        const payloads = performance
          .getEntriesByName('irodori.preview.presentation')
          .slice(measureStart)
          .filter((entry) =>
            originalJson((entry as PerformanceMeasure).detail)?.includes('pngBase64'),
          ).length
        return {
          probe: { ...probe },
          payloads,
          changes: [...changes],
          inputs: [...inputs],
          final: snapshot(),
        }
      },
      close: () => {
        recording = false
        observer.disconnect()
        JSON.stringify = originalJson
        window.structuredClone = originalClone
        WebGL2RenderingContext.prototype.texImage2D = originalUpload
        WebGL2RenderingContext.prototype.texSubImage2D = originalSubUpload
        WebGL2RenderingContext.prototype.readPixels = originalRead
        for (const type of ['wheel', 'pointerdown', 'mousemove', 'pointerup'])
          viewport.removeEventListener(type, capture, true)
      },
    }
  })
}

export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
  return {
    count: values.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1)!,
  }
}
