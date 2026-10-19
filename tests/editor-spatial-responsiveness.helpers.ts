import type { Page } from '@playwright/test'

export type SpatialGesture = 'pan' | 'zoom' | 'zoom-fit-native' | 'drag'

/** Prepare the complete measured path; warm measurements never hide tile misses. */
export async function warmSpatialPath(page: Page, gesture: SpatialGesture) {
  return page.evaluate(async (gesture) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const histogram = document.getElementById('histogram')!
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const settle = async () => {
      const start = performance.now()
      do {
        await frame()
        if (performance.now() - start > 10000) throw new Error('Spatial warmup did not converge.')
      } while (
        canvas.dataset.quality !== 'normal' ||
        canvas.dataset.completedEditSerial !== canvas.dataset.requestedSerial
      )
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
  }, gesture)
}

/** Real event handlers, an uninterrupted input clock, and fenced publication plus a following rAF. */
export async function sustainedSpatialInput(
  page: Page,
  options: { gesture: SpatialGesture; frequency: 60 | 120; cursor: { x: number; y: number } },
) {
  return page.evaluate(async ({ gesture, frequency, cursor }) => {
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
          Math.abs(a[key as keyof Omit<View, 'fit'>] - b[key as keyof Omit<View, 'fit'>]) < 1e-6,
      )
    const photo = (await window.luma.listPhotos()).photos.find(
      (photo) => photo.filename === 'sony-zv1.ARW',
    )!
    const historyBefore = await window.luma.getEditHistory(photo.id)
    const editsBefore = await window.luma.getEdits(photo.id)
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
    const initialHistogramCurves = Array.from(histogram.querySelectorAll('svg path')).map((path) =>
      path.getAttribute('d'),
    )
    const initialView = readView(canvas.dataset.presentedView)!
    const sourceIdentity = canvas.dataset.presentedSourceIdentity
    const epoch = Number(canvas.dataset.presentedEpoch)
    const histogramSerial = histogram.dataset.editSerial
    const uploadsBefore = Number(canvas.dataset.sourceUploads)
    const renderedBefore = Number(canvas.dataset.renderedTiles)
    const nativeCapture = document.pointerLockElement === viewport || viewport.hasPointerCapture(1)
    const inputs: {
      serial: number
      at: number
      raf: number
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
    }[] = []
    let omittedAnalysisObservations = 0,
      omittedDisplayTargets = 0
    const observeAnalysis = (reason: string) => {
      if (analysisObservations.length < 512)
        analysisObservations.push({ ...readAnalysis(), reason })
      else omittedAnalysisObservations++
    }
    const offDisplay = window.luma.onDisplayState((target) => {
      const snapshot = {
        at: performance.now(),
        generation: target.generation,
        mode: target.mode,
        colorSpace: target.colorSpace,
        peak: target.peak,
        headroom: target.headroom,
      }
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
    let releaseAt = 0,
      refinementMs = 0,
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
      if (!records.some((record) => record.attributeName === 'data-completed-edit-serial')) return
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
      if (gesture === 'drag' && !nativeCapture)
        throw new Error('Native drag capture was not acquired.')
      const started = await frame()
      let deadline = started
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
        let raf = await frame()
        while (raf + 0.1 < deadline) raf = await frame()
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
        }
        inputs.push(input)
        if (gesture === 'drag') {
          if (document.pointerLockElement === viewport)
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
        deadline += 1000 / frequency
        loaders += Number(document.body.textContent?.includes('Loading preview…'))
        hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
      }
      releaseAt = performance.now()
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
    }
    const historyAfter = await window.luma.getEditHistory(photo.id)
    const editsAfter = await window.luma.getEdits(photo.id)
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
    const duringInput = changedPresentations.filter((presentation) => presentation.at <= releaseAt)
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
      inputStartedAt: inputs[0]?.at ?? null,
      releaseAt,
      inputDurationMs: releaseAt - (inputs[0]?.at ?? releaseAt),
      achievedHz:
        inputs.length > 1 ? ((inputs.length - 1) * 1000) / (inputs.at(-1)!.at - inputs[0].at) : 0,
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
          Array.from(histogram.querySelectorAll('svg path')).map((path) => path.getAttribute('d')),
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
  }, options)
}
