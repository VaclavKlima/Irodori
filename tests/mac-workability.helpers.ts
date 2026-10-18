import type { Page } from '@playwright/test'

export type WorkabilitySlider =
  'Exposure' | 'Contrast' | 'Highlights' | 'Shadows' | 'Whites' | 'Blacks' | 'Temperature' | 'Tint'

// Drive the real React input/history path. Absolute deadlines keep slower output
// from silently lowering the requested load; native rAF remains authoritative.
export async function sustainedEditorInput(
  page: Page,
  options: { label: WorkabilitySlider; zoom: 'fit' | '100%'; frequency: 60 | 120 },
) {
  return page.evaluate(async ({ label, zoom, frequency }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const histogram = document.getElementById('histogram')!
    const device = canvas.getContext('webgpu')!.getConfiguration()!.device
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const heading = Array.from(document.querySelectorAll('label')).find(
      (element) => element.textContent === label,
    )!
    const slider = document.getElementById(heading.htmlFor) as HTMLInputElement
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
    const readValue = () =>
      label === 'Temperature'
        ? (JSON.parse(canvas.dataset.whiteBalance!).kelvin as number)
        : label === 'Tint'
          ? (JSON.parse(canvas.dataset.whiteBalance!).tint as number)
          : Number(canvas.dataset[label.toLowerCase()])
    const wait = async (predicate: () => boolean, description: string) => {
      const deadline = performance.now() + 10000
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error(description)
        await frame()
      }
    }
    const photoId = (await window.luma.listPhotos()).photos.find(
      (photo) => photo.filename === 'sony-zv1.ARW',
    )!.id
    const state = await window.luma.getEdits(photoId)
    await window.luma.updateEdits(
      photoId,
      {
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        whiteBalance: { mode: 'as-shot' },
      },
      state.revision,
    )
    await wait(
      () =>
        ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'].every(
          (key) => Number(canvas.dataset[key]) === 0,
        ) &&
        JSON.parse(canvas.dataset.whiteBalance!).mode === 'as-shot' &&
        canvas.dataset.quality === 'normal',
      'Neutral editor state did not converge before sustained input.',
    )
    const historyBefore = await window.luma.getEditHistory(photoId)
    canvas.focus()
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: zoom === 'fit' ? '0' : '1', bubbles: true }),
    )
    await frame()
    await device.queue.onSubmittedWorkDone()
    await frame()

    const inputs: {
      serial: number
      value: number
      at: number
      raf: number
      dispatchCompletedAt?: number
    }[] = []
    const requests: {
      editSerial: number
      inputSerial: number
      value: number
      at: number | null
      observedAt: number
      inputToRequestMs: number | null
      observationDelayMs: number | null
      sourceIdentity: string
      epoch: number | null
      intent: string
    }[] = []
    type GpuObservation = {
      inputSerial: number
      epoch: number
      sourceIdentity: string
      tileGpuMs: number
      offscreenGpuMs: number
      blitGpuMs: number
      measuredPasses: number
      droppedPasses: number
      complete: number
      imagePresented: number
      observedAt: number
    }
    const gpuByRequest = new Map<string, GpuObservation>()
    const requestKey = (sourceIdentity: string, epoch: number | null, serial: number) =>
      JSON.stringify([sourceIdentity, epoch, serial])
    const requestBySerial = new Map<number, (typeof requests)[number]>()
    const presentations: {
      serial: number
      editSerial: number
      analysisSerial: number
      at: number
      latencyMs: number
      quality: string
      previewPolicy: string
      intent: string
      timings?: Record<string, number>
      publicationObservedAt: number
      sourceIdentity?: string
      epoch?: number | null
      inputToRequestMs?: number | null
      requestToPublicationObservedMs?: number | null
      requestToPresentationMs?: number | null
      publicationObservationToPresentationMs?: number
      latestInputSerialAtPresentation?: number
      inputsBehindAtPresentation?: number
      intentLagAtPresentationMs?: number
      gpu?: GpuObservation
    }[] = []
    const histograms: { editSerial: number; at: number; latencyMs: number }[] = []
    const requestedInputs = new Map<number, (typeof inputs)[number]>()
    const frameByAnalysis = new Map<number, (typeof presentations)[number]>()
    const seenFrames = new Set<number>(),
      seenHistograms = new Set<number>()
    const completions: Promise<void>[] = []
    const heights: number[] = [],
      staleAges: number[] = []
    let regressed = false,
      attributionFailures = 0,
      previousSerial = Number(canvas.dataset.completedEditSerial),
      loaders = 0,
      hidden = 0,
      unobservedRequestSerials = 0,
      previousRequestedSerial = Number(canvas.dataset.requestedSerial),
      lastPresentedInputAt = performance.now()
    const observeFrame = () => {
      const editSerial = Number(canvas.dataset.completedEditSerial)
      if (seenFrames.has(editSerial)) return
      const input = requestedInputs.get(editSerial)
      if (!input) return
      if (readValue() !== input.value) {
        attributionFailures++
        return
      }
      regressed ||= editSerial < previousSerial
      previousSerial = editSerial
      seenFrames.add(editSerial)
      const publicationObservedAt = performance.now(),
        request = requestBySerial.get(editSerial)
      const completed: (typeof presentations)[number] = {
        serial: input.serial,
        editSerial,
        analysisSerial: editSerial,
        at: publicationObservedAt,
        publicationObservedAt,
        latencyMs: publicationObservedAt - input.at,
        sourceIdentity: request?.sourceIdentity,
        epoch: request?.epoch,
        inputToRequestMs: request?.inputToRequestMs,
        requestToPublicationObservedMs:
          request?.at === null || request?.at === undefined
            ? null
            : publicationObservedAt - request.at,
        quality: canvas.dataset.quality ?? 'unknown',
        previewPolicy: canvas.dataset.interactivePolicy ?? 'reference',
        intent: request?.intent ?? canvas.dataset.presentationIntent ?? 'unknown',
        timings: canvas.dataset.frameTimings
          ? (JSON.parse(canvas.dataset.frameTimings) as Record<string, number>)
          : undefined,
      }
      frameByAnalysis.set(completed.analysisSerial, completed)
      completions.push(
        (async () => {
          // completedEditSerial advances after the presenter's final blit fence.
          // A fresh queue fence here would also wait for unrelated histogram work.
          await frame()
          if (
            Number(canvas.dataset.completedEditSerial) !== editSerial ||
            getComputedStyle(canvas).visibility === 'hidden'
          )
            return
          completed.at = performance.now()
          completed.latencyMs = completed.at - input.at
          completed.publicationObservationToPresentationMs = completed.at - publicationObservedAt
          completed.requestToPresentationMs =
            request?.at === null || request?.at === undefined ? null : completed.at - request.at
          const latest = inputs.at(-1)!
          completed.latestInputSerialAtPresentation = latest.serial
          completed.inputsBehindAtPresentation = latest.serial - input.serial
          completed.intentLagAtPresentationMs = latest.at - input.at
          lastPresentedInputAt = input.at
          presentations.push(completed)
        })(),
      )
    }
    const observeHistogram = () => {
      const serial = Number(
        histogram.querySelector<SVGSVGElement>('svg[role="slider"]')?.dataset.curveEditSerial,
      )
      const presented = frameByAnalysis.get(serial)
      if (!presented || seenHistograms.has(serial)) return
      seenHistograms.add(serial)
      histograms.push({
        editSerial: serial,
        at: performance.now(),
        latencyMs: performance.now() - inputs[presented.serial].at,
      })
    }
    const observeGpu = () => {
      if (!canvas.dataset.gpuFrameTimings) return
      const timing = JSON.parse(canvas.dataset.gpuFrameTimings) as Omit<
          GpuObservation,
          'observedAt'
        >,
        request = requestBySerial.get(timing.inputSerial)
      if (
        !request ||
        timing.sourceIdentity !== request.sourceIdentity ||
        timing.epoch !== request.epoch
      )
        return
      const key = requestKey(timing.sourceIdentity, timing.epoch, timing.inputSerial)
      if (!gpuByRequest.has(key))
        gpuByRequest.set(key, { ...timing, observedAt: performance.now() })
    }
    const canvasObserver = new MutationObserver((records) => {
      if (records.some((record) => record.attributeName === 'data-requested-serial')) {
        const observedAt = performance.now(),
          timestamp = Number(canvas.dataset.requestedAt),
          at = Number.isFinite(timestamp) ? timestamp : null,
          epoch = Number(canvas.dataset.requestedEpoch),
          editSerial = Number(canvas.dataset.requestedSerial),
          requested = JSON.parse(canvas.dataset.requestedParameters!)
        const value =
          label === 'Temperature'
            ? requested.whiteBalance.kelvin
            : label === 'Tint'
              ? requested.whiteBalance.tint
              : requested[label === 'Exposure' ? 'exposureEv' : label.toLowerCase()]
        let input: (typeof inputs)[number] | undefined
        for (let index = inputs.length - 1; index >= 0; index--)
          if (inputs[index].value === value && inputs[index].at <= (at ?? observedAt)) {
            input = inputs[index]
            break
          }
        if (editSerial > previousRequestedSerial + 1)
          unobservedRequestSerials += editSerial - previousRequestedSerial - 1
        previousRequestedSerial = editSerial
        if (input) {
          requestedInputs.set(editSerial, input)
          if (!requestBySerial.has(editSerial)) {
            const request = {
              editSerial,
              inputSerial: input.serial,
              value,
              at,
              observedAt,
              inputToRequestMs: at === null ? null : at - input.at,
              observationDelayMs: at === null ? null : observedAt - at,
              sourceIdentity: canvas.dataset.requestedSourceIdentity ?? '',
              epoch: Number.isFinite(epoch) ? epoch : null,
              intent: canvas.dataset.requestIntent ?? 'unknown',
            }
            requests.push(request)
            requestBySerial.set(editSerial, request)
          }
        }
      }
      observeFrame()
      if (records.some((record) => record.attributeName === 'data-gpu-frame-timings')) observeGpu()
    })
    canvasObserver.observe(canvas, {
      attributes: true,
      attributeFilter: [
        'data-requested-serial',
        'data-completed-edit-serial',
        'data-gpu-frame-timings',
      ],
    })
    const histogramObserver = new MutationObserver(observeHistogram)
    histogramObserver.observe(histogram, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-edit-serial', 'data-curve-edit-serial'],
    })
    let refinementMs = 0,
      finalHistogramMs = 0,
      finalHistogramConvergenceMs = 0,
      releaseAt = 0,
      finalMatched = false,
      histogramMatched = false,
      finalValue = 0,
      error: string | undefined
    try {
      const start = await frame()
      let deadline = start
      for (let serial = 0; serial < 240; serial++) {
        let raf = await frame()
        while (raf + 0.1 < deadline) raf = await frame()
        const value =
          label === 'Temperature'
            ? 4000 + serial * 50
            : label === 'Tint'
              ? (serial % 201) - 100
              : label === 'Exposure'
                ? Number((-1.2 + serial * 0.01).toFixed(2))
                : (serial % 201) - 100
        const input: (typeof inputs)[number] = { serial, value, at: performance.now(), raf }
        inputs.push(input)
        setter.call(slider, String(value))
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchCompletedAt = performance.now()
        deadline += 1000 / frequency
        loaders += Number(document.body.textContent?.includes('Loading preview…'))
        hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
        heights.push(histogram.getBoundingClientRect().height)
        staleAges.push(performance.now() - lastPresentedInputAt)
      }
      finalValue = inputs.at(-1)!.value
      const release = performance.now()
      releaseAt = release
      slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      await wait(
        () =>
          readValue() === finalValue &&
          canvas.dataset.quality === 'normal' &&
          canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial &&
          canvas.dataset.gesturing === 'false',
        `Final sharp ${label} frame did not converge.`,
      )
      await frame()
      refinementMs = performance.now() - release
      finalMatched = true
      await wait(
        () =>
          canvas.dataset.analysisPending === 'false' &&
          !!canvas.dataset.analysisKey &&
          canvas.dataset.analysisKey === canvas.dataset.displayedAnalysisKey &&
          histogram.dataset.editSerial === canvas.dataset.analysisSerial &&
          histogram.querySelector<SVGSVGElement>('svg[role="slider"]')?.dataset.curveEditSerial ===
            canvas.dataset.analysisSerial,
        `Final ${label} histogram did not converge.`,
      )
      finalHistogramMs = performance.now() - inputs.at(-1)!.at
      histogramMatched = true
      observeFrame()
      observeHistogram()
      await wait(
        () =>
          histogram.querySelector<SVGSVGElement>('svg[role="slider"]')?.dataset.animating ===
          'false',
        `Final ${label} histogram curve did not finish its animation.`,
      )
      finalHistogramConvergenceMs = performance.now() - inputs.at(-1)!.at
      await Promise.all(completions)
      observeGpu()
    } catch (failure) {
      error = String(failure)
    } finally {
      slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      canvasObserver.disconnect()
      histogramObserver.disconnect()
    }
    const historyAfter = await window.luma.getEditHistory(photoId)
    const requestedInputSerials = new Set(requests.map((request) => request.inputSerial))
    const presentedInputSerials = new Set(presentations.map((presentation) => presentation.serial))
    const p95 = (values: number[]) =>
      values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null
    const intervals = inputs.slice(1).map((input, i) => input.at - inputs[i].at)
    const duringInput = presentations.filter(
      (presentation) => presentation.at >= inputs[0].at && presentation.at <= releaseAt,
    )
    const presentationBoundaries = [
      inputs[0].at,
      ...duringInput.map((frame) => frame.at),
      releaseAt,
    ]
    const presentationGaps = presentationBoundaries
      .slice(1)
      .map((at, i) => at - presentationBoundaries[i])
    const latencySorted = presentations.map((frame) => frame.latencyMs).sort((a, b) => a - b)
    const interactionLatencies = presentations
      .filter((frame) => frame.intent === 'interactive')
      .map((frame) => frame.latencyMs)
      .sort((a, b) => a - b)
    const interactionQuantile = (p: number) =>
      interactionLatencies.length
        ? interactionLatencies[Math.ceil(interactionLatencies.length * p) - 1]
        : null
    for (const presentation of presentations)
      if (presentation.sourceIdentity !== undefined)
        presentation.gpu = gpuByRequest.get(
          requestKey(
            presentation.sourceIdentity,
            presentation.epoch ?? null,
            presentation.editSerial,
          ),
        )
    const gpuObservations = [...gpuByRequest.values()]
    const summarize = (values: number[]) => ({
      count: values.length,
      mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      p95: p95(values),
      maximum: values.length ? Math.max(...values) : null,
    })
    const completeGpuObservations = gpuObservations.filter((sample) => sample.complete === 1)
    const gpuTimingSummary = Object.fromEntries(
      (['tileGpuMs', 'offscreenGpuMs', 'blitGpuMs'] as const).map((key) => [
        key,
        summarize(completeGpuObservations.map((sample) => sample[key])),
      ]),
    )
    const matchedGpuObservations = presentations
      .map((presentation) => presentation.gpu)
      .filter(
        (sample): sample is GpuObservation => sample?.complete === 1 && sample.imagePresented === 1,
      )
    const matchedGpuTimingSummary = Object.fromEntries(
      (['tileGpuMs', 'offscreenGpuMs', 'blitGpuMs'] as const).map((key) => [
        key,
        summarize(matchedGpuObservations.map((sample) => sample[key])),
      ]),
    )
    const optionalValues = (values: (number | null | undefined)[]) =>
      values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const frameTimings = presentations
      .filter((presentation) => presentation.timings?.inputSerial === presentation.editSerial)
      .map((presentation) => presentation.timings!)
    const frameTimingSummary = Object.fromEntries(
      Object.keys(frameTimings[0] ?? {}).map((key) => {
        const values = frameTimings.map((timing) => timing[key])
        return [
          key,
          {
            mean: values.reduce((sum, value) => sum + value, 0) / values.length,
            p95: p95(values),
            maximum: Math.max(...values),
          },
        ]
      }),
    )
    return {
      label,
      zoom,
      epochMs: performance.timeOrigin,
      requestedHz: frequency,
      inputStartedAt: inputs[0].at,
      inputReleasedAt: releaseAt,
      inputDurationMs: releaseAt - inputs[0].at,
      achievedHz: (inputs.length - 1) / ((inputs.at(-1)!.at - inputs[0].at) / 1000),
      inputIntervalP95Ms: p95(intervals),
      inputs,
      requests,
      presentations,
      requestCount: requests.length,
      observedRequestedInputCount: requestedInputSerials.size,
      observedPresentedInputCount: presentedInputSerials.size,
      observedCoalescedBeforeRequest: inputs.length - requestedInputSerials.size,
      observedRequestedWithoutVisible: [...requestedInputSerials].filter(
        (serial) => !presentedInputSerials.has(serial),
      ).length,
      unobservedRequestSerials,
      inputToRequestSummary: summarize(
        optionalValues(requests.map((request) => request.inputToRequestMs)),
      ),
      requestObservationDelaySummary: summarize(
        optionalValues(requests.map((request) => request.observationDelayMs)),
      ),
      inputDispatchSummary: summarize(
        optionalValues(
          inputs.map((input) =>
            input.dispatchCompletedAt === undefined
              ? undefined
              : input.dispatchCompletedAt - input.at,
          ),
        ),
      ),
      requestToPublicationObservedSummary: summarize(
        optionalValues(
          presentations.map((presentation) => presentation.requestToPublicationObservedMs),
        ),
      ),
      requestToPresentationSummary: summarize(
        optionalValues(presentations.map((presentation) => presentation.requestToPresentationMs)),
      ),
      publicationObservationToPresentationSummary: summarize(
        optionalValues(
          presentations.map((presentation) => presentation.publicationObservationToPresentationMs),
        ),
      ),
      inputsBehindAtPresentationSummary: summarize(
        optionalValues(
          presentations.map((presentation) => presentation.inputsBehindAtPresentation),
        ),
      ),
      intentLagAtPresentationSummary: summarize(
        optionalValues(presentations.map((presentation) => presentation.intentLagAtPresentationMs)),
      ),
      gpuObservations,
      gpuTimingStatus: canvas.dataset.gpuTimings ?? 'unavailable',
      gpuFrameTimingSampleCount: gpuObservations.length,
      gpuCompleteTimingSampleCount: completeGpuObservations.length,
      gpuIncompleteTimingSampleCount: gpuObservations.length - completeGpuObservations.length,
      gpuMatchedPresentationCount: presentations.filter((presentation) => presentation.gpu).length,
      gpuCompleteMatchedPresentationCount: matchedGpuObservations.length,
      gpuTimingSummary,
      matchedGpuTimingSummary,
      requestTimingByIntent: Object.fromEntries(
        [...new Set(requests.map((request) => request.intent))].map((intent) => [
          intent,
          {
            count: requests.filter((request) => request.intent === intent).length,
            inputToRequestSummary: summarize(
              optionalValues(
                requests
                  .filter((request) => request.intent === intent)
                  .map((request) => request.inputToRequestMs),
              ),
            ),
          },
        ]),
      ),
      frameTimingSampleCount: frameTimings.length,
      frameTimingSummary,
      histograms,
      completed: presentations.length,
      completedDuringInput: presentations.filter((presentation) => presentation.at <= releaseAt)
        .length,
      histogramsDuringInput: histograms.filter((histogram) => histogram.at <= releaseAt).length,
      sharp: presentations.filter((presentation) => presentation.quality === 'normal').length,
      draft: presentations.filter((presentation) => presentation.quality === 'draft').length,
      interactive: presentations.filter((presentation) => presentation.quality === 'interactive')
        .length,
      visibleUpdatesPerSecond: duringInput.length / ((releaseAt - inputs[0].at) / 1000),
      longestPresentationGapMs: Math.max(...presentationGaps),
      latencyP50Ms: latencySorted.length
        ? latencySorted[Math.ceil(latencySorted.length * 0.5) - 1]
        : null,
      latencyP99Ms: latencySorted.length
        ? latencySorted[Math.ceil(latencySorted.length * 0.99) - 1]
        : null,
      latencyMaximumMs: latencySorted.length ? latencySorted.at(-1)! : null,
      interactionPresentationCount: interactionLatencies.length,
      interactionLatencyP50Ms: interactionQuantile(0.5),
      interactionLatencyP95Ms: interactionQuantile(0.95),
      interactionLatencyP99Ms: interactionQuantile(0.99),
      interactionLatencyMaximumMs: interactionLatencies.at(-1) ?? null,
      missing:
        inputs.length - new Set(presentations.map((presentation) => presentation.serial)).size,
      latencyP95Ms: p95(presentations.map((presentation) => presentation.latencyMs)),
      histogramP95Ms: p95(histograms.map((histogram) => histogram.latencyMs)),
      staleAgeP95Ms: p95(staleAges),
      staleAgeMaximumMs: Math.max(...staleAges),
      refinementMs,
      finalHistogramMs,
      finalHistogramConvergenceMs,
      finalMatched,
      histogramMatched,
      finalValue,
      regressed,
      attributionFailures,
      loaders,
      hidden,
      sidebarMovement: Math.max(...heights) - Math.min(...heights),
      historyEntriesAdded: historyAfter.snapshots.length - historyBefore.snapshots.length,
      sourceUploads: Number(canvas.dataset.sourceUploads),
      tileKernel: canvas.dataset.tileKernel ?? 'unknown',
      tileBatch: Number(canvas.dataset.tileBatch),
      backend: canvas.dataset.backend,
      error,
    }
  }, options)
}
