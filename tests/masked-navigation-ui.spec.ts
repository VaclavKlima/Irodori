import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'

test('masked navigation reuses serialized coverage while actual edit changes invalidate it', async ({
  irodori,
}, info) => {
  test.setTimeout(120000)
  const { app, page } = irodori
  await importPhotos(app, page, ['tests/fixtures/sony-zv1.ARW'], false, 'renderer')
  const photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const maskId = crypto.randomUUID()
  await page.evaluate(
    ({ photoId, maskId }) =>
      window.irodori.mutateMasks(photoId, 0, {
        operations: [
          {
            kind: 'create',
            id: maskId,
            name: 'Prepared navigation coverage',
            range: { version: 1, kind: 'luminance', lower: 10, upper: null, softness: 25 },
          },
          {
            kind: 'update',
            id: maskId,
            edge: { featherPx: 3 },
            light: { exposureEv: 0.5 },
            color: { temperature: 8, saturation: 5 },
          },
        ],
      }),
    { photoId, maskId },
  )
  const canvas = page.getByTestId('main-preview')
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '1', { timeout: 60000 })
  const settled = () =>
    expect
      .poll(
        () =>
          canvas.evaluate(
            (c) =>
              c.dataset.editing === 'ready' &&
              c.dataset.completedEditSerial === c.dataset.requestedSerial,
          ),
        { timeout: 60000 },
      )
      .toBe(true)
  await settled()
  const history = await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)
  const state = await page.evaluate(async () => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const key = async (key: string) => {
      const serial = c.dataset.requestedSerial
      c.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      const start = performance.now()
      while (
        c.dataset.requestedSerial === serial ||
        c.dataset.completedEditSerial !== c.dataset.requestedSerial
      ) {
        if (performance.now() - start > 15000) throw new Error('Masked navigation did not settle')
        await frame()
      }
      await c.getContext('webgpu')!.getConfiguration()!.device.queue.onSubmittedWorkDone()
      return performance.now() - start
    }
    await key('1')
    await key('ArrowRight')
    await key('ArrowLeft')
    await key('+')
    await key('-')
    const original = JSON.stringify
    const probe = { calls: 0, bytes: 0, coverageClones: 0, stacks: [] as string[] }
    const originalClone = structuredClone
    const clone = ((value: unknown, options?: StructuredSerializeOptions) => {
      const candidate = value as { localMasks?: unknown[] } | unknown[] | null
      const masks = Array.isArray(candidate) ? candidate : candidate?.localMasks
      if (
        masks?.some((mask) => {
          const m = mask as { preparedCoverage?: unknown; preparedRangeBase?: unknown }
          return m.preparedCoverage || m.preparedRangeBase
        })
      )
        probe.coverageClones++
      return originalClone(value, options)
    }) as typeof structuredClone
    const wrapped = ((...args: unknown[]) => {
      const result = Reflect.apply(original, JSON, args) as string | undefined
      if (result?.includes('pngBase64')) {
        probe.calls++
        probe.bytes += result.length
        if (probe.stacks.length < 3) probe.stacks.push(new Error().stack ?? '')
      }
      return result
    }) as typeof JSON.stringify
    JSON.stringify = wrapped
    window.structuredClone = clone
    const measuresBefore = performance.getEntriesByName('irodori.preview.presentation').length
    const before = {
      tiles: c.dataset.renderedTiles,
      uploads: c.dataset.sourceUploads,
      analysis: c.dataset.analysisSerial,
    }
    const samples: number[] = []
    try {
      for (const input of [
        'ArrowRight',
        'ArrowLeft',
        '+',
        '-',
        'ArrowRight',
        'ArrowLeft',
        '+',
        '-',
      ])
        samples.push(await key(input))
    } finally {
      JSON.stringify = original
      window.structuredClone = originalClone
    }
    const retainedPayloads = performance
      .getEntriesByName('irodori.preview.presentation')
      .slice(measuresBefore)
      .filter((entry) =>
        JSON.stringify((entry as PerformanceMeasure).detail).includes('pngBase64'),
      ).length
    return {
      probe,
      retainedPayloads,
      samples,
      before,
      after: {
        tiles: c.dataset.renderedTiles,
        uploads: c.dataset.sourceUploads,
        analysis: c.dataset.analysisSerial,
      },
      quality: c.dataset.quality,
      policy: c.dataset.presentedPolicy,
    }
  })
  await writeFile(info.outputPath('masked-navigation.json'), JSON.stringify(state, null, 2))
  expect(state.probe.calls).toBe(0)
  expect(state.probe.bytes).toBe(0)
  expect(state.probe.coverageClones).toBe(0)
  expect(state.retainedPayloads).toBe(0)
  expect(state.after).toEqual(state.before)
  expect(state.quality).toBe('normal')
  expect(state.policy).toBe('reference')
  expect(await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).toEqual(history)
  await page.evaluate(
    ({ photoId, maskId }) =>
      window.irodori.mutateMasks(photoId, 1, {
        operations: [{ kind: 'update', id: maskId, light: { exposureEv: 0.65 } }],
      }),
    { photoId, maskId },
  )
  await expect(canvas).toHaveAttribute('data-frame-geometry-revision', '2', { timeout: 60000 })
  await settled()
  const changed = await page.evaluate((id) => window.irodori.getEdits(id), photoId)
  expect(changed.settings.maskStack[0].light.exposureEv).toBe(0.65)
  expect(changed.settings.maskStack[0].range).toEqual(history.settings.maskStack[0].range)
  expect(
    (await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).snapshots,
  ).toHaveLength(history.snapshots.length + 1)
})
