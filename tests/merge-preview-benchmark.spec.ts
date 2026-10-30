import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { setupMergePreview } from './merge-preview.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { foregroundTest, requiresForeground } from './foreground'

const foregroundReason =
  'Merge gesture presentation latency requires a visible window and the existing foreground baseline.'
requiresForeground(test, foregroundReason)

test(
  'warmed native merge wheel and drag presentation with deghost overlay',
  foregroundTest(foregroundReason),
  async ({ irodori }, info) => {
    test.skip(
      process.env.IRODORI_PREVIEW_BENCHMARK !== '1',
      'Select target merge-preview-benchmark.',
    )
    test.setTimeout(120000)
    const { page, app } = irodori
    const { viewport, zoom } = await setupMergePreview(app, page, 3672, 5496, false, 2, true)
    const measurements = []
    for (const scale of [1, 8]) {
      for (const overlay of [false, true]) {
        await page.getByRole('checkbox', { name: 'Show deghost overlay' }).setChecked(overlay)
        for (const gesture of ['wheel', 'horizontal', 'vertical', 'drag'] as const) {
          await zoom.selectOption(String(scale))
          const box = (await viewport.boundingBox())!
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          if (gesture === 'drag') await page.mouse.down()
          const result = await viewport.evaluate(async (el, gesture) => {
            const bounds = el.getBoundingClientRect()
            const latencies: number[] = []
            const completions: Promise<void>[] = []
            const canvas = el.querySelector('canvas')!
            const initialFrames = Number(canvas.dataset.frames)
            let middleFrames = 0
            let lastOffset = 0
            const afterPaint = () =>
              new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
            // Four events per frame exercise high-frequency devices without CDP transport delay.
            // The next animation frame and posted task include the browser's paint/composite work.
            for (let i = 0; i < 65; i++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
              const start = performance.now()
              for (let n = 0; n < 4; n++) {
                if (gesture !== 'drag') {
                  el.dispatchEvent(
                    new WheelEvent('wheel', {
                      bubbles: true,
                      cancelable: true,
                      ctrlKey: gesture === 'wheel',
                      clientX: bounds.x + bounds.width / 2 + 40,
                      clientY: bounds.y + bounds.height / 2 + 25,
                      deltaX: gesture === 'horizontal' ? (i % 2 ? 4 : -4) : 0,
                      deltaY:
                        gesture === 'wheel'
                          ? i % 2
                            ? 1.6
                            : -1.6
                          : gesture === 'vertical'
                            ? i % 2
                              ? 4
                              : -4
                            : 0,
                    }),
                  )
                } else {
                  const offset = Math.sin((i * 4 + n) / 15) * 80
                  if (document.pointerLockElement === el)
                    el.dispatchEvent(
                      new MouseEvent('mousemove', {
                        bubbles: true,
                        buttons: 1,
                        movementX: offset - lastOffset,
                        movementY: (offset - lastOffset) / 2,
                      }),
                    )
                  else
                    el.dispatchEvent(
                      new PointerEvent('pointermove', {
                        bubbles: true,
                        pointerId: 1,
                        isPrimary: true,
                        pointerType: 'mouse',
                        buttons: 1,
                        clientX: bounds.x + bounds.width / 2 + offset,
                        clientY: bounds.y + bounds.height / 2 + offset / 2,
                      }),
                    )
                  lastOffset = offset
                }
              }
              completions.push(
                afterPaint().then(() => {
                  if (i >= 5) latencies.push(performance.now() - start)
                }),
              )
              if (i === 32) middleFrames = Number(canvas.dataset.frames) - initialFrames
            }
            await Promise.all(completions)
            latencies.sort((a, b) => a - b)
            const gl = canvas?.getContext('webgl2')
            const debug = gl?.getExtension('WEBGL_debug_renderer_info')
            return {
              latencies,
              p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
              maxMs: latencies.at(-1)!,
              presentations: Number(canvas.dataset.frames) - initialFrames,
              middleFrames,
              backend: canvas?.dataset.backend ?? 'dom-images',
              renderer: debug ? (gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string) : '',
              mainSuspended: document.querySelector<HTMLElement>('[data-testid="main-preview"]')
                ?.dataset.suspended,
              mainBackend: document.querySelector<HTMLElement>('[data-testid="main-preview"]')
                ?.dataset.backend,
              dpr: devicePixelRatio,
              viewport: { width: bounds.width, height: bounds.height },
            }
          }, gesture)
          if (gesture === 'drag') await page.mouse.up()
          measurements.push({ scale, overlay, gesture, ...result })
        }
      }
    }
    const path = info.outputPath('merge-gestures.json')
    await writeFile(path, JSON.stringify(measurements, null, 2))
    for (const measurement of measurements) {
      const { latencies, ...metrics } = measurement
      await recordBenchmark(info, {
        family: 'merge',
        measurements: {
          ...metrics,
          presentationShortfall: Math.max(0, 60 - measurement.presentations),
          samples: latencies.length,
          warmupGestures: 5,
        },
        gates: [
          { metric: 'p95Ms', operator: '<=', limit: 33 },
          { metric: 'presentationShortfall', operator: '<=', limit: 0 },
        ],
        evidence: [path],
      })
    }
    for (const measurement of measurements) {
      expect(measurement.backend).toBe('webgl2')
      expect(measurement.mainSuspended).toBe('true')
      expect(measurement.presentations).toBeGreaterThanOrEqual(60)
      expect(measurement.middleFrames).toBeGreaterThanOrEqual(25)
      expect(
        measurement.p95Ms,
        JSON.stringify({ ...measurement, latencies: undefined }),
      ).toBeLessThanOrEqual(33)
    }
  },
)
