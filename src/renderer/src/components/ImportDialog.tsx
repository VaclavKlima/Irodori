import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, FileImage, FolderOpen, HardDrive, Images, RefreshCw, X } from 'lucide-react'
import {
  PAGE_SIZE,
  type ImportCandidate,
  type ImportReview,
  type ImportVerificationMode,
} from '../../../shared/contracts'
import type { ImportDevice } from '../../../shared/import-devices'
import styles from '../App.module.css'

interface SelectionChange {
  version: number
  ids: string[] | null
  selected: boolean
  previous: boolean
  bytes: number
}

function applySelection(review: ImportReview, changes: SelectionChange[]): ImportReview {
  let current = review
  for (const change of changes) {
    if (change.version <= review.selectionRevision) continue
    const eligible = (candidate: ImportCandidate) =>
      (candidate.status === 'unchecked' || candidate.status === 'ready') &&
      !(current.onlyMissing && candidate.alreadyImported)
    const visible = change.ids && current.candidates.find((item) => item.id === change.ids![0])
    if (visible && !eligible(visible)) continue
    const candidates = current.candidates.map((candidate) =>
      eligible(candidate) && (change.ids === null || change.ids.includes(candidate.id))
        ? { ...candidate, selected: change.selected }
        : candidate,
    )
    const previous = visible ? visible.selected : change.previous
    current = {
      ...current,
      candidates,
      selected:
        change.ids === null
          ? change.selected
            ? current.unchecked +
              current.ready -
              (current.onlyMissing ? current.alreadyImported : 0)
            : 0
          : current.selected + (change.selected === previous ? 0 : change.selected ? 1 : -1),
      selectedBytes:
        change.ids === null
          ? change.selected
            ? current.totalBytes - (current.onlyMissing ? current.alreadyImportedBytes : 0)
            : 0
          : current.selectedBytes +
            (change.selected === previous ? 0 : change.selected ? change.bytes : -change.bytes),
    }
  }
  return current
}

