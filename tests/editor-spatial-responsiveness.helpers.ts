import type { ElectronApplication, Page } from '@playwright/test'
import { createEditorInputPacer, type EditorInputPacingMode } from './editor-input-pacing.helpers'

export type SpatialGesture = 'pan' | 'zoom' | 'zoom-fit-native' | 'drag'

/** Observe native interruptions without IPC or queue fences inside the input clock. */
export async function startSpatialDiagnostics(app: ElectronApplication, page: Page) {
  const nativeWindow = await app.browserWindow(page)
  const native = await nativeWindow.evaluateHandle((window) => {
    const contents = window.webContents as Electron.WebContents & {
      setEmbedder?: (embedder: Electron.WebContents) => void
    }
    const events: {
      wallAt: number
      reason: string
      windowFocused: boolean
      contentsFocused: boolean
      type?: string
      button?: string
    }[] = []
    let omitted = 0
    const record = (reason: string, input?: Electron.MouseInputEvent) => {
      if (events.length >= 256) {
        omitted++
        return
      }
      events.push({
        wallAt: Date.now(),
        reason,
        windowFocused: window.isFocused(),
        contentsFocused: contents.isFocused(),
        type: input?.type,
        button: input?.button,
      })
    }
    const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (input.type !== 'mouseMove') record('before-mouse-event', input)
    }
    const windowFocus = () => record('window:focus')
    const windowBlur = () => record('window:blur')
    const windowHide = () => record('window:hide')
    const windowShow = () => record('window:show')
    const windowMinimize = () => record('window:minimize')
    const windowRestore = () => record('window:restore')
    const contentsFocus = () => record('contents:focus')
    const contentsBlur = () => record('contents:blur')
    const original = contents.setEmbedder
    const enabled =
      process.platform === 'linux' &&
      Boolean(process.env.WAYLAND_DISPLAY) &&
      process.versions.electron === '44.3.0' &&
      !!original
    const wrapped = (embedder: Electron.WebContents) => {
      record('setEmbedder:before')
      original!.call(contents, embedder)
      record('setEmbedder:after')
    }
    contents.on('before-mouse-event', mouse)
    contents.on('focus', contentsFocus)
    contents.on('blur', contentsBlur)
    window.on('focus', windowFocus)
    window.on('blur', windowBlur)
    window.on('hide', windowHide)
    window.on('show', windowShow)
    window.on('minimize', windowMinimize)
    window.on('restore', windowRestore)
    if (enabled) contents.setEmbedder = wrapped
    record('start')
    return {
      stop: () => {
        record('stop')
        if (enabled && contents.setEmbedder === wrapped) contents.setEmbedder = original
        contents.off('before-mouse-event', mouse)
        contents.off('focus', contentsFocus)
        contents.off('blur', contentsBlur)
        window.off('focus', windowFocus)
        window.off('blur', windowBlur)
        window.off('hide', windowHide)
        window.off('show', windowShow)
        window.off('minimize', windowMinimize)
        window.off('restore', windowRestore)
        return { events, omitted, limit: 256, embedderObserved: enabled }
      },
    }
  })
  try {
    const renderer = await page.evaluateHandle(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      const listeners = new AbortController()
      const state = () => ({
        pointerLocked: document.pointerLockElement === viewport,
        captured: viewport.hasPointerCapture(1),
        dragging: viewport.dataset.dragging,
        gliding: viewport.dataset.gliding,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        targetGeneration: canvas.dataset.targetGeneration,
        requestedSerial: canvas.dataset.requestedSerial,
        completedSerial: canvas.dataset.completedEditSerial,
        x: viewport.dataset.panX,
        y: viewport.dataset.panY,
        scale: viewport.dataset.scale,
      })
      const events: {
        at: number
        wallAt: number
        reason: string
        state: ReturnType<typeof state>
        trusted?: boolean
        buttons?: number
        pointerId?: number
        movementX?: number
        movementY?: number
      }[] = []
      let omitted = 0
      const record = (reason: string, event?: Event) => {
        if (events.length >= 256) {
          omitted++
          return
        }
        events.push({
          at: performance.now(),
          wallAt: Date.now(),
          reason,
          state: state(),
          trusted: event?.isTrusted,
          buttons: event instanceof MouseEvent ? event.buttons : undefined,
          pointerId: event instanceof PointerEvent ? event.pointerId : undefined,
          movementX: event instanceof MouseEvent ? event.movementX : undefined,
          movementY: event instanceof MouseEvent ? event.movementY : undefined,
        })
      }
      const transition = (event: Event) => record(event.type, event)
      for (const type of [
        'pointerlockchange',
        'pointerlockerror',
        'gotpointercapture',
        'lostpointercapture',
        'pointerdown',
        'pointercancel',
        'pointerup',
        'mouseup',
        'visibilitychange',
      ])
        document.addEventListener(type, transition, { capture: true, signal: listeners.signal })
      for (const type of ['focus', 'blur'])
        window.addEventListener(type, transition, { signal: listeners.signal })
      document.addEventListener(
        'mousemove',
        (event) => {
          if (
            event.isTrusted &&
            !(event.buttons & 1) &&
            (document.pointerLockElement === viewport || viewport.dataset.dragging === 'true')
          )
            record('native-move-without-left-button', event)
        },
        { capture: true, signal: listeners.signal },
      )
      const observer = new MutationObserver(() => record('drag-state'))
      observer.observe(viewport, {
        attributes: true,
        attributeFilter: ['data-pointer-locked', 'data-dragging', 'data-gliding'],
      })
      record('start')
      return {
        stop: () => {
          record('stop')
          listeners.abort()
          observer.disconnect()
          return { events, omitted, limit: 256, epochMs: performance.timeOrigin }
        },
      }
    })
    return {
      finish: async () => {
        try {
          const [rendererTrace, nativeTrace] = await Promise.allSettled([
            renderer.evaluate((control) => control.stop()),
            native.evaluate((control) => control.stop()),
          ])
          if (rendererTrace.status === 'rejected') throw rendererTrace.reason
          if (nativeTrace.status === 'rejected') throw nativeTrace.reason
          return { renderer: rendererTrace.value, native: nativeTrace.value }
        } finally {
          await Promise.all([renderer.dispose(), native.dispose()])
        }
      },
    }
  } catch (error) {
    try {
      await native.evaluate((control) => control.stop())
    } finally {
      await native.dispose()
    }
    throw error
  }
}

