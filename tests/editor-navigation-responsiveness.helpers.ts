import type { Page } from '@playwright/test'
import type { AdjustmentParameters } from '../src/shared/adjustments'
import type { DisplayTarget } from '../src/shared/hdr'
import type { HdrFirstSurfaceOffer } from '../src/shared/hdr-first-surface'
import type { ResourcePolicySnapshot } from '../src/shared/resource-policy'
import { HDR_PRESENTATION_CACHE_BUDGET } from '../src/renderer/src/preview/hdr-presentation-cache'

export const NAVIGATION_MEASUREMENT_VERSION = 'photo-activation-painted-first-surface-v4'

export interface NavigationTarget {
  id: string
  filename: string
  revision: number
  parameters: AdjustmentParameters
  sourceIdentity?: string
}

/** The capture-phase click starts the renderer clock before React's selection handler. */
export async function observePhotoActivation(page: Page) {
  return page.evaluateHandle(
    async ({
      expectedKernel,
      retainedCacheBudgetBytes,
    }: {
      expectedKernel: 'linear64'
      retainedCacheBudgetBytes: number
    }) => {
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
        pendingFirstSurfacePaintFrames: number
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
      let authoritativeTarget: DisplayTarget | null = null
      const acceptTarget = (target: DisplayTarget) => {
        if (
          Number.isSafeInteger(target.generation) &&
          target.generation >= (authoritativeTarget?.generation ?? -1)
        )
          authoritativeTarget = structuredClone(target)
      }
      // Existing public events provide the immutable source/display identity. Never fetch pixels.
      const firstOffers = new Map<string, HdrFirstSurfaceOffer>()
      let omittedFirstOffers = 0
      const stopFirstSurface = window.irodori.onHdrFirstSurface((offer) => {
        if (firstOffers.has(offer.surfaceId)) return
        firstOffers.set(offer.surfaceId, structuredClone(offer))
        if (firstOffers.size > 64) {
          firstOffers.delete(firstOffers.keys().next().value!)
          omittedFirstOffers++
        }
      })
      const stopTarget = window.irodori.onDisplayState(acceptTarget)
      try {
        acceptTarget(await window.irodori.getDisplayState())
      } catch (error) {
        stopTarget()
        stopFirstSurface()
        throw error
      }
      const pending = new Set<string>()
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const json = <T>(value: string | undefined): T | null => {
        try {
          return value ? (JSON.parse(value) as T) : null
        } catch {
          return null
        }
      }
      // Missing and empty diagnostics are missing evidence, including zero-like budgets.
      const numeric = (value: string | undefined) =>
        value === undefined || value.trim() === '' ? Number.NaN : Number(value)
      function snapshot() {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
        const viewport = document.querySelector<HTMLElement>('[data-testid="preview-viewport"]')
        const visible =
          !!canvas &&
          getComputedStyle(canvas).visibility !== 'hidden' &&
          canvas.getBoundingClientRect().width > 0
        const parameters = json<AdjustmentParameters>(canvas?.dataset.cachedParameters)
        const nativeParameters = canvas
          ? {
              exposureEv: numeric(canvas.dataset.exposure),
              contrast: numeric(canvas.dataset.contrast),
              highlights: numeric(canvas.dataset.highlights),
              shadows: numeric(canvas.dataset.shadows),
              whites: numeric(canvas.dataset.whites),
              blacks: numeric(canvas.dataset.blacks),
              whiteBalance: json<unknown>(canvas.dataset.whiteBalance),
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
          previewRequestId: canvas?.dataset.previewRequestId,
          sourceOwnerWaitStartedAt: numeric(canvas?.dataset.sourceOwnerWaitStartedAt),
          sourceOwnerWaitFinishedAt: numeric(canvas?.dataset.sourceOwnerWaitFinishedAt),
          sourceAdmissionFinishedAt: numeric(canvas?.dataset.sourceAdmissionFinishedAt),
          sourceRequestStartedAt: numeric(canvas?.dataset.sourceRequestStartedAt),
          editingEpoch: numeric(canvas?.dataset.editingEpoch),
          firstSurfacePhase: canvas?.dataset.firstSurface,
          firstSurfaceReady: canvas?.dataset.firstSurfaceReady === 'true',
          firstSurfacePainted: canvas?.dataset.firstSurfacePainted === 'true',
          firstSurfaceId: canvas?.dataset.firstSurfaceId,
          firstSurfaceSha256: canvas?.dataset.firstSurfaceSha256,
          firstSurfaceParentWorkingKey: canvas?.dataset.firstSurfaceParentWorkingKey,
          firstSurfaceFencedAt: numeric(canvas?.dataset.firstSurfaceFencedAt),
          firstSurfacePostPaintAt: numeric(canvas?.dataset.firstSurfacePostPaintAt),
          firstSurfaceTimings: json<Record<string, number | string>>(
            canvas?.dataset.firstSurfaceTimings,
          ),
          firstSurfaceMemory: json<{
            ramBytes: number
            vramBytes: number
            limits: { ramBytes: number; vramBytes: number; revision: number }
          }>(canvas?.dataset.firstSurfaceMemory),
          resourcePolicy: json<ResourcePolicySnapshot>(canvas?.dataset.resourcePolicy),
          cacheState: canvas?.dataset.presentationCache,
          cacheEligible: canvas?.dataset.presentationCacheEligible,
          authoritativeTarget: structuredClone(authoritativeTarget),
          authoritativeTargetGeneration: authoritativeTarget?.generation ?? -1,
          targetGeneration: numeric(canvas?.dataset.targetGeneration),
          cachedTargetGeneration: numeric(canvas?.dataset.cachedTargetGeneration),
          cachedSource: canvas?.dataset.cachedSourceIdentity,
          cachedRevision: numeric(canvas?.dataset.cachedSettingsRevision),
          cachedParameters: parameters,
          cachedFencedAt: numeric(canvas?.dataset.cachedFencedAt),
          cachedPostPaintAt: numeric(canvas?.dataset.cachedPostPaintAt),
          nativeSource: canvas?.dataset.presentedSourceIdentity,
          nativeRevision: numeric(canvas?.dataset.presentedSettingsRevision),
          nativeEpoch: numeric(canvas?.dataset.presentedEpoch),
          nativeParameters,
          nativeWhiteBalanceDeclared:
            !!canvas?.dataset.whiteBalance && json<unknown>(canvas.dataset.whiteBalance) !== null,
          completedSerial: canvas?.dataset.completedEditSerial,
          requestedSerial: canvas?.dataset.requestedSerial,
          nativeEditingReadyAt: numeric(canvas?.dataset.nativeEditingReadyAt),
          normalCanvasWriteStartedAt: numeric(canvas?.dataset.normalCanvasWriteStartedAt),
          normalCanvasSubmittedAt: numeric(canvas?.dataset.normalCanvasSubmittedAt),
          normalCanvasSubmittedSerial: numeric(canvas?.dataset.normalCanvasSubmittedSerial),
          normalCanvasSubmittedEpoch: numeric(canvas?.dataset.normalCanvasSubmittedEpoch),
          allocatedBytes: numeric(canvas?.dataset.allocatedBytes),
          allocatedRamBytes: numeric(canvas?.dataset.allocatedRamBytes),
          allocatedGpuBytes: numeric(canvas?.dataset.allocatedGpuBytes),
          ramBudgetBytes: numeric(canvas?.dataset.ramBudgetBytes),
          vramBudgetBytes: numeric(canvas?.dataset.vramBudgetBytes),
          resourcePolicyRevision: numeric(canvas?.dataset.resourcePolicyRevision),
          retainedBytes: numeric(canvas?.dataset.retainedPresentationBytes),
          sourceUploads: numeric(canvas?.dataset.sourceUploads),
          resolution: viewport?.dataset.resolution,
          previewViewport: viewport
            ? {
                width: viewport.getBoundingClientRect().width,
                height: viewport.getBoundingClientRect().height,
                imageWidth: numeric(viewport.dataset.imageWidth),
                imageHeight: numeric(viewport.dataset.imageHeight),
                fit: viewport.dataset.mode === 'fit',
                scale: numeric(viewport.dataset.scale),
                x: numeric(viewport.dataset.panX),
                y: numeric(viewport.dataset.panY),
                dragging: viewport.dataset.dragging === 'true',
              }
            : null,
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
      const sameParameters = (a: Target['parameters'] | null, b: Target['parameters']) =>
        !!a &&
        ['exposureEv', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'].every(
          (key) =>
            a[key as keyof Omit<Target['parameters'], 'whiteBalance'>] ===
            b[key as keyof Omit<Target['parameters'], 'whiteBalance'>],
        ) &&
        JSON.stringify(a.whiteBalance ?? { mode: 'as-shot' }) ===
          JSON.stringify(b.whiteBalance ?? { mode: 'as-shot' })
      const sourceMatches = (source: string | undefined, target: Target) =>
        !!source?.startsWith(`irodori-photo://library/${target.id}/`) &&
        (!target.sourceIdentity || source === target.sourceIdentity)
      const nativeWitnessValid = (value: Snapshot) => {
        const policy = value.resourcePolicy
        return (
          [
            value.allocatedBytes,
            value.allocatedRamBytes,
            value.allocatedGpuBytes,
            value.ramBudgetBytes,
            value.vramBudgetBytes,
          ].every((bytes) => Number.isSafeInteger(bytes) && bytes > 0) &&
          value.allocatedRamBytes <= value.ramBudgetBytes &&
          value.allocatedGpuBytes <= value.vramBudgetBytes &&
          value.allocatedBytes === value.allocatedRamBytes + value.allocatedGpuBytes &&
          Number.isSafeInteger(value.resourcePolicyRevision) &&
          value.resourcePolicyRevision >= 0 &&
          !!policy &&
          policy.version === 'managed-image-memory-v1' &&
          policy.scope === 'managed-image-resources' &&
          policy.revision === value.resourcePolicyRevision &&
          policy.ram?.effectiveBytes === value.ramBudgetBytes &&
          policy.vram?.effectiveBytes === value.vramBudgetBytes &&
          Number.isSafeInteger(value.retainedBytes) &&
          value.retainedBytes >= 0 &&
          value.retainedBytes <= retainedCacheBudgetBytes &&
          Number.isSafeInteger(value.sourceUploads) &&
          value.sourceUploads >= 0 &&
          Number.isSafeInteger(value.nativeEpoch) &&
          value.nativeEpoch >= 0 &&
          value.nativeWhiteBalanceDeclared &&
          Number.isSafeInteger(numeric(value.completedSerial)) &&
          numeric(value.completedSerial) > 0 &&
          Number.isSafeInteger(numeric(value.requestedSerial)) &&
          numeric(value.requestedSerial) > 0 &&
          Number.isFinite(value.nativeEditingReadyAt) &&
          value.nativeEditingReadyAt > 0 &&
          value.nativeEditingReadyAt <= value.at
        )
      }
      const firstIdentityMatches = (value: Snapshot, target: Target) => {
        const offer = firstOffers.get(value.firstSurfaceId ?? ''),
          view = value.previewViewport,
          memory = value.firstSurfaceMemory,
          currentTarget = value.authoritativeTarget
        if (!offer || !view || !value.canvas || !memory || !currentTarget) return false
        const identity = offer.identity,
          policy = offer.policy,
          targetFields = [
            'outputVersion',
            'generation',
            'mode',
            'colorSpace',
            'peak',
            'headroom',
          ] as const
        return (
          offer.photoId === target.id &&
          identity.originalSha256 === target.id &&
          offer.requestId === value.previewRequestId &&
          identity.generation === value.editingEpoch + 1 &&
          offer.sha256 === value.firstSurfaceSha256 &&
          /^[a-f0-9]{64}$/.test(offer.sha256) &&
          identity.parentWorkingKey === value.firstSurfaceParentWorkingKey &&
          /^[a-f0-9]{64}$/.test(identity.parentWorkingKey) &&
          identity.settingsRevision === target.revision &&
          sameParameters(identity.parameters, target.parameters) &&
          targetFields.every((field) => identity.target[field] === currentTarget[field]) &&
          identity.viewport.width === view.width &&
          identity.viewport.height === view.height &&
          identity.dpr === value.viewport.dpr &&
          identity.image.width === view.imageWidth &&
          identity.image.height === view.imageHeight &&
          identity.view.fit &&
          view.fit &&
          !view.dragging &&
          identity.view.x === 0 &&
          identity.view.y === 0 &&
          view.x === 0 &&
          view.y === 0 &&
          identity.view.scale === view.scale &&
          identity.view.scale ===
            Math.min(1, view.width / identity.image.width, view.height / identity.image.height) &&
          identity.comparison === 'after' &&
          identity.split === 0.5 &&
          !identity.hdrRanges &&
          identity.kernel === expectedKernel &&
          offer.format === 'rgba16float-le' &&
          offer.width === Math.round(view.width * identity.dpr) &&
          offer.height === Math.round(view.height * identity.dpr) &&
          value.canvas.width === offer.width &&
          value.canvas.height === offer.height &&
          value.canvas.bounds.width === view.width &&
          value.canvas.bounds.height === view.height &&
          offer.byteLength === offer.width * offer.height * 8 &&
          policy.scope === 'managed-image-resources' &&
          JSON.stringify(value.resourcePolicy) === JSON.stringify(policy) &&
          Number.isSafeInteger(policy.revision) &&
          policy.revision >= 0 &&
          memory.limits.revision === policy.revision &&
          memory.limits.ramBytes === policy.ram.effectiveBytes &&
          memory.limits.vramBytes === policy.vram.effectiveBytes &&
          Number.isSafeInteger(memory.ramBytes) &&
          memory.ramBytes > 0 &&
          Number.isSafeInteger(memory.vramBytes) &&
          memory.vramBytes > 0 &&
          memory.ramBytes <= memory.limits.ramBytes &&
          memory.vramBytes <= memory.limits.vramBytes
        )
      }
      const nativeReady = (value: Snapshot, target: Target) =>
        value.visible &&
        !value.loader &&
        value.filename === target.filename &&
        value.authoritativeTargetGeneration >= 0 &&
        value.editing === 'ready' &&
        value.quality === 'normal' &&
        nativeWitnessValid(value) &&
        value.completedSerial === value.requestedSerial &&
        value.nativeRevision === target.revision &&
        value.targetGeneration === value.authoritativeTargetGeneration &&
        sourceMatches(value.nativeSource, target) &&
        sameParameters(value.nativeParameters, target.parameters)
      const nativeReceipt = (value: Snapshot) =>
        JSON.stringify([
          value.previewRequestId,
          value.nativeSource,
          value.nativeRevision,
          value.nativeEpoch,
          value.editingEpoch,
          value.completedSerial,
          value.requestedSerial,
          value.nativeEditingReadyAt,
          value.nativeParameters,
          value.targetGeneration,
          value.authoritativeTarget && [
            value.authoritativeTarget.outputVersion,
            value.authoritativeTarget.generation,
            value.authoritativeTarget.mode,
            value.authoritativeTarget.colorSpace,
            value.authoritativeTarget.peak,
            value.authoritativeTarget.headroom,
          ],
          value.previewViewport,
          value.canvas,
          value.viewport,
          value.resourcePolicy,
        ])
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
        if (nativeReady(value, target)) return 'native-normal'
        if (
          value.firstSurfaceReady &&
          value.firstSurfacePainted &&
          value.firstSurfacePhase === 'painted' &&
          firstIdentityMatches(value, target) &&
          Number.isFinite(value.firstSurfaceFencedAt) &&
          value.firstSurfaceFencedAt > 0 &&
          Number.isFinite(value.firstSurfacePostPaintAt) &&
          value.firstSurfacePostPaintAt >= value.firstSurfaceFencedAt &&
          value.firstSurfacePostPaintAt <= value.at
        )
          return 'first-surface-exact'
        return null
      }
      const hasFirstSurfacePublication = (value: Snapshot) =>
        value.firstSurfaceReady ||
        value.firstSurfacePhase === 'fenced' ||
        value.firstSurfacePhase === 'painted'
      const wrongIdentity = (value: Snapshot, target: Target) => {
        if (value.filename !== target.filename) return true
        if (value.cachedReady)
          return (
            value.cachedRevision !== target.revision ||
            !sourceMatches(value.cachedSource, target) ||
            !sameParameters(value.cachedParameters, target.parameters)
          )
        if (value.editing !== 'ready' && hasFirstSurfacePublication(value))
          return !firstIdentityMatches(value, target)
        return (
          value.nativeRevision !== target.revision ||
          !sourceMatches(value.nativeSource, target) ||
          !sameParameters(value.nativeParameters, target.parameters)
        )
      }
      const firstReceipt = (value: Snapshot) =>
        JSON.stringify([
          value.previewRequestId,
          value.firstSurfaceId,
          value.firstSurfaceSha256,
          value.firstSurfaceParentWorkingKey,
          value.firstSurfaceFencedAt,
          value.firstSurfacePostPaintAt,
          value.resourcePolicy,
        ])
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
          const firstPublication = hasFirstSurfacePublication(value)
          if (
            value.visible &&
            selected &&
            (value.cachedReady || value.editing === 'ready' || firstPublication)
          ) {
            if (wrongIdentity(value, sample.target)) sample.wrongVisiblePublications++
            else if (!kind) {
              sample.correctVisibleButNotUsefulFrames++
              if (value.loader) sample.loaderBlockedVisibleFrames++
              if (firstPublication && value.editing !== 'ready')
                sample.pendingFirstSurfacePaintFrames++
              if (
                !value.cachedReady &&
                !firstPublication &&
                value.completedSerial !== value.requestedSerial
              )
                sample.pendingRequestVisibleFrames++
              if (
                (value.cachedReady
                  ? value.cachedTargetGeneration
                  : firstPublication && value.editing !== 'ready'
                    ? firstOffers.get(value.firstSurfaceId ?? '')?.identity.target.generation
                    : value.targetGeneration) !== value.authoritativeTargetGeneration
              )
                sample.pendingTargetVisibleFrames++
            }
          }
          if (
            value.visible &&
            selected &&
            !value.cachedReady &&
            !firstPublication &&
            value.editing !== 'ready'
          )
            sample.unattributedVisibleFrames++
          const candidate = (type: 'useful' | 'native') => {
            const key = `${activations.length}:${type}`
            if (pending.has(key)) return
            pending.add(key)
            void (async () => {
              // A conservative post-paint observation, without another shared queue fence.
              const receipt =
                  type === 'useful' && kind === 'first-surface-exact' ? firstReceipt(value) : null,
                native = type === 'native' ? nativeReceipt(value) : null,
                canvas =
                  type === 'native'
                    ? document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')
                    : null,
                sameNative = (snapshot: Snapshot) =>
                  nativeReady(snapshot, sample.target) &&
                  nativeReceipt(snapshot) === native &&
                  document.querySelector('[data-testid="main-preview"]') === canvas
              await frame()
              const intermediate = snapshot()
              if (
                (type === 'native' && !sameNative(intermediate)) ||
                (receipt &&
                  (classify(intermediate, sample.target) !== 'first-surface-exact' ||
                    firstReceipt(intermediate) !== receipt))
              ) {
                pending.delete(key)
                return
              }
              await frame()
              if (active !== sample || stopped) return
              const presented = snapshot(),
                currentKind = classify(presented, sample.target)
              if (
                !currentKind ||
                (type === 'native' && !sameNative(presented)) ||
                (receipt &&
                  (currentKind !== 'first-surface-exact' || firstReceipt(presented) !== receipt))
              ) {
                pending.delete(key)
                return
              }
              // A native witness can finish while an earlier transient witness is
              // invalidating. Its same two real RAFs also establish first usefulness.
              if (sample.firstUsefulAt === null) {
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
          if (nativeReady(value, sample.target) && sample.nativeReadyAt === null)
            candidate('native')
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
          pendingFirstSurfacePaintFrames: 0,
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
        // Poll only recorded witnesses. Cloning retained frame history here stalls the renderer.
        status: () => ({
          activationCount: activations.length,
          current: active
            ? {
                photoId: active.target.id,
                filename: active.target.filename,
                phase: active.phase,
                startedAt: active.startedAt,
                supersededAt: active.supersededAt,
                firstUsefulAt: active.firstUsefulAt,
                firstUsefulMs: active.firstUsefulMs,
                firstUsefulKind: active.firstUsefulKind,
                nativeReadyAt: active.nativeReadyAt,
                nativeReadyMs: active.nativeReadyMs,
                nativeSource: active.nativeReady?.nativeSource ?? null,
                wrongVisiblePublications: active.wrongVisiblePublications,
                unattributedVisibleFrames: active.unattributedVisibleFrames,
                correctVisibleButNotUsefulFrames: active.correctVisibleButNotUsefulFrames,
                loaderBlockedVisibleFrames: active.loaderBlockedVisibleFrames,
                pendingRequestVisibleFrames: active.pendingRequestVisibleFrames,
                pendingTargetVisibleFrames: active.pendingTargetVisibleFrames,
                pendingFirstSurfacePaintFrames: active.pendingFirstSurfacePaintFrames,
              }
            : null,
        }),
        read: () => {
          sampleDepartures()
          return structuredClone({
            activations,
            current: active,
            departures,
            firstSurfaceOffers: [...firstOffers.values()],
            omittedFirstOffers,
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
          stopFirstSurface()
          firstOffers.clear()
          departingCanvases.clear()
        },
      }
    },
    {
      expectedKernel: 'linear64' as const,
      retainedCacheBudgetBytes: HDR_PRESENTATION_CACHE_BUDGET,
    },
  )
}