export function ImportDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const candidateFocusRecovery = useRef<{
    sessionId: string
    element: HTMLInputElement
    index: number
  } | null>(null)
  const activeSession = useRef<string | null>(null)
  const selectionQueue = useRef<Promise<void>>(Promise.resolve())
  const selectionChanges = useRef<SelectionChange[]>([])
  const selectionVersion = useRef(0)
  const selectionError = useRef(false)
  const reviewEpoch = useRef(0)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [review, setReview] = useState<ImportReview | null>(null)
  const [offset, setOffset] = useState(0)
  const [recursive, setRecursive] = useState(true)
  const [tab, setTab] = useState<'files' | 'device'>('files')
  const [devices, setDevices] = useState<ImportDevice[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [searchEntire, setSearchEntire] = useState(false)
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [verificationMode, setVerificationMode] = useState<ImportVerificationMode>('camera-fast')
  const verificationOption = useRef<HTMLSelectElement>(null)
  const restoreVerificationFocus = useRef(false)
  const missingOption = useRef<HTMLInputElement>(null)
  const restoreMissingFocus = useRef(false)
  const [deviceError, setDeviceError] = useState('')
  const [refreshingDevices, setRefreshingDevices] = useState(false)
  const deviceRequest = useRef<Promise<void> | null>(null)
  const deviceTabVisible = useRef(false)
  const focusTabAfterSwitch = useRef<'files' | 'device' | null>(null)
  const [pending, setPending] = useState(false)
  const operationsPending = useRef(false)
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const scanning = review?.phase === 'scanning'
  const importing = review?.phase === 'importing'
  const terminal = review?.phase === 'complete' || review?.phase === 'cancelled'
  const selectionDisabled = pending || importing || terminal || !!review?.sourceError

  useLayoutEffect(() => {
    if (pending || !restoreVerificationFocus.current) return
    restoreVerificationFocus.current = false
    verificationOption.current?.focus({ preventScroll: true })
  }, [pending])

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    if (pending || focusTabAfterSwitch.current !== tab) return
    dialog.current
      ?.querySelector<HTMLButtonElement>(
        tab === 'files' ? '#import-files-tab' : '#import-device-tab',
      )
      ?.focus()
    focusTabAfterSwitch.current = null
  }, [pending, tab])

  useEffect(() => {
    if (pending || !restoreMissingFocus.current) return
    restoreMissingFocus.current = false
    if (document.activeElement === document.body || document.activeElement === dialog.current)
      missingOption.current?.focus()
  }, [pending])

  const refreshDevices = useCallback(() => {
    if (deviceRequest.current || !deviceTabVisible.current) return
    setRefreshingDevices(true)
    const request = window.luma.listImportDevices().then(
      (value) => {
        if (deviceTabVisible.current) {
          setDevices(value)
          setDeviceError('')
        }
      },
      (failure) => {
        if (deviceTabVisible.current) setDeviceError(String(failure))
      },
    )
    deviceRequest.current = request
    void request.finally(() => {
      deviceRequest.current = null
      setRefreshingDevices(false)
    })
  }, [])

  useEffect(() => {
    deviceTabVisible.current = tab === 'device'
    if (tab !== 'device') return
    refreshDevices()
    const timer = window.setInterval(refreshDevices, 3000)
    return () => {
      deviceTabVisible.current = false
      window.clearInterval(timer)
    }
  }, [tab, refreshDevices])

  useEffect(() => {
    if (!sessionId || pending) return
    let active = true
    let running = false
    let queued = false
    const update = async () => {
      if (operationsPending.current) return
      if (running) {
        queued = true
        return
      }
      running = true
      do {
        queued = false
        try {
          const epoch = reviewEpoch.current
          const value = await window.luma.getReview(sessionId, offset)
          if (
            active &&
            epoch === reviewEpoch.current &&
            !operationsPending.current &&
            activeSession.current === sessionId
          ) {
            const focused = document.activeElement
            if (
              focused instanceof HTMLInputElement &&
              focused.type === 'checkbox' &&
              grid.current?.contains(focused)
            ) {
              const id = focused.closest<HTMLElement>('[data-candidate-id]')?.dataset.candidateId
              candidateFocusRecovery.current = value.candidates.some((item) => item.id === id)
                ? null
                : {
                    sessionId,
                    element: focused,
                    index: [...grid.current.querySelectorAll('input[type="checkbox"]')].indexOf(
                      focused,
                    ),
                  }
            } else candidateFocusRecovery.current = null
            selectionVersion.current = Math.max(selectionVersion.current, value.selectionRevision)
            setReview(applySelection(value, selectionChanges.current))
          }
        } catch (failure) {
          if (active && !operationsPending.current) setError(String(failure))
        }
      } while (active && queued && !operationsPending.current)
      running = false
    }
    void update()
    const unsubscribe = window.luma.onLibraryEvent((event) => {
      if (event.sessionId === sessionId) void update()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [sessionId, offset, refreshVersion, pending])

  const candidateIds = review?.candidates.map((item) => item.id).join(',') ?? ''
  useLayoutEffect(() => {
    const recovery = candidateFocusRecovery.current
    candidateFocusRecovery.current = null
    if (
      !recovery ||
      recovery.sessionId !== sessionId ||
      recovery.element.isConnected ||
      (document.activeElement !== document.body && document.activeElement !== dialog.current)
    )
      return
    const candidates = grid.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    let nearest: HTMLInputElement | undefined
    let distance = Infinity
    for (const [index, candidate] of Array.from(candidates ?? []).entries()) {
      const candidateDistance = Math.abs(index - recovery.index)
      if (!candidate.disabled && candidateDistance < distance) {
        nearest = candidate
        distance = candidateDistance
      }
    }
    nearest?.focus({ preventScroll: true })
  }, [candidateIds, sessionId])
  const thumbnailsActive = !!review && !review.sourceError && !terminal && !importing && !pending
  useEffect(() => {
    const root = grid.current
    if (!root || !sessionId || !thumbnailsActive) return
    let frame = 0
    let active = true
    let visible: string[] = []
    const request = () => {
      frame = 0
      if (!active || operationsPending.current) return
      void window.luma.requestReviewThumbnails(sessionId, visible).catch((failure) => {
        if (active) setError(String(failure))
      })
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entered: string[] = []
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.candidateId!
          visible = visible.filter((item) => item !== id)
          if (entry.isIntersecting) entered.push(id)
        }
        // Newly visible photographs take priority over work remaining from the old view.
        visible = [...entered, ...visible]
        if (!frame) frame = window.requestAnimationFrame(request)
      },
      { root, threshold: 0 },
    )
    root.querySelectorAll('[data-candidate-id]').forEach((element) => observer.observe(element))
    return () => {
      active = false
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [sessionId, candidateIds, thumbnailsActive, review?.checkingPrevious])

  async function action(work: () => Promise<void>) {
    operationsPending.current = true
    setPending(true)
    setError('')
    try {
      await work()
    } catch (failure) {
      setError(String(failure))
    } finally {
      operationsPending.current = false
      setPending(false)
    }
  }

  function resetReview() {
    reviewEpoch.current++
    candidateFocusRecovery.current = null
    activeSession.current = null
    setSessionId(null)
    setReview(null)
    setOffset(0)
    selectionChanges.current = []
    selectionVersion.current = 0
    selectionError.current = false
  }

  async function disposeReview() {
    const previous = activeSession.current
    await selectionQueue.current
    resetReview()
    if (previous) {
      await window.luma.cancelImport(previous)
      await window.luma.disposeImport(previous)
    }
  }

  function openReview(id: string) {
    activeSession.current = id
    setSessionId(id)
    setOffset(0)
  }

  function choose(kind: 'files' | 'folder') {
    void action(async () => {
      await selectionQueue.current
      const id = await window.luma.chooseSource(kind, recursive)
      if (id) {
        resetReview()
        openReview(id)
      }
    })
  }

  function chooseDevice(id: string, entire = false) {
    const previousMode = searchEntire
    setSearchEntire(entire)
    void action(async () => {
      try {
        await selectionQueue.current
        const next = await window.luma.chooseDevice(id, entire, onlyMissing, verificationMode)
        resetReview()
        setDeviceId(id)
        openReview(next)
      } catch (failure) {
        setSearchEntire(previousMode)
        throw failure
      }
    })
  }

  function changeOnlyMissing(enabled: boolean) {
    const id = activeSession.current
    if (!id || operationsPending.current) return
    reviewEpoch.current++
    restoreMissingFocus.current = document.activeElement === missingOption.current
    void action(async () => {
      await selectionQueue.current
      await window.luma.setImportOnlyMissing(id, enabled)
      setOnlyMissing(enabled)
      const value = await window.luma.getReview(id, offset)
      if (activeSession.current !== id) return
      selectionVersion.current = value.selectionRevision
      selectionChanges.current = selectionChanges.current.filter(
        (change) => change.version > value.selectionRevision,
      )
      setReview(applySelection(value, selectionChanges.current))
    })
  }

  function changeVerificationMode(mode: ImportVerificationMode) {
    const id = activeSession.current
    if (operationsPending.current) return
    if (!id) {
      setVerificationMode(mode)
      return
    }
    reviewEpoch.current++
    restoreVerificationFocus.current = document.activeElement === verificationOption.current
    void action(async () => {
      await selectionQueue.current
      await window.luma.setImportVerificationMode(id, mode)
      setVerificationMode(mode)
      const value = await window.luma.getReview(id, offset)
      if (activeSession.current !== id) return
      selectionVersion.current = value.selectionRevision
      selectionChanges.current = selectionChanges.current.filter(
        (change) => change.version > value.selectionRevision,
      )
      setReview(applySelection(value, selectionChanges.current))
    })
  }

  function switchTab(next: 'files' | 'device') {
    if (next === tab || operationsPending.current) return
    focusTabAfterSwitch.current = next
    void action(async () => {
      try {
        await disposeReview()
        setDeviceId(null)
        setSearchEntire(false)
        setTab(next)
      } catch (failure) {
        focusTabAfterSwitch.current = tab
        throw failure
      }
    })
  }

  function close() {
    if (pending) return
    void action(async () => {
      await disposeReview()
      dialog.current?.close()
      onClose()
    })
  }

  function select(ids: string[] | null, selected: boolean, candidate?: ImportCandidate) {
    const id = activeSession.current
    if (!id) return
    const change: SelectionChange = {
      version: ++selectionVersion.current,
      ids,
      selected,
      previous: candidate?.selected ?? false,
      bytes: candidate?.bytes ?? 0,
    }
    selectionChanges.current.push(change)
    setReview((current) => (current ? applySelection(current, [change]) : current))
    selectionQueue.current = selectionQueue.current.then(async () => {
      try {
        await window.luma.selectCandidates(id, ids, selected)
      } catch (failure) {
        selectionError.current = true
        if (activeSession.current === id) setError(String(failure))
      } finally {
        if (activeSession.current === id) setRefreshVersion((value) => value + 1)
      }
    })
  }

  return (
    <dialog
      ref={dialog}
      className={styles.importDialog}
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header className={styles.importHeader}>
        <div>
          <h1 id="import-title">Import photographs</h1>
          <p>Review your selection. Originals will be copied into your library.</p>
        </div>
        <button
          className={styles.iconButton}
          onClick={close}
          disabled={pending}
          aria-label="Close import"
        >
          <X size={18} />
        </button>
      </header>
      <div
        className={styles.importTabs}
        role="tablist"
        aria-label="Import source"
        onKeyDown={(event) => {
          if (
            !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
            operationsPending.current
          )
            return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 'files'
              : event.key === 'End'
                ? 'device'
                : tab === 'files'
                  ? 'device'
                  : 'files'
          switchTab(next)
        }}
      >
        <button
          id="import-files-tab"
          role="tab"
          tabIndex={tab === 'files' ? 0 : -1}
          aria-selected={tab === 'files'}
          aria-controls="import-source-panel"
          disabled={pending}
          onClick={() => switchTab('files')}
        >
          Files and folders
        </button>
        <button
          id="import-device-tab"
          role="tab"
          tabIndex={tab === 'device' ? 0 : -1}
          aria-selected={tab === 'device'}
          aria-controls="import-source-panel"
          disabled={pending}
          onClick={() => switchTab('device')}
        >
          Import from device
        </button>
      </div>
      <div
        id="import-source-panel"
        role="tabpanel"
        aria-labelledby={tab === 'files' ? 'import-files-tab' : 'import-device-tab'}
        className={styles.importSources}
      >
        {tab === 'files' ? (
          <>
            <button
              className={styles.secondaryButton}
              disabled={pending || importing}
              onClick={() => choose('files')}
            >
              <Images size={15} /> Choose photos
            </button>
            <button
              className={styles.secondaryButton}
              disabled={pending || importing}
              onClick={() => choose('folder')}
            >
              <FolderOpen size={15} /> Choose folder
            </button>
            <label>
              <input
                type="checkbox"
                checked={recursive}
                disabled={pending || importing}
                onChange={(event) => setRecursive(event.target.checked)}
              />{' '}
              Include subfolders
            </label>
          </>
        ) : deviceId ? (
          <>
            <button
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() =>
                void action(async () => {
                  await disposeReview()
                  setDeviceId(null)
                  setSearchEntire(false)
                })
              }
            >
              <HardDrive size={15} /> Change device
            </button>
            <button
              className={styles.secondaryButton}
              disabled={refreshingDevices || pending}
              onClick={refreshDevices}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <button
              className={styles.secondaryButton}
              disabled={pending}
              onClick={() => chooseDevice(deviceId, searchEntire)}
            >
              <RefreshCw size={15} /> Restart review
            </button>
            <label>
              <input
                type="checkbox"
                checked={searchEntire}
                disabled={pending}
                onChange={(event) => chooseDevice(deviceId, event.target.checked)}
              />{' '}
              Search entire device
            </label>
          </>
        ) : (
          <>
            <span className={styles.importDeviceHint}>
              Choose mounted storage to review its photographs.
            </span>
            <button
              className={styles.secondaryButton}
              disabled={refreshingDevices || pending}
              onClick={refreshDevices}
            >
              <RefreshCw size={15} /> Refresh
            </button>
          </>
        )}
      </div>
      {tab === 'device' && (
        <div className={styles.importMissingOption}>
          <label htmlFor="import-verification-mode">
            Repeat-import checks:
            <select
              id="import-verification-mode"
              ref={verificationOption}
              value={review?.verificationMode ?? verificationMode}
              disabled={selectionDisabled}
              aria-describedby="import-verification-description"
              onChange={(event) =>
                changeVerificationMode(event.target.value as ImportVerificationMode)
              }
            >
              <option value="camera-fast">Fast camera checks</option>
              <option value="full">Full verification</option>
            </select>
          </label>
          <span id="import-verification-description">
            Fast trusts unchanged camera originals. Same-size edits with preserved timestamps may be
            missed. Full verification checks complete contents.
          </span>
        </div>
      )}
      {tab === 'device' && deviceId && (
        <div className={styles.importMissingOption}>
          <label>
            <input
              ref={missingOption}
              type="checkbox"
              checked={review?.onlyMissing ?? onlyMissing}
              disabled={selectionDisabled}
              aria-describedby="import-missing-description"
              onChange={(event) => changeOnlyMissing(event.target.checked)}
            />
            Import only missing photos
          </label>
          <span id="import-missing-description">
            Skip copying photos already in your library. New or unchecked files still receive
            duplicate checks during import.
          </span>
        </div>
      )}
      {(error || review?.sourceError) && (
        <p className={styles.errorBanner} role="alert">
          {error || review?.sourceError}
        </p>
      )}
      {tab === 'device' && deviceError && (
        <p className={`${styles.errorBanner} ${styles.importDeviceError}`} role="alert">
          <span>Could not refresh devices: {deviceError}</span>
          <button
            className={styles.secondaryButton}
            disabled={refreshingDevices}
            onClick={refreshDevices}
          >
            Retry
          </button>
        </p>
      )}
      {review ? (
        <>
          <div className={styles.importSummary} role="status" data-testid="import-status">
            <strong>
              {review.sourceError
                ? 'Source unavailable'
                : review.verificationPending && review.checkingPrevious
                  ? `Checking previous import: ${review.checkingPrevious}`
                  : scanning
                    ? review.checkingPrevious
                      ? `Checking previous import: ${review.checkingPrevious}`
                      : 'Finding photographs…'
                    : importing
                      ? 'Copying originals…'
                      : terminal
                        ? review.phase === 'cancelled'
                          ? 'Import cancelled'
                          : 'Import complete'
                        : 'Ready to import'}
            </strong>
            <span>
              {review.total} found ·{' '}
              {review.onlyMissing !== undefined
                ? `${review.alreadyImported} already in library · ${Math.max(0, review.unchecked + review.ready - review.alreadyImported)} new or unchecked`
                : `${review.unchecked} awaiting checks`}{' '}
              · {review.duplicates} duplicates · {review.errors} errors · {review.imported} imported
              {review.skipped ? ` · ${review.skipped} skipped` : ''}
            </span>
            <span className={styles.importSourceName}>{review.source}</span>
          </div>
          <div className={styles.importSelection}>
            <button disabled={selectionDisabled} onClick={() => select(null, true)}>
              Select all
            </button>
            <button disabled={selectionDisabled} onClick={() => select(null, false)}>
              Deselect all
            </button>
            <span>
              {review.selected} selected · {formatBytes(review.selectedBytes)}
            </span>
          </div>
          <div
            ref={grid}
            className={styles.importGrid}
            aria-label="Import candidates"
            onBlurCapture={(event) => {
              if (event.target === candidateFocusRecovery.current?.element)
                candidateFocusRecovery.current = null
            }}
          >
            {review.candidates.map((candidate) => (
              <label
                key={candidate.id}
                data-candidate-id={candidate.id}
                className={`${styles.importCard} ${candidate.selected ? styles.importSelected : ''}`}
                title={candidate.relativePath}
              >
                <div className={styles.importThumbnail}>
                  {candidate.thumbnailUrl ? (
                    <img src={candidate.thumbnailUrl} alt="" loading="lazy" />
                  ) : (
                    <FileImage size={30} strokeWidth={1} />
                  )}
                  <input
                    type="checkbox"
                    aria-label={`Import ${candidate.filename}`}
                    aria-describedby={
                      candidate.alreadyImported ? `import-candidate-${candidate.id}` : undefined
                    }
                    checked={candidate.selected}
                    disabled={
                      selectionDisabled ||
                      (review.onlyMissing && candidate.alreadyImported) ||
                      (candidate.status !== 'unchecked' && candidate.status !== 'ready')
                    }
                    onChange={(event) => select([candidate.id], event.target.checked, candidate)}
                  />
                </div>
                <strong>{candidate.filename}</strong>
                <span id={`import-candidate-${candidate.id}`}>
                  {candidate.alreadyImported
                    ? 'Already in library'
                    : (candidate.message ??
                      (candidate.status === 'imported'
                        ? 'Imported'
                        : candidate.thumbnailState === 'loading'
                          ? 'Loading thumbnail…'
                          : candidate.thumbnailState === 'error'
                            ? 'Thumbnail unavailable'
                            : formatBytes(candidate.bytes)))}
                </span>
              </label>
            ))}
            {!review.total && !scanning && (
              <p className={styles.importEmpty}>
                No supported photographs found.
                {tab === 'device' && !searchEntire ? ' Try Search entire device.' : ''}
              </p>
            )}
          </div>
          {review.total > PAGE_SIZE && (
            <nav className={styles.pageControls} aria-label="Import pages">
              <button
                disabled={offset === 0}
                onClick={() => {
                  grid.current?.scrollTo(0, 0)
                  setOffset(offset - PAGE_SIZE)
                }}
              >
                Previous
              </button>
              <span>
                {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(review.total / PAGE_SIZE)}
              </span>
              <button
                disabled={offset + PAGE_SIZE >= review.total}
                onClick={() => {
                  grid.current?.scrollTo(0, 0)
                  setOffset(offset + PAGE_SIZE)
                }}
              >
                Next
              </button>
            </nav>
          )}
        </>
      ) : tab === 'device' && !deviceId ? (
        <div className={styles.importDeviceList} aria-label="Mounted import devices">
          {devices.map((device) => (
            <button
              key={device.id}
              className={styles.importDevice}
              disabled={!device.available || pending}
              aria-label={`Import from ${device.name}`}
              onClick={() => chooseDevice(device.id)}
            >
              <HardDrive size={25} strokeWidth={1} />
              <span>
                <strong>{device.name}</strong>
                <span>
                  {device.capacityBytes === null
                    ? 'Capacity unavailable'
                    : formatBytes(device.capacityBytes)}{' '}
                  ·{' '}
                  {device.available
                    ? `${device.volumeCount} mounted ${device.volumeCount === 1 ? 'volume' : 'volumes'}`
                    : 'Unavailable'}
                </span>
              </span>
            </button>
          ))}
          {!devices.length && (
            <div className={styles.importEmpty}>
              <HardDrive size={38} strokeWidth={1} />
              <h2>{refreshingDevices ? 'Looking for devices…' : 'No mounted devices found'}</h2>
              <p>Connect an SD card, USB drive, or a mounted camera, then refresh.</p>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.importEmpty}>
          <FolderOpen size={38} strokeWidth={1} />
          <h2>{deviceId ? 'Finding photographs…' : 'Start with a photo or a folder'}</h2>
          <p>JPEG, PNG, TIFF, and Sony ARW files are supported.</p>
          <p>
            Discovered photographs are selected by default. Duplicate and validity checks run during
            import.
          </p>
        </div>
      )}
      <footer className={styles.importFooter}>
        <span>Original files stay untouched.</span>
        <button className={styles.secondaryButton} disabled={pending} onClick={close}>
          {terminal ? 'Done' : 'Cancel'}
        </button>
        {!terminal && (
          <button
            className={styles.primaryButton}
            disabled={
              pending ||
              scanning ||
              importing ||
              review?.verificationPending ||
              !review?.selected ||
              !!review.sourceError
            }
            onClick={() =>
              void action(async () => {
                const id = activeSession.current!
                await selectionQueue.current
                if (selectionError.current)
                  throw new Error(
                    'Selection could not be saved. Restart the review before importing.',
                  )
                await window.luma.importSelected(id)
                activeSession.current = null
                dialog.current?.close()
                onStarted(id)
              })
            }
          >
            <Check size={15} /> Import {review?.selected ?? 0} photos
          </button>
        )}
      </footer>
    </dialog>
  )
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return bytes < 1024 ** 2
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
