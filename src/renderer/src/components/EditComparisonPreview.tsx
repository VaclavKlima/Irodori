import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DisplayPreview } from '../../../shared/contracts'
import type { EditComparisonSession } from '../../../shared/edit-comparisons'
import type { EditorPreviewPolicy } from '../../../shared/editor-preview-policy'
import type { DisplayTarget } from '../../../shared/hdr'
import type { PreviewViewState } from '../../../shared/workspace'
import { neutralAdjustments } from '../../../shared/adjustments'
import { useWorkingPreview } from '../hooks/useWorkingPreview'
import { usePanDrag } from '../hooks/usePanDrag'
import { usePreviewWheel } from '../hooks/usePreviewWheel'
import {
  ComparisonPublication,
  comparisonClips,
  comparisonMemoryPlan,
} from '../preview/edit-comparison'
import {
  constrain,
  INITIAL_VIEW,
  restoreView,
  minimumScale,
  stepScale,
  zoomAt,
  ZOOM_STOPS,
  type Size,
  type View,
} from '../preview/geometry'
import { HdrPresenter } from '../preview/hdr-presenter'
import { hdrDevice } from '../preview/hdr-device'
import { PreviewPresenter } from '../preview/presenter'
import { imageResourceOwners } from '../preview/image-resource-owners'
import { rendererImageResources, sourceCache } from '../preview/hdr-preview-resources'
import type { HdrSourceMemorySnapshot } from '../preview/hdr-source-cache'
import type { ResourcePolicySnapshot } from '../../../shared/resource-policy'
import { Button } from './ui/Controls'
import styles from './EditComparisonPreview.module.css'

