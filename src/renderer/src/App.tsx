import { MergeDialog } from './components/MergeDialog'
import type { MergeMode } from '../../shared/merge'
import type { StackSummary } from '../../shared/stacks'
import { DisplayDetails } from './components/DisplayDetails'
import { useDisplayState } from './hooks/useDisplayState'
import type { PreviewPreference } from '../../shared/hdr-display'
import { usePreviewTools } from './hooks/usePreviewTools'
import { useEdits } from './hooks/useEdits'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Aperture,
  ArrowDownToLine,
  ArrowUpFromLine,
  Columns2,
  Crop,
  FileImage,
  Redo2,
  SlidersHorizontal,
  TerminalSquare,
  Undo2,
} from 'lucide-react'
import {
  type AppInfo,
  type Photo,
  type PhotoReference,
  type BackgroundTask,
} from '../../shared/contracts'
import { Library } from './components/Library'
import { Inspector } from './components/Inspector'
import { Console } from './components/Console'
import { ImportDialog } from './components/ImportDialog'
import { TaskCenter } from './components/TaskCenter'
import { useLibrary } from './hooks/useLibrary'
import { DeleteDialog } from './components/DeleteDialog'
import { PhotoContextMenu } from './components/PhotoContextMenu'
import { PhotoPreview } from './components/PhotoPreview'
import styles from './App.module.css'