export type SpatialDiagnostics = Awaited<
  ReturnType<Awaited<ReturnType<typeof startSpatialDiagnostics>>['finish']>
>

/** Prepare the complete measured path; warm measurements never hide tile misses. */
export async function warmSpatialPath(
  page: Page,
  gesture: SpatialGesture,
  targetGeneration: number,
) {
  return page.evaluate(
    async ({ gesture, targetGeneration }) => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      const histogram = document.getElementById('histogram')!
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const confirmTarget = async () => {
        const completedGeneration = Number(canvas.dataset.targetGeneration)
        if (completedGeneration !== targetGeneration)
          throw new Error(
            `Display target changed during spatial warmup: ${JSON.stringify({
              expectedGeneration: targetGeneration,
              completedGeneration,
              target: await window.irodori.getDisplayState(),
            })}`,
          )
      }
      await confirmTarget()
      const settle = async () => {
        const start = performance.now()
        do {
          await frame()
          if (performance.now() - start > 10000) throw new Error('Spatial warmup did not converge.')
        } while (
          canvas.dataset.quality !== 'normal' ||
          canvas.dataset.completedEditSerial !== canvas.dataset.requestedSerial
        )
        await confirmTarget()
      }
      const bounds = viewport.getBoundingClientRect()
      const zooming = gesture === 'zoom' || gesture === 'zoom-fit-native'
      const fitToNative = gesture === 'zoom-fit-native'
      const startScale = Number(viewport.dataset.scale)
      const zoomDelta = fitToNative ? Math.log(1 / startScale) * 5 : 1
      const anchor = {
        x: fitToNative ? bounds.width * 0.15 : 0,
        y: fitToNative ? -bounds.height * 0.1 : 0,
      }
      let previous = 0
      const positions = Array.from({ length: 40 }, (_, i) => {
        const step = (i + 1) % 40
        return step <= 20 ? step : 40 - step
      })
      const inputs = []
      for (const position of positions) {
        const at = performance.now()
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: zooming,
          clientX: bounds.x + bounds.width / 2 + anchor.x,
          clientY: bounds.y + bounds.height / 2 + anchor.y,
          deltaX: zooming ? 0 : (previous - position) * 4,
          deltaY: zooming ? (previous - position) * zoomDelta : (previous - position) * 2,
        })
        viewport.dispatchEvent(event)
        previous = position
        await settle()
        inputs.push({
          at,
          position,
          view: canvas.dataset.presentedView,
          wheel: { clientX: event.clientX, clientY: event.clientY, deltaY: event.deltaY },
        })
      }
      if (gesture === 'drag') {
        // Include the native release glide's bounded 24 CSS-pixel extension.
        let last = { x: 0, y: 0 }
        for (const next of [
          { x: -24, y: -24 },
          { x: 104, y: -24 },
          { x: 104, y: 64 },
          { x: -24, y: 64 },
          { x: 0, y: 0 },
        ]) {
          viewport.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaX: last.x - next.x,
              deltaY: last.y - next.y,
            }),
          )
          last = next
          await settle()
          inputs.push({ at: performance.now(), position: null, view: canvas.dataset.presentedView })
        }
      }
      const analysisDrainStartedAt = performance.now()
      const analysisSettled = () => {
        const curve = histogram.querySelector<SVGSVGElement>('svg[role="slider"]')
        return (
          canvas.dataset.quality === 'normal' &&
          canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial &&
          canvas.dataset.analysisPending === 'false' &&
          !!canvas.dataset.analysisKey &&
          canvas.dataset.analysisKey === canvas.dataset.displayedAnalysisKey &&
          histogram.dataset.editSerial === canvas.dataset.analysisSerial &&
          curve?.dataset.curveEditSerial === canvas.dataset.analysisSerial &&
          curve?.dataset.animating === 'false'
        )
      }
      while (!analysisSettled()) {
        await frame()
        if (performance.now() - analysisDrainStartedAt > 10000)
          throw new Error('Spatial warmup analysis did not converge.')
      }
      await confirmTarget()
      return {
        inputs,
        renderedTiles: Number(canvas.dataset.renderedTiles),
        finalView: canvas.dataset.presentedView,
        analysisDrainMs: performance.now() - analysisDrainStartedAt,
        analysisKey: canvas.dataset.analysisKey,
        analysisSerial: canvas.dataset.analysisSerial,
        histogramSerial: histogram.dataset.editSerial,
        targetGeneration: canvas.dataset.targetGeneration,
      }
    },
    { gesture, targetGeneration },
  )
}

