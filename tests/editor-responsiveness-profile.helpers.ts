import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import { sustainedEditorInput } from './mac-workability.helpers'
import { selectInteractivePreviewPolicy } from '../src/shared/interactive-preview-policy'
import { editorTestPreviewPolicy } from './hdr-test-policy.helpers'

export const editorDisplayPreference = process.env.LUMA_RESPONSIVENESS_DISPLAY ?? 'auto'
if (editorDisplayPreference !== 'auto' && editorDisplayPreference !== 'sdr')
  throw new Error('LUMA_RESPONSIVENESS_DISPLAY must be auto or sdr.')

export const editorDisplayProfile = process.env.LUMA_RESPONSIVENESS_PROFILE ?? 'mac-retina-dpr2'
if (!['mac-retina-dpr2', 'linux-native-dpr1'].includes(editorDisplayProfile))
  throw new Error('LUMA_RESPONSIVENESS_PROFILE must be mac-retina-dpr2 or linux-native-dpr1.')
export const editorExpectedDpr = editorDisplayProfile === 'linux-native-dpr1' ? 1 : 2
export const editorRequestedTileBatch = editorTestPreviewPolicy.tileBatch
export const editorRequestedInteractiveFence = editorTestPreviewPolicy.interactiveFence

export async function editorPhysicalDisplay(app: ElectronApplication, page: Page) {
  const nativeWindow = await app.browserWindow(page)
  const bounds = await nativeWindow.evaluate((window) => window.getBounds())
  const estimate = await app.evaluate(({ screen, app }, bounds) => {
    const display = screen.getDisplayMatching(bounds)
    return {
      platform: process.platform,
      id: display.id,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      displayFrequency: display.displayFrequency,
      colorSpace: display.colorSpace,
      internal: display.internal,
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      waylandDisplayAvailable: !!process.env.WAYLAND_DISPLAY,
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform'),
    }
  }, bounds)
  const renderer = await page.evaluate(async () => {
    const before = await window.luma.getDisplayState()
    let permission: PermissionState | 'unavailable' = 'unavailable'
    let currentScreen: {
      label: string | null
      left: number | null
      top: number | null
      width: number
      height: number
      scale: number | null
      hdrHeadroom: number | null
    } | null = null
    let screenDetailsStatus = 'unavailable'
    let screenDetailsError: string | null = null
    if (window.getScreenDetails) {
      try {
        permission = (
          await navigator.permissions.query({ name: 'window-management' as PermissionName })
        ).state
      } catch {
        // Older permission implementations may still expose an already granted display API.
      }
      if (
        permission === 'granted' ||
        (permission === 'unavailable' && before.capabilities?.permission === 'granted')
      ) {
        try {
          const screen = (await window.getScreenDetails()).currentScreen
          currentScreen = {
            label: screen.label ?? null,
            left: screen.left ?? null,
            top: screen.top ?? null,
            width: screen.width,
            height: screen.height,
            scale: screen.devicePixelRatio ?? null,
            hdrHeadroom: screen.hdrHeadroom ?? null,
          }
          screenDetailsStatus = 'available'
        } catch (error) {
          screenDetailsStatus = 'failed'
          screenDetailsError = String(error)
        }
      } else screenDetailsStatus = `permission-${permission}`
    }
    const target = await window.luma.getDisplayState()
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
    return {
      currentScreen,
      screenDetailsStatus,
      screenDetailsError,
      permission,
      target,
      observedGenerationBefore: before.generation,
      completedTargetGeneration: Number(canvas?.dataset.targetGeneration),
    }
  })
  const monitor = renderer.target.capabilities?.monitor ?? null
  const currentScreenMatchesConfirmedMonitor =
    monitor && renderer.currentScreen
      ? monitor.left === renderer.currentScreen.left &&
        monitor.top === renderer.currentScreen.top &&
        monitor.width === renderer.currentScreen.width &&
        monitor.height === renderer.currentScreen.height &&
        monitor.scale === renderer.currentScreen.scale
      : null
  const confirmedMonitorReliable =
    !!monitor &&
    [monitor.left, monitor.top, monitor.width, monitor.height, monitor.scale].every(
      Number.isFinite,
    ) &&
    monitor.width > 0 &&
    monitor.height > 0 &&
    monitor.scale > 0 &&
    renderer.target.capabilities?.permission === 'granted' &&
    (renderer.permission === 'granted' || renderer.permission === 'unavailable') &&
    renderer.screenDetailsStatus !== 'failed' &&
    renderer.observedGenerationBefore === renderer.target.generation &&
    renderer.target.presentation?.stage === 'presented' &&
    renderer.target.presentation.targetGeneration === renderer.target.generation &&
    renderer.completedTargetGeneration === renderer.target.generation &&
    currentScreenMatchesConfirmedMonitor !== false
  const wayland =
    estimate.platform === 'linux' &&
    (estimate.ozonePlatform === 'wayland' ||
      (estimate.ozonePlatform !== 'x11' &&
        (estimate.sessionType === 'wayland' || estimate.waylandDisplayAvailable)))
  const boundsEstimateMatchesConfirmedMonitor = monitor
    ? estimate.bounds.x === monitor.left &&
      estimate.bounds.y === monitor.top &&
      estimate.bounds.width === monitor.width &&
      estimate.bounds.height === monitor.height &&
      estimate.scaleFactor === monitor.scale
    : null
  return {
    // Preserve existing fields as the Electron bounds-based estimate for older consumers.
    ...estimate,
    attributionVersion: 'renderer-current-display-v1',
    boundsEstimateAttribution: {
      source: 'Electron screen.getDisplayMatching(BrowserWindow.getBounds())',
      reliability: wayland ? 'unreliable-wayland-window-position' : 'bounds-based-estimate',
      reason: wayland
        ? 'Wayland window bounds can omit the compositor global position; this estimate cannot identify the physical output.'
        : 'A window-bounds association is retained separately from renderer current-screen evidence.',
      matchesConfirmedRendererMonitor: boundsEstimateMatchesConfirmedMonitor,
      reportedRefreshKnown: estimate.displayFrequency > 0,
    },
    rendererCurrentScreen: {
      source: 'window.getScreenDetails().currentScreen',
      screen: renderer.currentScreen,
      status: renderer.screenDetailsStatus,
      permission: renderer.permission,
      error: renderer.screenDetailsError,
      matchesConfirmedMonitor: currentScreenMatchesConfirmedMonitor,
    },
    confirmedRendererMonitor: {
      source: 'window.luma.getDisplayState().capabilities.monitor',
      monitor,
      reliable: confirmedMonitorReliable,
      generation: renderer.target.generation,
      observedGenerationBefore: renderer.observedGenerationBefore,
      completedTargetGeneration: renderer.completedTargetGeneration,
      presentationTargetGeneration: renderer.target.presentation?.targetGeneration ?? null,
      presentationStage: renderer.target.presentation?.stage ?? null,
      permission: renderer.target.capabilities?.permission ?? null,
    },
    profileDisplaySource: confirmedMonitorReliable ? 'confirmed-renderer-monitor' : null,
    physicalRefreshBoundary:
      'Native rAF cadence is measured in each trial. Electron displayFrequency may be unknown; host compositor mode evidence is separate.',
  }
}

