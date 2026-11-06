import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react'
import { neutralAdjustments } from '../../../shared/adjustments'
import type { ExportOptions, ExportPreparation, ExportTarget } from '../../../shared/export'
import { exportFilename } from '../../../shared/export'
import {
  outputProofDisplayTarget,
  outputProofPixelKey,
  type OutputProof as Proof,
} from '../../../shared/export-proof'
import type { DisplayTarget } from '../../../shared/hdr'
import type { PreviewPreference } from '../../../shared/hdr-display'
import type { EditorPreviewPolicy } from '../../../shared/editor-preview-policy'
import { usePanDrag } from '../hooks/usePanDrag'
import { usePreviewFrame } from '../hooks/usePreviewFrame'
import { usePreviewWheel } from '../hooks/usePreviewWheel'
import { loadFrame, type FrameLease } from '../preview/frame-cache'
import {
  constrain,
  INITIAL_VIEW,
  minimumScale,
  replaceDimensions,
  stepScale,
  zoomAt,
  ZOOM_STOPS,
  type Size,
  type View,
} from '../preview/geometry'
import { HdrPresenter } from '../preview/hdr-presenter'
import { captureHdrPreviewRetirement } from '../preview/hdr-preview-resources'
import { PreviewPresenter } from '../preview/presenter'
import { Button, IconButton } from './ui/Controls'
import styles from './OutputProof.module.css'

interface Props {
  preparation: ExportPreparation
  initialPhotoId: string | null
  options: ExportOptions
  invalid: boolean
  preparationInvalid: boolean
  displayTarget: DisplayTarget
  previewPolicy: EditorPreviewPolicy
}
export function OutputProof(props: Props) {
  const { preparation, initialPhotoId } = props
  const [preference, setPreference] = useState<PreviewPreference>(props.displayTarget.requested)
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      preparation.targets.findIndex((t) => t.photoId === initialPhotoId),
    ),
  )
  const target = preparation.targets[index]
  return (
    <section className={styles.panel} aria-label="Output preview">
      <div className={styles.heading}>
        <h3>Output preview</h3>
        {preparation.targets.length > 1 && (
          <nav aria-label="Output preview photographs">
            <IconButton
              icon={ChevronLeft}
              label="Previous output photograph"
              disabled={index === 0}
              onClick={() => setIndex((n) => n - 1)}
            />
            <span>
              {index + 1} of {preparation.targets.length}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next output photograph"
              disabled={index === preparation.targets.length - 1}
              onClick={() => setIndex((n) => n + 1)}
            />
          </nav>
        )}
      </div>
      <ProofPhoto
        key={target.photoId}
        {...props}
        target={target}
        index={index}
        preference={preference}
        onPreferenceChange={setPreference}
      />
    </section>
  )
}

