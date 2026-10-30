import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { foregroundTest, requiresForeground } from './foreground'

const foregroundReason =
  'Editor gesture latency requires visible canvas presentation and the existing foreground baseline.'
requiresForeground(test, foregroundReason)

for (const adjustment of [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
] as const)
  test(
    `benchmarks warmed RAW ${adjustment} gestures through the actual editor`,
    foregroundTest(foregroundReason),
    async ({ irodori }, info) => {
      test.skip(
        process.env.IRODORI_PREVIEW_BENCHMARK !== '1',
        'Run npm run benchmark:adjustments -- <name> or benchmark:all.',
      )
      test.setTimeout(90000)
      await importPhotos(irodori.app, irodori.page, ['tests/fixtures/sony-zv1.ARW'])
      await expect(irodori.page.getByTestId('main-preview')).toHaveAttribute(
        'data-editing',
        'ready',
        {
          timeout: 30000,
        },
      )
      if (adjustment === 'temperature') {
        await expect(
          irodori.page.getByRole('spinbutton', { name: 'Temperature value' }),
        ).toBeEnabled()
        await irodori.page.getByRole('button', { name: 'Shadow clipping', exact: true }).click()
        await irodori.page.getByRole('button', { name: 'Highlight clipping', exact: true }).click()
        await expect(
          irodori.page.getByRole('slider', { name: 'Histogram tonal value' }),
        ).toHaveAttribute('aria-valuetext', /Value/)
      }
      const result = await irodori.page.evaluate(async (adjustment) => {
        const label = Array.from(document.querySelectorAll('label')).find(
          (label) => label.textContent === adjustment[0].toUpperCase() + adjustment.slice(1),
        )!
        const slider = document.getElementById(label.htmlFor) as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        const latencies: number[] = []
        for (let i = 0; i < 65; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const ev =
            adjustment === 'temperature'
              ? 3000 + (i % 40) * 200
              : adjustment === 'exposure'
                ? ((i % 40) - 20) / 10
                : ((i % 40) - 20) * 5
          const start = performance.now()
          setter.call(slider, String(ev))
          slider.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise<void>((resolve) => {
            const check = () => {
              const dataset = document.querySelector<HTMLElement>(
                '[data-testid="main-preview"]',
              )!.dataset
              if (
                adjustment === 'temperature'
                  ? JSON.parse(dataset.whiteBalance!).kelvin === ev
                  : dataset[adjustment] === String(ev)
              )
                resolve()
              else requestAnimationFrame(check)
            }
            requestAnimationFrame(check)
          })
          if (i >= 5) latencies.push(performance.now() - start)
        }
        slider.dispatchEvent(new Event('pointerup', { bubbles: true }))
        latencies.sort((a, b) => a - b)
        return {
          latencies,
          p95: latencies[Math.ceil(latencies.length * 0.95) - 1],
          backend: document.querySelector<HTMLElement>('[data-testid="main-preview"]')!.dataset
            .backend,
        }
      }, adjustment)
      await writeFile(
        info.outputPath(`${adjustment}-latency.json`),
        JSON.stringify(result, null, 2),
      )
      await recordBenchmark(info, {
        family: 'adjustments',
        measurements: {
          adjustment,
          p95Ms: result.p95,
          backend: result.backend,
          samples: result.latencies.length,
          warmupGestures: 5,
        },
        gates: [{ metric: 'p95Ms', operator: '<=', limit: 33 }],
        evidence: [info.outputPath(`${adjustment}-latency.json`)],
      })
      console.log({ adjustment, p95: result.p95, backend: result.backend })
      expect(result.backend).toBe('webgl2')
      expect(result.p95).toBeLessThanOrEqual(33)
    },
  )