/** Confirm the completed canvas, rather than just the preference-setting IPC reply. */
export async function confirmEditorDisplay(page: Page, selectPreference = false) {
  if (selectPreference && editorDisplayPreference === 'sdr')
    await page.evaluate(() => window.luma.setPreviewPreference('sdr'))
  await expect
    .poll(
      () =>
        page.evaluate(async (preference) => {
          const target = await window.luma.getDisplayState()
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
          const configuration = canvas?.getContext('webgpu')?.getConfiguration()
          return (
            target.capabilities?.hardware === true &&
            (preference !== 'sdr' ||
              (target.requested === 'sdr' && target.mode === 'sdr' && target.peak === 1)) &&
            target.presentation?.stage === 'presented' &&
            target.presentation.backend === 'webgpu-hdr' &&
            target.presentation.mode === target.mode &&
            target.presentation.targetGeneration === target.generation &&
            Number(canvas?.dataset.targetGeneration) === target.generation &&
            canvas?.dataset.quality === 'normal' &&
            canvas.dataset.presentedPolicy === 'reference' &&
            canvas.dataset.presentedArithmeticPolicy === 'reference' &&
            canvas.dataset.rangeArithmeticPolicy ===
              (target.mode === 'sdr' && canvas.dataset.hdrRanges === 'true' ? 'reference' : '') &&
            canvas.dataset.editing === 'ready' &&
            configuration?.format === 'rgba16float' &&
            configuration.colorSpace === target.colorSpace &&
            configuration.toneMapping?.mode === (target.mode === 'sdr' ? 'standard' : 'extended')
          )
        }, editorDisplayPreference),
      {
        timeout: 60000,
        message: 'A completed hardware frame must match the confirmed display target.',
      },
    )
    .toBe(true)
  const completed = await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const configuration = canvas.getContext('webgpu')!.getConfiguration()!
    return {
      target: await window.luma.getDisplayState(),
      completedTargetGeneration: Number(canvas.dataset.targetGeneration),
      presentedArithmeticPolicy: canvas.dataset.presentedArithmeticPolicy,
      rangeArithmeticPolicy: canvas.dataset.rangeArithmeticPolicy,
      tileBatch: Number(canvas.dataset.tileBatch),
      interactiveFence: canvas.dataset.interactiveFence,
      configuration: {
        format: configuration.format,
        colorSpace: configuration.colorSpace,
        toneMapping: configuration.toneMapping,
      },
    }
  })
  expect(
    completed.tileBatch,
    'The compiled tile batch must match the ordinary platform policy.',
  ).toBe(editorRequestedTileBatch)
  expect(
    completed.interactiveFence,
    'The compiled interactive fence must match the ordinary platform policy.',
  ).toBe(editorRequestedInteractiveFence)
  return {
    ...completed,
    requestedTileBatch: editorRequestedTileBatch,
    requestedInteractiveFence: editorRequestedInteractiveFence,
  }
}

