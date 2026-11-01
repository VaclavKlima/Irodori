import { realpath, writeFile } from 'node:fs/promises'
import type { JSHandle, Locator } from '@playwright/test'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { foregroundTest } from './foreground'
import { importPhotos } from './import.helpers'
import {
  captureNativeEditor,
  nativeEditorInput,
  nativeOriginalHash,
} from './professional-editor-native.helpers'

const retentionMs = 3300
const samplePeriodMs = 16
type PopupSample = {
  time: number
  open: boolean
  connected: boolean
  value: string
  documentFocus: boolean
  visibility: string
}
type PopupRead = {
  current: PopupSample
  started: number
  elapsed: number
  samples: PopupSample[]
  events: unknown[]
}
type PopupObserver = {
  read: () => PopupRead
  start: () => void
  end: () => PopupRead
  stop: () => PopupRead
}
const scenarios = [
  { id: 'mouse-choice', open: 'mouse', close: 'choice' },
  { id: 'keyboard-escape', open: 'keyboard', close: 'escape' },
  { id: 'mouse-outside', open: 'mouse', close: 'outside' },
] as const

for (const scenario of scenarios)
  test(
    `native Aspect ratio picker retains its open popup through three refresh periods: ${scenario.id}`,
    foregroundTest(
      'Native Wayland select-popup lifetime, owner activation and Electron input routing require an explicitly available foreground desktop.',
    ),
    async ({ irodori }, info) => {
      test.setTimeout(120000)
      const { app, page } = irodori
      test.skip(
        !(await app.evaluate(
          () =>
            process.platform === 'linux' &&
            Boolean(process.env.WAYLAND_DISPLAY) &&
            process.versions.electron === '44.3.0',
        )),
        'This regression exercises the pinned Electron 44.3.0 native Wayland refresh.',
      )
      let failed = false
      const captures: { name: string; path?: string; error?: string }[] = []
      const phases: unknown[] = []
      let inputEvidence: unknown
      let popupEvidence: unknown
      let nativeEvidence: unknown
      let observation: JSHandle<PopupObserver> | undefined

      const cleanupErrors: { operation: string; message: string }[] = []
      let originalFailure: string | undefined
      let inputCleanup: Awaited<ReturnType<typeof nativeEditorInput>> | undefined
      let stopNative: (() => Promise<void>) | undefined
      let disposeNative: (() => Promise<void>) | undefined
      let captureFailure: (() => Promise<void>) | undefined
      let profileVerified = false
      try {
        expect(await page.evaluate(() => CSS.supports('selector(select:open)'))).toBe(true)
        const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
        expect(await realpath(actualProfile)).toBe(await realpath(irodori.userDataDir))
        profileVerified = true
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
              // The compositor can deliver the initial 1440x900 configure after
              // a first resize. Recover only during setup, before input exists.
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
              phases.push({
                phase: 'startup-geometry',
                time: performance.now(),
                native: state,
                viewport,
              })
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
        const input = await nativeEditorInput(app, page, irodori.userDataDir)
        inputCleanup = input

        // The wrapper only observes real calls; it calls the original exactly once,
        // preserves its receiver/argument/return/throw, and never runs a timer itself.
        const nativeObservation = await native.evaluateHandle((window) => {
          const contents = window.webContents as Electron.WebContents & {
            setEmbedder: (embedder: Electron.WebContents) => void
          }
          const original = contents.setEmbedder
          if (typeof original !== 'function') throw new Error('Native refresh is unavailable.')
          let phase = 'setup'
          const events: {
            time: number
            phase: string
            type: string
            details?: unknown
            owner: boolean
            contents: boolean
          }[] = []
          let count = 0
          const record = (type: string, details?: unknown) => {
            events.push({
              time: performance.now(),
              phase,
              type,
              details,
              owner: !window.isDestroyed() && window.isFocused(),
              contents: !contents.isDestroyed() && contents.isFocused(),
            })
          }
          const wrapped = (embedder: Electron.WebContents) => {
            count++
            record('refresh-before', { count })
            try {
              return original.call(contents, embedder)
            } finally {
              record('refresh-after', { count })
            }
          }
          const blur = () => record('contents-blur')
          const ownerBlur = () => record('owner-blur')
          const keyboard = (_event: Electron.Event, value: Electron.Input) =>
            record('keyboard', {
              type: value.type,
              key: value.key,
              code: value.code,
              control: value.control,
              alt: value.alt,
              meta: value.meta,
              shift: value.shift,
            })
          const mouse = (_event: Electron.Event, value: Electron.MouseInputEvent) => {
            if (value.type !== 'mouseMove') record('mouse', value)
          }
          contents.setEmbedder = wrapped
          contents.on('blur', blur)
          contents.on('before-input-event', keyboard)
          contents.on('before-mouse-event', mouse)
          window.on('blur', ownerBlur)
          const read = () => ({
            count,
            events: structuredClone(events),
            unexpectedHoldInputs: events.filter(
              (event) =>
                event.phase === 'retention-no-input' &&
                (event.type === 'keyboard' || event.type === 'mouse'),
            ),
            ownerLosses: events.filter((event) => event.type === 'owner-blur'),
          })
          return {
            read,
            phase(value: string) {
              phase = value
              record('phase')
            },
            stop() {
              const preserved = contents.setEmbedder === wrapped
              if (preserved) contents.setEmbedder = original
              contents.off('blur', blur)
              contents.off('before-input-event', keyboard)
              contents.off('before-mouse-event', mouse)
              window.off('blur', ownerBlur)
              return { ...read(), originalWrapperStillOwned: preserved }
            },
          }
        })

        stopNative = async () => {
          const result = await nativeObservation.evaluate((observer) => observer.stop())
          nativeEvidence = result
          expect(
            result.originalWrapperStillOwned,
            'Native refresh observer ownership changed before cleanup.',
          ).toBe(true)
        }
        disposeNative = () => nativeObservation.dispose()

        async function ownerGuard(phase: string) {
          const state = await native.evaluate((window) => ({
            visible: window.isVisible(),
            owner: window.isFocused(),
            contents: window.webContents.isFocused(),
            minimized: window.isMinimized(),
            destroyed: window.isDestroyed() || window.webContents.isDestroyed(),
            contentSize: window.getContentSize(),
          }))
          phases.push({ phase, time: performance.now(), state })
          expect(
            state,
            `The isolated owner lost activation during ${phase}; stop sending input.`,
          ).toMatchObject({
            visible: true,
            owner: true,
            minimized: false,
            destroyed: false,
            contentSize: [1100, 700],
          })
          const evidence = await nativeObservation.evaluate((observer) => observer.read())
          expect(evidence.ownerLosses, `Owner activation changed during ${phase}.`).toEqual([])
          expect(
            evidence.unexpectedHoldInputs,
            `Unrequested native input interfered with the idle popup hold during ${phase}.`,
          ).toEqual([])
          // A native popup can own view focus. Record that state without requiring
          // the parent contents or document to be focused while its picker is open.
          return state
        }
        async function setPhase(phase: string) {
          await nativeObservation.evaluate((observer, phase) => observer.phase(phase), phase)
        }
        async function popupKeys(events: Electron.KeyboardInputEvent[], purpose: string) {
          await ownerGuard(`before ${purpose}`)
          await native.evaluate((window, events) => {
            if (!window.isVisible() || !window.isFocused() || window.isMinimized())
              throw new Error('The isolated owner lost activation before popup keyboard delivery.')
            for (const event of events) window.webContents.sendInputEvent(event)
          }, events)
          await ownerGuard(`after ${purpose}`)
        }
        const popupKey = (keyCode: string) =>
          popupKeys(
            [
              { type: 'keyDown', keyCode },
              ...(keyCode === 'Enter' ? [{ type: 'char' as const, keyCode: '\r' }] : []),
              { type: 'keyUp', keyCode },
            ],
            `native popup ${keyCode}`,
          )
        async function popupClick(locator: Locator, purpose: string) {
          await ownerGuard(`before ${purpose}`)
          const box = await locator.boundingBox()
          expect(box, `${purpose} needs an actual visible client rectangle.`).not.toBeNull()
          const point = {
            x: Math.round(box!.x + box!.width / 2),
            y: Math.round(box!.y + box!.height / 2),
          }
          expect(point.x).toBeGreaterThanOrEqual(0)
          expect(point.x).toBeLessThan(1100)
          expect(point.y).toBeGreaterThanOrEqual(0)
          expect(point.y).toBeLessThan(700)
          await native.evaluate((window, point) => {
            if (!window.isVisible() || !window.isFocused() || window.isMinimized())
              throw new Error('The isolated owner lost activation before popup pointer delivery.')
            window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
            window.webContents.sendInputEvent({
              type: 'mouseDown',
              button: 'left',
              clickCount: 1,
              ...point,
            })
            window.webContents.sendInputEvent({
              type: 'mouseUp',
              button: 'left',
              clickCount: 1,
              ...point,
            })
          }, point)
          await ownerGuard(`after ${purpose}`)
        }
        async function capture(name: string) {
          await ownerGuard(`before capture ${name}`)
          captures.push({ name, path: await captureNativeEditor(app, page, info, name) })
          await ownerGuard(`after capture ${name}`)
        }
        captureFailure = () => capture('native-dropdown-failure')
        const refreshCount = () => nativeObservation.evaluate((observer) => observer.read().count)

        const source = info.outputPath('generated-dropdown.png')
        await sharp({
          create: { width: 160, height: 100, channels: 3, background: { r: 73, g: 110, b: 152 } },
        })
          .png()
          .toFile(source)
        const sourceSha256 = await nativeOriginalHash(source)
        await input.activate(page.getByTestId('console-toggle'))
        await expect(page.getByTestId('console-panel')).toBeVisible()
        await importPhotos(app, page, [source], true, 'keyboard')
        await input.guard('generated input imported in the isolated minimum-size editor')
        const photos = await page.evaluate(() => window.irodori.listPhotos())
        expect(photos.total).toBe(1)
        expect(photos.photos[0].id).toBe(sourceSha256)
        const id = photos.photos[0].id
        const history = () => page.evaluate((id) => window.irodori.getEditHistory(id), id)
        const initialHistory = await history()
        const cropSection = page.getByRole('button', { name: 'Crop', exact: true })
        if ((await cropSection.getAttribute('aria-expanded')) !== 'true')
          await input.activate(cropSection)
        await input.activate(page.getByRole('button', { name: 'Crop and straighten', exact: true }))
        await expect(page.getByTestId('crop-overlay')).toBeVisible()
        const aspect = page.getByRole('combobox', { name: 'Aspect ratio', exact: true })
        await input.focus(aspect)
        await expect(aspect).toHaveValue('free')
        await expect
          .poll(refreshCount, { timeout: 7000, intervals: [50] })
          .toBeGreaterThanOrEqual(2)
        await input.guard('native refresh is alive before opening the picker')
        await capture('native-dropdown-before-open')
        observation = await aspect.evaluateHandle((element, period) => {
          const select = element as HTMLSelectElement
          const events: unknown[] = []
          let holding = false
          let started = 0
          const samples: {
            time: number
            open: boolean
            connected: boolean
            value: string
            documentFocus: boolean
            visibility: string
          }[] = []
          const sample = () => ({
            time: performance.now(),
            open: select.matches(':open'),
            connected: select.isConnected,
            value: select.value,
            documentFocus: document.hasFocus(),
            visibility: document.visibilityState,
          })
          const record = (event: Event) =>
            events.push({
              time: performance.now(),
              type: event.type,
              trusted: event.isTrusted,
              key: event instanceof KeyboardEvent ? event.key : undefined,
              open: select.matches(':open'),
              value: select.value,
            })
          const types = ['input', 'change', 'keydown', 'keyup', 'click', 'focus', 'blur']
          for (const type of types) select.addEventListener(type, record, true)
          const timer = setInterval(() => {
            if (holding) samples.push(sample())
          }, period)
          const read = () => ({
            current: sample(),
            started,
            elapsed: started ? performance.now() - started : 0,
            samples: structuredClone(samples),
            events: structuredClone(events),
          })
          return {
            read,
            start() {
              started = performance.now()
              holding = true
              samples.push(sample())
            },
            end() {
              samples.push(sample())
              holding = false
              return read()
            },
            stop() {
              clearInterval(timer)
              for (const type of types) select.removeEventListener(type, record, true)
              return read()
            },
          }
        }, samplePeriodMs)
        await setPhase(`open-${scenario.open}`)
        const beforeOpen = await refreshCount()
        if (scenario.open === 'mouse') await popupClick(aspect, 'native mouse open')
        else
          await popupKeys(
            [
              { type: 'keyDown', keyCode: 'Alt' },
              { type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] },
              { type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] },
              { type: 'keyUp', keyCode: 'Alt' },
            ],
            'native Alt+Down open',
          )
        await expect
          .poll(() => aspect.evaluate((select) => select.matches(':open')), {
            timeout: 1000,
            intervals: [10],
            message:
              'The native input route must open the actual picker; closed-select edits do not establish this precondition.',
          })
          .toBe(true)
        await observation.evaluate((observer) => observer.start())
        await setPhase('retention-no-input')
        await capture('native-dropdown-open')
        const started = performance.now()
        while (performance.now() - started < retentionMs) {
          await ownerGuard('native popup idle retention')
          const state = await observation.evaluate((observer) => observer.read())
          expect(
            state.current.open,
            'The real Aspect ratio picker closed without requested dismissal.',
          ).toBe(true)
          expect(
            state.samples.every((sample) => sample.open && sample.connected),
            'The native picker did not stay open continuously throughout the sampled idle interval.',
          ).toBe(true)
          await page.waitForTimeout(50)
        }
        const held = await observation.evaluate((observer) => observer.end())
        expect(held.elapsed).toBeGreaterThanOrEqual(retentionMs)
        expect(held.samples.length).toBeGreaterThan(20)
        expect(held.samples.every((sample) => sample.open && sample.connected)).toBe(true)
        expect(await history()).toEqual(initialHistory)
        phases.push({
          phase: 'retention-complete',
          nominalRefreshPeriodMs: 1000,
          beforeOpen,
          afterHold: await refreshCount(),
          hold: held,
        })
        await setPhase(`close-${scenario.close}`)
        if (scenario.close === 'choice') {
          for (const key of ['Home', 'Down', 'Down']) {
            await expect(aspect).toHaveJSProperty('disabled', false)
            expect(
              await aspect.evaluate((select) => select.matches(':open')),
              'Option navigation must target a still-open popup.',
            ).toBe(true)
            await popupKey(key)
            expect(
              await aspect.evaluate((select) => select.matches(':open')),
              'Electron keyboard routing closed the popup before the explicit option commit.',
            ).toBe(true)
          }
          await popupKey('Enter')
          await expect(aspect).toHaveValue('1:1')
        } else if (scenario.close === 'escape') {
          await popupKey('Escape')
          await expect(aspect).toHaveValue('free')
        } else {
          await popupClick(page.getByTestId('app-version'), 'native click outside the picker')
          await expect(aspect).toHaveValue('free')
        }
        await expect
          .poll(() => aspect.evaluate((select) => select.matches(':open')), {
            timeout: 1500,
            intervals: [20],
            message:
              'The declared native input route must close the real popup; no synthetic selection or DOM dismissal substitutes are allowed.',
          })
          .toBe(false)
        await expect(page.getByTestId('crop-overlay')).toBeVisible()
        await expect(page.getByTestId('console-panel')).toBeVisible()
        if (scenario.close === 'choice') {
          const chosen = await observation.evaluate((observer) => observer.read())
          for (const type of ['input', 'change'])
            expect(
              chosen.events.filter(
                (event) =>
                  typeof event === 'object' &&
                  event !== null &&
                  'type' in event &&
                  event.type === type &&
                  'trusted' in event &&
                  event.trusted === true &&
                  'value' in event &&
                  event.value === '1:1',
              ),
              `A real popup choice must emit one trusted ${type} event.`,
            ).toHaveLength(1)
        }
        const afterClose = await refreshCount()
        await setPhase('closed-refresh-resumption')
        await expect
          .poll(refreshCount, { timeout: 5000, intervals: [50] })
          .toBeGreaterThan(afterClose)
        await ownerGuard('refresh resumed after explicit popup closure')
        await input.guard('parent view focus after explicit popup closure and resumed refresh')
        expect(await history()).toEqual(initialHistory)
        await capture('native-dropdown-after-close')
        await info.attach('generated-dropdown-input', {
          body: JSON.stringify({
            generator: 'Sharp create 160x100 RGB(73,110,152) PNG; no photographic input',
            sourceSha256,
            scenario,
            initialHistory,
          }),
          contentType: 'application/json',
        })
        popupEvidence = await observation.evaluate((observer) => observer.read())
        await setPhase('crop-draft-cleanup')
        await input.activate(page.getByRole('button', { name: 'Cancel crop', exact: true }))
        await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
        expect(await history()).toEqual(initialHistory)
        phases.push({ phase: 'crop-draft-cancelled', time: performance.now() })
      } catch (error) {
        failed = true
        originalFailure = error instanceof Error ? (error.stack ?? error.message) : String(error)
        phases.push({ phase: 'failure', message: originalFailure })
        throw error
      } finally {
        async function drain(operation: string, cleanup: () => Promise<void>) {
          try {
            await cleanup()
          } catch (error) {
            cleanupErrors.push({ operation, message: String(error) })
          }
        }
        if (failed && captureFailure) await drain('failure capture', captureFailure)
        else if (failed)
          captures.push({
            name: 'native-dropdown-failure',
            error: 'Setup did not complete; no capture is available.',
          })
        if (observation) {
          await drain('popup observer stop', async () => {
            const stopped = await observation!.evaluate((observer) => observer.stop())
            popupEvidence ??= stopped
          })
          await drain('popup observer handle disposal', () => observation!.dispose())
        }
        if (stopNative) await drain('native observer stop', stopNative)
        if (disposeNative) await drain('native observer handle disposal', disposeNative)
        if (failed && profileVerified && inputCleanup && !page.isClosed())
          await drain('failed-test crop draft cancellation', async () => {
            const input = inputCleanup!
            await input.guard('before failed-test crop draft cancellation')
            const aspect = page.getByRole('combobox', { name: 'Aspect ratio', exact: true })
            const popupOpen = () =>
              aspect.evaluateAll((selects) => selects.some((select) => select.matches(':open')))
            if (await popupOpen()) {
              await input.key('Escape')
              await expect.poll(popupOpen, { timeout: 1500, intervals: [20] }).toBe(false)
            }
            if (await page.getByTestId('crop-overlay').count()) {
              await input.activate(page.getByRole('button', { name: 'Cancel crop', exact: true }))
              await expect(page.getByTestId('crop-overlay')).toHaveCount(0)
            }
            phases.push({ phase: 'failed-test crop draft cancelled', time: performance.now() })
          })
        if (inputCleanup)
          await drain('shared input observer stop', async () => {
            inputEvidence = await inputCleanup!.stop()
          })
        const receipt = () => ({
          status: failed ? 'failed' : cleanupErrors.length ? 'cleanup-failed' : 'completed',
          originalFailure,
          profileVerified,
          scenario,
          retentionMs,
          samplePeriodMs,
          phases,
          captures,
          popup: popupEvidence,
          native: nativeEvidence,
          input: inputEvidence,
          cleanupErrors,
          limitations: [
            'Input uses Electron sendInputEvent, not a physical keyboard or mouse.',
            'Popup option, Escape and outside-click delivery may require a separate native widget input route; failure must remain explicit.',
            'Native window captures are supporting evidence; CSS select:open samples establish the actual picker-open state.',
            'A 16 ms observer samples popup continuity; this does not prove unobservable intervals between samples.',
            'Setup, source generation, observer, capture or cleanup failures do not establish native popup acceptance.',
            'No monitor transition, physical HDR output, performance or macOS claim is made.',
          ],
        })
        let evidencePath: string | undefined
        let evidenceWritten = false
        await drain('evidence JSON write', async () => {
          evidencePath = info.outputPath('native-dropdown-evidence.json')
          await writeFile(evidencePath, JSON.stringify(receipt(), null, 2))
          evidenceWritten = true
        })
        await drain('evidence attachment', () =>
          info.attach(
            'native-dropdown-evidence',
            evidenceWritten
              ? { path: evidencePath!, contentType: 'application/json' }
              : { body: JSON.stringify(receipt(), null, 2), contentType: 'application/json' },
          ),
        )
      }
      // An original assertion/setup failure remains the thrown test error even
      // when cleanup also fails. Successful work cannot pass with failed cleanup.
      if (cleanupErrors.length)
        throw new Error(`Native dropdown cleanup/evidence failed: ${JSON.stringify(cleanupErrors)}`)
    },
  )
