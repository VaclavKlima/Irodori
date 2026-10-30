import { configureCollections } from './collections/controller'
import { APP_NAME, APP_TAGLINE } from '../../shared/app-identity'
import { useWorkspaceCheckpoint } from './hooks/useWorkspaceCheckpoint'
import {
  DEFAULT_INSPECTOR_SECTIONS,
  DEFAULT_CREATIVE_COLOR_SELECTION,
  type CreativeColorSelection,
  type InspectorSections,
  type WorkspaceState,
} from '../../shared/workspace'
import { MergeDialog } from './components/MergeDialog'
import { PasteEditsDialog } from './components/PasteEditsDialog'
import { ExportDialog } from './components/ExportDialog'
import { ResourceSettingsDialog } from './components/ResourceSettingsDialog'
import type { ResourceSettings } from '../../shared/resource-policy'
import { groupMergeUnavailable, type MergeMode } from '../../shared/merge'
import type { PhotoActionId, PhotoActionsContext } from '../../shared/photo-actions'
import { DisplayDetails } from './components/DisplayDetails'
import { useDisplayState } from './hooks/useDisplayState'
import type { PreviewPreference } from '../../shared/hdr-display'
import { usePreviewTools } from './hooks/usePreviewTools'
import { useEdits } from './hooks/useEdits'
import { useWhiteBalancePicker } from './hooks/useWhiteBalancePicker'
import { useCrop } from './hooks/useCrop'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Aperture,
  ArrowDownToLine,
  ArrowUpFromLine,
  Columns2,
  Crop,
  FileImage,
  Images,
  Redo2,
  Settings,
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
import { AllPhotos } from './components/AllPhotos'
import type { BrowsePhoto } from '../../shared/browse'
import { Inspector } from './components/Inspector'
import { Console } from './components/Console'
import { ImportDialog } from './components/ImportDialog'
import { TaskCenter } from './components/TaskCenter'
import { useLibrary } from './hooks/useLibrary'
import { DeleteDialog } from './components/DeleteDialog'
import { PhotoContextMenu, type MenuInitialFocus } from './components/PhotoContextMenu'
import { PhotoPreview } from './components/PhotoPreview'
import { selectEditorPreviewPolicy } from '../../shared/editor-preview-policy'
import styles from './App.module.css'
import { imageResourceOwners } from './preview/image-resource-owners'
import { rendererImageResources } from './preview/hdr-preview-resources'

interface MenuState {
  x: number
  y: number
  context: PhotoActionsContext
  toolbar: boolean
  initialFocus: MenuInitialFocus
}

interface MergeHandoff {
  taskId: string
  photoId: string | null
  automatic: boolean
  opening: boolean
}

const loadResourceSettings = () => window.irodori.getResourceSettings()
const saveResourceSettings = (settings: ResourceSettings) =>
  window.irodori.setResourceSettings(settings)