type Presenter = PreviewPresenter | HdrPresenter
export function EditComparisonPreview({
  session,
  filename,
  initialView,
  displayTarget,
  previewPolicy,
  suspended = false,
  onEnd,
}: {
  session: EditComparisonSession
  filename?: string
  initialView?: PreviewViewState | null
  displayTarget: DisplayTarget
  previewPolicy: EditorPreviewPolicy
  suspended?: boolean
  onEnd?: () => void
}) {
  const viewport = useRef<HTMLDivElement>(null),
    surfaces = useRef<HTMLDivElement>(null),
    canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)] as const,
    presenters = useRef<[Presenter | null, Presenter | null]>([null, null]),
    retirement = useRef<Promise<unknown>>(Promise.resolve()),
    publication = useRef(new ComparisonPublication()),
    [size, setSize] = useState<Size>({ width: 0, height: 0 }),
    [dpr, setDpr] = useState(window.devicePixelRatio || 1),
    [view, setView] = useState<View>(INITIAL_VIEW),
    [mode, setMode] = useState<'a' | 'b' | 'split'>('a'),
    [split, setSplit] = useState(0.5),
    [frames, setFrames] = useState<readonly [DisplayPreview, DisplayPreview] | null>(null),
    [loadedRendition, setLoadedRendition] = useState(''),
    [policy, setPolicy] = useState<ResourcePolicySnapshot | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0),
    [readyKey, setReadyKey] = useState(''),
    [surfaceEpoch, setSurfaceEpoch] = useState(0),
    [external, setExternal] = useState({ ramBytes: 0, vramBytes: 0 }),
    [retrying, setRetrying] = useState(false),
    pairReservation = useRef<ReturnType<typeof imageResourceOwners.register> | null>(null),
    baselineShared = useRef({ ramBytes: 0, vramBytes: 0 }),
    baselineSources = useRef<HdrSourceMemorySnapshot | undefined>(undefined),
    image = useMemo(
      () => ({ width: session.context.width, height: session.context.height }),
      [session.context.width, session.context.height],
    )

  useEffect(() => {
    if (suspended) return
    let cancelled = false
    void (async () => {
      try {
        const shared = rendererImageResources(),
          live = imageResourceOwners.snapshot()
        const reservation = {
          ramBytes: shared.ramBytes + live.ramBytes,
          vramBytes: shared.vramBytes + live.vramBytes,
        }
        baselineShared.current = shared
        baselineSources.current = sourceCache.captureMemory()
        const device = session.context.sourceDynamicRange === 'hdr' ? await hdrDevice() : null
        const resolved = await window.irodori.getResourcePolicy(
          device
            ? {
                vendor: device.adapterInfo.vendor,
                architecture: device.adapterInfo.architecture,
                device: device.adapterInfo.device,
                description: device.adapterInfo.description,
              }
            : null,
        )
        const rendition = session.context.sourceDynamicRange === 'hdr' ? displayTarget.mode : 'sdr'
        const a = await window.irodori.requestEditComparisonFrame(
          session.photoId,
          session.id,
          'a',
          crypto.randomUUID(),
          rendition,
          reservation,
        )
        if (cancelled) return
        const b = await window.irodori.requestEditComparisonFrame(
          session.photoId,
          session.id,
          'b',
          crypto.randomUUID(),
          rendition,
          reservation,
        )
        if (cancelled) return
        setPolicy(resolved)
        setExternal(reservation)
        setFrames([a, b])
        setLoadedRendition(displayTarget.mode)
      } catch (failure) {
        if (!cancelled) setError(String(failure))
      }
    })()
    return () => {
      cancelled = true
    }
    // The session owns its frame leases. Its parent drains them on comparison exit.
  }, [
    session.id,
    session.photoId,
    session.context.sourceDynamicRange,
    displayTarget.mode,
    attempt,
    suspended,
  ])

  useLayoutEffect(() => {
    const element = viewport.current!
    let initialized = false
    const measure = () => {
      const box = element.getBoundingClientRect(),
        next = { width: box.width, height: box.height }
      setSize(next)
      setDpr(window.devicePixelRatio || 1)
      setView((previous) => {
        if (!initialized && initialView?.photoId === session.photoId) {
          initialized = true
          return restoreView({ ...initialView, fit: false, scale: 1 }, image, next)
        }
        const nextView = initialized ? previous : { ...previous, fit: false, scale: 1 }
        initialized = true
        return constrain(nextView, image, next)
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [session.id, session.photoId, image, initialView])

  const plan = useMemo(
    () =>
      frames && policy && size.width && size.height
        ? comparisonMemoryPlan(frames, size, dpr, policy, external)
        : null,
    [frames, policy, size, dpr, external],
  )
  const admitted = Boolean(
      !suspended && plan?.accepted && !error && loadedRendition === displayTarget.mode,
    ),
    a = useWorkingPreview(frames?.[0] ?? null, admitted, true),
    b = useWorkingPreview(frames?.[1] ?? null, admitted && !!a.working, true),
    working = [a.working, b.working] as const,
    viewKey = JSON.stringify([
      session.id,
      session.members.map((member) => member.identity),
      view,
      size,
      dpr,
      displayTarget,
      attempt,
      a.working?.identity,
      b.working?.identity,
    ]),
    ready = readyKey === viewKey && admitted && !!a.working && !!b.working,
    failure =
      error ||
      a.error ||
      b.error ||
      (plan && !plan.accepted
        ? 'These two versions exceed the managed image-memory budget. Close other processing or use a smaller preview window, then retry.'
        : '')

  // Reserve anticipated pair ownership before transferring either full-resolution plane.
  const liveWorking = useRef(working)
  useLayoutEffect(() => {
    liveWorking.current = [a.working, b.working]
  }, [a.working, b.working])

  const latest = useRef({
    view,
    size,
    displayTarget,
    viewKey,
    sourceA: a.working?.identity,
    sourceB: b.working?.identity,
  })
  useLayoutEffect(() => {
    latest.current = {
      view,
      size,
      displayTarget,
      viewKey,
      sourceA: a.working?.identity,
      sourceB: b.working?.identity,
    }
    publication.current.request(viewKey)
  }, [view, size, displayTarget, viewKey, a.working?.identity, b.working?.identity])
  const slotKey = JSON.stringify([
    a.working?.identity,
    b.working?.identity,
    plan?.limits,
    attempt,
    admitted,
    failure,
  ])
  useEffect(() => {
    if (!a.working || !b.working || !plan?.accepted || !frames || !admitted || failure) return
    let cancelled = false
    const currentFrames = frames,
      currentWorking = [a.working, b.working] as const,
      prior = retirement.current,
      surfaceElement = surfaces.current
    const created: [Presenter | null, Presenter | null] = [null, null]
    void (async () => {
      await prior.catch(() => undefined)
      if (cancelled) return
      const lost = (reason: string) => {
        if (cancelled) return
        if (surfaces.current) surfaces.current.style.opacity = '0'
        setError(reason)
      }
      for (const index of [0, 1] as const) {
        if (cancelled) return
        const canvas = canvases[index].current!,
          frame = currentFrames[index],
          source = currentWorking[index]
        const presented = () => {
          if (cancelled) return
          const presenter = created[index],
            geometry = presenter?.presentedGeometry,
            expected = latest.current
          if (
            !geometry ||
            (index === 0 ? expected.sourceA : expected.sourceB) !== source.identity ||
            geometry.sourceIdentity !== source.identity ||
            JSON.stringify(geometry.view) !== JSON.stringify(expected.view) ||
            JSON.stringify(geometry.viewport) !== JSON.stringify(expected.size) ||
            (presenter instanceof HdrPresenter &&
              canvas.dataset.targetGeneration !== String(expected.displayTarget.generation))
          )
            return
          if (publication.current.accept(expected.viewKey, index === 0 ? 'a' : 'b'))
            setReadyKey(expected.viewKey)
        }
        const presenter = source.hdr
          ? new HdrPresenter(
              canvas,
              latest.current.displayTarget,
              { ...previewPolicy, presentationCache: false },
              lost,
              presented,
            )
          : new PreviewPresenter(canvas, false, lost, presented)
        created[index] = presenter
        if (presenter instanceof HdrPresenter) {
          presenter.setReadOnlyComparison(
            plan.limits,
            () => {
              const peer = created[index === 0 ? 1 : 0]
              return peer instanceof HdrPresenter ? peer.comparisonSourceLease : undefined
            },
            baselineSources.current,
          )
          const parameters = {
            ...(frame.adjustments ?? neutralAdjustments),
            maskGeometry: frame.maskGeometry,
          }
          presenter.setEditing(false, 0, null, {
            revision: frame.settingsRevision ?? 0,
            settings: parameters,
          })
          presenter.setWorking(source)
        } else {
          presenter.setReadOnlyComparison()
          presenter.setWorking(source)
        }
      }
      if (!cancelled) {
        presenters.current = created
        setSurfaceEpoch((value) => value + 1)
      }
    })().catch((reason) => {
      if (!cancelled) setError(String(reason))
    })
    return () => {
      cancelled = true
      if (surfaceElement) surfaceElement.style.opacity = '0'
      for (const presenter of created) presenter?.dispose()
      retirement.current = Promise.allSettled([
        prior,
        ...created.map((presenter) =>
          presenter instanceof HdrPresenter ? presenter.whenDisposed : presenter?.whenDisposed,
        ),
      ])
      if (presenters.current === created) presenters.current = [null, null]
    }
    // These immutable slot identities own GPU allocation; geometry changes use draw below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey])

  // Retire this reservation after the slot cleanup has captured the real GPU drains.
  useEffect(() => {
    if (!plan?.accepted || suspended) return
    const owner = imageResourceOwners.register(() => {
      const own = presenters.current.reduce(
          (sum, presenter) => {
            const bytes = presenter?.comparisonReservation
            return {
              ramBytes: sum.ramBytes + (bytes?.ramBytes ?? 0),
              vramBytes: sum.vramBytes + (bytes?.vramBytes ?? 0),
            }
          },
          { ramBytes: 0, vramBytes: 0 },
        ),
        source = rendererImageResources(),
        ram = liveWorking.current.reduce((sum, frame) => sum + (frame?.data.byteLength ?? 0), 0)
      return {
        ramBytes: Math.max(
          0,
          plan.reservation.ramBytes -
            own.ramBytes -
            ram -
            Math.max(0, source.ramBytes - baselineShared.current.ramBytes),
        ),
        vramBytes: Math.max(
          0,
          plan.reservation.vramBytes -
            own.vramBytes -
            Math.max(0, source.vramBytes - baselineShared.current.vramBytes),
        ),
      }
    })
    pairReservation.current = owner
    return () => {
      owner.retire(retirement.current)
      if (pairReservation.current === owner) pairReservation.current = null
    }
  }, [plan, suspended, attempt])

  useLayoutEffect(() => {
    if (surfaces.current) surfaces.current.style.opacity = '0'
    if (!admitted || failure || !frames || !a.working || !b.working) return
    for (const index of [0, 1] as const) {
      const presenter = presenters.current[index],
        frame = frames[index]
      if (!presenter) continue
      try {
        if (presenter instanceof HdrPresenter) presenter.setTarget(displayTarget)
        presenter.draw(image, size, view, {
          ...(frame.adjustments ?? neutralAdjustments),
          maskGeometry: frame.maskGeometry,
        })
      } catch (reason) {
        queueMicrotask(() => setError(String(reason)))
      }
    }
  }, [
    viewKey,
    surfaceEpoch,
    admitted,
    failure,
    frames,
    a.working,
    b.working,
    image,
    size,
    view,
    displayTarget,
  ])

  const changeView = useCallback(
    (next: View) => {
      if (surfaces.current) surfaces.current.style.opacity = '0'
      setView(next)
    },
    [setView],
  )
  const current = useRef({ view, size, image })
  useLayoutEffect(() => {
    current.current = { view, size, image }
  }, [view, size, image])
  const panBy = useCallback(
    (x: number, y: number) => {
      const model = current.current,
        next = constrain(
          { ...model.view, x: model.view.x + x, y: model.view.y + y },
          model.image,
          model.size,
        )
      changeView(next)
      current.current = { ...model, view: next }
      return { x: next.x - model.view.x, y: next.y - model.view.y }
    },
    [changeView],
  )
  const pan = usePanDrag(viewport, panBy)
  const dividerDrag = useRef<{ pointer: number; start: number; element: HTMLDivElement } | null>(
    null,
  )
  const cancelDivider = useCallback(() => {
    const drag = dividerDrag.current
    dividerDrag.current = null
    if (!drag) return
    setSplit(drag.start)
    if (drag.element.hasPointerCapture(drag.pointer))
      drag.element.releasePointerCapture(drag.pointer)
  }, [setSplit])
  useEffect(() => window.irodori.onWindowBlur(cancelDivider), [cancelDivider])
  const wheelChange = useCallback(
    (
      action: (model: { view: View; image: Size; viewport: Size }) => {
        view: View
        image: Size
        viewport: Size
      },
    ) => {
      const model = current.current
      changeView(action({ view: model.view, image: model.image, viewport: model.size }).view)
    },
    [changeView],
  )
  usePreviewWheel(viewport, !!a.working && !!b.working && !failure, wheelChange, pan.stop)
  const clips = comparisonClips(size.width, dpr, split, mode)
  return (
    <section
      className={styles.preview}
      data-testid="edit-comparison-preview"
      hidden={suspended}
      inert={suspended}
      data-mode={mode}
      data-status={failure ? 'error' : ready ? 'ready' : 'pending'}
    >
      <div className={styles.toolbar}>
        <span className={styles.title}>
          {filename && <strong title={filename}>{filename}</strong>}
          <span>Versions · Read-only</span>
        </span>
        <Button aria-label="Show A" aria-pressed={mode === 'a'} onClick={() => setMode('a')}>
          A
        </Button>
        <Button aria-label="Show B" aria-pressed={mode === 'b'} onClick={() => setMode('b')}>
          B
        </Button>
        <Button
          aria-label="Split versions"
          aria-pressed={mode === 'split'}
          onClick={() => setMode('split')}
        >
          Split
        </Button>
        <Button onClick={onEnd}>End comparison</Button>
      </div>
      <div
        ref={viewport}
        className={styles.viewport}
        tabIndex={0}
        aria-label="Version comparison photograph"
        data-scale={view.scale}
        data-pan-x={view.x}
        data-pan-y={view.y}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey
          )
            return
          if (event.key === 'Escape') {
            onEnd?.()
          } else if (event.key === '\\') {
            setMode((previous) => (previous === 'a' ? 'b' : 'a'))
          } else if (event.key.toLowerCase() === 'y') {
            setMode((previous) => (previous === 'split' ? 'a' : 'split'))
          } else if (event.key === '1' || event.key === '0') {
            changeView(
              event.key === '0'
                ? constrain(INITIAL_VIEW, image, size)
                : zoomAt(view, 1, { x: 0, y: 0 }, image, size),
            )
          } else if (event.key === '+' || event.key === '=' || event.key === '-') {
            changeView(
              zoomAt(
                view,
                stepScale(view.scale, event.key === '-' ? -1 : 1, minimumScale(image, size)),
                { x: 0, y: 0 },
                image,
                size,
              ),
            )
          } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            pan.stop()
            const amount = event.shiftKey ? 120 : 40
            panBy(
              event.key === 'ArrowLeft' ? amount : event.key === 'ArrowRight' ? -amount : 0,
              event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0,
            )
          } else return
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDownCapture={(event) => {
          if (event.button === 1 && event.pointerType === 'mouse' && !failure) {
            event.preventDefault()
            event.stopPropagation()
            pan.start(event.nativeEvent)
          }
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !failure) pan.start(event.nativeEvent)
        }}
        onPointerMove={(event) => pan.move(event.nativeEvent)}
        onPointerUp={(event) => pan.release(event.nativeEvent)}
        onPointerCancel={(event) => pan.cancel(event.nativeEvent)}
        onLostPointerCapture={pan.lostCapture}
      >
        <div ref={surfaces} className={styles.surfaces} style={{ opacity: ready ? 1 : 0 }}>
          {([0, 1] as const).map((index) => (
            <div
              key={index}
              className={styles.clip}
              style={{ clipPath: index === 0 ? clips.a : clips.b }}
            >
              <canvas
                key={working[index]?.hdr ? 'hdr' : 'raster'}
                ref={canvases[index]}
                className={styles.canvas}
                data-testid={`edit-comparison-${index === 0 ? 'a' : 'b'}`}
              />
            </div>
          ))}
        </div>
        <span className={styles.labelA}>A · {session.members[0].label}</span>
        <span className={styles.labelB}>B · {session.members[1].label}</span>
        {mode === 'split' && (
          <div
            className={styles.divider}
            style={{ left: clips.boundary }}
            role="slider"
            tabIndex={0}
            aria-label="Version comparison divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split * 100)}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return
              event.preventDefault()
              event.stopPropagation()
              dividerDrag.current = {
                pointer: event.pointerId,
                start: split,
                element: event.currentTarget,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                const box = viewport.current!.getBoundingClientRect()
                setSplit(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)))
              }
            }}
            onPointerUp={(event) => {
              dividerDrag.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={cancelDivider}
            onLostPointerCapture={cancelDivider}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape' && dividerDrag.current) {
                event.preventDefault()
                cancelDivider()
                return
              }
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                setSplit(
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 1
                      : Math.max(
                          0,
                          Math.min(1, split + (event.key === 'ArrowLeft' ? -0.01 : 0.01)),
                        ),
                )
              }
            }}
          />
        )}
        {!ready && (
          <div className={styles.pending} role={failure ? 'alert' : 'status'}>
            {failure || 'Preparing matched versions…'}
            {failure && (
              <Button
                disabled={retrying}
                onClick={() => {
                  if (retrying) return
                  setRetrying(true)
                  setLoadedRendition('')
                  setReadyKey('')
                  void (async () => {
                    const active = presenters.current
                    presenters.current = [null, null]
                    for (const presenter of active) presenter?.dispose()
                    retirement.current = Promise.allSettled([
                      retirement.current,
                      ...active.map((presenter) => presenter?.whenDisposed),
                    ])
                    await retirement.current
                    pairReservation.current?.release()
                    pairReservation.current = null
                    await window.irodori.setPreviewPreference(displayTarget.requested)
                    a.retry()
                    b.retry()
                    setError('')
                    setAttempt((value) => value + 1)
                  })()
                    .catch((reason) => setError(String(reason)))
                    .finally(() => setRetrying(false))
                }}
              >
                {retrying ? 'Retrying GPU…' : 'Retry GPU'}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span>
          {image.width} × {image.height}
        </span>
        <label>
          Zoom{' '}
          <select
            aria-label="Preview zoom"
            value={view.fit ? 'fit' : String(view.scale)}
            onChange={(event) =>
              changeView(
                event.target.value === 'fit'
                  ? constrain(INITIAL_VIEW, image, size)
                  : zoomAt(view, Number(event.target.value), { x: 0, y: 0 }, image, size),
              )
            }
          >
            <option value="fit">Fit</option>
            {!view.fit && !ZOOM_STOPS.some((scale) => Math.abs(scale - view.scale) < 0.00001) && (
              <option value={String(view.scale)}>{(view.scale * 100).toFixed(1)}%</option>
            )}
            {ZOOM_STOPS.map((scale) => (
              <option key={scale} value={String(scale)}>
                {scale * 100}%
              </option>
            ))}
          </select>
        </label>
        <span>Same native region · Analysis paused</span>
      </div>
    </section>
  )
}
