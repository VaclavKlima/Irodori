import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { EditHistory } from '../src/shared/edits'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import { expectAdjustmentBounds, minimumAdjustmentWindow } from './adjustment-input.helpers'
import {
  captureNativeEditor,
  nativeEditorInput,
  nativeOriginalHash,
  nativeSensorSource,
  nonblankNativePhotograph,
  readyNativeEditor,
} from './professional-editor-native.helpers'

test(
  'real Sony editing retains native keyboard focus, grouped tools and current photo pixels at 1100 × 700 with Console open',
  foregroundTest(
    'Native window focus, Electron keyboard delivery and compositor-presented real RAW captures require an explicitly available foreground desktop.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(900000)
    const { app, page } = irodori,
      native = await app.browserWindow(page),
      source = resolve('tests/fixtures/sony-zv1.ARW'),
      originalHash = await nativeOriginalHash(source)
    expect(originalHash).toBe('14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2')
    // Wait for the compositor's real client geometry before import starts preparing a source.
    await native.evaluate((window) => {
      window.unmaximize()
      window.setContentSize(1100, 700)
    })
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1100, 700])
    await expect
      .poll(() =>
        native.evaluate((window) => {
          const bounds = window.getContentBounds()
          return [bounds.width, bounds.height]
        }),
      )
      .toEqual([1100, 700])
    const input = await nativeEditorInput(app, page, irodori.userDataDir)
    let inputEvidence: Awaited<ReturnType<typeof input.stop>> | undefined
    try {
      let stableSince = 0
      await expect
        .poll(
          async () => {
            const nativeBounds = await native.evaluate((window) => window.getContentBounds()),
              renderer = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
            await input.guard('native minimum-size precondition')
            if (
              nativeBounds.width !== 1100 ||
              nativeBounds.height !== 700 ||
              renderer.width !== 1100 ||
              renderer.height !== 700
            ) {
              stableSince = 0
              return false
            }
            stableSince ||= Date.now()
            return Date.now() - stableSince >= 1000
          },
          { timeout: 15000, intervals: [100] },
        )
        .toBe(true)
      const consoleToggle = page.getByTestId('console-toggle')
      if ((await consoleToggle.getAttribute('aria-expanded')) !== 'true')
        await input.activate(consoleToggle)
      await expect(consoleToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(page.getByTestId('console-panel')).toBeVisible()
      await input.guard('before ordinary real RAW import')
      await importPhotos(app, page, [source], false, 'keyboard')
      await input.guard('after ordinary real RAW import')
      const photos = await page.evaluate(() => window.irodori.listPhotos())
      expect(photos.total).toBe(1)
      const photo = photos.photos[0],
        id = photo.id,
        state = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
        originalPath = join(irodori.userDataDir, 'library', 'originals', id, 'original.arw')
      expect(photo).toMatchObject({ filename: 'sony-zv1.ARW', format: 'ARW' })
      expect(id).toBe(originalHash)
      expect(await nativeOriginalHash(originalPath)).toBe(originalHash)
      const initial = await state()
      expect(initial).toMatchObject({ revision: 0, cursor: 0, settings: { processing: 'hdr-v1' } })
      expect(initial.snapshots).toHaveLength(1)
      const frame = await readyNativeEditor(page, id, 0),
        sensor = await nativeSensorSource(irodori.userDataDir, id, frame.sourceUrl!),
        display = await page.evaluate(() => window.irodori.getDisplayState())
      expect(sensor.dimensions.width).toBeGreaterThan(5000)
      expect(sensor.dimensions.height).toBeGreaterThan(3000)
      expect(frame.sourceIdentity).toContain(sensor.asset.sha256)
      const captures: { name: string; path: string; nonblank?: unknown }[] = []
      async function capture(name: string, checkPhoto = false) {
        await input.guard(`before capture ${name}`)
        const path = await captureNativeEditor(app, page, info, name)
        captures.push({
          name,
          path,
          ...(checkPhoto ? { nonblank: await nonblankNativePhotograph(page, path) } : {}),
        })
        await input.guard(`after capture ${name}`)
      }
      await capture('native-sony-original-minimum-console', true)
      const historyEvidence: { action: string; history: EditHistory }[] = []
      async function changed(action: string, revision: number) {
        await expect.poll(async () => (await state()).revision, { timeout: 120000 }).toBe(revision)
        const history = await state()
        expect(history.photoId).toBe(id)
        await readyNativeEditor(page, id, revision)
        historyEvidence.push({ action, history })
        return history
      }
      async function section(name: string) {
        const disclosure = page.getByRole('button', { name, exact: true })
        if ((await disclosure.getAttribute('aria-expanded')) !== 'true')
          await input.activate(disclosure)
        await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
        return disclosure
      }
      const exposure = page.getByRole('spinbutton', { name: 'Exposure value', exact: true })
      await expect(exposure).toBeEnabled({ timeout: 120000 })
      await input.replace(exposure, '-0.25')
      expect(await state()).toEqual(initial)
      await input.key('Escape')
      await expect(exposure).toHaveValue('0.00')
      expect(await state()).toEqual(initial)
      await input.replace(exposure, '99')
      await expect(exposure).toHaveAttribute('aria-invalid', 'true')
      await input.key('Enter')
      await expect(exposure).toHaveValue('0.00')
      expect(await state()).toEqual(initial)
      await input.number(exposure, '-0.25')
      const light = await changed('native negative decimal Enter commit', 1)
      expect(light.settings.exposureEv).toBe(-0.25)
      expect(light.snapshots).toHaveLength(2)
      await expect(exposure).toBeFocused()
      await input.key('Tab')
      await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeFocused()
      await input.key('Tab', ['shift'])
      await expect(exposure).toBeFocused()
      await expect(page.getByTestId('preview-viewport')).toHaveAttribute('data-mode', 'fit')

      await section('Crop')
      const cropTool = page.getByRole('button', { name: 'Crop and straighten', exact: true }),
        cropWidth = page.getByRole('spinbutton', { name: 'Crop width value', exact: true }),
        straighten = page.getByRole('spinbutton', { name: 'Straighten value', exact: true })
      await input.activate(cropTool)
      await expect(page.getByTestId('crop-overlay')).toBeVisible()
      await input.number(cropWidth, String(Math.floor(sensor.dimensions.width * 0.8)))
      await input.number(straighten, '1.25')
      const aspect = page.getByRole('combobox', { name: 'Aspect ratio', exact: true })
      await input.focus(aspect)
      await input.key('Home')
      await expect(aspect).toHaveValue('free')
      await input.key('Down')
      await expect(aspect).toHaveValue('original')
      await expect(aspect).toBeFocused()
      await input.key('Home')
      await expect(aspect).toHaveValue('free')
      expect(await state()).toEqual(light)
      await capture('native-sony-crop-draft-dropdown')
      await input.activate(page.getByRole('button', { name: 'Cancel crop', exact: true }))
      await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
      expect(await state()).toEqual(light)
      await readyNativeEditor(page, id, 1)
      await input.activate(cropTool)
      await expect(page.getByTestId('crop-overlay')).toBeVisible()
      await input.number(cropWidth, String(Math.floor(sensor.dimensions.width * 0.8)))
      const cropHeight = page.getByRole('spinbutton', { name: 'Crop height value', exact: true })
      await input.number(cropHeight, String(Math.floor(sensor.dimensions.height * 0.8)))
      await input.number(straighten, '1.25')
      expect(await state()).toEqual(light)
      await input.activate(page.getByRole('button', { name: 'Apply crop', exact: true }))
      await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
      const cropped = await changed('native crop Apply combines framing and straighten', 2)
      expect(cropped.snapshots).toHaveLength(3)
      expect(cropped.settings.crop.angle).toBe(1.25)
      expect(cropped.settings.crop.width).toBeLessThan(1)
      expect(cropped.settings.crop.height).toBeLessThan(1)
      await input.activate(page.getByRole('button', { name: 'Undo', exact: true }))
      const undone = await changed('photo-wide crop Undo', 3)
      expect(undone.settings).toEqual(light.settings)
      expect(undone.snapshots).toHaveLength(3)
      await input.activate(page.getByRole('button', { name: 'Redo', exact: true }))
      const redone = await changed('photo-wide crop Redo', 4)
      expect(redone.settings).toEqual(cropped.settings)
      expect(redone.snapshots).toHaveLength(3)
      await capture('native-sony-crop-applied-minimum-console', true)

      await section('Color')
      const color = page.locator('#color-controls'),
        saturation = color.getByRole('slider', { name: 'Saturation', exact: true })
      await input.focus(saturation)
      await input.send(
        [
          { type: 'keyDown', keyCode: 'Right' },
          { type: 'keyDown', keyCode: 'Right' },
        ],
        'held Saturation arrow gesture',
      )
      await expect(saturation).toHaveValue('2')
      expect(await state()).toEqual(redone)
      await input.send([{ type: 'keyUp', keyCode: 'Right' }], 'Saturation gesture release')
      const saturated = await changed('held native slider commits once on release', 5)
      expect(saturated.settings.saturation).toBe(2)
      expect(saturated.snapshots).toHaveLength(4)
      await input.number(
        color.getByRole('spinbutton', { name: 'Vibrance value', exact: true }),
        '8',
      )
      expect((await changed('native Vibrance field', 6)).settings.vibrance).toBe(8)

      await section('Color Mixer')
      await input.activate(
        page
          .getByRole('group', { name: 'Color mixer range' })
          .getByRole('button', { name: 'Blue', exact: true }),
      )
      const mixer = page.locator('#color-mixer-controls')
      for (const [label, value, revision] of [
        ['Hue', '-4', 7],
        ['Saturation', '3', 8],
        ['Luminance', '2', 9],
      ] as const) {
        await input.number(
          mixer.getByRole('spinbutton', { name: `${label} value`, exact: true }),
          value,
        )
        await changed(`native Blue mixer ${label}`, revision)
      }
      expect((await state()).settings.colorMixer.ranges.blue).toEqual({
        hue: -4,
        saturation: 3,
        luminance: 2,
      })
      await section('Color Grading')
      const toneButtons = page.getByRole('group', { name: 'Color grading tone' }),
        grading = page.locator('#color-grading-controls')
      await input.activate(toneButtons.getByRole('button', { name: 'Shadows', exact: true }))
      for (const [label, value, revision] of [
        ['Hue', '210', 10],
        ['Saturation', '4', 11],
      ] as const) {
        await input.number(
          grading.getByRole('spinbutton', { name: `${label} value`, exact: true }),
          value,
        )
        await changed(`native Shadows grading ${label}`, revision)
      }
      const beforeToneNavigation = await state()
      await input.activate(toneButtons.getByRole('button', { name: 'Highlights', exact: true }))
      await expect(grading.getByRole('spinbutton', { name: 'Hue value', exact: true })).toHaveValue(
        '0.0',
      )
      await input.activate(toneButtons.getByRole('button', { name: 'Shadows', exact: true }))
      await expect(grading.getByRole('spinbutton', { name: 'Hue value', exact: true })).toHaveValue(
        '210.0',
      )
      expect(await state()).toEqual(beforeToneNavigation)
      await capture('native-sony-mixer-grading-controls')

      await section('Detail')
      const detail = page.locator('#detail-controls')
      for (const [label, value, revision] of [
        ['Luminance noise', '6', 12],
        ['Color noise', '8', 13],
        ['Sharpening', '12', 14],
        ['Radius', '1.1', 15],
        ['Threshold', '10', 16],
      ] as const) {
        const field = detail.getByRole('spinbutton', { name: `${label} value`, exact: true })
        await expect(field).toBeEnabled({ timeout: 120000 })
        const before = await state()
        await input.replace(field, value)
        expect(await state()).toEqual(before)
        await input.key('Enter')
        await changed(`native Detail ${label}`, revision)
      }
      const final = await state()
      expect(final.settings).toMatchObject({
        exposureEv: -0.25,
        saturation: 2,
        vibrance: 8,
        colorMixer: { ranges: { blue: { hue: -4, saturation: 3, luminance: 2 } } },
        colorGrading: { tones: { shadows: { hue: 210, saturation: 4 } } },
        noiseReduction: { luminance: 6, chroma: 8 },
        detailSharpening: { amount: 12, radius: 1.1, threshold: 10 },
        crop: cropped.settings.crop,
      })
      expect(final.snapshots).toHaveLength(15)

      const pinned = page.getByTestId('inspector-pinned'),
        scroll = page.getByTestId('inspector-scroll'),
        viewport = page.getByTestId('preview-viewport'),
        consolePanel = page.getByTestId('console-panel')
      await input.focus(page.getByRole('button', { name: 'Crop', exact: true }))
      const pinnedBefore = await pinned.boundingBox(),
        viewportBefore = await viewport.boundingBox(),
        consoleBefore = await consolePanel.boundingBox(),
        scrollBefore = await scroll.evaluate((element) => element.scrollTop),
        box = (await scroll.boundingBox())!
      await input.guard('before inspector wheel')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 1200)
      await expect
        .poll(() => scroll.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(scrollBefore)
      await input.guard('after inspector wheel')
      expect(await pinned.boundingBox()).toEqual(pinnedBefore)
      expect(await viewport.boundingBox()).toEqual(viewportBefore)
      expect(await consolePanel.boundingBox()).toEqual(consoleBefore)
      expect(
        await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          scrollY,
        })),
      ).toEqual({ width: 1100, height: 700, horizontalOverflow: false, scrollY: 0 })
      expect(await state()).toEqual(final)
      await capture('native-sony-independent-inspector-scroll')
      await input.focus(detail.getByRole('spinbutton', { name: 'Sharpening value', exact: true }))
      await capture('native-sony-final-detail-keyboard-focus', true)

      const finalFrame = await readyNativeEditor(page, id, 16),
        finalSensor = await nativeSensorSource(irodori.userDataDir, id, finalFrame.sourceUrl!)
      expect(finalFrame.parameters).toMatchObject({
        exposureEv: -0.25,
        saturation: 2,
        vibrance: 8,
        colorMixer: final.settings.colorMixer,
        colorGrading: final.settings.colorGrading,
      })
      expect(finalFrame.sourceIdentity).toContain(finalSensor.asset.sha256)
      expect(finalSensor.asset.sha256).not.toBe(sensor.asset.sha256)
      expect(finalSensor.detailSource).toMatchObject({
        noiseReduction: final.settings.noiseReduction,
        detailSharpening: final.settings.detailSharpening,
      })
      expect(finalSensor.cropSettings).toEqual(final.settings.crop)
      await input.focus(
        page.getByRole('textbox', {
          name: 'Agent console output, disconnected and read only',
          exact: true,
        }),
      )
      await input.key('Delete')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(await state()).toEqual(final)
      expect((await page.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
      expect(await nativeOriginalHash(source)).toBe(originalHash)
      expect(await nativeOriginalHash(originalPath)).toBe(originalHash)
      inputEvidence = await input.stop()
      expect(inputEvidence.events.some((event) => event.type === 'input' && event.trusted)).toBe(
        true,
      )
      expect(
        inputEvidence.events
          .filter((event) => event.type === 'keydown')
          .every((event) => event.trusted),
      ).toBe(true)
      await writeFile(
        info.outputPath('native-editor-acceptance.json'),
        JSON.stringify(
          {
            source: { path: source, sha256: originalHash, photo },
            nativeContent: { width: 1100, height: 700, consoleOpen: true },
            initialDisplay: display,
            finalDisplay: await page.evaluate(() => window.irodori.getDisplayState()),
            initialFrame: frame,
            finalFrame,
            sensor,
            finalSensor,
            captures,
            historyEvidence,
            final,
            inputEvidence,
            limitations: [
              'Native keyboard input is delivered through Electron; no physical keyboard or mouse device is exercised.',
              'Inspector wheel delivery is Chromium input; native popup composition and manual pointer gestures are not certified.',
              'Captures prove visible nonblank real-photo composition and revision ownership, not photographic quality or physical HDR luminance.',
              'This functional case measures no cadence, responsiveness budget, full-frame CPU/GPU numerical agreement or performance gate.',
              'Windows and macOS coverage depends on actually running this target on those platforms.',
            ],
          },
          null,
          2,
        ),
      )
    } finally {
      if (!inputEvidence) {
        const evidence = await input.stop().catch((error: unknown) => ({ error: String(error) }))
        await writeFile(
          info.outputPath('native-input-interrupted.json'),
          JSON.stringify(evidence, null, 2),
        )
      }
    }
  },
)