/** Keep every observed completed generation and every authoritative target change. */
export async function matchedEditorInput(
  page: Page,
  options: Parameters<typeof sustainedEditorInput>[1],
) {
  await confirmEditorDisplay(page)
  const observer = await page.evaluateHandle(async (requestedInteractiveFence) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const initialTarget = await window.luma.getDisplayState()
    const attentionState = () => ({
      epochMs: Date.now(),
      at: performance.now(),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    })
    const attentionStart = attentionState()
    let attentionEnd: ReturnType<typeof attentionState> | undefined
    const attentionEvents: (ReturnType<typeof attentionState> & {
      type: 'focus' | 'blur' | 'visibilitychange'
    })[] = []
    let droppedAttentionEvents = 0
    const recordAttention = (type: 'focus' | 'blur' | 'visibilitychange') => {
      if (attentionEvents.length === 256) {
        attentionEvents.shift()
        droppedAttentionEvents++
      }
      attentionEvents.push({ type, ...attentionState() })
    }
    const focused = () => recordAttention('focus')
    const blurred = () => recordAttention('blur')
    const visibilityChanged = () => recordAttention('visibilitychange')
    window.addEventListener('focus', focused)
    window.addEventListener('blur', blurred)
    document.addEventListener('visibilitychange', visibilityChanged)
    let target = initialTarget
    const targets = [{ at: performance.now(), target }]
    const stopTarget = window.luma.onDisplayState((next) => {
      target = next
      if (next.generation !== targets.at(-1)!.target.generation)
        targets.push({ at: performance.now(), target: next })
    })
    const publications: {
      at: number
      presentationSerial: number
      editSerial: number
      epoch: number
      sourceIdentity: string | undefined
      targetGeneration: number
      authoritativeTargetGeneration: number
      mode: 'sdr' | 'hdr'
      colorSpace: string
      peak: number
      presentedPolicy: string | undefined
      presentedArithmeticPolicy: string | undefined
      rangeArithmeticPolicy: string | undefined
      hdrRanges: boolean
      quality: string | undefined
      requestedInteractiveFence: string
      interactiveFence: string | undefined
    }[] = []
    let last = canvas.dataset.presentationSerial
    const mutations = new MutationObserver(() => {
      if (canvas.dataset.presentationSerial === last) return
      last = canvas.dataset.presentationSerial
      publications.push({
        at: performance.now(),
        presentationSerial: Number(last),
        editSerial: Number(canvas.dataset.completedEditSerial),
        epoch: Number(canvas.dataset.presentedEpoch),
        sourceIdentity: canvas.dataset.presentedSourceIdentity,
        targetGeneration: Number(canvas.dataset.targetGeneration),
        authoritativeTargetGeneration: target.generation,
        mode: target.mode,
        colorSpace: target.colorSpace,
        peak: target.peak,
        presentedPolicy: canvas.dataset.presentedPolicy,
        presentedArithmeticPolicy: canvas.dataset.presentedArithmeticPolicy,
        rangeArithmeticPolicy: canvas.dataset.rangeArithmeticPolicy,
        hdrRanges: canvas.dataset.hdrRanges === 'true',
        quality: canvas.dataset.quality,
        requestedInteractiveFence,
        interactiveFence: canvas.dataset.interactiveFence,
      })
    })
    mutations.observe(canvas, { attributes: true, attributeFilter: ['data-presentation-serial'] })
    return {
      stop() {
        if (!attentionEnd) {
          window.removeEventListener('focus', focused)
          window.removeEventListener('blur', blurred)
          document.removeEventListener('visibilitychange', visibilityChanged)
          mutations.disconnect()
          stopTarget()
          attentionEnd = attentionState()
        }
        return {
          initialTarget,
          finalTarget: target,
          targets,
          publications,
          rendererAttention: {
            clock: 'Date.now epoch milliseconds and renderer performance.now milliseconds',
            start: attentionStart,
            end: attentionEnd,
            events: attentionEvents.slice(),
            eventLimit: 256,
            retention: 'most recent events',
            droppedEvents: droppedAttentionEvents,
            observedEvents: attentionEvents.length + droppedAttentionEvents,
          },
        }
      },
    }
  }, editorRequestedInteractiveFence)
  try {
    const trial = await sustainedEditorInput(page, {
      ...options,
      pacing: options.pacing ?? (options.frequency === 120 ? 'timer-deadline-v1' : 'native-raf'),
    })
    const display = await observer.evaluate((observer) => observer.stop())
    const presentations = trial.presentations.map((frame) => {
      const publication = display.publications.find(
        (publication) =>
          publication.editSerial === frame.editSerial &&
          publication.epoch === frame.epoch &&
          publication.sourceIdentity === frame.sourceIdentity &&
          publication.presentedPolicy === frame.presentedPolicy,
      )
      return {
        ...frame,
        presentedArithmeticPolicy: publication?.presentedArithmeticPolicy,
        rangeArithmeticPolicy: publication?.rangeArithmeticPolicy,
        requestedInteractiveFence: editorRequestedInteractiveFence,
        interactiveFence: publication?.interactiveFence,
      }
    })
    const arithmeticPolicyMismatches = display.publications.filter((publication) => {
      const selector =
        publication.quality === 'interactive'
          ? editorTestPreviewPolicy.interactivePrecision
          : undefined
      return (
        publication.presentedArithmeticPolicy !==
          selectInteractivePreviewPolicy(selector, publication.mode) ||
        publication.rangeArithmeticPolicy !==
          (publication.mode === 'sdr' && publication.hdrRanges
            ? selectInteractivePreviewPolicy(selector, 'hdr')
            : '')
      )
    }).length
    const interactiveFence = await page
      .getByTestId('main-preview')
      .getAttribute('data-interactive-fence')
    const interactiveFenceMismatches = display.publications.filter(
      (publication) => publication.interactiveFence !== publication.requestedInteractiveFence,
    ).length
    expect
      .soft(interactiveFence, 'The interactive fence policy must remain unchanged.')
      .toBe(editorRequestedInteractiveFence)
    expect
      .soft(interactiveFenceMismatches, 'Every publication must retain the selected fence.')
      .toBe(0)
    const presentedTargetMatches =
      arithmeticPolicyMismatches === 0 &&
      interactiveFenceMismatches === 0 &&
      presentations.every((frame) =>
        display.publications.some(
          (publication) =>
            publication.editSerial === frame.editSerial &&
            publication.epoch === frame.epoch &&
            publication.sourceIdentity === frame.sourceIdentity &&
            publication.targetGeneration === publication.authoritativeTargetGeneration &&
            publication.targetGeneration === display.initialTarget.generation &&
            publication.presentedPolicy === frame.presentedPolicy &&
            publication.presentedArithmeticPolicy === frame.presentedArithmeticPolicy &&
            publication.rangeArithmeticPolicy === frame.rangeArithmeticPolicy &&
            publication.interactiveFence === frame.interactiveFence,
        ),
      )
    return {
      ...trial,
      presentations,
      display,
      presentedTargetMatches,
      arithmeticPolicyMismatches,
      requestedInteractiveFence: editorRequestedInteractiveFence,
      interactiveFence,
      interactiveFenceMismatches,
      requestedTileBatch: editorRequestedTileBatch,
      tileBatch: Number(await page.getByTestId('main-preview').getAttribute('data-tile-batch')),
    }
  } finally {
    try {
      await observer.evaluate((observer) => observer.stop()).catch(() => undefined)
    } finally {
      await observer.dispose()
    }
  }
}