/** Real event handlers, an uninterrupted input clock, and fenced publication plus a following rAF. */
export async function sustainedSpatialInput(
  page: Page,
  options: {
    gesture: SpatialGesture
    frequency: 60 | 120
    cursor: { x: number; y: number }
    targetGeneration: number
    pacing?: EditorInputPacingMode
  },
) {
  const pacer = options.pacing
    ? await page.evaluateHandle(createEditorInputPacer, {
        mode: options.pacing,
        frequency: options.frequency,
      })
    : null
  try {
    return await page.evaluate(
      async ({ options, pacer }) => {
        const { gesture, frequency, cursor } = options
        type View = { fit: boolean; scale: number; x: number; y: number }
        const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        const histogram = document.getElementById('histogram')!
        const device = canvas.getContext('webgpu')!.getConfiguration()!.device
        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
        const readView = (value: string | undefined): View | null =>
          value ? (JSON.parse(value) as View) : null
        const sameView = (a: View | null, b: View | null) =>
          !!a &&
          !!b &&
          a.fit === b.fit &&
          ['scale', 'x', 'y'].every(
            (key) =>
              Math.abs(a[key as keyof Omit<View, 'fit'>] - b[key as keyof Omit<View, 'fit'>]) <
              1e-6,
          )
        const photo = (await window.irodori.listPhotos()).photos.find(
          (photo) => photo.filename === 'sony-zv1.ARW',
        )!
        const historyBefore = await window.irodori.getEditHistory(photo.id)
        const editsBefore = await window.irodori.getEdits(photo.id)
        const readAnalysis = () => {
          const curve = histogram.querySelector<SVGSVGElement>('svg[role="slider"]')
          return {
            at: performance.now(),
            pending: canvas.dataset.analysisPending,
            key: canvas.dataset.analysisKey,
            displayedKey: canvas.dataset.displayedAnalysisKey,
            serial: canvas.dataset.analysisSerial,
            histogramSerial: histogram.dataset.editSerial,
            curveSerial: curve?.dataset.curveEditSerial,
            animating: curve?.dataset.animating,
            targetGeneration: canvas.dataset.targetGeneration,
          }
        }
        const analysisSettled = () => {
          const analysis = readAnalysis()
          return (
            canvas.dataset.quality === 'normal' &&
            canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial &&
            analysis.pending === 'false' &&
            !!analysis.key &&
            analysis.key === analysis.displayedKey &&
            analysis.histogramSerial === analysis.serial &&
            analysis.curveSerial === analysis.serial &&
            analysis.animating === 'false'
          )
        }
        // A display refresh can arrive between warmup and this call. Drain only actual
        // outstanding analysis before fixing the baseline and starting the input clock.
        const baselineDrainStartedAt = performance.now()
        while (!analysisSettled()) {
          await frame()
          if (performance.now() - baselineDrainStartedAt > 10000)
            throw new Error('Spatial baseline analysis did not converge.')
        }
        const baselineAnalysisDrainMs = performance.now() - baselineDrainStartedAt
        const initialAnalysis = readAnalysis()
        const initialTargetGeneration = Number(canvas.dataset.targetGeneration)
        const initialHistogramCurves = Array.from(histogram.querySelectorAll('svg path')).map(
          (path) => path.getAttribute('d'),
        )
        const initialView = readView(canvas.dataset.presentedView)!
        const sourceIdentity = canvas.dataset.presentedSourceIdentity
        const epoch = Number(canvas.dataset.presentedEpoch)
        const histogramSerial = histogram.dataset.editSerial
        const uploadsBefore = Number(canvas.dataset.sourceUploads)
        const renderedBefore = Number(canvas.dataset.renderedTiles)
        const nativeCapture =
          document.pointerLockElement === viewport || viewport.hasPointerCapture(1)
        const nativePointerLock = document.pointerLockElement === viewport
        const spatialState = () => ({
          pointerLocked: document.pointerLockElement === viewport,
          captured: viewport.hasPointerCapture(1),
          dragging: viewport.dataset.dragging,
          gliding: viewport.dataset.gliding,
          focused: document.hasFocus(),
          visibility: document.visibilityState,
          targetGeneration: Number(canvas.dataset.targetGeneration),
          x: Number(viewport.dataset.panX),
          y: Number(viewport.dataset.panY),
          scale: Number(viewport.dataset.scale),
          requestedSerial: Number(canvas.dataset.requestedSerial),
          completedSerial: Number(canvas.dataset.completedEditSerial),
          requestedView: canvas.dataset.requestedView,
          presentedView: canvas.dataset.presentedView,
        })
        const inputs: {
          serial: number
          at: number
          raf: number | null
          scheduledAt?: number
          dispatchLatenessMs?: number
          position: number
          expectedView: View
          wheel: {
            clientX: number
            clientY: number
            anchorX: number
            anchorY: number
            deltaX: number
            deltaY: number
          } | null
          dispatchCompletedAt: number
          dispatchKind: 'mouse-relative' | 'pointer-absolute' | 'wheel'
          stateBefore: ReturnType<typeof spatialState>
          stateAfter: ReturnType<typeof spatialState> | null
        }[] = []
        const requests: {
          serial: number
          at: number
          inputSerial: number | null
          view: View | null
          sourceIdentity: string | undefined
          epoch: number
          intent: string
          phase: string
        }[] = []
        const publications: {
          serial: number
          at: number
          view: View | null
          sourceIdentity: string | undefined
          epoch: number
          quality: string | undefined
          presentedPolicy: string | undefined
          intent: string | undefined
          visibility: string
          observation: string
          frameTimings: string | undefined
          resources: {
            renderedTiles: number
            sourceUploads: number
            allocatedRamBytes: number
            allocatedGpuBytes: number
          }
        }[] = []
        const presentations: {
          serial: number
          inputSerial: number
          at: number
          latencyMs: number
          view: View | null
          sourceIdentity: string | undefined
          epoch: number
          quality: string | undefined
          presentedPolicy: string | undefined
          intent: string | undefined
        }[] = []
        const requestBySerial = new Map<number, (typeof requests)[number]>()
        const pending: Promise<void>[] = []
        const analysisObservations: (ReturnType<typeof readAnalysis> & { reason: string })[] = []
        const displayTargets: {
          at: number
          generation: number
          mode: string
          colorSpace: string
          peak: number
          headroom: number | null
          duringInput: boolean
        }[] = []
        let targetChangedDuringInput = false
        let releaseAt = 0
        let omittedAnalysisObservations = 0,
          omittedDisplayTargets = 0
        const observeAnalysis = (reason: string) => {
          if (analysisObservations.length < 512)
            analysisObservations.push({ ...readAnalysis(), reason })
          else omittedAnalysisObservations++
        }
        const offDisplay = window.irodori.onDisplayState((target) => {
          const snapshot = {
            at: performance.now(),
            generation: target.generation,
            mode: target.mode,
            colorSpace: target.colorSpace,
            peak: target.peak,
            headroom: target.headroom,
            duringInput: inputs.length > 0 && !releaseAt,
          }
          if (snapshot.duringInput && target.generation !== options.targetGeneration)
            targetChangedDuringInput = true
          const previous = displayTargets.at(-1)
          if (
            !previous ||
            ['generation', 'mode', 'colorSpace', 'peak', 'headroom'].some(
              (key) =>
                snapshot[key as keyof typeof snapshot] !== previous[key as keyof typeof previous],
            )
          )
            if (displayTargets.length < 128) displayTargets.push(snapshot)
            else omittedDisplayTargets++
        })
        let refinementMs = 0,
          histogramUpdates = 0,
          regressed = false,
          attributionFailures = 0,
          unobservedRequestSerials = 0,
          loaders = 0,
          hidden = 0,
          previousRequested = Number(canvas.dataset.requestedSerial),
          previousPresented = Number(canvas.dataset.completedEditSerial),
          error: string | undefined
        const histogramObserver = new MutationObserver(() => {
          histogramUpdates++
          observeAnalysis('histogram-publication')
        })
        histogramObserver.observe(histogram, {
          attributes: true,
          attributeFilter: ['data-edit-serial'],
        })
        const observer = new MutationObserver((records) => {
          if (
            inputs.length > 0 &&
            !releaseAt &&
            Number(canvas.dataset.targetGeneration) !== options.targetGeneration
          )
            targetChangedDuringInput = true
          if (
            records.some((record) =>
              [
                'data-analysis-key',
                'data-analysis-pending',
                'data-analysis-serial',
                'data-displayed-analysis-key',
                'data-target-generation',
              ].includes(record.attributeName ?? ''),
            )
          )
            observeAnalysis('canvas-analysis-or-target')
          if (records.some((record) => record.attributeName === 'data-requested-serial')) {
            const serial = Number(canvas.dataset.requestedSerial),
              at = Number(canvas.dataset.requestedAt)
            const view = readView(canvas.dataset.requestedView)
            if (serial > previousRequested + 1)
              unobservedRequestSerials += serial - previousRequested - 1
            previousRequested = serial
            const input = [...inputs]
              .reverse()
              .find((input) => input.at <= at && sameView(input.expectedView, view))
            const request = {
              serial,
              at,
              inputSerial: input?.serial ?? null,
              view,
              sourceIdentity: canvas.dataset.requestedSourceIdentity,
              epoch: Number(canvas.dataset.requestedEpoch),
              intent: canvas.dataset.requestIntent ?? 'unknown',
              phase: input ? 'input' : releaseAt ? 'release' : 'unattributed',
            }
            requests.push(request)
            requestBySerial.set(serial, request)
            if (
              request.sourceIdentity !== sourceIdentity ||
              request.epoch !== epoch ||
              request.intent !== 'navigation' ||
              (!releaseAt && !input)
            )
              attributionFailures++
          }
          if (!records.some((record) => record.attributeName === 'data-completed-edit-serial'))
            return
          const serial = Number(canvas.dataset.completedEditSerial)
          if (serial === previousPresented) return
          regressed ||= serial < previousPresented
          previousPresented = serial
          const request = requestBySerial.get(serial)
          const publication = {
            serial,
            at: performance.now(),
            view: readView(canvas.dataset.presentedView),
            sourceIdentity: canvas.dataset.presentedSourceIdentity,
            epoch: Number(canvas.dataset.presentedEpoch),
            quality: canvas.dataset.quality,
            presentedPolicy: canvas.dataset.presentedPolicy,
            intent: canvas.dataset.presentationIntent,
            visibility: getComputedStyle(canvas).visibility,
            observation: 'pending',
            frameTimings: canvas.dataset.frameTimings,
            resources: {
              renderedTiles: Number(canvas.dataset.renderedTiles),
              sourceUploads: Number(canvas.dataset.sourceUploads),
              allocatedRamBytes: Number(canvas.dataset.allocatedRamBytes),
              allocatedGpuBytes: Number(canvas.dataset.allocatedGpuBytes),
            },
          }
          publications.push(publication)
          if (
            !request ||
            !sameView(publication.view, request.view) ||
            publication.sourceIdentity !== sourceIdentity ||
            publication.epoch !== epoch ||
            publication.intent !== request.intent
          )
            attributionFailures++
          pending.push(
            (async () => {
              // The publication serial follows the image's own final blit fence. Another
              // queue fence would also wait for unrelated histogram or following work.
              await frame()
              if (
                Number(canvas.dataset.completedEditSerial) !== serial ||
                getComputedStyle(canvas).visibility === 'hidden'
              ) {
                publication.observation = 'overwritten-or-hidden-before-observation'
                return
              }
              publication.observation = 'visible-after-rAF'
              if (
                request?.inputSerial === null ||
                request?.inputSerial === undefined ||
                request.phase !== 'input'
              )
                return
              const input = inputs[request.inputSerial]
              presentations.push({
                serial,
                inputSerial: input.serial,
                at: performance.now(),
                latencyMs: performance.now() - input.at,
                view: publication.view,
                sourceIdentity: publication.sourceIdentity,
                epoch: publication.epoch,
                quality: publication.quality,
                presentedPolicy: publication.presentedPolicy,
                intent: publication.intent,
              })
            })(),
          )
        })
        observer.observe(canvas, {
          attributes: true,
          attributeFilter: [
            'data-requested-serial',
            'data-completed-edit-serial',
            'data-analysis-key',
            'data-analysis-pending',
            'data-analysis-serial',
            'data-displayed-analysis-key',
            'data-target-generation',
          ],
        })
        let previousPosition = 0
        let expectedPrevious = initialView
        try {
          if (!sourceIdentity || !initialView || !Number.isFinite(epoch))
            throw new Error('Missing authoritative spatial identity.')
          if (Number(canvas.dataset.targetGeneration) !== options.targetGeneration)
            throw new Error('Display target changed after spatial warmup.')
          if (gesture === 'drag' && !nativePointerLock)
            throw new Error('Native pointer lock was not acquired before timed dragging.')
          let deadline = 0
          if (pacer) await pacer.start()
          else deadline = await frame()
          const bounds = viewport.getBoundingClientRect()
          const zooming = gesture === 'zoom' || gesture === 'zoom-fit-native'
          const fitToNative = gesture === 'zoom-fit-native'
          const zoomDelta = fitToNative ? Math.log(1 / initialView.scale) * 5 : 1
          const anchor = {
            x: fitToNative ? bounds.width * 0.15 : 0,
            y: fitToNative ? -bounds.height * 0.1 : 0,
          }
          const image = {
            width: Number(viewport.dataset.imageWidth),
            height: Number(viewport.dataset.imageHeight),
          }
          for (let serial = 0; serial < 120; serial++) {
            const tick = pacer ? await pacer.next() : null
            let raf = tick ? tick.raf : await frame()
            while (!tick && (raf ?? 0) + 0.1 < deadline) raf = await frame()
            const step = (serial + 1) % 40,
              position = step <= 20 ? step : 40 - step
            const at = performance.now()
            const wheel =
              gesture === 'drag'
                ? null
                : new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    ctrlKey: zooming,
                    clientX: bounds.x + bounds.width / 2 + anchor.x,
                    clientY: bounds.y + bounds.height / 2 + anchor.y,
                    deltaX: zooming ? 0 : (previousPosition - position) * 4,
                    deltaY: zooming
                      ? (previousPosition - position) * zoomDelta
                      : (previousPosition - position) * 2,
                  })
            // Derive the independent expectation from the event's represented coordinates:
            // Chromium can quantize fractional constructor coordinates before dispatch.
            const eventAnchor = wheel
              ? {
                  x: wheel.clientX - bounds.left - bounds.width / 2,
                  y: wheel.clientY - bounds.top - bounds.height / 2,
                }
              : anchor
            const scale = initialView.scale * Math.exp(position * zoomDelta * 0.01)
            const ratio = scale / expectedPrevious.scale
            const limit = {
              x: Math.max(0, (image.width * scale - bounds.width) / 2),
              y: Math.max(0, (image.height * scale - bounds.height) / 2),
            }
            const expectedView: View = zooming
              ? {
                  fit: false,
                  scale,
                  x: Math.max(
                    -limit.x,
                    Math.min(limit.x, eventAnchor.x - (eventAnchor.x - expectedPrevious.x) * ratio),
                  ),
                  y: Math.max(
                    -limit.y,
                    Math.min(limit.y, eventAnchor.y - (eventAnchor.y - expectedPrevious.y) * ratio),
                  ),
                }
              : {
                  ...initialView,
                  fit: false,
                  x: initialView.x + position * 4,
                  y: initialView.y + position * 2,
                }
            const input = {
              serial,
              at,
              raf,
              position,
              expectedView,
              scheduledAt: tick?.scheduledAt,
              dispatchLatenessMs: tick ? Math.max(0, at - tick.scheduledAt) : undefined,
              wheel: wheel
                ? {
                    clientX: wheel.clientX,
                    clientY: wheel.clientY,
                    anchorX: eventAnchor.x,
                    anchorY: eventAnchor.y,
                    deltaX: wheel.deltaX,
                    deltaY: wheel.deltaY,
                  }
                : null,
              dispatchCompletedAt: 0,
              dispatchKind:
                gesture !== 'drag'
                  ? ('wheel' as const)
                  : document.pointerLockElement === viewport
                    ? ('mouse-relative' as const)
                    : ('pointer-absolute' as const),
              stateBefore: spatialState(),
              stateAfter: null as ReturnType<typeof spatialState> | null,
            }
            if (input.stateBefore.targetGeneration !== options.targetGeneration)
              targetChangedDuringInput = true
            if (tick) pacer!.recordDispatch(tick.index, input.at)
            inputs.push(input)
            if (gesture === 'drag') {
              if (input.dispatchKind === 'mouse-relative')
                viewport.dispatchEvent(
                  new MouseEvent('mousemove', {
                    bubbles: true,
                    buttons: 1,
                    movementX: (position - previousPosition) * 4,
                    movementY: (position - previousPosition) * 2,
                  }),
                )
              else
                viewport.dispatchEvent(
                  new PointerEvent('pointermove', {
                    bubbles: true,
                    buttons: 1,
                    pointerId: 1,
                    isPrimary: true,
                    pointerType: 'mouse',
                    clientX: cursor.x + position * 4,
                    clientY: cursor.y + position * 2,
                  }),
                )
            } else viewport.dispatchEvent(wheel!)
            previousPosition = position
            expectedPrevious = expectedView
            input.dispatchCompletedAt = performance.now()
            input.stateAfter = spatialState()
            if (input.stateAfter.targetGeneration !== options.targetGeneration)
              targetChangedDuringInput = true
            deadline += 1000 / frequency
            loaders += Number(document.body.textContent?.includes('Loading preview…'))
            hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
          }
          releaseAt = performance.now()
          pacer?.stop()
          if (gesture === 'drag') {
            viewport.dispatchEvent(
              new PointerEvent('pointerup', {
                bubbles: true,
                button: 0,
                pointerId: 1,
                isPrimary: true,
                pointerType: 'mouse',
              }),
            )
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
          }
          do {
            await frame()
            if (performance.now() - releaseAt > 10000)
              throw new Error('Spatial refinement did not converge.')
          } while (
            canvas.dataset.quality !== 'normal' ||
            canvas.dataset.completedEditSerial !== canvas.dataset.requestedSerial ||
            viewport.dataset.gliding === 'true' ||
            viewport.dataset.dragging === 'true'
          )
          await frame()
          refinementMs = performance.now() - releaseAt
          await Promise.all(pending)
        } catch (failure) {
          error = String(failure)
        } finally {
          observer.disconnect()
          histogramObserver.disconnect()
          offDisplay()
          pacer?.stop()
        }
        const historyAfter = await window.irodori.getEditHistory(photo.id)
        const editsAfter = await window.irodori.getEdits(photo.id)
        const changedPresentations: typeof presentations = [],
          duplicatePresentations: typeof presentations = []
        const changedInputs = new Set<number>()
        let lastVisibleView = initialView
        for (const presentation of [...presentations].sort((a, b) => a.at - b.at)) {
          if (
            changedInputs.has(presentation.inputSerial) ||
            sameView(presentation.view, lastVisibleView)
          )
            duplicatePresentations.push(presentation)
          else {
            changedInputs.add(presentation.inputSerial)
            changedPresentations.push(presentation)
            lastVisibleView = presentation.view!
          }
        }
        const duringInput = changedPresentations.filter(
          (presentation) => presentation.at <= releaseAt,
        )
        const boundaries = [
          inputs[0]?.at ?? releaseAt,
          ...duringInput.map((frame) => frame.at),
          releaseAt,
        ]
        const gaps = boundaries.slice(1).map((at, i) => at - boundaries[i])
        const latencies = changedPresentations.map((frame) => frame.latencyMs).sort((a, b) => a - b)
        const quantile = (p: number) =>
          latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null
        const requestedInputs = new Set(
          requests
            .filter((request) => request.phase === 'input' && request.inputSerial !== null)
            .map((request) => request.inputSerial!),
        )
        const presentedInputs = new Set(changedPresentations.map((frame) => frame.inputSerial))
        return {
          gesture,
          requestedHz: frequency,
          pacingMode: options.pacing ?? 'legacy-native-raf',
          pacing: pacer?.snapshot() ?? null,
          epochMs: performance.timeOrigin,
          inputs,
          requests,
          publications,
          presentations,
          changedPresentations,
          duplicatePresentations,
          changedPresentationCount: changedPresentations.length,
          duplicatePresentationCount: duplicatePresentations.length,
          sourceIdentity,
          epoch,
          initialView,
          finalView: readView(canvas.dataset.presentedView),
          nativeCapture,
          nativePointerLock,
          expectedTargetGeneration: options.targetGeneration,
          initialTargetGeneration,
          targetChangedDuringInput,
          inputStartedAt: inputs[0]?.at ?? null,
          releaseAt,
          inputDurationMs: releaseAt - (inputs[0]?.at ?? releaseAt),
          achievedHz:
            inputs.length > 1
              ? ((inputs.length - 1) * 1000) / (inputs.at(-1)!.at - inputs[0].at)
              : 0,
          inputIntervalMaximumMs: Math.max(
            0,
            ...inputs.slice(1).map((input, i) => input.at - inputs[i].at),
          ),
          latencyP50Ms: quantile(0.5),
          latencyP95Ms: quantile(0.95),
          latencyP99Ms: quantile(0.99),
          latencyMaximumMs: latencies.at(-1) ?? null,
          visibleUpdatesPerSecond:
            (duringInput.length * 1000) / (releaseAt - (inputs[0]?.at ?? releaseAt)),
          longestPresentationGapMs: Math.max(0, ...gaps),
          refinementMs,
          uniqueRequestedInputs: requestedInputs.size,
          uniquePresentedInputs: presentedInputs.size,
          coalescedBeforeObservedRequest: inputs.length - requestedInputs.size,
          requestedWithoutVisibleResult: [...requestedInputs].filter(
            (serial) => !presentedInputs.has(serial),
          ).length,
          unobservedRequestSerials,
          missing: inputs.length - presentedInputs.size,
          regressed,
          attributionFailures,
          histogramUpdates,
          histogramUnchanged: histogramSerial === histogram.dataset.editSerial,
          histogramCurveUnchanged:
            JSON.stringify(initialHistogramCurves) ===
            JSON.stringify(
              Array.from(histogram.querySelectorAll('svg path')).map((path) =>
                path.getAttribute('d'),
              ),
            ),
          baselineAnalysisDrainMs,
          initialAnalysis,
          finalAnalysis: readAnalysis(),
          finalAnalysisSettled: analysisSettled(),
          analysisObservations,
          omittedAnalysisObservations,
          displayTargets,
          omittedDisplayTargets,
          historyUnchanged: JSON.stringify(historyBefore) === JSON.stringify(historyAfter),
          editsUnchanged: JSON.stringify(editsBefore) === JSON.stringify(editsAfter),
          uploadsBefore,
          uploadsAfter: Number(canvas.dataset.sourceUploads),
          renderedBefore,
          renderedAfter: Number(canvas.dataset.renderedTiles),
          finalNormal:
            canvas.dataset.quality === 'normal' &&
            canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial,
          captureReleased:
            document.pointerLockElement !== viewport &&
            !viewport.hasPointerCapture(1) &&
            viewport.dataset.dragging === 'false',
          backend: canvas.dataset.backend,
          policy: canvas.dataset.interactivePolicy,
          loaders,
          hidden,
          allocatedBytes: Number(canvas.dataset.allocatedBytes),
          allocatedRamBytes: Number(canvas.dataset.allocatedRamBytes),
          allocatedGpuBytes: Number(canvas.dataset.allocatedGpuBytes),
          ramBudgetBytes: Number(canvas.dataset.ramBudgetBytes),
          vramBudgetBytes: Number(canvas.dataset.vramBudgetBytes),
          resourcePolicyRevision: Number(canvas.dataset.resourcePolicyRevision),
          canvas: {
            width: canvas.width,
            height: canvas.height,
            bounds: canvas.getBoundingClientRect().toJSON(),
          },
          device: {
            label: device.label,
            features: [...device.features],
            maxTextureDimension2D: device.limits.maxTextureDimension2D,
            maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
          },
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          error,
        }
      },
      { options, pacer },
    )
  } finally {
    if (pacer) {
      await pacer.evaluate((value) => value.stop()).catch(() => undefined)
      await pacer.dispose()
    }
  }
}