test(
  'Sony 8000 K and Tint 25 retain native compact inspector visibility with Console open',
  foregroundTest(
    'Real Sony white-balance viewport visibility and compositor capture after an OS resize require an explicitly available foreground desktop.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(300000)
    const { app, page } = irodori,
      source = resolve('tests/fixtures/sony-zv1.ARW'),
      hash = await nativeOriginalHash(source)
    expect(hash).toBe('14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2')
    await minimumAdjustmentWindow(app, page)
    const input = await nativeEditorInput(app, page, irodori.userDataDir)
    let inputEvidence: Awaited<ReturnType<typeof input.stop>> | undefined
    try {
      await importPhotos(app, page, [source], false, 'keyboard')
      const photo = (await page.evaluate(() => window.irodori.listPhotos())).photos[0],
        id = photo.id,
        temperature = page.getByRole('spinbutton', { name: 'Temperature value', exact: true }),
        tint = page.getByRole('spinbutton', { name: 'Tint value', exact: true }),
        state = () => page.evaluate((id) => window.irodori.getEdits(id), id)
      await readyNativeEditor(page, id, 0)
      expect((await state()).whiteBalanceProfile?.provider).toBe('sony-zv1-white-balance')
      await expect(temperature).toBeEditable({ timeout: 40000 })
      await input.number(temperature, '8000')
      await expect.poll(state).toMatchObject({
        revision: 1,
        settings: { whiteBalance: { mode: 'custom', kelvin: 8000 } },
      })
      await readyNativeEditor(page, id, 1)
      await expect(tint).toBeEditable()
      await input.number(tint, '25')
      await expect.poll(state).toMatchObject({
        revision: 2,
        settings: { whiteBalance: { mode: 'custom', kelvin: 8000, tint: 25 } },
      })
      await readyNativeEditor(page, id, 2)
      await input.activate(page.getByRole('button', { name: 'As Shot', exact: true }))
      await expect
        .poll(state)
        .toMatchObject({ revision: 3, settings: { whiteBalance: { mode: 'as-shot' } } })
      await readyNativeEditor(page, id, 3)
      await input.activate(page.getByRole('button', { name: 'Undo', exact: true }))
      const frame = await readyNativeEditor(page, id, 4)
      expect(await state()).toMatchObject({
        revision: 4,
        settings: { whiteBalance: { mode: 'custom', kelvin: 8000, tint: 25 } },
      })
      await expect(temperature).toHaveValue('8000')
      await expect(tint).toHaveValue('25')
      await expect(page.getByTestId('console-panel')).toBeVisible()
      const bounds = await expectAdjustmentBounds(page, tint)
      await expect(tint).toBeInViewport()
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeInViewport()
      await expect(page.getByTestId('main-preview')).toBeVisible()
      await expect(page.getByTestId('main-preview')).toHaveCSS('visibility', 'visible')
      expect(frame.parameters.whiteBalance).toEqual({ mode: 'custom', kelvin: 8000, tint: 25 })
      const sensor = await nativeSensorSource(irodori.userDataDir, id, frame.sourceUrl!)
      expect(frame.sourceIdentity).toContain(sensor.asset!.sha256)
      await input.guard('before native 8000 K/Tint 25 capture')
      const capture = await captureNativeEditor(app, page, info, 'white-balance-1100-console')
      const nonblank = await nonblankNativePhotograph(page, capture)
      await input.guard('after native 8000 K/Tint 25 capture')
      expect(await nativeOriginalHash(source)).toBe(hash)
      expect(
        await nativeOriginalHash(
          join(irodori.userDataDir, 'library', 'originals', id, 'original.arw'),
        ),
      ).toBe(hash)
      inputEvidence = await input.stop()
      await writeFile(
        info.outputPath('white-balance-native-visual.json'),
        JSON.stringify(
          {
            photo,
            hash,
            state: await state(),
            frame,
            sensor,
            bounds,
            capture,
            nonblank,
            inputEvidence,
            display: await page.evaluate(() => window.irodori.getDisplayState()),
            limitations:
              'Native real-photo composition only; physical input, HDR luminance, photographic quality and performance remain separate acceptance gates.',
          },
          null,
          2,
        ),
      )
    } finally {
      if (!inputEvidence) {
        const evidence = await input.stop().catch((error: unknown) => ({ error: String(error) }))
        await writeFile(
          info.outputPath('white-balance-native-input-interrupted.json'),
          JSON.stringify(evidence, null, 2),
        )
      }
    }
  },
)