export function editorConfigurationMatches(
  viewport: { dpr: number },
  display: Awaited<ReturnType<typeof editorPhysicalDisplay>>,
  trials: Awaited<ReturnType<typeof matchedEditorInput>>[],
) {
  return (
    viewport.dpr === editorExpectedDpr &&
    (editorDisplayProfile === 'linux-native-dpr1'
      ? display.platform === 'linux' &&
        display.confirmedRendererMonitor.reliable &&
        display.confirmedRendererMonitor.monitor?.scale === editorExpectedDpr &&
        trials.length > 0 &&
        trials.every(
          (trial) =>
            trial.display.initialTarget.capabilities?.monitor?.scale === editorExpectedDpr &&
            trial.pacing?.nativeRafAchievedHz !== null &&
            trial.pacing?.nativeRafAchievedHz !== undefined &&
            trial.pacing.nativeRafAchievedHz >= 59.4,
        )
      : display.scaleFactor === editorExpectedDpr)
  )
}

/** Title filtering mirrors Playwright; final executed statuses remain in its summary.json. */
export function editorCaseSelection(info: TestInfo, titles: string[], fullCaseCount: number) {
  const matches = (patterns: RegExp | RegExp[], value: string) =>
    (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) =>
      new RegExp(pattern.source, pattern.flags).test(value),
    )
  const selected = titles.filter((title) => {
    const fullTitle = [...info.titlePath.slice(0, -1), title, ...info.tags].join(' ')
    return (
      matches(info.project.grep, fullTitle) &&
      (!info.project.grepInvert || !matches(info.project.grepInvert, fullTitle))
    )
  })
  return {
    fullMatrixCaseCount: fullCaseCount,
    configuredCaseCount: titles.length,
    titleSelectedCaseCount: selected.length,
    titleSelectedExecutionCount: selected.length * info.project.repeatEach,
    selectedTitles: selected,
    grep: String(info.project.grep),
    grepInvert: String(info.project.grepInvert),
    repeatEach: info.project.repeatEach,
    shard: info.config.shard,
    caseCountBoundary:
      'This file after environment and title filters, before sharding, last-failed and line filters. The invocation summary.json contains actual executed statuses.',
    matrixPartial: titles.length !== fullCaseCount || selected.length !== fullCaseCount,
  }
}
