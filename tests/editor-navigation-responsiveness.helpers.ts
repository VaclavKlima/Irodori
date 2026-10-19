import type { Page } from '@playwright/test'
import type { AdjustmentParameters } from '../src/shared/adjustments'

export interface NavigationTarget {
  id: string
  filename: string
  revision: number
  parameters: AdjustmentParameters
  sourceIdentity?: string
}

/** The capture-phase click starts the renderer clock before React's selection handler. */
export async function observePhotoActivation(page: Page) {
  return page.evaluateHandle(async () => {
    type Target = {
      id: string
      filename: string
      revision: number
      parameters: {
        exposureEv: number
        contrast: number
        highlights: number
        shadows: number
        whites: number
        blacks: number
        whiteBalance?: unknown
      }
      sourceIdentity?: string
    }
    type Snapshot = ReturnType<typeof snapshot>
    type Activation = {
      target: Target
      phase: string
      trigger: string
      startedAt: number
      firstUsefulAt: number | null
      firstUsefulMs: number | null
      nativeReadyAt: number | null
      nativeReadyMs: number | null
      firstUsefulKind: string | null
      supersededAt: number | null
      wrongVisiblePublications: number
      unattributedVisibleFrames: number
      correctVisibleButNotUsefulFrames: number
      loaderBlockedVisibleFrames: number
      pendingRequestVisibleFrames: number
      pendingTargetVisibleFrames: number
      frames: Snapshot[]
      firstUseful?: Snapshot
      nativeReady?: Snapshot
    }
    const activations: Activation[] = []
    const departures: {
      from: string | null
      to: string
      capturedAt: number
      observedAt?: number
      departure?: unknown
    }[] = []
    const departingCanvases = new Map<HTMLCanvasElement, (typeof departures)[number]>()
    const sampleDepartures = () => {
      for (const [canvas, record] of departingCanvases) {
        if (!canvas.dataset.presentationDeparture) continue
        record.observedAt = performance.now()
        record.departure = JSON.parse(canvas.dataset.presentationDeparture)
        departingCanvases.delete(canvas)
      }
    }
    let armed: { target: Target; phase: string; workspace: boolean } | null = null
    let active: Activation | null = null
    let stopped = false,
      raf = 0
    let authoritativeTargetGeneration = -1
    const acceptTarget = ({ generation }: { generation: number }) => {
      if (Number.isSafeInteger(generation) && generation >= authoritativeTargetGeneration)
        authoritativeTargetGeneration = generation
    }
    const stopTarget = window.luma.onDisplayState(acceptTarget)
    try {
      acceptTarget(await window.luma.getDisplayState())
    } catch (error) {
      stopTarget()
      throw error
    }
    const pending = new Set<string>()
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    function snapshot() {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')
      const visible =
        !!canvas &&
        getComputedStyle(canvas).visibility !== 'hidden' &&
        canvas.getBoundingClientRect().width > 0
      const parameters = canvas?.dataset.cachedParameters
        ? JSON.parse(canvas.dataset.cachedParameters)
        : null
      const nativeParameters = canvas
        ? {
            exposureEv: Number(canvas.dataset.exposure),
            contrast: Number(canvas.dataset.contrast),
            highlights: Number(canvas.dataset.highlights),
            shadows: Number(canvas.dataset.shadows),
            whites: Number(canvas.dataset.whites),
            blacks: Number(canvas.dataset.blacks),
            whiteBalance: canvas.dataset.whiteBalance
              ? JSON.parse(canvas.dataset.whiteBalance)
              : null,
          }
        : null
      return {
        at: performance.now(),
        filename: canvas?.getAttribute('aria-label') ?? null,
        visible,
        loader: !!Array.from(document.querySelectorAll('[role="status"] span')).find(
          (element) => element.textContent === 'Loading preview…',
        ),
        backend: canvas?.dataset.backend,
        quality: canvas?.dataset.quality,
        editing: canvas?.dataset.editing,
        cachedReady: canvas?.dataset.cachedDisplayReady === 'true',
        cacheState: canvas?.dataset.presentationCache,
        cacheEligible: canvas?.dataset.presentationCacheEligible,
        authoritativeTargetGeneration,
        targetGeneration: Number(canvas?.dataset.targetGeneration),
        cachedTargetGeneration: Number(canvas?.dataset.cachedTargetGeneration),
        cachedSource: canvas?.dataset.cachedSourceIdentity,
        cachedRevision: Number(canvas?.dataset.cachedSettingsRevision),
        cachedParameters: parameters,
        cachedPostPaintAt: Number(canvas?.dataset.cachedPostPaintAt),
        nativeSource: canvas?.dataset.presentedSourceIdentity,
        nativeRevision: Number(canvas?.dataset.presentedSettingsRevision),
        nativeEpoch: Number(canvas?.dataset.presentedEpoch),
        nativeParameters,
        completedSerial: canvas?.dataset.completedEditSerial,
        requestedSerial: canvas?.dataset.requestedSerial,
        nativeEditingReadyAt: Number(canvas?.dataset.nativeEditingReadyAt),
        allocatedBytes: Number(canvas?.dataset.allocatedBytes),
        retainedBytes: Number(canvas?.dataset.retainedPresentationBytes),
        sourceUploads: Number(canvas?.dataset.sourceUploads),
        resolution: viewport?.dataset.resolution,
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              bounds: canvas.getBoundingClientRect().toJSON(),
            }
          : null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      }
    }
    const sameParameters = (a: Snapshot['nativeParameters'], b: Target['parameters']) =>
      !!a &&
      ['exposureEv', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'].every(
        (key) =>
          a[key as keyof Omit<Target['parameters'], 'whiteBalance'>] ===
          b[key as keyof Omit<Target['parameters'], 'whiteBalance'>],
      ) &&
      JSON.stringify(a.whiteBalance ?? { mode: 'as-shot' }) ===
        JSON.stringify(b.whiteBalance ?? { mode: 'as-shot' })
    const sourceMatches = (source: string | undefined, target: Target) =>
      !!source?.startsWith(`luma-photo://library/${target.id}/`) &&
      (!target.sourceIdentity || source === target.sourceIdentity)
    const classify = (value: Snapshot, target: Target) => {
      if (!value.visible || value.loader || value.filename !== target.filename) return null
      if (value.authoritativeTargetGeneration < 0) return null
      if (
        value.cachedReady &&
        value.cachedRevision === target.revision &&
        value.cachedTargetGeneration === value.authoritativeTargetGeneration &&
        sourceMatches(value.cachedSource, target) &&
        sameParameters(value.cachedParameters, target.parameters)
      )
        return 'cached-exact'
      if (
        value.editing === 'ready' &&
        value.quality === 'normal' &&
        value.completedSerial === value.requestedSerial &&
        value.nativeRevision === target.revision &&
        value.targetGeneration === value.authoritativeTargetGeneration &&
        sourceMatches(value.nativeSource, target) &&
        sameParameters(value.nativeParameters, target.parameters)
      )
        return 'native-normal'
      return null
    }
    const wrongIdentity = (value: Snapshot, target: Target) => {
      if (value.filename !== target.filename) return true
      if (value.cachedReady)
        return (
          value.cachedRevision !== target.revision ||
          !sourceMatches(value.cachedSource, target) ||
          !sameParameters(value.cachedParameters, target.parameters)
        )
      return (
        value.nativeRevision !== target.revision ||
        !sourceMatches(value.nativeSource, target) ||
        !sameParameters(value.nativeParameters, target.parameters)
      )
    }
    const observe = () => {
      if (stopped) return
      sampleDepartures()
      const sample = active
      if (sample) {
        const value = snapshot()
        sample.frames.push(value)
        const card = document.getElementById(`editor-photo-${sample.target.id}`)
        const selected = card?.getAttribute('aria-current') === 'true'
        const kind = classify(value, sample.target)
        if (value.visible && selected && (value.cachedReady || value.editing === 'ready')) {
          if (wrongIdentity(value, sample.target)) sample.wrongVisiblePublications++
          else if (!kind) {
            sample.correctVisibleButNotUsefulFrames++
            if (value.loader) sample.loaderBlockedVisibleFrames++
            if (!value.cachedReady && value.completedSerial !== value.requestedSerial)
              sample.pendingRequestVisibleFrames++
            if (
              (value.cachedReady ? value.cachedTargetGeneration : value.targetGeneration) !==
              value.authoritativeTargetGeneration
            )
              sample.pendingTargetVisibleFrames++
          }
        }
        if (value.visible && selected && !value.cachedReady && value.editing !== 'ready')
          sample.unattributedVisibleFrames++
        const candidate = (type: 'useful' | 'native') => {
          const key = `${activations.length}:${type}`
          if (pending.has(key)) return
          pending.add(key)
          void (async () => {
            // A conservative post-paint observation, without another shared queue fence.
            await frame()
            await frame()
            if (active !== sample || stopped) return
            const presented = snapshot(),
              currentKind = classify(presented, sample.target)
            if (!currentKind || (type === 'native' && currentKind !== 'native-normal')) {
              pending.delete(key)
              return
            }
            if (type === 'useful' && sample.firstUsefulAt === null) {
              sample.firstUsefulAt = presented.at
              sample.firstUsefulMs = presented.at - sample.startedAt
              sample.firstUsefulKind = currentKind
              sample.firstUseful = presented
            }
            if (type === 'native' && sample.nativeReadyAt === null) {
              sample.nativeReadyAt = presented.at
              sample.nativeReadyMs = presented.at - sample.startedAt
              sample.nativeReady = presented
            }
          })()
        }
        if (kind && sample.firstUsefulAt === null) candidate('useful')
        if (kind === 'native-normal' && sample.nativeReadyAt === null) candidate('native')
      }
      raf = requestAnimationFrame(observe)
    }
    const click = (event: MouseEvent) => {
      if (!armed) return
      const button = (event.target as Element | null)?.closest('button')
      if (
        !button ||
        (armed.workspace
          ? button.textContent?.trim() !== 'Editor'
          : button.id !== `editor-photo-${armed.target.id}`)
      )
        return
      const at = performance.now()
      const departing = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
      if (
        departing &&
        departing.getAttribute('aria-label') !== armed.target.filename &&
        !departingCanvases.has(departing)
      ) {
        const record = {
          from: departing.getAttribute('aria-label'),
          to: armed.target.filename,
          capturedAt: at,
        }
        departures.push(record)
        departingCanvases.set(departing, record)
      }
      if (active) active.supersededAt = at
      active = {
        target: structuredClone(armed.target),
        phase: armed.phase,
        trigger: armed.workspace ? 'native-editor-workspace-click' : 'native-photo-button-click',
        startedAt: at,
        firstUsefulAt: null,
        firstUsefulMs: null,
        nativeReadyAt: null,
        nativeReadyMs: null,
        firstUsefulKind: null,
        supersededAt: null,
        wrongVisiblePublications: 0,
        unattributedVisibleFrames: 0,
        correctVisibleButNotUsefulFrames: 0,
        loaderBlockedVisibleFrames: 0,
        pendingRequestVisibleFrames: 0,
        pendingTargetVisibleFrames: 0,
        frames: [],
      }
      activations.push(active)
      armed = null
    }
    document.addEventListener('click', click, true)
    raf = requestAnimationFrame(observe)
    return {
      arm: (target: Target, phase: string, workspace = false) => {
        armed = { target, phase, workspace }
      },
      read: () => {
        sampleDepartures()
        return structuredClone({
          activations,
          current: active,
          departures,
          epochMs: performance.timeOrigin,
          observedAt: performance.now(),
        })
      },
      close: () => {
        sampleDepartures()
        stopped = true
        cancelAnimationFrame(raf)
        document.removeEventListener('click', click, true)
        stopTarget()
        departingCanvases.clear()
      },
    }
  })
}
