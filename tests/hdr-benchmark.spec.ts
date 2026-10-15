import { writeFile } from 'node:fs/promises'
import { expect, test } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { recordBenchmark } from './benchmark.helpers'
import { foregroundTest, requiresForeground } from './foreground'

const foregroundReason =
  'HDR edit and selection latency requires visible presentation and the existing foreground baseline.'
requiresForeground(test, foregroundReason)

test.use({ hdrDisplay: true })
for (const adjustment of ['exposure'] as const)
  test(
    `benchmarks warmed HDR ${adjustment} gestures through the actual editor`,
    foregroundTest(foregroundReason),
    async ({ luma }, info) => {
      test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Run npm run benchmark:hdr.')
      test.setTimeout(180000)
      luma.page.on('console', (message) => {
        if (message.type() === 'warning') console.log(message.text())
      })
      await importPhotos(luma.app, luma.page, ['tests/fixtures/sony-zv1.ARW'], false)
      await expect(luma.page.getByTestId('main-preview')).toHaveAttribute('data-editing', 'ready', {
        timeout: 45000,
      })
      await expect(
        luma.page.getByRole('button', { name: 'Canvas channel clipping', exact: true }),
      ).toBeVisible({ timeout: 45000 })
      await luma.page.getByRole('button', { name: 'Canvas channel clipping', exact: true }).click()
      const result = await luma.page.evaluate(async (adjustment) => {
        const label = Array.from(document.querySelectorAll('label')).find(
          (label) => label.textContent === adjustment[0].toUpperCase() + adjustment.slice(1),
        )!
        const slider = document.getElementById(label.htmlFor) as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        const latencies: number[] = []
        for (let i = 0; i < 65; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const ev = ((i % 40) - 20) / 10
          const start = performance.now()
          setter.call(slider, String(ev))
          slider.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise<void>((resolve) => {
            const check = () => {
              const dataset = document.querySelector<HTMLElement>(
                '[data-testid="main-preview"]',
              )!.dataset
              if (dataset[adjustment] === String(ev)) resolve()
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
        family: 'hdr',
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
      expect(result.backend).toBe('webgpu-hdr')
      expect(result.p95).toBeLessThanOrEqual(33)
    },
  )

test(
  'benchmarks cold HDR selection and cached revisits at native resolution',
  foregroundTest(foregroundReason),
  async ({ luma }, info) => {
    test.skip(process.env.LUMA_PREVIEW_BENCHMARK !== '1', 'Run npm run benchmark:hdr.')
    test.setTimeout(180000)
    await importPhotos(
      luma.app,
      luma.page,
      ['tests/fixtures/photos/alpine-lake.jpg', 'tests/fixtures/sony-zv1.ARW'],
      false,
    )
    const photos = (await luma.page.evaluate(() => window.luma.listPhotos())).photos
    const raw = photos.find((photo) => photo.filename.endsWith('.ARW'))!
    const raster = photos.find((photo) => photo.id !== raw.id)!
    const cold: number[] = [],
      cached: number[] = [],
      evidence: unknown[] = []
    let page = luma.page
    const select = async () => {
      await page.getByRole('button', { name: 'Select alpine-lake.jpg', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.luma.getPreviewDiagnostics())).presentation?.photoId,
        )
        .toBe(raster.id)
      await page.getByRole('button', { name: 'Select sony-zv1.ARW', exact: true }).click()
      await expect
        .poll(
          async () => {
            const diagnostics = await page.evaluate(() => window.luma.getPreviewDiagnostics())
            return diagnostics.presentation?.photoId === raw.id
              ? diagnostics.presentation.stage
              : undefined
          },
          { timeout: 45000 },
        )
        .toBe('presented')
      const diagnostics = await page.evaluate(() => window.luma.getPreviewDiagnostics())
      expect(diagnostics.presentation?.backend).toBe('webgpu-hdr')
      evidence.push(diagnostics)
      return diagnostics.presentation!.timings.selectionToPresentedMs
    }
    for (let run = 0; run < 3; run++) {
      if (run) {
        // The fixture closes Electron before removing only its isolated disposable cache.
        page = (await luma.restart(true)).page
      }
      cold.push(await select())
      for (let visit = 0; visit < 6; visit++) cached.push(await select())
    }
    cold.sort((a, b) => a - b)
    cached.sort((a, b) => a - b)
    const result = {
      coldMedian: cold[1],
      cachedP95: cached[Math.ceil(cached.length * 0.95) - 1],
      cold,
      cached,
      evidence,
    }
    await writeFile(info.outputPath('selection-latency.json'), JSON.stringify(result, null, 2))
    await recordBenchmark(info, {
      family: 'hdr',
      measurements: {
        coldMedianMs: result.coldMedian,
        cachedP95Ms: result.cachedP95,
        coldSamples: cold.length,
        cachedSamples: cached.length,
        backend: 'webgpu-hdr',
      },
      gates: [
        { metric: 'coldMedianMs', operator: '<=', limit: 3000 },
        { metric: 'cachedP95Ms', operator: '<=', limit: 1000 },
      ],
      evidence: [info.outputPath('selection-latency.json')],
    })
    console.log({ coldMedian: result.coldMedian, cachedP95: result.cachedP95 })
    expect(result.coldMedian).toBeLessThanOrEqual(3000)
    expect(result.cachedP95).toBeLessThanOrEqual(1000)
  },
)
