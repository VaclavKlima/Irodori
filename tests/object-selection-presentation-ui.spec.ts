import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import { navigateInspector } from './inspector.helpers'
import { holdNormalOffscreenFence } from './hdr-presentation-gate.helpers'
import { createMask } from './mask-panel.helpers'

test('object boxes stay on submitted HDR geometry while zoom and pan are pending', async ({
  irodori: { app, page },
}) => {
  test.setTimeout(90000)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(
    app,
    page,
    ['assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW'],
    false,
    'keyboard',
  )
  const photo = page.getByTestId('main-preview')
  await expect(photo).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
  await expect(photo).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
  await navigateInspector(page, 'Masks')
  await createMask(page, 'Select object…')
  const overlay = page.getByTestId('object-selection-overlay')
  await expect(overlay).toHaveAttribute('data-matching-grid', 'true', { timeout: 60000 })
  await photo.focus()
  await photo.press('1')
  await expect
    .poll(() =>
      photo.evaluate((element) => element.dataset.presentedView === element.dataset.requestedView),
    )
    .toBe(true)
  const initial = await photo.evaluate(
    (element) =>
      JSON.parse(element.dataset.presentedView!) as { scale: number; x: number; y: number },
  )
  const gate = await holdNormalOffscreenFence(page)
  try {
    await photo.press('+')
    await expect
      .poll(async () => (await gate.evaluate((control) => control.state())).held)
      .toBe(true)
    await photo.press('ArrowRight')
    expect(await photo.evaluate((element) => JSON.parse(element.dataset.presentedView!))).toEqual(
      initial,
    )
    const area = (await overlay.boundingBox())!
    const start = { x: area.x + area.width / 2 - 50, y: area.y + area.height / 2 + 30 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 80, start.y + 40)
    await page.mouse.up()
    const frame = page.getByTestId('object-selection-box')
    expect((await frame.boundingBox())!.width).toBeCloseTo(80)
    expect((await frame.boundingBox())!.height).toBeCloseTo(40)
    await gate.evaluate((control) => control.release())
    await expect
      .poll(() =>
        photo.evaluate(
          (element) => element.dataset.presentedView === element.dataset.requestedView,
        ),
      )
      .toBe(true)
    const requested = await photo.evaluate(
      (element) => JSON.parse(element.dataset.presentedView!) as { scale: number },
    )
    await expect
      .poll(async () => (await frame.boundingBox())!.width)
      .toBeCloseTo((80 * requested.scale) / initial.scale)
    const photos = await page.evaluate(() => window.irodori.listPhotos())
    expect(
      (await page.evaluate((id) => window.irodori.getEditHistory(id), photos.photos[0].id))
        .revision,
    ).toBe(0)
  } finally {
    await gate.evaluate((control) => control.release())
    await gate.dispose()
  }
})

