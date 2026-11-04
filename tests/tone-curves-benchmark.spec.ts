import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { activateButton } from './button.helpers'
import { focusPreviewWindow } from './preview-pan.helpers'
import { foregroundTest, requiresForeground } from './foreground'
import {
  createEditorInputPacer,
  summarizeFirstVisibleInputResponses,
} from './editor-input-pacing.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { curveGraphPosition, curveGraphValue, curveGraphRange } from '../src/shared/curve-graph'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const reason = 'Curve dragging measures completed GPU presentation in a visible native window.'
requiresForeground(test, reason)
test.use({ hdrDisplay: true })
test(
  'warmed Master curve dragging at Fit and 100% retains latency, visible-gap and refinement gates',
  foregroundTest(reason),
  async ({ irodori: { app, page } }, info) => {
    test.setTimeout(120000)
    const path = 'assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW',
      digest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path])
    expect(digest).toBe('dead1a70a02909faf8458119fcc8f7067733b756978fd26921710e3008364605')
    await (
      await app.browserWindow(page)
    ).evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1440, 1000)
    })
    await importPhotos(app, page, [path], true, 'keyboard')
    await focusPreviewWindow(app, page)
    const canvas = page.getByTestId('main-preview')
    await expect(canvas).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await activateButton(page.getByRole('button', { name: 'Light', exact: true }))
    const id = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id,
      points = [
        { input: 0, output: 0 },
        { input: 0.18, output: 0.2 },
        { input: 1, output: 1 },
      ],
      activation = await page.evaluate(
        async ({ id, points }) => {
          const started = performance.now(),
            state = await window.irodori.getEdits(id)
          await window.irodori.updateEdits(id, { curves: { master: points } }, state.revision)
          return {
            started,
            source: document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
              .dataset.presentedSourceIdentity,
          }
        },
        { id, points },
      )
    await expect.poll(() => canvas.getAttribute('data-curves')).toContain('"output":0.2')
    await expect(canvas).toHaveAttribute('data-quality', 'normal')
    const activationMs = await page.evaluate(
      (started) => performance.now() - started,
      activation.started,
    )
    const sample = await page.evaluate(async (id) => {
      const state = await window.irodori.getEdits(id),
        start = performance.now()
      const result = await window.irodori.sampleCurveTone(id, state.revision, {
        channel: 'master',
        x: 0.5,
        y: 0.5,
      })
      return { ms: performance.now() - start, input: result.input }
    }, id)
    await page.getByLabel('Graph view', { exact: true }).selectOption('hdr')
    const range = curveGraphRange('hdr', points),
      graph = page.getByTestId('curve-graph'),
      measurements = []
    for (const zoom of ['fit', '100%'] as const) {
      await canvas.focus()
      await page.keyboard.press(zoom === 'fit' ? '0' : '1')
      await expect(canvas).toHaveAttribute('data-quality', 'normal')
      await graph.evaluate((node) => node.scrollIntoView({ block: 'center' }))
      const beforeHistory = await page.evaluate((id) => window.irodori.getEditHistory(id), id),
        state = beforeHistory,
        current = state.settings.curves.master[1],
        box = (await graph.boundingBox())!,
        x = box.x + (box.width * (20 + 220 * curveGraphPosition(0.18, range))) / 256,
        y =
          box.y + (box.height * (256 - 20 - 220 * curveGraphPosition(current.output, range))) / 256,
        inputs = Array.from({ length: 120 }, (_, i) => {
          const fraction = (zoom === 'fit' ? 0.2 : 0.23) + i * 0.0002,
            clientY = box.y + (box.height * (256 - 20 - 220 * fraction)) / 256
          return { clientY, value: curveGraphValue(fraction, range) }
        })
      const pacer = await page.evaluateHandle(createEditorInputPacer, {
        mode: 'native-raf' as const,
        frequency: 60 as const,
      })
      await page.mouse.move(x, y)
      await page.mouse.down()
      const trial = await page.evaluate(
        async ({ pacer, inputs, x, source }) => {
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
            graph = document.querySelector<SVGSVGElement>('[data-testid="curve-graph"]')!,
            device = canvas.getContext('webgpu')!.getConfiguration()!.device,
            events: {
              serial: number
              at: number
              latencyMs: number
              editSerial: number
              source: string | undefined
              epoch: string | undefined
            }[] = [],
            dispatched: { value: number; at: number }[] = [],
            seen = new Set<string>(),
            pending: Promise<void>[] = []
          let sourceMismatch = 0,
            hidden = 0,
            loaders = 0
          const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const output = () =>
            JSON.parse(canvas.dataset.curves ?? 'null')?.master[1]?.output as number | undefined
          const observer = new MutationObserver(() => {
            const serial = canvas.dataset.completedEditSerial
            if (!serial || seen.has(serial)) return
            const value = output(),
              index = dispatched.findIndex(
                (p) => value !== undefined && Math.abs(p.value - value) < 1e-8,
              )
            if (index < 0) return
            seen.add(serial)
            pending.push(
              (async () => {
                await device.queue.onSubmittedWorkDone()
                await frame()
                if (canvas.dataset.completedEditSerial !== serial) return
                if (canvas.dataset.presentedSourceIdentity !== source) sourceMismatch++
                const at = performance.now()
                events.push({
                  serial: index,
                  at,
                  latencyMs: at - dispatched[index].at,
                  editSerial: Number(serial),
                  source: canvas.dataset.presentedSourceIdentity,
                  epoch: canvas.dataset.presentedEpoch,
                })
              })(),
            )
          })
          observer.observe(canvas, {
            attributes: true,
            attributeFilter: ['data-presentation-serial', 'data-completed-edit-serial'],
          })
          let release: number, refinementMs: number
          try {
            await pacer.start()
            for (const input of inputs) {
              const tick = await pacer.next(),
                at = performance.now()
              pacer.recordDispatch(tick.index, at)
              dispatched.push({ value: input.value, at })
              graph.dispatchEvent(
                new PointerEvent('pointermove', {
                  pointerId: 1,
                  isPrimary: true,
                  buttons: 1,
                  clientX: x,
                  clientY: input.clientY,
                  bubbles: true,
                }),
              )
              hidden += Number(getComputedStyle(canvas).visibility === 'hidden')
              loaders += Number(document.body.textContent?.includes('Loading preview…'))
            }
            release = performance.now()
            pacer.stop()
            graph.dispatchEvent(
              new PointerEvent('pointerup', {
                pointerId: 1,
                isPrimary: true,
                button: 0,
                clientX: x,
                clientY: inputs.at(-1)!.clientY,
                bubbles: true,
              }),
            )
            const until = performance.now() + 10000
            while (!(
              Math.abs((output() ?? NaN) - inputs.at(-1)!.value) < 1e-8 &&
              canvas.dataset.quality === 'normal' &&
              canvas.dataset.gesturing === 'false' &&
              canvas.dataset.completedEditSerial === canvas.dataset.requestedSerial
            )) {
              if (performance.now() > until)
                throw new Error('Final curve refinement did not converge')
              await frame()
            }
            await device.queue.onSubmittedWorkDone()
            await frame()
            refinementMs = performance.now() - release
            await Promise.all(pending)
          } finally {
            observer.disconnect()
            pacer.stop()
          }
          const during = events.filter((e) => e.at <= release),
            boundaries = [dispatched[0].at, ...during.map((e) => e.at), release],
            gaps = boundaries.slice(1).map((t, i) => t - boundaries[i])
          return {
            inputs: dispatched,
            presentations: events,
            pacing: pacer.snapshot(),
            refinementMs,
            sourceMismatch,
            hidden,
            loaders,
            longestPresentationGapMs: Math.max(...gaps),
            visibleUpdatesPerSecond: (during.length * 1000) / (release - dispatched[0].at),
            achievedHz:
              ((dispatched.length - 1) * 1000) / (dispatched.at(-1)!.at - dispatched[0].at),
            adapter: canvas.dataset.adapter,
            source: canvas.dataset.presentedSourceIdentity,
          }
        },
        { pacer, inputs, x, source: activation.source },
      )
      await page.mouse.up()
      await pacer.dispose()
      const latency = summarizeFirstVisibleInputResponses(trial.inputs, trial.presentations),
        after = await page.evaluate((id) => window.irodori.getEditHistory(id), id)
      measurements.push({
        zoom,
        ...trial,
        ...latency,
        historyEntriesAdded: after.snapshots.length - beforeHistory.snapshots.length,
      })
    }
    const evidence = info.outputPath('curve-dragging.json')
    await writeFile(
      evidence,
      JSON.stringify(
        {
          path,
          digest,
          activationMs,
          sample,
          measurements,
          meaning:
            'DOM pointer moves under native pointer capture; GPU completion plus animation-frame publication, not physical scanout.',
        },
        null,
        2,
      ),
    )
    await recordBenchmark(info, {
      family: 'adjustments',
      measurements: {
        activationMs,
        sampleMs: sample.ms,
        trials: measurements.map((t) => ({
          zoom: t.zoom,
          achievedHz: t.achievedHz,
          visibleUpdatesPerSecond: t.visibleUpdatesPerSecond,
          firstVisibleLatencyP95Ms: t.firstVisibleLatencyP95Ms,
          firstVisibleLatencyP99Ms: t.firstVisibleLatencyP99Ms,
          firstVisibleLatencyMaximumMs: t.firstVisibleLatencyMaximumMs,
          longestPresentationGapMs: t.longestPresentationGapMs,
          refinementMs: t.refinementMs,
        })),
      },
      gates: measurements.flatMap((t) => [
        { metric: `${t.zoom}.firstVisibleLatencyP95Ms`, operator: '<=' as const, limit: 33 },
        { metric: `${t.zoom}.firstVisibleLatencyP99Ms`, operator: '<=' as const, limit: 50 },
        { metric: `${t.zoom}.firstVisibleLatencyMaximumMs`, operator: '<=' as const, limit: 100 },
        { metric: `${t.zoom}.longestPresentationGapMs`, operator: '<=' as const, limit: 100 },
        { metric: `${t.zoom}.refinementMs`, operator: '<=' as const, limit: 200 },
      ]),
      evidence: [evidence],
    })
    for (const t of measurements) {
      expect.soft(t.sourceMismatch).toBe(0)
      expect.soft(t.hidden).toBe(0)
      expect.soft(t.loaders).toBe(0)
      expect.soft(t.historyEntriesAdded).toBe(1)
      expect.soft(t.firstVisibleLatencyP95Ms).not.toBeNull()
      expect.soft(t.firstVisibleLatencyP95Ms!).toBeLessThanOrEqual(33)
      expect.soft(t.firstVisibleLatencyP99Ms!).toBeLessThanOrEqual(50)
      expect.soft(t.firstVisibleLatencyMaximumMs!).toBeLessThanOrEqual(100)
      expect.soft(t.longestPresentationGapMs).toBeLessThanOrEqual(100)
      expect.soft(t.visibleUpdatesPerSecond).toBeGreaterThanOrEqual(55)
      expect.soft(t.refinementMs).toBeLessThanOrEqual(200)
    }
  },
)