export function App() {
  useEffect(
    () =>
      window.irodori.onImageResourceQuery(() => {
        const fixed = rendererImageResources(),
          live = imageResourceOwners.snapshot()
        return {
          ramBytes: fixed.ramBytes + live.ramBytes,
          vramBytes: fixed.vramBytes + live.vramBytes,
        }
      }),
    [],
  )
  const recovery = useWorkspaceCheckpoint()
  const { checkpoint, patch: saveWorkspace } = recovery
  const [hydrated, setHydrated] = useState(false)
  const [recoveredState, setRecoveredState] = useState<WorkspaceState | null>(null)
  const [restoringPreview, setRestoringPreview] = useState<WorkspaceState['preview']>(null)
  const clearRecoveredPreview = useCallback(() => setRestoringPreview(null), [])
  const [editorFocusId, setEditorFocusId] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<'editor' | 'library'>('editor')
  const workspaceRef = useRef(workspace)
  const [mergeHandoffPhoto, setMergeHandoffPhoto] = useState<string | null>(null)
  const mergeHandoffRef = useRef<MergeHandoff | null>(null)
  const finishMergeHandoff = useCallback((handoff: MergeHandoff) => {
    if (mergeHandoffRef.current !== handoff) return
    mergeHandoffRef.current = null
    setMergeHandoffPhoto(null)
  }, [])
  const resumeEditing = useCallback(() => {
    const handoff = mergeHandoffRef.current
    if (!handoff?.automatic) return
    handoff.automatic = false
    setMergeHandoffPhoto(null)
  }, [])
  const switchWorkspace = (next: 'editor' | 'library') => {
    resumeEditing()
    workspaceRef.current = next
    setWorkspace(next)
  }
  const [browserPhoto, setBrowserPhoto] = useState<BrowsePhoto | null>(null)
  const browserPhotoRef = useRef<BrowsePhoto | null>(null)
  const focusBrowserPhoto = useCallback((photo: BrowsePhoto | null) => {
    browserPhotoRef.current = photo
    setBrowserPhoto(photo)
  }, [])
  const [mergeTargets, setMergeTargets] = useState<{ ids: string[]; mode: MergeMode } | null>(null)
  const [pasteTargets, setPasteTargets] = useState<string[] | null>(null)
  const [exportTargets, setExportTargets] = useState<string[] | null>(null)
  const [preparingExport, setPreparingExport] = useState(false)
  const [tasks, setTasks] = useState<BackgroundTask[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState('')
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [inspectorSections, setInspectorSections] = useState<InspectorSections>({
    ...DEFAULT_INSPECTOR_SECTIONS,
  })
  const [creativeColorSelection, setCreativeColorSelection] = useState<CreativeColorSelection>({
    ...DEFAULT_CREATIVE_COLOR_SELECTION,
  })
  const changeCreativeColorSelection = useCallback(
    (creativeColor: CreativeColorSelection) => {
      setCreativeColorSelection(creativeColor)
      saveWorkspace({ creativeColor })
    },
    [saveWorkspace],
  )
  const changeInspectorSections = useCallback(
    (inspector: InspectorSections) => {
      setInspectorSections(inspector)
      saveWorkspace({ inspector })
    },
    [saveWorkspace],
  )
  const consoleToggleRef = useRef<HTMLButtonElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const editorPreviewPolicy = selectEditorPreviewPolicy(appInfo?.platform ?? null)
  const library = useLibrary(setError, clearRecoveredPreview)
  const {
    total,
    position,
    photo,
    selected,
    refresh,
    onEvent,
    select,
    navigate,
    openPhoto,
    getSelection,
    hydrate,
  } = library
  const edits = useEdits(photo?.id, workspace === 'editor')
  const displayTarget = useDisplayState()
  const previewTools = usePreviewTools(photo?.id)
  const [interactivePhoto, setInteractivePhoto] = useState<string | null>(null)
  const crop = useCrop(
    edits,
    photo?.id,
    workspace === 'editor' && !!photo && !mergeTargets && !importOpen && !settingsOpen,
    !!photo && interactivePhoto === photo.id,
    (id, crop, revision) => window.irodori.updateEdits(id, { crop }, revision),
  )
  const whiteBalancePicker = useWhiteBalancePicker(
    edits,
    photo?.id,
    workspace === 'editor' && !!photo && !crop.active && !crop.pending,
    !!photo && interactivePhoto === photo.id,
  )
  const startCrop = async () => {
    if (!crop.supported || crop.pending) return
    whiteBalancePicker.cancel()
    previewTools.update({ mode: 'after' })
    changeInspectorSections({ ...inspectorSections, crop: true })
    await crop.start()
  }
  const cropTool = { ...crop, start: startCrop }
  const presentationTools = crop.active
    ? {
        ...previewTools,
        mode: 'after' as const,
        hdrRanges: false,
        hdrOverlay: 0,
        shadows: false,
        highlights: false,
        hover: null,
      }
    : previewTools
  const [deleteTargets, setDeleteTargets] = useState<readonly PhotoReference[] | null>(null)
  const [contextMenu, setContextMenu] = useState<MenuState | null>(null)
  const contextMenuRef = useRef<MenuState | null>(null)
  const updateMenu = useCallback((menu: MenuState | null) => {
    contextMenuRef.current = menu
    setContextMenu(menu)
  }, [])
  const availabilityGeneration = useRef(0)
  const actionsButtonRef = useRef<HTMLButtonElement>(null)
  const [loadingActions, setLoadingActions] = useState(false)
  const [toolbarLoading, setToolbarLoading] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const actionsGeneration = useRef(0)
  const activeAction = useRef<number | null>(null)
  const actionOrigin = useRef<HTMLElement | null>(null)
  const restoreFocus = useCallback(() => {
    const origin = actionOrigin.current
    if (origin?.isConnected) origin.focus()
    else if (origin?.dataset.testid === 'main-preview')
      document.querySelector<HTMLElement>('[data-testid="main-preview"]')?.focus()
    else
      document
        .querySelector<HTMLElement>(
          workspaceRef.current === 'library'
            ? '[data-testid="browse-grid"]'
            : '[data-testid="photo-library"]',
        )
        ?.focus()
  }, [])
  const closeContextMenu = useCallback(
    (restore = false) => {
      actionsGeneration.current++
      activeAction.current = null
      setLoadingActions(false)
      setToolbarLoading(false)
      setActionPending(false)
      updateMenu(null)
      if (restore) restoreFocus()
    },
    [restoreFocus, updateMenu],
  )
  const waitingForActions = loadingActions || (actionPending && !contextMenu)
  useEffect(() => {
    if (!waitingForActions) return
    const outside = () => closeContextMenu(false)
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      if (event.key === 'Escape') event.preventDefault()
      closeContextMenu(true)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keydown)
    window.addEventListener('resize', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', keydown)
      window.removeEventListener('resize', outside)
    }
  }, [waitingForActions, closeContextMenu])
  useEffect(
    () => () => {
      actionsGeneration.current++
    },
    [],
  )

  const beginAction = useCallback(() => {
    if (activeAction.current !== null) return null
    const ticket = ++actionsGeneration.current
    activeAction.current = ticket
    setLoadingActions(false)
    setActionPending(true)
    return ticket
  }, [])
  const actionFailed = useCallback(
    (ticket: number, error: unknown) => {
      if (ticket !== actionsGeneration.current) return
      closeContextMenu(true)
      setError(String(error))
    },
    [closeContextMenu],
  )
  const confirmDeletion = useCallback(
    async (targets: readonly PhotoReference[], ticket: number) => {
      if (!targets.length || ticket !== actionsGeneration.current) return
      const frozen = Object.freeze(
        [...new Map(targets.map((photo) => [photo.id, photo])).values()].map(({ id, filename }) =>
          Object.freeze({ id, filename }),
        ),
      )
      const current = await window.irodori.listTasks()
      if (ticket !== actionsGeneration.current) return
      setTasks(current)
      closeContextMenu(false)
      if (
        current.some(
          (task) =>
            task.kind === 'capture-grouping' &&
            (task.status === 'running' || task.status === 'cancelling'),
        )
      ) {
        setTasksOpen(true)
        return
      }
      setTasksOpen(false)
      setDeleteTargets(frozen)
    },
    [closeContextMenu],
  )
  const requestDeletion = useCallback(
    async (requestedTargets?: readonly PhotoReference[]) => {
      const ticket = beginAction()
      if (ticket === null) return
      try {
        const selection = await getSelection()
        await confirmDeletion(requestedTargets ?? selection, ticket)
      } catch (error) {
        actionFailed(ticket, error)
      } finally {
        if (activeAction.current === ticket) {
          activeAction.current = null
          setActionPending(false)
        }
      }
    },
    [getSelection, beginAction, confirmDeletion, actionFailed],
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
      // A deletion shortcut supersedes a pending menu action and always targets selection.
      if (contextMenu && activeAction.current !== null) closeContextMenu(false)
      void requestDeletion()
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [selected, requestDeletion, contextMenu, closeContextMenu])

  function showContextMenu(photo: Photo, element: HTMLElement, x: number, y: number) {
    closeContextMenu(false)
    const ticket = actionsGeneration.current
    actionOrigin.current = element
    setTasksOpen(false)
    setLoadingActions(true)
    setToolbarLoading(false)
    void library
      .contextSelect(photo, workspace === 'library')
      .then(async () => loadActions(ticket, x, y, await getSelection(), false, 'preferred'))
      .catch((error) => actionFailed(ticket, error))
  }

  const refreshMenu = useCallback(async () => {
    const menu = contextMenuRef.current
    if (!menu || activeAction.current !== null) return
    const generation = actionsGeneration.current
    const read = ++availabilityGeneration.current
    try {
      const context = await window.irodori.getPhotoActionsContext(
        menu.context.photo?.id ?? null,
        menu.context.selection.map((p) => p.id),
      )
      if (
        generation !== actionsGeneration.current ||
        read !== availabilityGeneration.current ||
        activeAction.current !== null ||
        !contextMenuRef.current
      )
        return
      if (!context.targetsCurrent || context.targetIdentity !== menu.context.targetIdentity)
        closeContextMenu(true)
      else updateMenu({ ...menu, context })
    } catch (error) {
      if (
        generation === actionsGeneration.current &&
        read === availabilityGeneration.current &&
        activeAction.current === null &&
        contextMenuRef.current
      ) {
        closeContextMenu(true)
        setError(String(error))
      }
    }
  }, [closeContextMenu, updateMenu])
  useEffect(
    () =>
      window.irodori.onLibraryEvent((event) => {
        if (event.libraryChanged || event.tasksChanged || event.sessionId) {
          availabilityGeneration.current++
          void refreshMenu()
        }
      }),
    [refreshMenu],
  )
  useEffect(() => {
    const menu = contextMenuRef.current
    if (!menu || activeAction.current !== null) return
    const focus = workspace === 'library' ? browserPhoto?.id : photo?.id
    if (
      (focus ?? null) !== (menu.context.photo?.id ?? null) ||
      JSON.stringify([...selected.keys()]) !==
        JSON.stringify(menu.context.selection.map((p) => p.id))
    )
      closeContextMenu(false)
  }, [selected, workspace, browserPhoto?.id, photo?.id, closeContextMenu])

  const completedMerges = useRef<Set<string> | null>(null)
  const refreshTasks = useCallback(async () => {
    try {
      const current = await window.irodori.listTasks()
      setTasks(current)
      if (!current.length) setTasksOpen(false)
      const completed = current.filter(
        (task) => task.kind === 'merge' && task.status === 'completed' && task.resultPhotoId,
      )
      const handoff = mergeHandoffRef.current
      const accepted = handoff && current.find((task) => task.id === handoff.taskId)
      if (
        handoff &&
        accepted &&
        accepted.status !== 'running' &&
        accepted.status !== 'cancelling'
      ) {
        if (
          accepted.status === 'completed' &&
          accepted.resultPhotoId &&
          handoff.automatic &&
          workspaceRef.current === 'editor'
        ) {
          if (!handoff.opening) {
            handoff.opening = true
            void openPhoto(
              accepted.resultPhotoId,
              false,
              () =>
                mergeHandoffRef.current === handoff &&
                handoff.automatic &&
                workspaceRef.current === 'editor',
            ).finally(() => finishMergeHandoff(handoff))
          }
        } else finishMergeHandoff(handoff)
      }
      if (!completedMerges.current) {
        completedMerges.current = new Set(completed.map((task) => task.id))
      } else {
        for (const task of completed) {
          if (completedMerges.current.has(task.id)) continue
          completedMerges.current.add(task.id)
          if (task.id === handoff?.taskId) continue
          if (workspaceRef.current === 'editor') void openPhoto(task.resultPhotoId!)
        }
      }
    } catch (error) {
      setError(String(error))
    }
  }, [openPhoto, finishMergeHandoff])
  const dismissTask = useCallback(
    async (id: string) => {
      await window.irodori.dismissTask(id)
      const handoff = mergeHandoffRef.current
      if (handoff?.taskId === id) finishMergeHandoff(handoff)
      await refreshTasks()
    },
    [refreshTasks, finishMergeHandoff],
  )

  useEffect(() => {
    let live = true
    void Promise.all([
      window.irodori.getWorkspaceState(),
      window.irodori.getCollectionPolicy(),
      window.irodori.getAppInfo(),
    ]).then(
      ([snapshot, policy, info]) => {
        if (!live) return
        configureCollections(policy)
        checkpoint.hydrate(snapshot)
        hydrate(snapshot)
        const state = snapshot.state
        setRecoveredState(state)
        setRestoringPreview(state?.preview ?? null)
        workspaceRef.current = state?.mode ?? 'editor'
        setWorkspace(workspaceRef.current)
        setConsoleOpen(state?.consoleOpen ?? false)
        setInspectorSections({ ...DEFAULT_INSPECTOR_SECTIONS, ...state?.inspector })
        setCreativeColorSelection({ ...DEFAULT_CREATIVE_COLOR_SELECTION, ...state?.creativeColor })
        setEditorFocusId(state?.editorFocusId ?? null)
        focusBrowserPhoto(snapshot.libraryPhoto)
        setAppInfo(info)
        setHydrated(true)
        void refresh()
        void refreshTasks()
      },
      (error) => {
        if (live) setError(String(error))
      },
    )
    return () => {
      live = false
    }
  }, [checkpoint, hydrate, focusBrowserPhoto, refresh, refreshTasks])
  useEffect(() => {
    if (!hydrated) return
    return window.irodori.onLibraryEvent((event) => {
      onEvent(event)
      if (event.tasksChanged) void refreshTasks()
    })
  }, [hydrated, onEvent, refreshTasks])
  useEffect(() => {
    if (!hydrated) return
    saveWorkspace({
      mode: workspace,
      activeId: photo?.id ?? null,
      editorFocusId,
      libraryFocusId: browserPhoto?.id ?? null,
      rangeAnchorId: library.anchor,
      consoleOpen,
    })
    checkpoint.selection(selected.keys())
  }, [
    hydrated,
    saveWorkspace,
    checkpoint,
    workspace,
    photo?.id,
    editorFocusId,
    browserPhoto?.id,
    library.anchor,
    consoleOpen,
    selected,
  ])
  useEffect(() => {
    if (!hydrated) return
    return window.irodori.onFlushWorkspace(async () => {
      const selection = await getSelection()
      checkpoint.selection(selection.map((p) => p.id))
      await checkpoint.flush()
    })
  }, [hydrated, getSelection, checkpoint])

  useEffect(() => {
    const timers = tasks
      .filter(
        (task) =>
          task.kind !== 'merge' &&
          task.kind !== 'export' &&
          task.kind !== 'edit-application' &&
          task.status === 'completed' &&
          task.finishedAt !== undefined,
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

  async function openActions(element: HTMLElement, initialFocus: MenuInitialFocus = 'preferred') {
    closeContextMenu(false)
    const ticket = actionsGeneration.current
    actionOrigin.current = element
    setLoadingActions(true)
    setToolbarLoading(true)
    const box = element.getBoundingClientRect()
    try {
      await loadActions(ticket, box.left, box.bottom + 4, await getSelection(), true, initialFocus)
    } catch (error) {
      actionFailed(ticket, error)
    }
  }
  async function loadActions(
    ticket: number,
    x: number,
    y: number,
    targets: PhotoReference[],
    toolbar: boolean,
    initialFocus: MenuInitialFocus,
  ) {
    if (ticket !== actionsGeneration.current) return
    const focused =
      workspaceRef.current === 'library' ? browserPhotoRef.current : library.getActivePhoto()
    const ids = targets.map((p) => p.id)
    const availability = availabilityGeneration.current
    const context = await window.irodori.getPhotoActionsContext(focused?.id ?? null, ids)
    if (ticket !== actionsGeneration.current) return
    const currentFocus =
      workspaceRef.current === 'library' ? browserPhotoRef.current : library.getActivePhoto()
    if (
      !context.targetsCurrent ||
      (currentFocus?.id ?? null) !== (focused?.id ?? null) ||
      JSON.stringify(library.getSelectedIds()) !== JSON.stringify(ids)
    ) {
      closeContextMenu(true)
      return
    }
    setLoadingActions(false)
    updateMenu({ x, y, context, toolbar, initialFocus })
    if (availability !== availabilityGeneration.current) void refreshMenu()
  }
  async function stackAction(action: 'group' | 'ungroup' | 'remove' | 'cover' | 'select' | 'scan') {
    const menu = contextMenu
    if (!menu) return
    const ticket = beginAction()
    if (ticket === null) return
    try {
      const stack = menu.context.group?.stack
      if (action === 'group') {
        const ids = menu.context.selection.map((p) => p.id)
        await window.irodori.groupPhotos(
          ids,
          menu.context.photo && ids.includes(menu.context.photo.id)
            ? menu.context.photo.id
            : ids[0],
          menu.context.galleryRevision,
        )
      } else if (action === 'scan') {
        await window.irodori.groupCaptureSequences()
        await refreshTasks()
        setTasksOpen(true)
      } else if (stack) {
        if (action === 'select') {
          await library.selectStack(
            stack.id,
            stack.revision,
            () => ticket === actionsGeneration.current,
          )
        } else {
          await window.irodori.getStackSnapshot(stack.id, stack.revision)
          if (ticket !== actionsGeneration.current) return
          if (action === 'ungroup') await window.irodori.ungroupStack(stack.id, stack.revision)
          if (action === 'remove' && menu.context.photo)
            await window.irodori.removeFromStack(menu.context.photo.id, stack.revision)
          if (action === 'cover' && menu.context.photo)
            await window.irodori.setStackCover(stack.id, menu.context.photo.id, stack.revision)
        }
      }
      if (ticket !== actionsGeneration.current) return
      await refresh()
      if (ticket === actionsGeneration.current) closeContextMenu(true)
    } catch (error) {
      actionFailed(ticket, error)
    }
  }
  function openMerge(mode: MergeMode) {
    if (!contextMenu) return
    const ticket = beginAction()
    if (ticket === null) return
    setMergeTargets({ ids: contextMenu.context.selection.map((p) => p.id), mode })
    closeContextMenu(false)
  }
  async function groupAction(action: 'delete' | MergeMode) {
    const stack = contextMenu?.context.group?.stack
    if (!stack) return
    const ticket = beginAction()
    if (ticket === null) return
    try {
      if (action === 'delete') await getSelection()
      if (ticket !== actionsGeneration.current) return
      const snapshot = await window.irodori.getStackSnapshot(stack.id, stack.revision)
      if (ticket !== actionsGeneration.current) return
      if (action === 'delete') {
        await confirmDeletion(snapshot.photos, ticket)
      } else {
        const originals = snapshot.photos.filter((photo) => photo.assetKind !== 'derived')
        const unavailable = groupMergeUnavailable(originals)
        if (unavailable) throw new Error(unavailable)
        setMergeTargets({ ids: originals.map((photo) => photo.id), mode: action })
        closeContextMenu(false)
      }
    } catch (error) {
      actionFailed(ticket, error)
    }
  }
  function dispatchPhotoAction(id: PhotoActionId) {
    const context = contextMenuRef.current?.context
    if (!context || context.availability[id].kind !== 'applicable' || activeAction.current !== null)
      return
    switch (id) {
      case 'photo-copy-edits':
        if (context.photo) void requestEditTransfer('copy', context.photo.id)
        break
      case 'photo-paste-edits':
        if (context.photo) void requestEditTransfer('paste', context.photo.id)
        break
      case 'selection-paste-edits':
        void requestEditTransfer('paste')
        break
      case 'photo-export':
        if (context.photo) void requestExport([context.photo.id])
        break
      case 'selection-export':
        void requestExport()
        break
      case 'photo-cover':
        void stackAction('cover')
        break
      case 'photo-remove':
        void stackAction('remove')
        break
      case 'selection-group':
        void stackAction('group')
        break
      case 'group-select':
        void stackAction('select')
        break
      case 'group-ungroup':
        void stackAction('ungroup')
        break
      case 'library-scan':
        void stackAction('scan')
        break
      case 'selection-hdr':
        openMerge('hdr')
        break
      case 'selection-noise':
        openMerge('noise')
        break
      case 'group-hdr':
        void groupAction('hdr')
        break
      case 'group-noise':
        void groupAction('noise')
        break
      case 'group-trash':
        void groupAction('delete')
        break
      case 'photo-trash':
        if (context.photo) void requestDeletion([context.photo])
        break
      case 'selection-trash':
        void requestDeletion()
        break
    }
  }
  async function requestEditTransfer(action: 'copy' | 'paste', photoId?: string) {
    const ticket = beginAction()
    if (ticket === null) return
    try {
      const selection = await getSelection()
      if (ticket !== actionsGeneration.current) return
      if (action === 'copy' && photoId) await window.irodori.copyEdits(photoId)
      if (ticket !== actionsGeneration.current) return
      const ids = photoId ? [photoId] : selection.map((photo) => photo.id)
      closeContextMenu(action === 'copy')
      if (action === 'paste' && ids.length) setPasteTargets(ids)
    } catch (error) {
      actionFailed(ticket, error)
    }
  }
  async function requestExport(ids?: string[]) {
    if (preparingExport) return
    setPreparingExport(true)
    try {
      const selection = await getSelection()
      await edits.flush()
      const focused =
        workspaceRef.current === 'library' ? browserPhotoRef.current : library.getActivePhoto()
      const targets =
        ids ?? (selection.length ? selection.map((p) => p.id) : focused ? [focused.id] : [])
      if (!targets.length) return
      closeContextMenu(false)
      setExportTargets([...new Set(targets)])
    } catch (error) {
      setError(String(error))
    } finally {
      setPreparingExport(false)
    }
  }
  async function openResult(id: string) {
    resumeEditing()
    await openPhoto(id, true)
    switchWorkspace('editor')
    setTasksOpen(false)
  }
  async function openBrowserPhoto(id: string, doubleClick = false) {
    resumeEditing()
    if (doubleClick) await library.restoreBrowserClick(id)
    await openPhoto(id, true)
    switchWorkspace('editor')
  }

  async function openImport() {
    try {
      const current = await window.irodori.listTasks()
      setTasks(current)
      if (
        current.some(
          (task) =>
            task.kind !== 'export' && (task.status === 'running' || task.status === 'cancelling'),
        )
      )
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

  const saveEditorAnchor = useCallback(
    (editorAnchor: WorkspaceState['editorAnchor']) => saveWorkspace({ editorAnchor }),
    [saveWorkspace],
  )
  const savePreviewView = useCallback(
    (preview: WorkspaceState['preview']) => {
      setRestoringPreview(null)
      saveWorkspace({ preview })
    },
    [saveWorkspace],
  )
  if (!hydrated)
    return (
      <div className={styles.app} role="status">
        {error || 'Restoring workspace…'}
      </div>
    )
  return (
    <div
      className={styles.app}
      onKeyDownCapture={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          ['z', 'y'].includes(event.key.toLowerCase()) &&
          !(event.target as HTMLElement).closest(
            'input, textarea, select, [contenteditable], #agent-console',
          )
        )
          resumeEditing()
      }}
    >
      <header className={styles.appHeader}>
        <div className={styles.brand}>
          <Aperture size={23} strokeWidth={1.35} />
          <span>{APP_NAME}</span>
          <span className={styles.brandDivider} />
          <span className={styles.brandTagline}>{APP_TAGLINE}</span>
        </div>
        <nav className={styles.workspaceMode} aria-label="Workspaces">
          <button
            aria-current={workspace === 'editor' ? 'page' : undefined}
            onClick={() => {
              closeContextMenu()
              switchWorkspace('editor')
            }}
          >
            <SlidersHorizontal size={13} />
            Editor
          </button>
          <button
            aria-current={workspace === 'library' ? 'page' : undefined}
            onClick={() => {
              closeContextMenu()
              switchWorkspace('library')
            }}
          >
            <Images size={13} />
            Library
          </button>
        </nav>
        <div className={styles.headerActions}>
          <button
            className={styles.headerButton}
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => {
              closeContextMenu()
              setSettingsOpen(true)
            }}
          >
            <Settings size={14} />
          </button>
          <button
            ref={actionsButtonRef}
            aria-haspopup="menu"
            aria-expanded={!!contextMenu?.toolbar}
            aria-controls={contextMenu?.toolbar ? 'photo-actions-menu' : undefined}
            aria-busy={loadingActions && toolbarLoading}
            onClick={(event) => {
              if (contextMenu?.toolbar || (loadingActions && toolbarLoading))
                closeContextMenu(false)
              else void openActions(event.currentTarget)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                void openActions(event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first')
              }
            }}
          >
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
          <button
            className={styles.exportButton}
            disabled={
              preparingExport ||
              !hydrated ||
              (!selected.size && !(workspace === 'editor' ? photo : browserPhoto))
            }
            aria-label="Export photo"
            onClick={(event) => {
              actionOrigin.current = event.currentTarget
              void requestExport()
            }}
          >
            <ArrowUpFromLine size={14} /> Export
          </button>
        </div>
      </header>

      <div
        className={styles.editor}
        data-testid="workspace"
        hidden={workspace !== 'editor'}
        inert={workspace !== 'editor'}
        onPointerDownCapture={(event) => {
          if (!(event.target as HTMLElement).closest('#agent-console')) resumeEditing()
        }}
        onKeyDownCapture={(event) => {
          if (
            !['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key) &&
            !(event.target as HTMLElement).closest('#agent-console')
          )
            resumeEditing()
        }}
        onWheelCapture={(event) => {
          if (!(event.target as HTMLElement).closest('#agent-console')) resumeEditing()
        }}
      >
        <Library
          active={
            workspace === 'editor' &&
            !importOpen &&
            !deleteTargets &&
            !mergeTargets &&
            !contextMenu &&
            !tasksOpen
          }
          summary={library.summary}
          focusId={editorFocusId}
          onFocus={setEditorFocusId}
          initialAnchor={recoveredState?.editorAnchor ?? null}
          onAnchor={saveEditorAnchor}
          onRefresh={refresh}
          onToggle={(photo) =>
            void library.browseSelect(photo, { search: '', grouping: 'date' }, { toggle: true })
          }
          hiddenActiveCover={library.hiddenActiveCover}
          onExpand={(stack) => {
            void window.irodori
              .setStackExpanded(stack.id, !stack.expanded, stack.revision)
              .then(() => refresh())
              .catch((error) => {
                setError(String(error))
                void refresh()
              })
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
              <span data-testid="preview-filename" title={photo?.filename}>
                {photo?.filename ?? 'No photo selected'}
              </span>
              <select
                aria-label="Preview display mode"
                value={displayTarget.requested}
                onChange={(event) => {
                  void window.irodori
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
                hdrJpeg={edits.state?.hdrJpeg}
              />
            </div>
            <div className={styles.previewActions}>
              <button
                className={styles.iconButton}
                disabled={edits.saving || crop.active || crop.pending || !edits.state?.canUndo}
                onClick={() => void edits.history('undo')}
                aria-label="Undo"
                title="Undo photo edit (Ctrl/Cmd+Z)"
              >
                <Undo2 size={15} />
              </button>
              <button
                className={styles.iconButton}
                disabled={edits.saving || crop.active || crop.pending || !edits.state?.canRedo}
                onClick={() => void edits.history('redo')}
                aria-label="Redo"
                title="Redo photo edit (Ctrl/Cmd+Shift+Z)"
              >
                <Redo2 size={15} />
              </button>
              <span className={styles.toolbarDivider} />
              <button
                className={styles.iconButton}
                disabled={!crop.supported || crop.pending}
                aria-label="Crop photo"
                aria-pressed={crop.active}
                onClick={() => (crop.active ? crop.cancel() : void startCrop())}
              >
                <Crop size={15} />
              </button>
              <button
                className={`${styles.iconButton} ${styles.beforeButton}`}
                disabled={crop.active || crop.pending || !photo || interactivePhoto !== photo.id}
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
                disabled={crop.active || crop.pending || !photo || interactivePhoto !== photo.id}
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
            crop={cropTool}
            whiteBalancePicker={whiteBalancePicker}
            previewPolicy={editorPreviewPolicy}
            hdrJpeg={edits.state?.hdrJpeg?.state === 'supported'}
            suspended={
              !!mergeTargets ||
              workspace !== 'editor' ||
              (mergeHandoffPhoto !== null && mergeHandoffPhoto === photo?.id)
            }
            displayTarget={displayTarget}
            key={photo?.id ?? 'empty'}
            photo={photo}
            initialView={restoringPreview?.photoId === photo?.id ? restoringPreview : null}
            onViewChange={savePreviewView}
            adjustments={edits.adjustments}
            confirmedEdits={
              edits.confirmed && edits.state?.photoId === photo?.id ? edits.state : null
            }
            tools={presentationTools}
            gesturing={edits.gesturing}
            editingEpoch={edits.epoch}
            gestureCommit={edits.gestureCommit?.photoId === photo?.id ? edits.gestureCommit : null}
            onEditingReady={setInteractivePhoto}
            total={total}
            position={position}
            onNavigate={navigate}
            onImport={() => void openImport()}
            onContextMenu={showContextMenu}
          />

          {consoleOpen && workspace === 'editor' && (
            <Console
              onClose={() => {
                setConsoleOpen(false)
                consoleToggleRef.current?.focus()
              }}
            />
          )}
        </main>

        <Inspector
          crop={cropTool}
          whiteBalancePicker={whiteBalancePicker}
          sections={inspectorSections}
          onSectionsChange={changeInspectorSections}
          creativeColor={creativeColorSelection}
          onCreativeColorChange={changeCreativeColorSelection}
          suspended={workspace !== 'editor' || crop.active || crop.pending}
          tools={presentationTools}
          photo={photo}
          edits={edits}
          previewReady={
            workspace === 'editor' &&
            !crop.active &&
            !crop.pending &&
            !!photo &&
            interactivePhoto === photo.id
          }
        />
      </div>

      <div className={styles.browserWorkspace} hidden={workspace !== 'library'}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
            <button onClick={() => setError('')} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        <AllPhotos
          active={workspace === 'library'}
          covered={importOpen || !!deleteTargets || !!mergeTargets || !!contextMenu || tasksOpen}
          initialState={recoveredState}
          onState={saveWorkspace}
          selected={selected}
          selection={{
            select: library.browseSelect,
            section: library.browseSection,
            clear: library.clearSelection,
          }}
          focusedPhoto={browserPhoto}
          onFocusPhoto={focusBrowserPhoto}
          onOpen={(id, doubleClick) => void openBrowserPhoto(id, doubleClick)}
          onContextMenu={showContextMenu}
          onImport={() => void openImport()}
          onError={setError}
        />
        {consoleOpen && workspace === 'library' && (
          <Console
            onClose={() => {
              setConsoleOpen(false)
              consoleToggleRef.current?.focus()
            }}
          />
        )}
      </div>

      <footer className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={styles.statusDot} />
          <span>Local library</span>
          {recovery.status && (
            <span role="status">
              {recovery.status}{' '}
              <button onClick={() => void checkpoint.retry().catch(() => {})}>Retry</button>
            </span>
          )}
          <span className={styles.statusSeparator}>/</span>
          <span>{library.storedTotal} photographs</span>
        </div>
        <TaskCenter
          onOpenResult={openResult}
          tasks={tasks}
          open={tasksOpen}
          onOpenChange={setTasksOpen}
          onCancel={window.irodori.cancelTask}
          onDismiss={dismissTask}
          getErrors={window.irodori.getTaskErrors}
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
          context={contextMenu.context}
          toolbar={contextMenu.toolbar}
          initialFocus={contextMenu.initialFocus}
          pending={actionPending}
          onAction={dispatchPhotoAction}
          onClose={closeContextMenu}
        />
      )}
      {settingsOpen && (
        <ResourceSettingsDialog
          load={loadResourceSettings}
          save={saveResourceSettings}
          onClose={() => setSettingsOpen(false)}
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
          onStarted={(taskId) => {
            const handoff: MergeHandoff = {
              taskId,
              photoId: photo?.id ?? null,
              automatic: workspaceRef.current === 'editor',
              opening: false,
            }
            mergeHandoffRef.current = handoff
            setMergeHandoffPhoto(handoff.automatic ? handoff.photoId : null)
            setMergeTargets(null)
            restoreFocus()
            void refreshTasks()
          }}
        />
      )}
      {pasteTargets && (
        <PasteEditsDialog
          ids={pasteTargets}
          onClose={() => {
            setPasteTargets(null)
            restoreFocus()
          }}
          onStarted={() => {
            setTasksOpen(true)
            void refreshTasks()
          }}
        />
      )}
      {exportTargets && (
        <ExportDialog
          ids={exportTargets}
          onClose={() => {
            setExportTargets(null)
            restoreFocus()
          }}
          onStarted={() => {
            setExportTargets(null)
            restoreFocus()
            setTasksOpen(true)
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