test('a production SAM2 RAW mask renders local Light and its native HDR histogram', async ({
  irodori: { app, page },
}, testInfo) => {
  test.setTimeout(120000)
  await page.evaluate(() => window.irodori.setPreviewPreference('sdr'))
  await importPhotos(
    app,
    page,
    ['assets/tests/images/raw/sony-zv-1a/fog-dogs/originals/DSC03280.ARW'],
    false,
    'keyboard',
  )
  const photo = page.getByTestId('main-preview'),
    histogram = page.locator('#histogram'),
    plot = histogram.getByRole('slider', { name: 'Histogram tonal value' }),
    photoId = (await page.evaluate(() => window.irodori.listPhotos())).photos[0].id
  const attachJson = async (name: string, value: unknown) => {
    const path = testInfo.outputPath(`${name}.json`)
    await writeFile(path, JSON.stringify(value, null, 2))
    await testInfo.attach(name, { path, contentType: 'application/json' })
  }
  const settled = async (revision: number, comparison: 'before' | 'after' = 'after') => {
    await expect(photo).toHaveAttribute('data-backend', 'webgpu-hdr', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-editing', 'ready', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-quality', 'normal', { timeout: 60000 })
    await expect(photo).toHaveAttribute('data-frame-geometry-revision', String(revision))
    await expect(photo).toHaveAttribute('data-comparison', comparison)
    await expect
      .poll(
        () =>
          photo.evaluate((element) => {
            const histogram = document.getElementById('histogram')!,
              plot = histogram.querySelector<SVGSVGElement>('svg[role="slider"]')!
            return (
              element.dataset.completedEditSerial === element.dataset.requestedSerial &&
              element.dataset.analysisPending === 'false' &&
              !!element.dataset.analysisKey &&
              element.dataset.analysisKey === element.dataset.displayedAnalysisKey &&
              histogram.dataset.editSerial === element.dataset.analysisSerial &&
              plot.dataset.curveEditSerial === element.dataset.analysisSerial &&
              plot.dataset.animating === 'false'
            )
          }),
        { timeout: 60000 },
      )
      .toBe(true)
    await expect(histogram).toHaveAttribute('data-samples', '65536')
    await expect(histogram).toHaveAttribute('data-pending', 'false')
    await expect(plot.locator('path[d]')).toHaveCount(3)
    await expect(page.getByTestId('preview-gpu-error')).toHaveCount(0)
    await expect(
      histogram.getByRole('status').filter({ hasText: /^(?:Before|After) \// }),
    ).toHaveText(`${comparison === 'before' ? 'Before' : 'After'} / Rec.2020 · HDR content`)
  }
  const paths = () =>
    plot.locator('path[d]').evaluateAll((items) => items.map((item) => item.getAttribute('d')))
  await settled(0)
  await photo.focus()
  await photo.press('1')
  await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-scale', '1')
  await settled(0)
  const neutral = await paths()
  // Observe real renderer bind groups without changing resources, shaders or submissions.
  const gpu = await page.evaluateHandle(() => {
    const original = GPUDevice.prototype.createBindGroup,
      devices = new Set<GPUDevice>(),
      errors: string[] = []
    let renderGroups = 0,
      histogramGroups = 0
    const failed = (event: Event) => errors.push((event as GPUUncapturedErrorEvent).error.message)
    const create: typeof original = function (this: GPUDevice, descriptor) {
      if (!devices.has(this)) {
        devices.add(this)
        this.addEventListener('uncapturederror', failed)
      }
      const group = original.call(this, descriptor),
        bindings = Array.from(descriptor.entries, (entry) => entry.binding)
      if (bindings.includes(18)) {
        if (bindings.includes(6)) histogramGroups++
        else if (bindings.includes(3)) renderGroups++
      }
      return group
    }
    GPUDevice.prototype.createBindGroup = create
    return {
      state: () => ({ renderGroups, histogramGroups, errors: [...errors] }),
      close: () => {
        GPUDevice.prototype.createBindGroup = original
        for (const device of devices) device.removeEventListener('uncapturederror', failed)
      },
    }
  })
  try {
    await attachJson(
      'production-raw-object-admission',
      await page.evaluate(async () => ({
        resources: await window.irodori.getResourceSettings(),
        presentation: Object.fromEntries(
          Object.entries(
            document.querySelector<HTMLElement>('[data-testid="main-preview"]')!.dataset,
          ).filter(([key]) => /(?:[Mm]emory|[Bb]ytes)/.test(key)),
        ),
      })),
    )
    const selection = await page.evaluate(async (photoId) => {
      const context = await window.irodori.getObjectSelectionContext(photoId, 0),
        proposal = await window.irodori.createObjectSelection({
          photoId,
          expectedRevision: 0,
          gridIdentity: context.gridIdentity,
          prompts: { box: [0.55, 0.4, 0.75, 0.8], positivePoints: [], negativePoints: [] },
        })
      return {
        proposalId: proposal.id,
        maskId: proposal.mask.id,
        modelIdentity: proposal.modelIdentity,
        base: proposal.mask.base && {
          hash: proposal.mask.base.hash,
          width: proposal.mask.base.width,
          height: proposal.mask.base.height,
        },
        width: context.geometry.canonicalWidth,
        height: context.geometry.canonicalHeight,
      }
    }, photoId)
    expect(selection.modelIdentity).toBe('sam2.1-hiera-tiny-f32-labels-v1')
    expect(selection.base).toMatchObject({ width: selection.width, height: selection.height })
    expect(selection.base?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(
      (await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).settings.maskStack,
    ).toEqual([])
    const accepted = await page.evaluate(
      ({ photoId, proposalId }) =>
        window.irodori.acceptObjectSelection({ photoId, proposalId, expectedRevision: 0 }),
      { photoId, proposalId: selection.proposalId },
    )
    expect(accepted.revision).toBe(1)
    expect(accepted.settings.maskStack[0]).toMatchObject({
      id: selection.maskId,
      base: selection.base,
    })
    await settled(1)
    const edited = await page.evaluate(
      ({ photoId, maskId }) =>
        window.irodori.mutateMasks(photoId, 1, {
          operations: [{ kind: 'update', id: maskId, light: { exposureEv: 0.35 } }],
        }),
      { photoId, maskId: selection.maskId },
    )
    expect(edited.revision).toBe(2)
    expect(edited.settings.maskStack[0]).toMatchObject({
      id: selection.maskId,
      base: selection.base,
      light: { exposureEv: 0.35 },
    })
    await settled(2)
    const adjusted = await paths()
    expect(adjusted).not.toEqual(neutral)
    await navigateInspector(page, 'Masks')
    const coverage = page.getByRole('checkbox', { name: 'Show overlay', exact: true })
    if (!(await coverage.isChecked())) await coverage.check()
    await expect(page.getByTestId('mask-coverage-overlay')).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const photo = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!,
            overlay = document.querySelector<HTMLCanvasElement>(
              '[data-testid="mask-coverage-overlay"]',
            )!,
            gl = overlay.getContext('webgl2')!,
            program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
            view = JSON.parse(photo.dataset.presentedView!) as {
              scale: number
              x: number
              y: number
            }
          if (!program || view.scale !== 1) return false
          const scaleLocation = gl.getUniformLocation(program, 'scale'),
            panLocation = gl.getUniformLocation(program, 'pan')
          if (!scaleLocation || !panLocation) return false
          const scale = gl.getUniform(program, scaleLocation) as number,
            pan = Array.from(gl.getUniform(program, panLocation) as Float32Array)
          return scale === 1 && pan[0] === Math.fround(view.x) && pan[1] === Math.fround(view.y)
        }),
      )
      .toBe(true)
    const evidence = await gpu.evaluate((control) => control.state())
    expect(evidence.renderGroups).toBeGreaterThan(0)
    expect(evidence.histogramGroups).toBeGreaterThan(0)
    expect(evidence.errors).toEqual([])
    await photo.focus()
    await photo.press('\\')
    await settled(2, 'before')
    expect(await paths()).toEqual(neutral)
    await photo.press('\\')
    await settled(2)
    expect(await paths()).toEqual(adjusted)
    expect(
      (await page.evaluate((id) => window.irodori.getEditHistory(id), photoId)).settings.maskStack,
    ).toEqual(edited.settings.maskStack)
    expect((await gpu.evaluate((control) => control.state())).errors).toEqual([])
    await attachJson('production-raw-object-mask-hdr', {
      ...selection,
      revision: edited.revision,
      histogramSamples: 65536,
      ...evidence,
    })
  } finally {
    await gpu.evaluate((control) => control.close())
    await gpu.dispose()
  }
})
