import { useEffect, useRef, useState } from 'react'
import {
  exposure,
  type MergeMode,
  type MergePreview,
  type MergeReview,
  type MergeSettings,
} from '../../../shared/merge'
import { AdjustmentInput } from './AdjustmentInput'
import { MergeViewport } from './MergeViewport'
import styles from './MergeDialog.module.css'

export function MergeDialog({
  ids,
  mode,
  onClose,
  onStarted,
}: {
  ids: string[]
  mode: MergeMode
  onClose: () => void
  onStarted: (taskId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    reviewRef = useRef<MergeReview | null>(null)
  const [review, setReview] = useState<MergeReview | null>(null),
    [preview, setPreview] = useState<MergePreview | null>(null),
    [decodedPreview, setDecodedPreview] = useState<MergePreview | null>(null)
  const [settings, setSettings] = useState<MergeSettings | null>(null),
    [strength, setStrength] = useState(50)
  const [error, setError] = useState(''),
    [updating, setUpdating] = useState(true),
    [starting, setStarting] = useState(false)
  const [comparison, setComparison] = useState(false),
    [overlay, setOverlay] = useState(false)
  const desired = useRef<MergeSettings | null>(null),
    generation = useRef(0),
    tail = useRef(Promise.resolve())
  const lifecycle = useRef<{ mounted: boolean; creation?: Promise<MergeReview> }>({
    mounted: false,
  })
  useEffect(() => {
    const life = lifecycle.current
    life.mounted = true
    const ticket = generation.current
    dialog.current?.showModal()
    let active = true
    life.creation ??= window.irodori.createMergeReview(ids, mode)
    void life.creation
      .then(async (value) => {
        if (!active) return
        reviewRef.current = value
        setReview(value)
        setSettings(value.settings)
        desired.current = value.settings
        return window.irodori.requestMergePreview(value.id, value.revision).then((result) => {
          if (
            active &&
            generation.current === ticket &&
            reviewRef.current?.revision === result.revision
          ) {
            setPreview(result)
            setUpdating(false)
          }
        })
      })
      .catch((e) => {
        if (active && generation.current === ticket) {
          setError(e instanceof Error ? e.message : String(e))
          setUpdating(false)
        }
      })
    return () => {
      active = false
      life.mounted = false
      // Invalidate asynchronous work when this dialog unmounts.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      queueMicrotask(() => {
        if (!life.mounted)
          void life.creation
            ?.then((value) => window.irodori.disposeMergeReview(value.id))
            .catch(() => {})
      })
    }
  }, [ids, mode])
  function change(patch: Partial<MergeSettings>, retry = false) {
    if (!desired.current) return
    if (
      !retry &&
      (Object.keys(patch) as (keyof MergeSettings)[]).every(
        (key) => desired.current![key] === patch[key],
      )
    )
      return
    desired.current = { ...desired.current, ...patch }
    setSettings(desired.current)
    setUpdating(true)
    setError('')
    const ticket = ++generation.current
    // Debounce expensive preparation; stale results never enable Merge.
    tail.current = tail.current
      .catch(() => {})
      .then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        if (ticket !== generation.current) return
        const current = reviewRef.current
        if (!current) return
        const next = await window.irodori.updateMergeReview(
          current.id,
          current.revision,
          desired.current!,
        )
        reviewRef.current = next
        setReview(next)
        void window.irodori.requestMergePreview(next.id, next.revision).then(
          (result) => {
            if (ticket === generation.current) {
              setPreview(result)
              setUpdating(false)
            }
          },
          (e) => {
            if (ticket === generation.current) {
              setError(e instanceof Error ? e.message : String(e))
              setUpdating(false)
            }
          },
        )
      })
      .catch((e) => {
        if (ticket === generation.current) {
          setError(e instanceof Error ? e.message : String(e))
          setUpdating(false)
        }
      })
  }
  async function close() {
    if (starting) return
    generation.current++
    const current = reviewRef.current
    if (current) await window.irodori.disposeMergeReview(current.id).catch(() => {})
    dialog.current?.close()
    onClose()
  }
  async function start() {
    if (!review || !preview || decodedPreview !== preview || updating || error) return
    setStarting(true)
    try {
      const taskId = await window.irodori.startMerge(review.id, preview.revision)
      reviewRef.current = null
      dialog.current?.close()
      onStarted(taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStarting(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="merge-title"
      onCancel={(e) => {
        e.preventDefault()
        void close()
      }}
    >
      <header>
        <h2 id="merge-title">
          {(settings?.mode ?? mode) === 'hdr' ? 'Merge to HDR' : 'Stack for noise reduction'}
        </h2>
        <button disabled={starting} onClick={() => void close()}>
          Cancel
        </button>
      </header>
      <div className={styles.body}>
        <aside aria-label="Merge sources">
          {review?.sources.map((source) => (
            <button
              key={source.photo.id}
              aria-pressed={settings?.referenceId === source.photo.id}
              onClick={() => change({ referenceId: source.photo.id })}
              disabled={starting}
            >
              <img src={source.photo.thumbnailUrl} alt="" />
              <span>
                {source.photo.filename}
                <small>
                  {source.photo.shutter ?? `${source.capture.shutterSeconds} s`} · ISO{' '}
                  {source.capture.iso} · f/{source.capture.aperture}
                </small>
                <small>
                  {Math.log2(
                    exposure(source.capture) /
                      exposure(
                        review.sources.find((s) => s.photo.id === settings?.referenceId)!.capture,
                      ),
                  ).toFixed(2)}{' '}
                  EV{settings?.referenceId === source.photo.id ? ' · Reference' : ''}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <div className={styles.center}>
          <MergeViewport
            preview={error ? null : preview}
            busy={updating || starting}
            comparison={comparison}
            overlay={overlay}
            onComparison={() => setComparison(!comparison)}
            onReady={setDecodedPreview}
            onError={setError}
          />
          {preview && decodedPreview === preview && !updating && !error && (
            <p>
              {preview.width} × {preview.height} pixels ·{' '}
              {preview.recipe.affectedPercent.toFixed(2)}% deghosted ·{' '}
              {preview.recipe.referenceClippedPercent.toFixed(2)}% uses a clipped reference
            </p>
          )}
        </div>
        <aside className={styles.controls} aria-label="Merge settings">
          {settings && (
            <>
              <label>
                Mode
                <select
                  value={settings.mode}
                  disabled={starting}
                  onChange={(e) => change({ mode: e.target.value as MergeMode })}
                >
                  <option value="hdr">HDR</option>
                  <option value="noise">Noise reduction</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.autoAlign}
                  disabled={starting}
                  onChange={(e) => change({ autoAlign: e.target.checked })}
                />{' '}
                Auto Align
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.deghost}
                  disabled={starting}
                  onChange={(e) => change({ deghost: e.target.checked })}
                />{' '}
                Deghost
              </label>
              <AdjustmentInput
                label="Deghost strength"
                value={strength}
                min={0}
                max={100}
                step={1}
                precision={0}
                disabled={starting || !settings.deghost}
                onChange={setStrength}
                onCommit={() => change({ strength })}
                onCancel={() => setStrength(settings.strength)}
                resetKey={review?.revision}
              />
              <p>
                Higher strength rejects more changing content in favor of the reference. Those areas
                lose stacking noise reduction and may lose recoverable highlights. Zero disables
                deghosting.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={settings.autoCrop}
                  disabled={starting}
                  onChange={(e) => change({ autoCrop: e.target.checked })}
                />{' '}
                Auto Crop
              </label>
              <p>
                {settings.autoCrop
                  ? 'Largest rectangle covered by every source.'
                  : 'Reference framing; pixels outside shared coverage are transparent.'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={overlay}
                  onChange={(e) => setOverlay(e.target.checked)}
                />{' '}
                Show deghost overlay
              </label>
              <p>Magenta marks areas resolved from the selected reference.</p>
              <p>
                Original RAW data, common reference white balance and fixed lens corrections. Source
                edits are excluded. Sony merge quality is experimental.
              </p>
            </>
          )}
        </aside>
      </div>
      {error && (
        <div className={styles.error}>
          <p role="alert">{error}</p>
          {review && !updating && !starting && (
            <button onClick={() => change({}, true)}>Retry preview</button>
          )}
        </div>
      )}
      <footer>
        <span>
          {review
            ? `${review.sources.length} sources · ${Math.ceil(review.scratchBytes / 1024 ** 3)} GiB temporary space budget`
            : 'Validating compatibility…'}
        </span>
        <button
          disabled={
            starting ||
            updating ||
            !!error ||
            !preview ||
            decodedPreview !== preview ||
            preview.revision !== review?.revision
          }
          onClick={() => void start()}
        >
          {starting ? 'Starting…' : 'Merge'}
        </button>
      </footer>
    </dialog>
  )
}
