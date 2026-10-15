import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  defaultExportOptions,
  exportCounts,
  exportPresets,
  validateExportOptions,
  type ExportAction,
  type ExportDestination,
  type ExportOptions,
  type ExportPreferences,
  type ExportPreparation,
} from '../../../shared/export'
import { AdjustmentInput } from './AdjustmentInput'
import styles from './ExportDialog.module.css'

export function ExportDialog({
  ids,
  onClose,
  onStarted,
}: {
  ids: string[]
  onClose: () => void
  onStarted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const life = useRef<{
    mounted: boolean
    loading?: Promise<[ExportPreparation, ExportPreferences]>
  }>({ mounted: false })
  const [preparation, setPreparation] = useState<ExportPreparation | null>(null)
  const [prefs, setPrefs] = useState<ExportPreferences | null>(null)
  const [destination, setDestination] = useState<ExportDestination | null>(null)
  const [custom, setCustom] = useState(false)
  const [options, setOptions] = useState<ExportOptions>(structuredClone(defaultExportOptions))
  const committedQuality = useRef(defaultExportOptions.quality)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const state = life.current
    state.mounted = true
    dialog.current?.showModal()
    state.loading ??= Promise.all([
      window.luma.prepareExport(ids),
      window.luma.getExportPreferences(),
    ])
    void state.loading
      .then(([prepared, preferences]) => {
        if (!state.mounted) return
        setPreparation(prepared)
        setPrefs(preferences)
        setDestination(preferences.destination)
        setOptions(structuredClone(preferences.lastCustom ?? defaultExportOptions))
        committedQuality.current = preferences.lastCustom?.quality ?? defaultExportOptions.quality
      })
      .catch((error) => {
        if (state.mounted) setError(String(error))
      })
    return () => {
      state.mounted = false
      queueMicrotask(() => {
        if (!state.mounted)
          void state.loading
            ?.then(([prepared]) => window.luma.disposeExportPreparation(prepared.id))
            .catch(() => {})
      })
    }
  }, [ids])
  let validation = ''
  try {
    validateExportOptions(options)
  } catch (error) {
    validation = (error as Error).message
  }
  const unsupported = options.output === 'hdr' ? (preparation?.sdr ?? 0) : 0
  const counts = preparation ? exportCounts(preparation, custom ? options.output : 'auto') : null
  const lastCounts =
    preparation && prefs?.lastCustom ? exportCounts(preparation, prefs.lastCustom.output) : null
  const lastUnsupported = prefs?.lastCustom?.output === 'hdr' ? (preparation?.sdr ?? 0) : 0
  async function changeFolder() {
    setBusy(true)
    setError('')
    try {
      const value = await window.luma.chooseExportDestination()
      if (value) setDestination(value)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  async function start(action: ExportAction) {
    if (busy || !preparation) return
    setBusy(true)
    setError('')
    try {
      let folder = destination
      if (!folder?.available) {
        folder = await window.luma.chooseExportDestination()
        if (!folder) return
        setDestination(folder)
      }
      await window.luma.startExport({
        preparationId: preparation.id,
        destinationId: folder.id,
        action,
        ...(action === 'custom' ? { options } : {}),
      })
      onStarted()
    } catch (error) {
      setError(String(error))
      const preferences = await window.luma.getExportPreferences().catch(() => null)
      if (preferences?.destination?.id === destination?.id) setDestination(preferences!.destination)
    } finally {
      setBusy(false)
    }
  }
  const size = (value: ExportOptions['size']) => setOptions((o) => ({ ...o, size: value }))
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="export-heading"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header>
        <h2 id="export-heading">{custom ? 'Custom JPEG export' : 'Export JPEG'}</h2>
        <button aria-label="Close export" disabled={busy} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className={styles.body} aria-busy={busy || !preparation}>
        <p className={styles.summary}>
          {preparation
            ? `${preparation.targets.length} ${preparation.targets.length === 1 ? 'photo' : 'photos'}`
            : 'Preparing export…'}
          {counts && ` · ${counts.hdr} HDR · ${counts.sdr} SDR`}
        </p>
        <div className={styles.destination}>
          <div>
            <span>Destination</span>
            <p title={destination?.label}>
              {destination?.label ?? 'Choose a folder on first export'}
            </p>
          </div>
          <button disabled={busy} onClick={() => void changeFolder()}>
            Change folder…
          </button>
        </div>
        {destination && !destination.available && (
          <p role="status">This folder is unavailable. Choose another folder to export.</p>
        )}
        {!custom ? (
          <>
            <div className={styles.presets} aria-label="JPEG export presets">
              {exportPresets.map((preset) => (
                <button
                  key={preset.id}
                  disabled={busy || !preparation}
                  onClick={() => void start(preset.id)}
                >
                  <strong>{preset.label}</strong>
                  <span>JPEG quality {preset.quality} · Original size · Auto</span>
                </button>
              ))}
              <button
                disabled={busy || !preparation || !prefs?.lastCustom || lastUnsupported > 0}
                onClick={() => void start('last-custom')}
              >
                <strong>Last custom</strong>
                <span>
                  {prefs?.lastCustom
                    ? lastUnsupported
                      ? `${lastUnsupported} unsupported for HDR JPEG`
                      : `JPEG quality ${prefs.lastCustom.quality} · ${lastCounts?.hdr} HDR · ${lastCounts?.sdr} SDR · Saved settings`
                    : 'No custom export saved yet'}
                </span>
              </button>
              <button disabled={busy || !preparation} onClick={() => setCustom(true)}>
                <strong>Custom…</strong>
                <span>Output, size, names and metadata</span>
              </button>
            </div>
            <p>
              Auto uses HDR JPEG for supported RAWs, merges and HDR JPEGs. Other photos use SDR
              JPEG. JPEG quality 100 still uses lossy compression.
            </p>
            <p>
              Quick exports keep camera and copyright metadata, exclude location and private camera
              identifiers, and rename collisions automatically.
            </p>
          </>
        ) : (
          <form
            id="custom-export"
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault()
              if (!unsupported && !validation) void start('custom')
            }}
          >
            <label>
              Output
              <select
                value={options.output}
                disabled={busy}
                onChange={(event) =>
                  setOptions((o) => ({
                    ...o,
                    output: event.target.value as ExportOptions['output'],
                  }))
                }
              >
                <option value="auto">Auto</option>
                <option value="sdr">SDR JPEG</option>
                <option value="hdr">HDR JPEG (gain map)</option>
              </select>
            </label>
            {unsupported > 0 && (
              <p role="alert">
                {unsupported} {unsupported === 1 ? 'photo does' : 'photos do'} not support HDR JPEG.
                Choose Auto or SDR JPEG.
              </p>
            )}
            <div className={styles.quality}>
              <AdjustmentInput
                label="JPEG quality"
                value={options.quality}
                min={1}
                max={100}
                step={1}
                precision={0}
                disabled={busy}
                onChange={(quality) => setOptions((o) => ({ ...o, quality }))}
                onCommit={() => {
                  committedQuality.current = options.quality
                }}
                onCancel={() => setOptions((o) => ({ ...o, quality: committedQuality.current }))}
              />
            </div>
            <label>
              Size
              <select
                value={options.size.mode}
                disabled={busy}
                onChange={(event) =>
                  size(
                    event.target.value === 'original'
                      ? { mode: 'original' }
                      : event.target.value === 'longest'
                        ? { mode: 'longest', edge: 2560 }
                        : { mode: 'fit', width: 2560, height: 2560 },
                  )
                }
              >
                <option value="original">Original</option>
                <option value="longest">Longest edge</option>
                <option value="fit">Fit within width / height</option>
              </select>
            </label>
            {options.size.mode === 'longest' && (
              <label>
                Longest edge (px)
                <input
                  type="number"
                  min={1}
                  max={32768}
                  step={1}
                  required
                  disabled={busy}
                  value={Number.isFinite(options.size.edge) ? options.size.edge : ''}
                  onChange={(event) => size({ mode: 'longest', edge: event.target.valueAsNumber })}
                />
              </label>
            )}
            {options.size.mode === 'fit' && (
              <div className={styles.pair}>
                {(['width', 'height'] as const).map((key) => (
                  <label key={key}>
                    {key === 'width' ? 'Width' : 'Height'} (px)
                    <input
                      type="number"
                      min={1}
                      max={32768}
                      step={1}
                      required
                      disabled={busy}
                      value={
                        options.size.mode === 'fit' && Number.isFinite(options.size[key])
                          ? options.size[key]
                          : ''
                      }
                      onChange={(event) => {
                        const value = event.target.valueAsNumber
                        setOptions((o) => ({
                          ...o,
                          size: o.size.mode === 'fit' ? { ...o.size, [key]: value } : o.size,
                        }))
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
            <p>
              Aspect ratio is preserved. Photos are never enlarged. Both HDR renditions use
              identical dimensions.
            </p>
            <label>
              Names
              <select
                value={options.names.mode}
                disabled={busy}
                onChange={(event) =>
                  setOptions((o) => ({
                    ...o,
                    names:
                      event.target.value === 'original'
                        ? { mode: 'original', suffix: '' }
                        : { mode: 'sequence', prefix: 'Photo-' },
                  }))
                }
              >
                <option value="original">Original basename</option>
                <option value="sequence">Custom prefix + sequence</option>
              </select>
            </label>
            <label>
              {options.names.mode === 'original' ? 'Optional suffix' : 'Prefix'}
              <input
                type="text"
                maxLength={100}
                disabled={busy}
                required={options.names.mode === 'sequence'}
                value={
                  options.names.mode === 'original' ? options.names.suffix : options.names.prefix
                }
                onChange={(event) => {
                  const value = event.target.value
                  setOptions((o) => ({
                    ...o,
                    names:
                      o.names.mode === 'original'
                        ? { mode: 'original', suffix: value }
                        : { mode: 'sequence', prefix: value },
                  }))
                }}
              />
            </label>
            <label>
              Metadata
              <select
                disabled={busy}
                value={options.metadata}
                onChange={(event) =>
                  setOptions((o) => ({
                    ...o,
                    metadata: event.target.value as ExportOptions['metadata'],
                  }))
                }
              >
                <option value="camera-copyright">Camera and copyright</option>
                <option value="copyright">Copyright only</option>
                <option value="none">None</option>
              </select>
            </label>
            <label>
              Existing files
              <select
                disabled={busy}
                value={options.existing}
                onChange={(event) =>
                  setOptions((o) => ({
                    ...o,
                    existing: event.target.value as ExportOptions['existing'],
                  }))
                }
              >
                <option value="rename">Rename automatically</option>
                <option value="skip">Skip</option>
              </select>
            </label>
            <p>
              Location, serial numbers, source thumbnails and internal paths are excluded. Required
              color and gain-map information is retained.
            </p>
            {validation && <p role="alert">{validation}</p>}
          </form>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>
      <footer>
        {custom ? (
          <button disabled={busy} onClick={() => setCustom(false)}>
            Back
          </button>
        ) : (
          <span />
        )}
        <div>
          <button disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {custom && (
            <button
              type="submit"
              form="custom-export"
              disabled={busy || !preparation || !!validation || unsupported > 0}
            >
              {busy ? 'Starting…' : 'Export'}
            </button>
          )}
        </div>
      </footer>
    </dialog>
  )
}
