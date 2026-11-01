import { execFile } from 'node:child_process'
import { realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication } from '@playwright/test'
import type {
  PhotoWhiteBalanceProposal,
  WhiteBalanceSample,
} from '../src/shared/white-balance-picker'
import { WHITE_BALANCE_PICKER_LIMITS } from '../src/shared/white-balance-picker'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import {
  captureNativeEditor,
  nativeEditorInput,
  nativeOriginalHash,
  nativeSensorSource,
  nonblankNativePhotograph,
  readyNativeEditor,
} from './professional-editor-native.helpers'

// Privacy-reviewed ISO125 functional capture, published in fixture commit 3067fd8796408b5bd970e884a2c798ac32b6037e.
// The scene and lighting are unmeasured; this is not a calibrated neutral target.
const fixture = {
  path: 'assets/tests/images/raw/sony-zv-1a/white-balance-functional/originals/capt_DSC07247.ARW',
  sha256: '8a2e09a6798e303ea2a991139dbc50245aedc218bffe11d614f307b93d7b1cfb',
} as const

// Frozen read-only functional grid, not selection for a color-quality score.
// Integer percentages retain the native numeric controls' coordinate precision.
// Prior fog and carpet refusals remain preserved; the unchanged grid/limits now
// exercise a separate low-ISO functional original, with no neutral-accuracy claim.
const preflightPolicy = {
    id: 'functional-grid-12x8-integer-percent-v2',
    order: 'row-major; stop at the first existing-validity proposal',
    diameter: 31,
    previousEightInvalidReceipt:
      'artifacts/verification/playwright-1793368093806-f4ccce27-2f59-4dda-ae8e-9d6343e99294/playwright/summary.json',
    previousFogGridReceipt:
      'artifacts/verification/playwright-1793368296633-5a6e4ab3-057c-4f7a-b677-25a62a09540b/playwright/summary.json',
    previousCarpetGridReceipt:
      'artifacts/verification/playwright-1793368363618-a6155748-17e0-4d9b-b960-f71c4302bfa5/playwright/summary.json',
    fixtureSelection:
      'Separately captured and published privacy-reviewed ISO125 original after the functional capture brief; original 31-pixel, 96-position policy and all validity rules retained. Prior fog/carpet refusals are not reclassified; no measured neutral or two-illuminant accuracy claim.',
  } as const,
  preflightPositions = [6, 18, 30, 42, 54, 66, 78, 90].flatMap((y) =>
    [4, 12, 20, 28, 36, 44, 52, 60, 68, 76, 84, 92].map((x) => ({ x: x / 100, y: y / 100 })),
  )

/** Independent application of the documented floor/endpoint/clipped-square rule. */
function expectedArea(sample: WhiteBalanceSample, width: number, height: number) {
  const centerX = Math.min(width - 1, Math.floor(sample.x * width)),
    centerY = Math.min(height - 1, Math.floor(sample.y * height)),
    radius = (sample.diameter - 1) / 2,
    x = Math.max(0, centerX - radius),
    y = Math.max(0, centerY - radius)
  return {
    centerX,
    centerY,
    x,
    y,
    width: Math.min(width - 1, centerX + radius) - x + 1,
    height: Math.min(height - 1, centerY + radius) - y + 1,
  }
}

/** Observe actual handlers and returned proposals without replacing service results. */
function recordPickerIpc(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const records: {
      channel: string
      args: unknown[]
      result?: unknown
      error?: string
    }[] = []
    const wrappers = ['white-balance:propose', 'edits:update'].map((channel) => {
      const original = handlers.get(channel)
      if (!original) throw new Error(`Missing real application handler ${channel}.`)
      const wrapper: Handler = async (...args) => {
        const record: (typeof records)[number] = {
          channel,
          args: structuredClone(args.slice(1)),
        }
        records.push(record)
        try {
          const result = await original(...args)
          record.result = structuredClone(result)
          return result
        } catch (error) {
          record.error = String(error)
          throw error
        }
      }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, wrapper)
      return { channel, original, wrapper }
    })
    return {
      read: () => structuredClone(records),
      close() {
        for (const { channel, original, wrapper } of wrappers)
          if (handlers.get(channel) === wrapper) {
            ipcMain.removeHandler(channel)
            ipcMain.handle(channel, original)
          }
      },
    }
  })
}