export function App() {
  const [mergeTargets, setMergeTargets] = useState<{ ids: string[]; mode: MergeMode } | null>(null)
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [error, setError] = useState('')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const consoleToggleRef = useRef<HTMLButtonElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const library = useLibrary(setError)
  const {
    total,
    offset,
    position,
    photo,
    selected,
    refresh,
    onEvent,
    select,
    navigate,
    changePage,
    openPhoto,
    getSelection,
  } = library
  const edits = useEdits(photo?.id)
  const displayTarget = useDisplayState()
  const previewTools = usePreviewTools(photo?.id)
  const [interactivePhoto, setInteractivePhoto] = useState<string | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<PhotoReference[] | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    targets: PhotoReference[]
    stack: StackSummary | null
    photoId: string | null
    revision: number
    canGroup: boolean
    busy: boolean
  } | null>(null)
  const actionOrigin = useRef<HTMLElement | null>(null)
  const restoreFocus = useCallback(() => {
    const origin = actionOrigin.current
    if (origin?.isConnected) origin.focus()
    else if (origin?.dataset.testid === 'main-preview')
      document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.focus()
    else document.querySelector<HTMLElement>('[data-testid="photo-library"]')?.focus()
  }, [])
  const closeContextMenu = useCallback(
    (restore = false) => {
      setContextMenu(null)
      if (restore) restoreFocus()
    },
    [restoreFocus],
  )
  const requestDeletion = useCallback(
    async (requestedTargets?: PhotoReference[]) => {
      try {
        const targets = requestedTargets ?? (await getSelection())
        if (!targets.length) return
        const current = await window.luma.listTasks()
        setTasks(current)
        setContextMenu(null)
        if (current.some((task) => task.status === 'running' || task.status === 'cancelling')) {
          setTasksOpen(true)
          return
        }
        setTasksOpen(false)
        setDeleteTargets(targets)
      } catch (error) {
        setError(String(error))
      }
    },
    [getSelection],
  )
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.key !== 'Delete' && event.key !== 'Backspace') ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector('dialog[open]') ||
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), #agent-console',
        )
      )
        return
      event.preventDefault()
      if (!contextMenu) actionOrigin.current = document.activeElement as HTMLElement | null
      void requestDeletion(contextMenu?.targets)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [selected, requestDeletion, contextMenu])

  function showContextMenu(photo: Photo, element: HTMLElement, x: number, y: number) {
    actionOrigin.current = element
    setTasksOpen(false)
    void library
      .contextSelect(photo)
      .then((targets) => loadActions(x, y, targets, photo.id))
      .catch((error) => setError(String(error)))
  }

  const completedMerges = useRef<Set<string> | null>(null)
  const refreshTasks = useCallback(async () => {
    try {
      const current = await window.luma.listTasks()
      setTasks(current)
      if (!current.length) setTasksOpen(false)
      const completed = current.filter(
        (task) => task.kind === 'merge' && task.status === 'completed' && task.resultPhotoId,
      )
      if (!completedMerges.current) {
        completedMerges.current = new Set(completed.map((task) => task.id))
      } else {
        for (const task of completed) {
          if (completedMerges.current.has(task.id)) continue
          completedMerges.current.add(task.id)
          void openPhoto(task.resultPhotoId!)
        }
      }
    } catch (error) {
      setError(String(error))
    }
  }, [openPhoto])
  const dismissTask = useCallback(
    async (id: string) => {
      await window.luma.dismissTask(id)
      await refreshTasks()
    },
    [refreshTasks],
  )

  useEffect(() => {
    void window.luma.getAppInfo().then(setAppInfo, (error) => setError(String(error)))
    // These refreshes update state only after the desktop bridge responds.
    void refresh()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshTasks()
    return window.luma.onLibraryEvent((event) => {
      onEvent(event)
      if (event.tasksChanged) void refreshTasks()
    })
  }, [refresh, refreshTasks, onEvent])

  useEffect(() => {
    const timers = tasks
      .filter(
        (task) =>
          task.kind !== 'merge' && task.status === 'completed' && task.finishedAt !== undefined,
      )
      .map((task) =>
        setTimeout(
          () => {
            void dismissTask(task.id).catch((error) => setError(String(error)))
          },
          Math.max(0, task.finishedAt! + 5000 - Date.now()),
        ),
      )
    return () => timers.forEach(clearTimeout)
  }, [tasks, dismissTask])

  async function openActions(element: HTMLElement) {
    actionOrigin.current = element
    const box = element.getBoundingClientRect()
    try {
      await loadActions(box.left, box.bottom + 4, await getSelection(), photo?.id ?? null)
    } catch (error) {
      setError(String(error))
    }
  }
  async function loadActions(
    x: number,
    y: number,
    targets: PhotoReference[],
    photoId: string | null,
  ) {
    const [overview, stack, currentTasks, groups] = await Promise.all([
      window.luma.listStacks(),
      photoId ? window.luma.getPhotoStack(photoId) : Promise.resolve(null),
      window.luma.listTasks(),
      Promise.all(targets.map((p) => window.luma.getPhotoStack(p.id))),
    ])
    setContextMenu({
      x,
      y,
      targets,
      photoId,
      stack,
      revision: overview.revision,
      canGroup: targets.length >= 2 && groups.every((s) => !s),
      busy: currentTasks.some((t) => t.status === 'running' || t.status === 'cancelling'),
    })
  }
  async function stackAction(action: 'group' | 'ungroup' | 'remove' | 'cover' | 'select' | 'scan') {
    const menu = contextMenu
    if (!menu) return
    setContextMenu(null)
    try {
      const stack = menu.stack
      if (action === 'group') {
        const ids = menu.targets.map((p) => p.id)
        await window.luma.groupPhotos(
          ids,
          menu.photoId && ids.includes(menu.photoId) ? menu.photoId : ids[0],
          menu.revision,
        )
      } else if (action === 'scan') {
        await window.luma.groupCaptureSequences()
        await refreshTasks()
        setTasksOpen(true)
      } else if (stack) {
        if (action === 'ungroup') await window.luma.ungroupStack(stack.id, stack.revision)
        if (action === 'remove' && menu.photoId)
          await window.luma.removeFromStack(menu.photoId, stack.revision)
        if (action === 'cover' && menu.photoId)
          await window.luma.setStackCover(stack.id, menu.photoId, stack.revision)
        if (action === 'select') await library.selectStack(stack.id)
      }
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      restoreFocus()
    }
  }
  function openMerge(mode: MergeMode) {
    if (!contextMenu) return
    setMergeTargets({ ids: contextMenu.targets.map((p) => p.id), mode })
    setContextMenu(null)
  }
  async function openResult(id: string) {
    await openPhoto(id)
    setTasksOpen(false)
  }

  async function openImport() {
    try {
      const current = await window.luma.listTasks()
      setTasks(current)
      if (current.some((task) => task.status === 'running' || task.status === 'cancelling'))
        setTasksOpen(true)
      else {
        setTasksOpen(false)
        setImportOpen(true)
      }
    } catch (error) {
      setError(String(error))
    }
  }

  function closeReview() {
    setImportOpen(false)
    importButtonRef.current?.focus()
  }

  return (
    <div className={styles.app}>
      <header className={styles.appHeader}>
        <div className={styles.brand}>
          <Aperture size={23} strokeWidth={1.35} />
          <span>luma</span>
          <span className={styles.brandDivider} />
          <span className={styles.workspaceName}>My library</span>
        </div>
        <div className={styles.workspaceMode}>
          <SlidersHorizontal size={13} />
          <span>Library</span>
        </div>
        <div className={styles.headerActions}>
          <button aria-haspopup="menu" onClick={(event) => void openActions(event.currentTarget)}>
            Actions
          </button>
          <button
            className={styles.headerButton}
            onClick={() => void openImport()}
            aria-label="Import photos"
            ref={importButtonRef}
          >
            <ArrowDownToLine size={14} /> Import
          </button>
          <button className={styles.exportButton} disabled aria-label="Export photo">
            <ArrowUpFromLine size={14} /> Export
          </button>
        </div>
      </header>

      <div className={styles.editor} data-testid="workspace">
        <Library
          entries={library.entries}
          total={total}
          storedTotal={library.storedTotal}
          hiddenSelectedIds={library.hiddenSelectedIds}
          hiddenActiveCover={library.hiddenActiveCover}
          onExpand={(stack) => {
            void window.luma
              .setStackExpanded(stack.id, !stack.expanded, stack.revision)
              .then(() => refresh())
              .catch((error) => {
                setError(String(error))
                void refresh()
              })
          }}
          offset={offset}
          onPage={(start) => {
            void changePage(start).catch((error) => setError(String(error)))
          }}
          selectedIds={selected}
          activeId={photo?.id ?? null}
          reveal={library.reveal}
          onSelect={(photo, modifiers) => {
            void select(photo, modifiers)
          }}
          onContextMenu={showContextMenu}
          onImport={() => void openImport()}
        />

        <main className={styles.workspace} aria-label="Photo workspace">
          <div className={styles.previewToolbar}>
            <div className={styles.filename}>
              <FileImage size={13} />
              <span data-testid="preview-filename">{photo?.filename ?? 'No photo selected'}</span>
              <select
                aria-label="Preview display mode"
                value={displayTarget.requested}
                onChange={(event) => {
                  void window.luma
                    .setPreviewPreference(event.target.value as PreviewPreference)
                    .catch((error) => setError(String(error)))
                }}
              >
                <option value="auto">Auto</option>
                <option value="hdr">HDR</option>
                <option value="sdr">SDR</option>
              </select>
              <DisplayDetails
                target={displayTarget}
                photoId={photo?.id}
                hdr={edits.state?.settings.processing === 'hdr-v1'}
              />
            </div>
            <div className={styles.previewActions}>
              <button
                className={styles.iconButton}
                disabled={edits.saving || !edits.state?.canUndo}
                onClick={() => void edits.history('undo')}
                aria-label="Undo"
                title="Undo photo edit (Ctrl/Cmd+Z)"
              >
                <Undo2 size={15} />
              </button>
              <button
                className={styles.iconButton}
                disabled={edits.saving || !edits.state?.canRedo}
                onClick={() => void edits.history('redo')}
                aria-label="Redo"
                title="Redo photo edit (Ctrl/Cmd+Shift+Z)"
              >
                <Redo2 size={15} />
              </button>
              <span className={styles.toolbarDivider} />
              <button className={styles.iconButton} disabled aria-label="Crop photo">
                <Crop size={15} />
              </button>
              <button
                className={`${styles.iconButton} ${styles.beforeButton}`}
                disabled={!photo || interactivePhoto !== photo.id}
                aria-pressed={previewTools.mode === 'before'}
                onClick={() =>
                  previewTools.update({ mode: previewTools.mode === 'before' ? 'after' : 'before' })
                }
                title="Before (\)"
              >
                Before
              </button>
              <button
                className={styles.iconButton}
                disabled={!photo || interactivePhoto !== photo.id}
                aria-label="Compare before and after"
                aria-pressed={previewTools.mode === 'split'}
                onClick={() =>
                  previewTools.update({ mode: previewTools.mode === 'split' ? 'after' : 'split' })
                }
                title="Split (Y)"
              >
                <Columns2 size={15} />
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className={styles.errorBanner}>
              {error}
            </p>
          )}
          {edits.error && (
            <p role="alert" className={styles.errorBanner}>
              {edits.error}
            </p>
          )}
          <PhotoPreview
            suspended={!!mergeTargets}
            displayTarget={displayTarget}
            key={photo?.id ?? 'empty'}
            photo={photo}
            adjustments={edits.adjustments}
            tools={previewTools}
            gesturing={edits.gesturing}
            editingEpoch={edits.epoch}
            onEditingReady={setInteractivePhoto}
            total={total}
            position={position}
            onNavigate={navigate}
            onImport={() => void openImport()}
            onContextMenu={showContextMenu}
          />

          {consoleOpen && (
            <Console
              onClose={() => {
                setConsoleOpen(false)
                consoleToggleRef.current?.focus()
              }}
            />
          )}
        </main>

        <Inspector
          tools={previewTools}
          photo={photo}
          edits={edits}
          previewReady={!!photo && interactivePhoto === photo.id}
        />
      </div>

      <footer className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={styles.statusDot} />
          <span>Local library</span>
          <span className={styles.statusSeparator}>/</span>
          <span>{total} photographs</span>
        </div>
        <TaskCenter
          onOpenResult={openResult}
          tasks={tasks}
          open={tasksOpen}
          onOpenChange={setTasksOpen}
          onCancel={window.luma.cancelTask}
          onDismiss={dismissTask}
          getErrors={window.luma.getTaskErrors}
        />
        <div className={styles.statusRight}>
          <button
            className={`${styles.consoleToggle} ${consoleOpen ? styles.consoleToggleOpen : ''}`}
            data-testid="console-toggle"
            ref={consoleToggleRef}
            aria-expanded={consoleOpen}
            aria-controls="agent-console"
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            <TerminalSquare size={13} /> Console
          </button>
          <span className={styles.version} data-testid="app-version">
            {appInfo ? `v${appInfo.version}` : 'Starting…'}
          </span>
        </div>
      </footer>
      {contextMenu && (
        <PhotoContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          count={contextMenu.targets.length}
          stack={contextMenu.stack}
          canGroup={contextMenu.canGroup}
          canSetCover={contextMenu.photoId !== contextMenu.stack?.coverId}
          busy={contextMenu.busy}
          onStackAction={(action) => void stackAction(action)}
          onClose={closeContextMenu}
          onDelete={() => void requestDeletion(contextMenu.targets)}
          onMerge={openMerge}
        />
      )}
      {mergeTargets && (
        <MergeDialog
          ids={mergeTargets.ids}
          mode={mergeTargets.mode}
          onClose={() => {
            setMergeTargets(null)
            restoreFocus()
          }}
          onStarted={() => {
            setMergeTargets(null)
            restoreFocus()
            void refreshTasks()
          }}
        />
      )}
      {deleteTargets && (
        <DeleteDialog
          photos={deleteTargets}
          onClose={() => {
            setDeleteTargets(null)
            restoreFocus()
          }}
          onStarted={() => {
            setDeleteTargets(null)
            restoreFocus()
            void refreshTasks()
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          onClose={closeReview}
          onStarted={() => {
            closeReview()
            void refreshTasks()
          }}
        />
      )}
    </div>
  )
}
