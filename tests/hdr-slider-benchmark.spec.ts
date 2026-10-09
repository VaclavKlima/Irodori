import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { recordBenchmark } from './benchmark.helpers'
interface SliderMeasurement {
  zoom: string
  label: string
  kind: 'paced' | 'continuous'
  p95Ms: number
  histogramP95Ms: number
  refinementMs: number
  latencies: number[]
  histograms: number[]
  sidebarMovement: number
}

test.use({ hdrDisplay: true })
test('all eight HDR sliders at Fit and 100% measure completed GPU frames and matching histograms under burst input', async ({
  luma,
}, info) => {
  test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Select target hdr-slider-benchmark.')
  test.setTimeout(180000)
  const { app, page } = luma
  await (await app.browserWindow(page)).evaluate((window) => window.setContentSize(1440, 900))
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false)
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
  const result = await page
    .evaluate(async () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
      const device = canvas.getContext('webgpu')!.getConfiguration()!.device
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const changed = (element: HTMLElement, matches: () => boolean) =>
        new Promise<void>((resolve, reject) => {
          const observer = new MutationObserver(check)
          const timeout = setTimeout(() => {
            observer.disconnect()
            reject(new Error('No completed HDR frame or matching histogram'))
          }, 2000)
          function check() {
            if (matches()) {
              observer.disconnect()
              clearTimeout(timeout)
              resolve()
            }
          }
          observer.observe(element, { attributes: true, subtree: true })
          check()
        })
      const measurements: SliderMeasurement[] = []
      const id = (await window.luma.listPhotos()).photos[0].id
      Object.assign(window, { hdrSliderBenchmark: { measurements } })
      const labels = [
        'Exposure',
        'Contrast',
        'Highlights',
        'Shadows',
        'Whites',
        'Blacks',
        'Temperature',
        'Tint',
      ]
      let loaders = 0,
        hidden = 0
      for (const zoom of ['fit', '100%']) {
        canvas.focus()
        canvas.dispatchEvent(
          new KeyboardEvent('keydown', { key: zoom === 'fit' ? '0' : '1', bubbles: true }),
        )
        await frame()
        await device.queue.onSubmittedWorkDone()
        await frame()
        for (const label of labels) {
          const heading = Array.from(document.querySelectorAll('label')).find(
            (l) => l.textContent === label,
          )!
          const slider = document.getElementById(heading.htmlFor) as HTMLInputElement
          const latencies: number[] = [],
            histograms: number[] = []
          const heights: number[] = []
          for (let i = 0; i < 45; i++) {
            await frame()
            const start = performance.now()
            const value =
              label === 'Temperature'
                ? 3500 + (i % 30) * 200
                : label === 'Tint'
                  ? (i % 30) - 15
                  : label === 'Exposure'
                    ? ((i % 30) - 15) / 10
                    : ((i % 30) - 15) * 5
            for (let burst = 0; burst < 4; burst++) {
              const offset =
                label === 'Temperature' ? burst * 10 : label === 'Exposure' ? burst / 100 : burst
              setter.call(slider, String(burst === 3 ? value : value + offset))
              slider.dispatchEvent(new Event('input', { bubbles: true }))
            }
            const matches = () =>
              label === 'Temperature'
                ? JSON.parse(canvas.dataset.whiteBalance!).kelvin === value
                : label === 'Tint'
                  ? JSON.parse(canvas.dataset.whiteBalance!).tint === value
                  : canvas.dataset[label.toLowerCase()] === String(value)
            await changed(canvas, matches)
            await device.queue.onSubmittedWorkDone()
            const histogram = document.getElementById('histogram')!
            await changed(
              histogram,
              () =>
                histogram.dataset.editSerial === canvas.dataset.completedEditSerial &&
                histogram.querySelector<SVGSVGElement>('svg[role="slider"]')?.dataset
                  .curveEditSerial === canvas.dataset.completedEditSerial,
            )
            const histogramMs = performance.now() - start
            await frame()
            if (i >= 5) {
              latencies.push(performance.now() - start)
              histograms.push(histogramMs)
            }
            loaders += Number(document.body.textContent?.includes('Loading preview…'))
            hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
            heights.push(histogram.getBoundingClientRect().height)
          }
          const released = performance.now()
          slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
          await new Promise<void>((resolve, reject) => {
            const check = () => {
              if (canvas.dataset.quality === 'normal' && canvas.dataset.gesturing === 'false')
                resolve()
              else if (performance.now() - released > 2000)
                reject(
                  new Error(
                    `Refinement did not finish: ${zoom} ${label} ${JSON.stringify(canvas.dataset)}`,
                  ),
                )
              else requestAnimationFrame(check)
            }
            requestAnimationFrame(check)
          })
          await device.queue.onSubmittedWorkDone()
          await frame()
          const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]
          measurements.push({
            zoom,
            label,
            kind: 'paced',
            p95Ms: p95(latencies),
            histogramP95Ms: p95(histograms),
            refinementMs: performance.now() - released,
            latencies,
            histograms,
            sidebarMovement: Math.max(...heights) - Math.min(...heights),
          })
          // New input continues every animation frame while the GPU is busy.
          const history = await window.luma.getEditHistory(id)
          const times = new Map<number, number>()
          const inputs = new Map<number, number>()
          const serialTimes = new Map<number, number>()
          const continuous: number[] = [],
            continuousHistogram: number[] = []
          const completions: Promise<void>[] = []
          let previousSerial = 0,
            regressed = false
          const histogram = document.getElementById('histogram')!
          const histogramObserver = new MutationObserver(() => {
            if (
              histogram.querySelector<SVGSVGElement>('svg[role="slider"]')?.dataset
                .curveEditSerial !== histogram.dataset.editSerial
            )
              return
            const at = serialTimes.get(Number(histogram.dataset.editSerial))
            if (at !== undefined) continuousHistogram.push(performance.now() - at)
          })
          histogramObserver.observe(histogram, {
            attributes: true,
            subtree: true,
            attributeFilter: ['data-edit-serial', 'data-curve-edit-serial'],
          })
          const observer = new MutationObserver(() => {
            const serial = Number(canvas.dataset.completedEditSerial)
            regressed ||= serial < previousSerial
            previousSerial = serial
            const value =
              label === 'Temperature'
                ? JSON.parse(canvas.dataset.whiteBalance!).kelvin
                : label === 'Tint'
                  ? JSON.parse(canvas.dataset.whiteBalance!).tint
                  : Number(canvas.dataset[label.toLowerCase()])
            const at = times.get(value)
            if (at === undefined) return
            serialTimes.set(serial, at)
            completions.push(
              (async () => {
                await device.queue.onSubmittedWorkDone()
                await frame()
                continuous.push(performance.now() - at)
              })(),
            )
          })
          observer.observe(canvas, {
            attributes: true,
            attributeFilter: ['data-completed-edit-serial'],
          })
          for (let i = 0; i < 45; i++) {
            await frame()
            const value =
              label === 'Temperature'
                ? 5000 + i * 50
                : label === 'Tint'
                  ? i - 22
                  : label === 'Exposure'
                    ? (i - 22) / 20
                    : (i - 22) * 2
            inputs.set(i, value)
            if (i >= 5) times.set(value, performance.now())
            for (let burst = 0; burst < 4; burst++) {
              const offset =
                label === 'Temperature' ? burst * 50 : label === 'Exposure' ? burst / 100 : burst
              setter.call(slider, String(burst === 3 ? value : value + offset))
              slider.dispatchEvent(new Event('input', { bubbles: true }))
            }
            loaders += Number(document.body.textContent?.includes('Loading preview…'))
            hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
          }
          const final = inputs.get(44)!
          await changed(canvas, () =>
            label === 'Temperature'
              ? JSON.parse(canvas.dataset.whiteBalance!).kelvin === final
              : label === 'Tint'
                ? JSON.parse(canvas.dataset.whiteBalance!).tint === final
                : Number(canvas.dataset[label.toLowerCase()]) === final,
          )
          await changed(
            histogram,
            () => histogram.dataset.editSerial === canvas.dataset.completedEditSerial,
          )
          await Promise.all(completions)
          observer.disconnect()
          histogramObserver.disconnect()
          if (regressed || continuous.length < 30 || continuousHistogram.length < 30)
            throw new Error(
              `Continuous frames/histograms did not advance: ${zoom} ${label} ${continuous.length}/${continuousHistogram.length}`,
            )
          const release = performance.now()
          slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
          await changed(
            canvas,
            () => canvas.dataset.quality === 'normal' && canvas.dataset.gesturing === 'false',
          )
          await device.queue.onSubmittedWorkDone()
          await frame()
          const refinementMs = performance.now() - release
          const saved = await window.luma.getEditHistory(id)
          if (saved.snapshots.length !== history.snapshots.length + 1)
            throw new Error(`Expected one history entry for continuous ${zoom} ${label}`)
          measurements.push({
            zoom,
            label,
            kind: 'continuous',
            p95Ms: p95(continuous),
            histogramP95Ms: p95(continuousHistogram),
            refinementMs,
            latencies: continuous,
            histograms: continuousHistogram,
            sidebarMovement: Math.max(...heights) - Math.min(...heights),
          })
        }
      }
      return {
        measurements,
        loaders,
        hidden,
        sourceUploads: Number(canvas.dataset.sourceUploads),
        backend: canvas.dataset.backend,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      }
    })
    .catch(async (error) => {
      await writeFile(
        info.outputPath('partial-hdr-sliders.json'),
        JSON.stringify(
          await page.evaluate(
            () => (window as unknown as { hdrSliderBenchmark: unknown }).hdrSliderBenchmark,
          ),
          null,
          2,
        ),
      )
      throw error
    })
  await writeFile(info.outputPath('hdr-sliders.json'), JSON.stringify(result, null, 2))
  await recordBenchmark(info, {
    family: 'hdr',
    measurements: {
      cases: result.measurements.map((m) => ({
        zoom: m.zoom,
        label: m.label,
        kind: m.kind,
        p95Ms: m.p95Ms,
        histogramP95Ms: m.histogramP95Ms,
        refinementMs: m.refinementMs,
        sidebarMovement: m.sidebarMovement,
      })),
      backend: result.backend,
      viewport: result.viewport,
    },
    gates: result.measurements.flatMap((m) => [
      { metric: `${m.kind}.${m.zoom}.${m.label}.p95Ms`, operator: '<=' as const, limit: 33 },
      {
        metric: `${m.kind}.${m.zoom}.${m.label}.histogramP95Ms`,
        operator: '<=' as const,
        limit: 33,
      },
      {
        metric: `${m.kind}.${m.zoom}.${m.label}.refinementMs`,
        operator: '<=' as const,
        limit: 500,
      },
    ]),
    evidence: [info.outputPath('hdr-sliders.json')],
  })
  expect(result.backend).toBe('webgpu-hdr')
  expect(result.sourceUploads).toBe(1)
  expect(result.loaders).toBe(0)
  expect(result.hidden).toBe(0)
  for (const m of result.measurements) {
    expect(m.p95Ms, `${m.zoom} ${m.label}`).toBeLessThanOrEqual(33)
    expect(m.histogramP95Ms, `${m.zoom} ${m.label} histogram`).toBeLessThanOrEqual(33)
    expect(m.refinementMs, `${m.zoom} ${m.label} refinement`).toBeLessThanOrEqual(500)
    expect(m.sidebarMovement).toBeLessThan(0.1)
  }
})