test(
  'published Sony RAW picker uses native numeric and pointer coordinates with one combined edit, history and restart at minimum size',
  foregroundTest(
    'Native focus, Electron keyboard/mouse delivery and real RAW compositor captures require an explicit foreground desktop.',
  ),
  async ({ irodori }, info) => {
    test.setTimeout(900000)
    const source = resolve(fixture.path),
      run = promisify(execFile)
    await run('git', ['ls-files', '--error-unmatch', '--', fixture.path])
    await run('git', ['diff', '--quiet', 'HEAD', '--', fixture.path])
    expect(await nativeOriginalHash(source)).toBe(fixture.sha256)

    let { app, page } = irodori
    let input: Awaited<ReturnType<typeof nativeEditorInput>>,
      recorder: Awaited<ReturnType<typeof recordPickerIpc>>,
      inputStopped = true,
      recorderClosed = true
    const inputEvidence: ({ purpose: string } & Awaited<ReturnType<typeof input.stop>>)[] = [],
      ipcEvidence: unknown[] = [],
      proposals: { purpose: string; proposal: PhotoWhiteBalanceProposal }[] = [],
      captures: { name: string; path: string; nonblank: unknown }[] = [],
      historyEvidence: { purpose: string; history: unknown }[] = [],
      setupEvidence: unknown[] = []
    let failed = false,
      failureMessage: string | undefined,
      deferredFailure: unknown

    async function resizeMinimumWindow(purpose: 'initial' | 'restart') {
      expect(
        inputStopped,
        'Window recovery is allowed only before this session starts native input.',
      ).toBe(true)
      const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
      expect(await realpath(actualProfile)).toBe(await realpath(irodori.userDataDir))
      const native = await app.browserWindow(page)
      await expect
        .poll(() => native.evaluate((window) => window.isVisible()), {
          timeout: 15000,
          intervals: [100],
        })
        .toBe(true)
      let stableSince = 0
      await expect
        .poll(
          async () => {
            // A late initial compositor configure can replace the first resize.
            // Recover only during setup, before this session has native input.
            const state = await native.evaluate((window) => {
              const size = window.getContentSize()
              const visible = window.isVisible()
              const minimized = window.isMinimized()
              const maximized = window.isMaximized()
              let recovery: 'restore' | 'unmaximize' | 'resize' | undefined
              if (minimized) {
                window.restore()
                recovery = 'restore'
              } else if (maximized) {
                window.unmaximize()
                recovery = 'unmaximize'
              } else if (visible && (size[0] !== 1100 || size[1] !== 700)) {
                window.setContentSize(1100, 700)
                recovery = 'resize'
              }
              return { size, visible, minimized, maximized, recovery }
            })
            const viewport = await page.evaluate(() => [innerWidth, innerHeight])
            setupEvidence.push({ purpose, time: performance.now(), native: state, viewport })
            if (
              state.recovery ||
              !state.visible ||
              state.minimized ||
              state.maximized ||
              state.size[0] !== 1100 ||
              state.size[1] !== 700 ||
              viewport[0] !== 1100 ||
              viewport[1] !== 700
            ) {
              stableSince = 0
              return false
            }
            stableSince ||= performance.now()
            return performance.now() - stableSince >= 1000
          },
          { timeout: 15000, intervals: [100] },
        )
        .toBe(true)
    }

    async function minimumWindow() {
      const native = await app.browserWindow(page)
      let stableSince = 0
      await expect
        .poll(
          async () => {
            const bounds = await native.evaluate((window) => window.getContentBounds()),
              renderer = await page.evaluate(() => [innerWidth, innerHeight])
            await input.guard('native minimum-size picker precondition')
            if (
              bounds.width !== 1100 ||
              bounds.height !== 700 ||
              renderer[0] !== 1100 ||
              renderer[1] !== 700
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
      await expect(page.getByTestId('console-panel')).toBeVisible()
      await input.guard('minimum Console-open picker workspace')
    }

    async function stopObservers(purpose: string) {
      if (!recorderClosed) {
        ipcEvidence.push({ purpose, records: await recorder.evaluate((value) => value.read()) })
        await recorder.evaluate((value) => value.close())
        await recorder.dispose()
        recorderClosed = true
      }
      if (!inputStopped) {
        const evidence = await input.stop()
        inputEvidence.push({ purpose, ...evidence })
        inputStopped = true
      }
    }

    try {
      await resizeMinimumWindow('initial')
      input = await nativeEditorInput(app, page, irodori.userDataDir)
      inputStopped = false
      recorder = await recordPickerIpc(app)
      recorderClosed = false
      await minimumWindow()
      await importPhotos(app, page, [source], false, 'keyboard')
      await input.guard('after isolated published RAW import')
      const photos = await page.evaluate(() => window.irodori.listPhotos())
      expect(photos.total).toBe(1)
      const photo = photos.photos[0],
        id = photo.id,
        original = join(irodori.userDataDir, 'library', 'originals', id, 'original.arw'),
        state = () => page.evaluate((id) => window.irodori.getEditHistory(id), id),
        initial = await state()
      expect(photo).toMatchObject({
        filename: 'capt_DSC07247.ARW',
        format: 'ARW',
        id: fixture.sha256,
      })
      expect(await nativeOriginalHash(original)).toBe(fixture.sha256)
      expect(initial).toMatchObject({
        revision: 0,
        cursor: 0,
        settings: { processing: 'hdr-v1', whiteBalance: { mode: 'as-shot' } },
      })
      expect(initial.snapshots).toHaveLength(1)
      const firstFrame = await readyNativeEditor(page, id, 0),
        sensor = await nativeSensorSource(irodori.userDataDir, id, firstFrame.sourceUrl!),
        { width, height } = sensor.dimensions,
        initialDisplay = await page.evaluate(() => window.irodori.getDisplayState())
      expect(firstFrame.sourceIdentity).toContain(sensor.asset.sha256)

      function checkArea(proposal: PhotoWhiteBalanceProposal, sample: WhiteBalanceSample) {
        expect(proposal).toMatchObject({ photoId: id, revision: 0, sample })
        expect(proposal.area).toEqual(expectedArea(sample, width, height))
        expect(proposal.total).toBe(proposal.area.width * proposal.area.height)
        expect(proposal.renderingIdentity).not.toBe('')
      }

      let selected: WhiteBalanceSample | undefined
      for (const position of preflightPositions) {
        const sample: WhiteBalanceSample = { ...position, diameter: 31 },
          proposal = await page.evaluate(
            ({ id, sample }) => window.irodori.proposeWhiteBalance(id, 0, sample),
            { id, sample },
          )
        checkArea(proposal, sample)
        proposals.push({ purpose: 'bounded read-only valid-ROI preflight', proposal })
        expect(await state()).toEqual(initial)
        if (proposal.status === 'valid') {
          selected = sample
          break
        }
      }
      expect(
        selected,
        'The frozen 96-position preflight must find a usable functional patch.',
      ).toBeTruthy()
      if (!selected)
        throw new Error('No valid RAW picker proposal in the frozen 96-position preflight.')
      for (const corner of [0, 1]) {
        const sample: WhiteBalanceSample = { x: corner, y: corner, diameter: 31 },
          proposal = await page.evaluate(
            ({ id, sample }) => window.irodori.proposeWhiteBalance(id, 0, sample),
            { id, sample },
          )
        checkArea(proposal, sample)
        proposals.push({ purpose: 'actual native endpoint/clipped-square geometry', proposal })
        expect(await state()).toEqual(initial)
      }

      const color = page.getByRole('button', { name: 'Color', exact: true })
      if ((await color.getAttribute('aria-expanded')) !== 'true') await input.activate(color)
      const toggle = () => page.getByRole('button', { name: 'Neutral white balance', exact: true }),
        sampleButton = () => page.getByRole('button', { name: 'Sample neutral area', exact: true }),
        apply = () => page.getByRole('button', { name: 'Apply white balance', exact: true }),
        canvas = () => page.getByTestId('main-preview'),
        viewport = () => page.getByTestId('preview-viewport')

      async function coordinates(sample: WhiteBalanceSample) {
        await input.number(
          page.getByRole('spinbutton', { name: 'Sample X value', exact: true }),
          String(Math.round(sample.x * 100)),
        )
        await input.number(
          page.getByRole('spinbutton', { name: 'Sample Y value', exact: true }),
          String(Math.round(sample.y * 100)),
        )
      }

      async function nextUiProposal(action: () => Promise<void>) {
        const count = (await recorder.evaluate((value) => value.read())).filter(
          (record) => record.channel === 'white-balance:propose',
        ).length
        await action()
        await expect
          .poll(
            async () =>
              (await recorder.evaluate((value) => value.read())).filter(
                (record) =>
                  record.channel === 'white-balance:propose' && record.result !== undefined,
              ).length,
            { timeout: 120000 },
          )
          .toBe(count + 1)
        await expect(sampleButton()).toBeEnabled({ timeout: 120000 })
        const record = (await recorder.evaluate((value) => value.read()))
            .filter((record) => record.channel === 'white-balance:propose')
            .at(-1)!,
          result = record.result as { proposal?: PhotoWhiteBalanceProposal; error?: string }
        expect(record.error).toBeUndefined()
        expect(result.error).toBeUndefined()
        if (!result.proposal) throw new Error('Real picker handler returned no proposal.')
        expect(record.args).toEqual([id, 0, result.proposal.sample])
        checkArea(result.proposal, result.proposal.sample)
        expect(await state()).toEqual(initial)
        await input.guard('after actual read-only UI proposal')
        return result.proposal
      }

      await expect(toggle()).toBeEnabled({ timeout: 120000 })
      await input.activate(toggle())
      await expect(toggle()).toHaveAttribute('aria-pressed', 'true')
      await coordinates(selected)
      for (const diameter of [7, 15, 31] as const) {
        const size = page.getByRole('button', {
          name: `Sample size ${diameter} pixels`,
          exact: true,
        })
        await input.activate(size)
        await expect(size).toHaveAttribute('aria-pressed', 'true')
        const proposal = await nextUiProposal(() => input.activate(sampleButton()))
        expect(proposal.sample).toEqual({ ...selected, diameter })
        proposals.push({
          purpose: `native keyboard numeric position and ${diameter}-pixel area`,
          proposal,
        })
        if (diameter === 31) {
          expect(proposal.status).toBe('valid')
          await expect(apply()).toBeEnabled()
        }
      }

      // Numeric source coordinates must remain independent of zoom and keyboard pan.
      await input.focus(canvas())
      await input.key('1')
      await expect(viewport()).toHaveAttribute('data-mode', 'manual')
      await expect.poll(() => viewport().getAttribute('data-scale')).toBe('1')
      const panBefore = Number(await viewport().getAttribute('data-pan-x'))
      await input.key('Left')
      await input.key('Up')
      await expect
        .poll(async () => Number(await viewport().getAttribute('data-pan-x')))
        .not.toBe(panBefore)
      await readyNativeEditor(page, id, 0)
      await coordinates(selected)
      const pannedProposal = await nextUiProposal(() => input.activate(sampleButton()))
      expect(pannedProposal.sample).toEqual(selected)
      expect(pannedProposal.status).toBe('valid')
      proposals.push({
        purpose: '100-percent keyboard-panned source-coordinate agreement',
        proposal: pannedProposal,
      })
      await input.focus(canvas())
      await input.key('0')
      await expect(viewport()).toHaveAttribute('data-mode', 'fit')
      await readyNativeEditor(page, id, 0)

      const pointer = await viewport().evaluate((element, sample) => {
        const bounds = element.getBoundingClientRect(),
          imageWidth = Number(element.dataset.imageWidth),
          imageHeight = Number(element.dataset.imageHeight),
          scale = Number(element.dataset.scale),
          panX = Number(element.dataset.panX),
          panY = Number(element.dataset.panY),
          left = bounds.x + bounds.width / 2 + panX - (imageWidth * scale) / 2,
          top = bounds.y + bounds.height / 2 + panY - (imageHeight * scale) / 2,
          x = Math.round(left + sample.x * imageWidth * scale),
          y = Math.round(top + sample.y * imageHeight * scale)
        if (!(x > bounds.left && x < bounds.right && y > bounds.top && y < bounds.bottom))
          throw new Error('Frozen Fit sample must be inside the actual preview viewport.')
        return {
          x,
          y,
          sample: { x: (x - left) / (imageWidth * scale), y: (y - top) / (imageHeight * scale) },
        }
      }, selected)
      const pointerProposal = await nextUiProposal(async () => {
        await input.guard('before native Electron pointer sample')
        const native = await app.browserWindow(page)
        await native.evaluate((window, point) => {
          if (!window.isFocused() || !window.webContents.isFocused())
            throw new Error('Native focus was lost before pointer delivery.')
          window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
          window.webContents.sendInputEvent({
            type: 'mouseDown',
            button: 'left',
            clickCount: 1,
            x: point.x,
            y: point.y,
          })
          window.webContents.sendInputEvent({
            type: 'mouseUp',
            button: 'left',
            clickCount: 1,
            x: point.x,
            y: point.y,
          })
        }, pointer)
        await input.guard('after native Electron pointer sample')
      })
      expect(pointerProposal.sample.x).toBeCloseTo(pointer.sample.x, 12)
      expect(pointerProposal.sample.y).toBeCloseTo(pointer.sample.y, 12)
      expect(pointerProposal.sample.diameter).toBe(31)
      expect(pointerProposal.area).toEqual(
        expectedArea({ ...pointer.sample, diameter: 31 }, width, height),
      )
      proposals.push({
        purpose: 'native Electron pointer with rounded client-pixel inverse geometry',
        proposal: pointerProposal,
      })

      await input.focus(page.getByRole('button', { name: 'Cancel picker', exact: true }))
      await input.key('Escape')
      await expect(toggle()).toHaveAttribute('aria-pressed', 'false')
      expect(await state()).toEqual(initial)
      await input.activate(toggle())
      await coordinates(selected)
      await input.activate(page.getByRole('button', { name: 'Sample size 31 pixels', exact: true }))
      const acceptedProposal = await nextUiProposal(() => input.activate(sampleButton()))
      expect(acceptedProposal.status).toBe('valid')
      if (acceptedProposal.status !== 'valid')
        throw new Error('The selected functional RAW patch became invalid.')
      expect(acceptedProposal.accepted).toBeGreaterThanOrEqual(
        WHITE_BALANCE_PICKER_LIMITS.minimumPixels,
      )
      expect(acceptedProposal.residual).toBeLessThanOrEqual(
        WHITE_BALANCE_PICKER_LIMITS.maximumNeutralResidual,
      )
      expect(acceptedProposal.scatter).toBeLessThanOrEqual(
        WHITE_BALANCE_PICKER_LIMITS.maximumLogScatter,
      )
      const proposalCapture = await captureNativeEditor(
        app,
        page,
        info,
        'native-real-raw-picker-proposal',
      )
      captures.push({
        name: 'proposal',
        path: proposalCapture,
        nonblank: await nonblankNativePhotograph(page, proposalCapture),
      })

      await input.activate(apply())
      await expect(toggle()).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => (await state()).revision, { timeout: 120000 }).toBe(1)
      const accepted = await state()
      expect(accepted.settings).toEqual({
        ...initial.settings,
        whiteBalance: acceptedProposal.settings,
      })
      expect(accepted.cursor).toBe(1)
      expect(accepted.snapshots).toHaveLength(2)
      expect(accepted.snapshots[0]).toEqual(initial.snapshots[0])
      const updates = (await recorder.evaluate((value) => value.read())).filter(
        (record) => record.channel === 'edits:update',
      )
      expect(updates).toHaveLength(1)
      expect(updates[0].args).toEqual([id, { whiteBalance: acceptedProposal.settings }, 0])
      await expect(
        page.getByRole('spinbutton', { name: 'Temperature value', exact: true }),
      ).toHaveValue(String(acceptedProposal.settings.kelvin))
      await expect(page.getByRole('spinbutton', { name: 'Tint value', exact: true })).toHaveValue(
        String(acceptedProposal.settings.tint),
      )
      await readyNativeEditor(page, id, 1)
      historyEvidence.push({ purpose: 'one combined Kelvin/Tint UI edit', history: accepted })
      await input.activate(page.getByRole('button', { name: 'Undo', exact: true }))
      await expect.poll(async () => (await state()).revision).toBe(2)
      const undone = await state()
      expect(undone.settings).toEqual(initial.settings)
      expect(undone.cursor).toBe(0)
      expect(undone.snapshots).toEqual(accepted.snapshots)
      await readyNativeEditor(page, id, 2)
      await input.activate(page.getByRole('button', { name: 'Redo', exact: true }))
      await expect.poll(async () => (await state()).revision).toBe(3)
      const redone = await state()
      expect(redone.settings).toEqual(accepted.settings)
      expect(redone.cursor).toBe(1)
      expect(redone.snapshots).toEqual(accepted.snapshots)
      await readyNativeEditor(page, id, 3)
      historyEvidence.push(
        { purpose: 'Undo', history: undone },
        { purpose: 'Redo', history: redone },
      )

      await stopObservers('before isolated application restart')
      ;({ app, page } = await irodori.restart())
      await resizeMinimumWindow('restart')
      input = await nativeEditorInput(app, page, irodori.userDataDir)
      inputStopped = false
      recorder = await recordPickerIpc(app)
      recorderClosed = false
      await minimumWindow()
      await readyNativeEditor(page, id, 3)
      expect(await state()).toEqual(redone)
      await expect(toggle()).toHaveAttribute('aria-pressed', 'false')
      const asShot = page.getByRole('button', { name: 'As Shot', exact: true })
      await input.activate(asShot)
      await expect.poll(async () => (await state()).revision).toBe(4)
      const reset = await state()
      expect(reset.settings).toEqual(initial.settings)
      expect(reset.cursor).toBe(2)
      expect(reset.snapshots).toHaveLength(3)
      await expect(asShot).toBeDisabled()
      const finalFrame = await readyNativeEditor(page, id, 4),
        finalSensor = await nativeSensorSource(irodori.userDataDir, id, finalFrame.sourceUrl!)
      expect(finalSensor.dimensions).toEqual(sensor.dimensions)
      expect(finalSensor.asset.sha256).toBe(sensor.asset.sha256)
      historyEvidence.push({
        purpose: 'restart retains complete history and As Shot adds one edit',
        history: reset,
      })
      const finalCapture = await captureNativeEditor(
        app,
        page,
        info,
        'native-real-raw-picker-as-shot',
      )
      captures.push({
        name: 'As Shot',
        path: finalCapture,
        nonblank: await nonblankNativePhotograph(page, finalCapture),
      })
      expect(await nativeOriginalHash(source)).toBe(fixture.sha256)
      expect(await nativeOriginalHash(original)).toBe(fixture.sha256)
      expect((await page.evaluate(() => window.irodori.listPhotos())).total).toBe(1)
      expect(
        await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
        })),
      ).toEqual({ width: 1100, height: 700, overflow: false })
      await input.guard('completed real RAW picker acceptance')
      historyEvidence.push({
        purpose: 'initial display and prepared source',
        history: { initialDisplay, firstFrame, finalFrame, sensor, finalSensor },
      })
      await stopObservers('completed real RAW picker acceptance')
      expect(inputEvidence).toHaveLength(2)
      for (const evidence of inputEvidence) {
        expect(evidence.events.some((event) => event.type === 'keydown' && event.trusted)).toBe(
          true,
        )
        expect(
          evidence.events
            .filter((event) => event.type === 'keydown')
            .every((event) => event.trusted),
        ).toBe(true)
      }
    } catch (error) {
      failed = true
      failureMessage = String(error)
      throw error
    } finally {
      let cleanupFailure: unknown
      try {
        await stopObservers('final cleanup')
      } catch (error) {
        cleanupFailure = error
      }
      try {
        await writeFile(
          info.outputPath('professional-picker-native.json'),
          JSON.stringify(
            {
              fixture,
              preflightPolicy,
              preflightPositions,
              proposals,
              captures,
              historyEvidence,
              setupEvidence,
              inputEvidence,
              ipcEvidence,
              failure: failureMessage ?? null,
              cleanupFailure: cleanupFailure === undefined ? null : String(cleanupFailure),
              requiredNativeContent: { width: 1100, height: 700, consoleOpen: true },
              limitations: [
                'A valid proposal tests provider/model recovery for an assumed neutral patch; physical scene neutrality and two measured illuminants remain unverified.',
                'Keyboard and pointer events use Electron webContents.sendInputEvent under native focus guards; no physical input device is exercised.',
                'This focused suite does not certify physical HDR luminance, camera calibration, photographic color accuracy or performance.',
              ],
            },
            null,
            2,
          ) + '\n',
        )
      } catch (error) {
        if (!failed && cleanupFailure === undefined) deferredFailure = error
      }
      if (!failed && cleanupFailure !== undefined) deferredFailure = cleanupFailure
    }
    if (deferredFailure !== undefined) throw deferredFailure
  },
)