function ProofPhoto({
  preparation,
  options,
  target,
  index,
  invalid,
  preparationInvalid,
  displayTarget,
  previewPolicy,
  preference,
  onPreferenceChange,
}: Props & {
  target: ExportTarget
  index: number
  preference: PreviewPreference
  onPreferenceChange: (preference: PreviewPreference) => void
}) {
  const [proof, setProof] = useState<Proof | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const retirement = useRef<Promise<void>>(Promise.resolve())
  const life = useRef({ mounted: false, token: '', key: '', proofs: new Set<string>() })
  let pixelKey = ''
  try {
    pixelKey = outputProofPixelKey(options, target.hdr)
  } catch {
    /* The settings owner reports invalid HDR selection. */
  }
  useLayoutEffect(() => {
    life.current.key = preparationInvalid ? '' : pixelKey
  }, [pixelKey, preparationInvalid])
  useEffect(() => {
    const state = life.current
    state.mounted = true
    return () => {
      state.mounted = false
      if (state.token) void window.irodori.cancelOutputProof(state.token)
      state.token = ''
      queueMicrotask(() => {
        if (state.mounted) return
        void retirement.current
          .then(async () => {
            await Promise.all([...state.proofs].map((id) => window.irodori.releaseOutputProof(id)))
            state.proofs.clear()
          })
          .catch(() => undefined)
      })
    }
  }, [])
  useEffect(() => {
    const state = life.current
    if (state.token) {
      void window.irodori.cancelOutputProof(state.token)
      state.token = ''
      // Explicit settings changes stop work without generating a replacement.
      setPending(false)
    }
  }, [pixelKey, preparationInvalid])
  useEffect(() => {
    if (!proof) return
    const state = life.current
    let current = true
    // Strict effects can clean/reinstall without changing the accepted proof.
    queueMicrotask(() => {
      current = false
    })
    return () => {
      if (current && state.mounted) return
      queueMicrotask(() => {
        const work = retirement.current
          .then(() => window.irodori.releaseOutputProof(proof.id))
          .then(() => {
            state.proofs.delete(proof.id)
          })
        retirement.current = work.catch(() => undefined)
      })
    }
  }, [proof])
  async function generate() {
    if (invalid || !pixelKey || pending) return
    const state = life.current,
      token = crypto.randomUUID(),
      requestedKey = pixelKey
    state.token = token
    setPending(true)
    setError('')
    try {
      await retirement.current
      if (!state.mounted || state.token !== token || state.key !== requestedKey) return
      const result = await window.irodori.requestOutputProof({
        preparationId: preparation.id,
        photoId: target.photoId,
        options,
        token,
      })
      if (!state.mounted || state.token !== token || state.key !== requestedKey) {
        await window.irodori.releaseOutputProof(result.id)
        return
      }
      state.proofs.add(result.id)
      setProof(result)
    } catch (error) {
      if (state.mounted && state.token === token) setError(String(error))
    } finally {
      if (state.mounted && state.token === token) {
        state.token = ''
        setPending(false)
      }
    }
  }
  const localTarget = useMemo(
    () =>
      outputProofDisplayTarget(
        displayTarget,
        preference,
        displayTarget.generation * 4 + ['auto', 'hdr', 'sdr'].indexOf(preference),
      ),
    [displayTarget, preference],
  )
  const stale = !!proof && (preparationInvalid || proof.pixelKey !== pixelKey)
  return (
    <>
      <div className={styles.caption}>
        <span
          title={exportFilename(target.filename, options.names, index)}
          data-testid="output-proof-filename"
        >
          {exportFilename(target.filename, options.names, index)}
        </span>
        <label>
          Display
          <select
            aria-label="Output preview display"
            value={preference}
            onChange={(e) => onPreferenceChange(e.target.value as PreviewPreference)}
          >
            <option value="auto">Auto</option>
            <option value="hdr">HDR</option>
            <option value="sdr">SDR</option>
          </select>
        </label>
      </div>
      <ProofCanvas
        proof={proof}
        target={localTarget}
        preference={preference}
        previewPolicy={previewPolicy}
        retirement={retirement}
      />
      <div className={styles.result}>
        <div aria-live="polite">
          {proof && (
            <p data-testid="output-proof-metadata">
              {proof.output === 'hdr' ? 'HDR JPEG' : 'SDR JPEG'} · Quality {proof.quality} ·{' '}
              {proof.width} × {proof.height} ·{' '}
              {proof.resizeMethod === 'original' ? 'Original size' : 'Lanczos3'}
            </p>
          )}
          <p role="status">
            {pending
              ? 'Generating output preview…'
              : stale
                ? 'Preview out of date'
                : proof
                  ? 'Decoded JPEG output'
                  : 'Generate a preview at the export dimensions.'}
          </p>
        </div>
        <Button disabled={invalid || !pixelKey || pending} onClick={() => void generate()}>
          {proof ? 'Update preview' : 'Preview output'}
        </Button>
      </div>
      {proof?.output === 'hdr' && (
        <p className={styles.explanation}>
          {localTarget.mode === 'hdr'
            ? 'Showing authored HDR output.'
            : `Showing the embedded SDR primary. ${localTarget.reason}`}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </>
  )
}

interface Model {
  image: Size
  viewport: Size
  view: View
}
function ProofCanvas({
  proof,
  target,
  preference,
  previewPolicy,
  retirement,
}: {
  proof: Proof | null
  target: DisplayTarget
  preference: PreviewPreference
  previewPolicy: EditorPreviewPolicy
  retirement: MutableRefObject<Promise<void>>
}) {
  const viewport = useRef<HTMLDivElement>(null),
    owner = useRef<PreviewPresenter | HdrPresenter | null>(null)
  const proofPolicy = useMemo(
    () => ({ ...previewPolicy, presentationCache: false }),
    [previewPolicy],
  )
  const [model, setModel] = useState<Model>({
    image: { width: 0, height: 0 },
    viewport: { width: 0, height: 0 },
    view: INITIAL_VIEW,
  })
  const current = useRef(model),
    [failureState, setFailureState] = useState({ key: '', reason: '' }),
    [hdrDemand, setHdrDemand] = useState(''),
    [attempt, setAttempt] = useState(0),
    [pixelsReady, setReady] = useState(false)
  const failureKey = `${proof?.id}:${preference}`
  const hdrDemandKey = JSON.stringify([proof?.id, target.capabilities?.monitor])
  const capabilityFailure = ['device-lost', 'adapter-unavailable', 'canvas-unsupported'].includes(
    target.capabilities?.failure ?? '',
  )
  const holdHdr =
    !!proof?.linear?.hdr && preference !== 'sdr' && hdrDemand === hdrDemandKey && capabilityFailure
  const failure =
    (failureState.key === failureKey ? failureState.reason : '') ||
    (holdHdr ? target.capabilities?.reason || 'HDR presentation failed. Retry GPU.' : '')
  const ready = pixelsReady && !failure
  useLayoutEffect(() => {
    if (proof?.linear?.hdr && preference !== 'sdr' && target.mode === 'hdr') {
      // Keep active authored content through capability loss on this monitor.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHdrDemand(hdrDemandKey)
    }
  }, [proof, preference, target.mode, hdrDemandKey])
  const setFailure = useCallback(
    (reason: string) => setFailureState({ key: failureKey, reason }),
    [failureKey],
  )
  const frame = usePreviewFrame(() => {
    const m = current.current
    owner.current?.draw(m.image, m.viewport, m.view, neutralAdjustments)
  })
  const change = useCallback((action: (model: Model) => Model) => {
    const next = action(current.current)
    current.current = next
    setModel(next)
  }, [])
  const pan = usePanDrag(
    viewport,
    useCallback(
      (x, y) => {
        const before = current.current.view
        change((m) => ({
          ...m,
          view: constrain({ ...m.view, x: m.view.x + x, y: m.view.y + y }, m.image, m.viewport),
        }))
        return { x: current.current.view.x - before.x, y: current.current.view.y - before.y }
      },
      [change],
    ),
  )
  const stopPan = pan.stop
  usePreviewWheel(viewport, ready, change, stopPan)
  useEffect(() => {
    if (!ready) stopPan()
  }, [ready, stopPan])
  useLayoutEffect(() => {
    if (proof) {
      // Modal entry and hidden window resizing can precede the observer's first delivery.
      const element = viewport.current!,
        size = { width: element.clientWidth, height: element.clientHeight }
      change((m) => ({
        ...m,
        image: proof,
        viewport: size,
        view: replaceDimensions(m.view, m.image, proof, size),
      }))
    }
  }, [proof, change])
  useEffect(() => {
    const element = viewport.current!
    const observer = new ResizeObserver(() => {
      const size = { width: element.clientWidth, height: element.clientHeight }
      change((m) => ({ ...m, viewport: size, view: constrain(m.view, m.image, size) }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [change])
  useLayoutEffect(() => {
    frame.schedule()
  }, [model, frame])
  const hdr = !!proof?.linear?.hdr && preference !== 'sdr' && (target.mode === 'hdr' || !!failure)
  const failed = useCallback(
    (reason: string) => {
      setFailure(reason)
      setReady(false)
    },
    [setFailure],
  )
  const loaded = useCallback(() => setReady(true), [])
  useLayoutEffect(() => {
    // A new completed JPEG or presentation route must produce its own ready receipt.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(false)
  }, [proof, hdr, attempt])
  async function retry() {
    try {
      await window.irodori.refreshPreviewDisplay()
      setFailure('')
      setAttempt((n) => n + 1)
    } catch (error) {
      setFailure(String(error))
    }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || !ready) return
    const key = event.key.toLowerCase()
    if (
      !['f', '0', '1', '+', '=', '-', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(
        key,
      )
    )
      return
    event.preventDefault()
    event.stopPropagation()
    pan.stop()
    change((m) => {
      let view = m.view
      if (key === 'f' || key === '0') view = constrain(INITIAL_VIEW, m.image, m.viewport)
      else if (key === '1') view = zoomAt(view, 1, { x: 0, y: 0 }, m.image, m.viewport)
      else if (['+', '=', '-'].includes(key))
        view = zoomAt(
          view,
          stepScale(view.scale, key === '-' ? -1 : 1, minimumScale(m.image, m.viewport)),
          { x: 0, y: 0 },
          m.image,
          m.viewport,
        )
      else
        view = constrain(
          {
            ...view,
            x:
              view.x +
              (key === 'arrowleft' ? 1 : key === 'arrowright' ? -1 : 0) *
                (event.shiftKey ? 100 : 30),
            y:
              view.y +
              (key === 'arrowup' ? 1 : key === 'arrowdown' ? -1 : 0) * (event.shiftKey ? 100 : 30),
          },
          m.image,
          m.viewport,
        )
      return { ...m, view }
    })
  }
  const zoom = model.view.fit ? 'fit' : String(model.view.scale)
  return (
    <div className={styles.viewer}>
      <div
        className={styles.viewport}
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Output pixels"
        aria-busy={!!proof && !ready && !failure}
        data-testid="output-proof-viewport"
        data-proof-id={proof?.id}
        data-ready={ready}
        data-scale={model.view.scale}
        data-fit={model.view.fit}
        data-x={model.view.x}
        data-y={model.view.y}
        data-pan-x={model.view.x}
        data-pan-y={model.view.y}
        data-dragging={pan.dragging}
        data-image-width={model.image.width}
        data-image-height={model.image.height}
        data-viewport-width={model.viewport.width}
        data-viewport-height={model.viewport.height}
        onKeyDown={keyboard}
        onPointerDown={(e) => {
          if (ready && !current.current.view.fit && (e.button === 1 || e.button === 0)) {
            e.preventDefault()
            e.currentTarget.focus({ preventScroll: true })
            pan.start(e.nativeEvent)
          }
        }}
        onPointerMove={(e) => pan.move(e.nativeEvent)}
        onPointerUp={(e) => pan.release(e.nativeEvent)}
        onPointerCancel={(e) => pan.cancel(e.nativeEvent)}
        onLostPointerCapture={pan.lostCapture}
        onAuxClick={(e) => {
          if (e.button === 1) e.preventDefault()
        }}
      >
        {proof ? (
          <ProofPixels
            key={`${proof.id}:${hdr}:${attempt}`}
            proof={proof}
            hdr={hdr}
            target={target}
            previewPolicy={proofPolicy}
            presenterRef={owner}
            retirementRef={retirement}
            draw={frame.flush}
            failed={failed}
            loaded={loaded}
          />
        ) : (
          <p className={styles.empty}>Output preview</p>
        )}
      </div>
      {proof && (
        <label className={styles.zoom}>
          {proof.width} × {proof.height}
          <select
            aria-label="Output preview zoom"
            value={zoom}
            onChange={(e) => {
              pan.stop()
              const value = e.target.value
              change((m) => ({
                ...m,
                view:
                  value === 'fit'
                    ? constrain(INITIAL_VIEW, m.image, m.viewport)
                    : zoomAt(m.view, Number(value), { x: 0, y: 0 }, m.image, m.viewport),
              }))
            }}
          >
            <option value="fit">Fit</option>
            {!ZOOM_STOPS.includes(model.view.scale) && !model.view.fit && (
              <option value={zoom}>{Math.round(model.view.scale * 100)}%</option>
            )}
            {ZOOM_STOPS.map((stop) => (
              <option key={stop} value={stop}>
                {stop * 100}%
              </option>
            ))}
          </select>
        </label>
      )}
      {failure && (
        <div className={styles.failure} role="alert">
          <p>{failure}</p>
          <Button onClick={() => void retry()}>Retry GPU</Button>
        </div>
      )}
    </div>
  )
}

function ProofPixels({
  proof,
  hdr,
  target,
  previewPolicy,
  presenterRef,
  retirementRef,
  draw,
  failed,
  loaded,
}: {
  proof: Proof
  hdr: boolean
  target: DisplayTarget
  previewPolicy: EditorPreviewPolicy
  presenterRef: MutableRefObject<PreviewPresenter | HdrPresenter | null>
  retirementRef: MutableRefObject<Promise<void>>
  draw: () => void
  failed: (reason: string) => void
  loaded: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    latestTarget = useRef(target)
  useLayoutEffect(() => {
    latestTarget.current = target
    if (presenterRef.current instanceof HdrPresenter) presenterRef.current.setTarget(target)
  }, [target, presenterRef])
  useEffect(() => {
    const abort = new AbortController(),
      earlier = retirementRef.current
    let presenter: PreviewPresenter | HdrPresenter | undefined, bitmap: FrameLease | undefined
    const work = (async () => {
      await earlier
      await captureHdrPreviewRetirement()
      if (abort.signal.aborted) return
      const lost = (reason: string) => {
        if (!abort.signal.aborted) {
          canvas.current!.style.visibility = 'hidden'
          failed(reason)
        }
      }
      const presented = () => {
        if (!abort.signal.aborted) loaded()
      }
      try {
        if (hdr) {
          presenter = new HdrPresenter(
            canvas.current!,
            latestTarget.current,
            previewPolicy,
            lost,
            presented,
          )
          presenter.setWorking(
            {
              identity: proof.identity,
              data: new Float32Array(0),
              width: proof.width,
              height: proof.height,
              transform: proof.linear!.transform,
              hdr: proof.linear!.hdr,
            },
            undefined,
            false,
          )
        } else {
          bitmap = await loadFrame(proof.primary, abort.signal, false)
          if (abort.signal.aborted) return
          presenter = new PreviewPresenter(canvas.current!, false, lost, presented)
          presenter.setBitmap(bitmap.bitmap)
        }
        if (!abort.signal.aborted) {
          presenterRef.current = presenter
          draw()
        }
      } catch (error) {
        if (!abort.signal.aborted) lost(String(error))
      }
    })()
    return () => {
      abort.abort()
      if (presenterRef.current === presenter) presenterRef.current = null
      presenter?.dispose()
      retirementRef.current = work
        .catch(() => undefined)
        .then(async () => {
          presenter?.dispose()
          await presenter?.whenDisposed
          bitmap?.release()
        })
    }
  }, [proof, hdr, previewPolicy, presenterRef, retirementRef, draw, failed, loaded])
  return <canvas ref={canvas} className={styles.canvas} aria-label="Decoded JPEG output" />
}
