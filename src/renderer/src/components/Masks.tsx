import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Brush,
  ChevronDown,
  Circle,
  Copy,
  Eye,
  EyeOff,
  FlipHorizontal2,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Palette,
  Sun,
  Plus,
  RotateCcw,
  ScanSearch,
  Trash2,
} from 'lucide-react'
import {
  maskCapabilities,
  neutralMaskColor,
  neutralMaskEdge,
  neutralMaskLight,
  type MaskColor,
  type MaskLight,
} from '../../../shared/masks'
import type { MaskDetailTab } from '../../../shared/workspace'
import { Button, IconButton, TabPanel, Tabs } from './ui/Controls'
import { CommandMenu, type CommandMenuAction, type MenuInitialFocus } from './ui/CommandMenu'
import { AdjustmentInput } from './AdjustmentInput'
import { InspectorSection } from './InspectorSection'
import type { MasksController } from '../hooks/useMasks'
import type { ObjectSelectionController } from '../hooks/useObjectSelection'
import { ObjectSelectionControls } from './ObjectSelection'
import { MaskParts } from './MaskParts'
import { MaskRangeControls } from './MaskRangeControls'
import { GradientShape } from './GradientShape'
import { maskCreationActions, startMaskCreation, type MaskToolId } from './mask-tools'
import styles from './Masks.module.css'

const controls: readonly { key: keyof MaskLight; label: string }[] = [
  { key: 'exposureEv', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'whites', label: 'Whites' },
  { key: 'blacks', label: 'Blacks' },
]
const colorControls: readonly { key: keyof MaskColor; label: string }[] = [
  { key: 'temperature', label: 'Temperature' },
  { key: 'tint', label: 'Tint' },
  { key: 'saturation', label: 'Saturation' },
]
type MaskAction = 'rename' | 'duplicate' | 'invert' | 'up' | 'down' | 'delete'
type OpenMenu = {
  kind: 'create' | 'mask'
  photoId: string | undefined
  scope: object
  maskId?: string
  trigger: HTMLButtonElement
  x: number
  y: number
  initialFocus: MenuInitialFocus
}

function MaskName({
  name,
  onFinish,
}: {
  name: string
  onFinish: (name: string | undefined, restoreFocus: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  const [draft, setDraft] = useState(name)
  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [])
  const finish = (save: boolean, restoreFocus = false) => {
    if (finished.current) return
    finished.current = true
    const trimmed = draft.trim()
    onFinish(save && trimmed && trimmed.length <= 100 ? trimmed : undefined, restoreFocus)
  }
  return (
    <input
      ref={input}
      className={styles.nameInput}
      aria-label="Mask name"
      value={draft}
      maxLength={100}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(event.key === 'Enter', true)
        }
      }}
    />
  )
}

export function Masks({
  masks: providedMasks,
  objectSelection,
}: {
  masks: MasksController
  objectSelection?: ObjectSelectionController
}) {
  const selecting = !!objectSelection?.active
  const masks = selecting
    ? { ...providedMasks, available: false, supported: false, busy: true }
    : providedMasks
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [renaming, setRenaming] = useState<{ scope: object; id: string } | null>(null)
  const [lightExpanded, setLightExpanded] = useState(true)
  const [colorExpanded, setColorExpanded] = useState(false)
  const [edgesExpanded, setEdgesExpanded] = useState(true)
  const list = useRef<HTMLOListElement>(null)
  const details = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ scope: object; id: string; deleted?: boolean } | null>(null)
  const dragging = useRef<{
    id: string
    pointer: number
    origin: number
    moved: boolean
    handle: HTMLButtonElement
  } | null>(null)
  const activeMenu =
    menu &&
    menu.scope === masks.scope &&
    menu.photoId === masks.photoId &&
    (menu.kind === 'create' || masks.masks.some((mask) => mask.id === menu.maskId))
      ? menu
      : null
  const closeMenu = useCallback(
    (restoreFocus = false) => {
      setMenu(null)
      if (restoreFocus && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true })
    },
    [menu],
  )
  const openMenu = (
    kind: OpenMenu['kind'],
    trigger: HTMLButtonElement,
    initialFocus: MenuInitialFocus,
    maskId?: string,
  ) => {
    if (activeMenu?.trigger === trigger) return closeMenu(true)
    const bounds = trigger.getBoundingClientRect()
    setMenu({
      kind,
      photoId: masks.photoId,
      scope: masks.scope,
      maskId,
      trigger,
      x: bounds.right - 285,
      y: bounds.bottom + 4,
      initialFocus,
    })
  }
  const menuKeys = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: OpenMenu['kind'],
    maskId?: string,
  ) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openMenu(kind, event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first', maskId)
  }
  const endDrag = (commit: boolean) => {
    const value = dragging.current
    dragging.current = null
    if (!value) return
    if (commit && value.moved) masks.finishOrder()
    else masks.cancel()
    if (value.handle.hasPointerCapture(value.pointer))
      value.handle.releasePointerCapture(value.pointer)
  }
  useEffect(() => {
    if (!masks.gesturing && dragging.current?.moved) {
      const value = dragging.current
      dragging.current = null
      if (value.handle.hasPointerCapture(value.pointer))
        value.handle.releasePointerCapture(value.pointer)
    }
  }, [masks.gesturing])
  useEffect(
    () => () => {
      const value = dragging.current
      dragging.current = null
      if (value?.handle.hasPointerCapture(value.pointer))
        value.handle.releasePointerCapture(value.pointer)
    },
    [],
  )
  useEffect(() => {
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"][data-mask-select]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [masks.selectedId])
  const selected = masks.selected
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    if (target.scope !== masks.scope) {
      pendingFocus.current = null
      return
    }
    if (target.deleted && masks.masks.some((mask) => mask.id === target.id)) return
    const button = target.deleted
      ? (list.current?.querySelector<HTMLButtonElement>(
          '[data-mask-select][aria-pressed="true"]',
        ) ??
        list.current
          ?.closest('section')
          ?.querySelector<HTMLButtonElement>('[aria-label="Create mask"]'))
      : list.current?.querySelector<HTMLButtonElement>(
          `[data-mask-id="${target.id}"] [data-mask-select]`,
        )
    if (button && !button.disabled && !masks.busy) {
      pendingFocus.current = null
      button.focus({ preventScroll: true })
    }
  })
  const detailTab: MaskDetailTab =
    selecting || masks.rangeCreating ? 'coverage' : masks.workspace.detailTab
  useEffect(() => {
    if (details.current) details.current.scrollTop = 0
  }, [detailTab, selected?.id])
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const value = dragging.current
    if (!value || value.pointer !== event.pointerId || !masks.available) return
    if (!value.moved && Math.abs(event.clientY - value.origin) < 4) return
    value.moved = true
    const bounds = list.current!.getBoundingClientRect()
    if (event.clientY < bounds.top + 16) list.current!.scrollTop -= 8
    if (event.clientY > bounds.bottom - 16) list.current!.scrollTop += 8
    const centers = Array.from(list.current?.children ?? []).map((row) => {
      const box = row.getBoundingClientRect()
      return box.y + box.height / 2
    })
    const target = centers.reduce(
      (nearest, center, index) =>
        Math.abs(event.clientY - center) < Math.abs(event.clientY - centers[nearest])
          ? index
          : nearest,
      0,
    )
    masks.previewOrder(value.id, target)
  }
  const creationActions = maskCreationActions({
    available: providedMasks.available,
    objectSelection,
    maskCount: masks.masks.length,
    busy: providedMasks.busy,
  })
  const create = (id: MaskToolId) => {
    const target = activeMenu
    const action = creationActions.find((action) => action.id === id)
    closeMenu(true)
    if (!target || target.photoId !== providedMasks.photoId || !action || action.disabledReason)
      return
    startMaskCreation(id, {
      available: providedMasks.available,
      objectSelection,
      maskCount: masks.masks.length,
      busy: providedMasks.busy,
      createBrush: providedMasks.create,
      createGradient: providedMasks.armGradient,
      createRange: providedMasks.startRange,
    })
  }
  const targetMask = masks.masks.find((mask) => mask.id === activeMenu?.maskId)
  const targetIndex = masks.masks.findIndex((mask) => mask.id === targetMask?.id)
  const blocked = !masks.available
    ? selecting
      ? 'Finish or cancel the object selection first.'
      : 'Wait for the photograph and current edit to be ready.'
    : undefined
  const rowActions: CommandMenuAction<MaskAction>[] = targetMask
    ? [
        { id: 'rename', label: 'Rename', icon: Pencil, disabledReason: blocked },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: Copy,
          disabledReason:
            blocked ??
            (masks.masks.length >= maskCapabilities.maxMasks
              ? `A photograph can have up to ${maskCapabilities.maxMasks} masks.`
              : undefined),
        },
        {
          id: 'invert',
          label: targetMask.inverted ? 'Uninvert' : 'Invert',
          icon: FlipHorizontal2,
          disabledReason: blocked,
        },
        {
          id: 'up',
          label: 'Move up',
          icon: ArrowUp,
          disabledReason:
            blocked ?? (targetIndex === 0 ? 'This mask is already at the top.' : undefined),
        },
        {
          id: 'down',
          label: 'Move down',
          icon: ArrowDown,
          disabledReason:
            blocked ??
            (targetIndex === masks.masks.length - 1
              ? 'This mask is already at the bottom.'
              : undefined),
        },
        { id: 'delete', label: 'Delete', icon: Trash2, destructive: true, disabledReason: blocked },
      ]
    : []
  const maskAction = (id: MaskAction) => {
    const target = activeMenu,
      mask = targetMask
    const action = rowActions.find((action) => action.id === id)
    closeMenu(id !== 'rename')
    if (
      !target ||
      target.photoId !== providedMasks.photoId ||
      !mask ||
      !action ||
      action.disabledReason
    )
      return
    if (id === 'rename') setRenaming({ scope: target.scope, id: mask.id })
    else if (id === 'duplicate') masks.duplicate(mask.id)
    else if (id === 'invert')
      masks.update({ kind: 'update', id: mask.id, inverted: !mask.inverted })
    else if (id === 'delete') {
      pendingFocus.current = { scope: target.scope, id: mask.id, deleted: true }
      masks.update({ kind: 'delete', id: mask.id })
    } else masks.move(mask.id, targetIndex + (id === 'up' ? -1 : 1))
  }
  return (
    <section
      className={styles.panel}
      aria-label="Local masks"
      data-testid="masks-panel"
      data-ready={masks.available}
    >
      <div className={styles.heading}>
        <h2>
          Masks <span className={styles.count}>{masks.masks.length || ''}</span>
        </h2>
        <Button
          leadingIcon={Plus}
          aria-label="Create mask"
          aria-haspopup="menu"
          aria-expanded={activeMenu?.kind === 'create'}
          aria-controls={activeMenu?.kind === 'create' ? 'mask-create-menu' : undefined}
          onClick={(event) => openMenu('create', event.currentTarget, 'preferred')}
          onKeyDown={(event) => menuKeys(event, 'create')}
        >
          <span>Create mask</span>
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
      </div>
      {!masks.masks.length && !selecting && !masks.rangeCreating && (
        <p className={styles.empty}>Create a mask to adjust part of this photograph.</p>
      )}
      <ol
        ref={list}
        className={styles.list}
        aria-label="Mask processing stack"
        aria-description="Top mask applies last."
        data-testid="masks-list"
      >
        {masks.masks.map((mask) => {
          const Icon = mask.range
            ? mask.range.kind === 'color'
              ? Palette
              : Sun
            : mask.gradient
              ? mask.gradient.kind === 'linear'
                ? ArrowDownToLine
                : Circle
              : mask.base
                ? ScanSearch
                : Brush
          const rename = renaming?.scope === masks.scope && renaming?.id === mask.id
          const type = mask.range
            ? `${mask.range.kind === 'color' ? 'Color' : 'Luminance'} range`
            : mask.gradient
              ? `${mask.gradient.kind === 'linear' ? 'Linear' : 'Radial'} gradient${mask.head || mask.resultHead ? ' + Brush' : ''}`
              : mask.base
                ? mask.head || mask.resultHead
                  ? 'Object + Brush'
                  : 'Object'
                : mask.head || mask.resultHead
                  ? 'Brush'
                  : 'Empty'
          const metadata = `${mask.operands?.length ? 'Combined' : type}${mask.inverted ? ' · Inverted' : ''}${!mask.enabled ? ' · Disabled' : ''}`
          return (
            <li
              key={mask.id}
              className={`${styles.row} ${mask.id === masks.selectedId ? styles.selected : ''}`}
              data-mask-id={mask.id}
            >
              <button
                type="button"
                className={styles.handle}
                aria-label={`Drag to reorder ${mask.name}`}
                title="Drag to reorder"
                disabled={!masks.available}
                onPointerDown={(event) => {
                  if (event.button !== 0 || !event.isPrimary || !masks.available) return
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                  dragging.current = {
                    id: mask.id,
                    pointer: event.pointerId,
                    origin: event.clientY,
                    moved: false,
                    handle: event.currentTarget,
                  }
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerMove={moveDrag}
                onPointerUp={(event) => {
                  if (dragging.current?.pointer === event.pointerId) endDrag(true)
                }}
                onPointerCancel={(event) => {
                  if (dragging.current?.pointer === event.pointerId) endDrag(false)
                }}
                onLostPointerCapture={(event) => {
                  if (dragging.current?.pointer === event.pointerId) endDrag(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && dragging.current) {
                    event.preventDefault()
                    endDrag(false)
                  }
                }}
              >
                <GripVertical size={14} aria-hidden="true" />
              </button>
              <IconButton
                icon={mask.enabled ? Eye : EyeOff}
                label={`${mask.enabled ? 'Disable' : 'Enable'} ${mask.name}`}
                aria-pressed={mask.enabled}
                disabled={!masks.available}
                onClick={() =>
                  masks.update({ kind: 'update', id: mask.id, enabled: !mask.enabled })
                }
              />
              {rename ? (
                <div className={styles.renaming}>
                  <MaskName
                    key={`${mask.id}:${mask.name}`}
                    name={mask.name}
                    onFinish={(name, restoreFocus) => {
                      if (restoreFocus) pendingFocus.current = { scope: masks.scope, id: mask.id }
                      setRenaming(null)
                      if (name && name !== mask.name && masks.available)
                        masks.update({ kind: 'update', id: mask.id, name })
                    }}
                  />
                  <small>{metadata}</small>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.select}
                  title={mask.name}
                  data-mask-select
                  aria-pressed={mask.id === masks.selectedId}
                  disabled={!masks.canNavigate}
                  onClick={() => void masks.select(mask.id).catch(() => undefined)}
                >
                  <span>
                    <Icon size={14} aria-hidden="true" />
                    <span className={styles.maskName}>{mask.name}</span>
                  </span>
                  <small>{metadata}</small>
                </button>
              )}
              <IconButton
                icon={MoreHorizontal}
                label={`Actions for ${mask.name}`}
                aria-haspopup="menu"
                aria-expanded={activeMenu?.kind === 'mask' && activeMenu.maskId === mask.id}
                aria-controls={
                  activeMenu?.kind === 'mask' && activeMenu.maskId === mask.id
                    ? 'mask-actions-menu'
                    : undefined
                }
                onClick={(event) => openMenu('mask', event.currentTarget, 'preferred', mask.id)}
                onKeyDown={(event) => menuKeys(event, 'mask', mask.id)}
              />
            </li>
          )
        })}
      </ol>
      {(selected || selecting || masks.rangeCreating) && (
        <>
          <div className={styles.overlayRow}>
            <label className={styles.overlayToggle}>
              <input
                type="checkbox"
                checked={selecting || masks.rangeCreating || masks.workspace.overlay}
                disabled={!providedMasks.supported || selecting || masks.rangeCreating}
                onChange={(event) => masks.preference({ overlay: event.target.checked })}
              />
              Show overlay
            </label>
            <select
              aria-label="Coverage inspection"
              value={masks.workspace.overlayScope ?? 'result'}
              disabled={selecting || masks.rangeCreating}
              onChange={(event) =>
                masks.preference({ overlayScope: event.target.value as 'result' | 'selected-part' })
              }
            >
              <option value="result">Result</option>
              <option value="selected-part">Selected part</option>
            </select>
          </div>
          <div
            className={styles.tabs}
            aria-describedby={selecting ? 'mask-selection-lock' : undefined}
          >
            <Tabs
              label="Mask details"
              value={detailTab}
              items={[
                { id: 'coverage', label: 'Coverage' },
                {
                  id: 'adjustments',
                  label: 'Adjustments',
                  disabledReason:
                    selecting || masks.rangeCreating
                      ? 'Use or cancel this selection before editing adjustments.'
                      : undefined,
                },
              ]}
              onChange={(tab) => {
                if (!selecting && !masks.rangeCreating)
                  void masks.showDetailTab(tab).catch(() => undefined)
              }}
            />
          </div>
          <div ref={details} className={styles.details} data-testid="mask-details-scroll">
            <TabPanel id="coverage" active={detailTab === 'coverage'}>
              {selecting && (
                <p id="mask-selection-lock" className={styles.hint}>
                  Use or cancel this selection before editing adjustments.
                </p>
              )}
              {objectSelection && <ObjectSelectionControls selection={objectSelection} />}
              {masks.rangeCreating && (
                <MaskRangeControls key={`range-create:${masks.selectedId}`} masks={providedMasks} />
              )}
              {selected && !selecting && !masks.rangeCreating && (
                <>
                  <MaskParts masks={masks} objectSelection={objectSelection} />
                  {masks.rangeKind && (
                    <MaskRangeControls
                      key={`range-edit:${masks.selectedId}:${masks.selectedComponentId}`}
                      masks={providedMasks}
                    />
                  )}
                  {masks.selectedPart?.gradient && <GradientShape masks={masks} />}
                  {masks.selectedComponentId === null && (
                    <p className={styles.hint}>
                      Paint and Erase correct the completed combination. Light and Color apply once
                      to the result.
                    </p>
                  )}
                  <InspectorSection
                    id="mask-edge-controls"
                    title="Mask edges"
                    expanded={edgesExpanded}
                    onToggle={() => setEdgesExpanded((value) => !value)}
                    headerActions={
                      <IconButton
                        icon={RotateCcw}
                        label="Reset mask edges"
                        disabled={!masks.available}
                        onClick={() =>
                          masks.update({
                            kind: 'update',
                            id: selected.id,
                            componentId: masks.selectedComponentId ?? undefined,
                            edge: { ...neutralMaskEdge },
                          })
                        }
                      />
                    }
                  >
                    <AdjustmentInput
                      label="Feather"
                      unit="px"
                      min={maskCapabilities.edge.featherPx.min}
                      max={maskCapabilities.edge.featherPx.max}
                      step={maskCapabilities.edge.featherPx.step}
                      precision={1}
                      value={masks.edgeValues.featherPx}
                      disabled={!masks.supported}
                      busy={masks.busy}
                      resetKey={masks.resetKey}
                      onChange={(value) => masks.changeEdge('featherPx', value)}
                      onCommit={masks.commitEdge}
                      onCancel={masks.cancel}
                    />
                    <AdjustmentInput
                      label="Expand/Contract"
                      unit="px"
                      min={maskCapabilities.edge.shiftPx.min}
                      max={maskCapabilities.edge.shiftPx.max}
                      step={maskCapabilities.edge.shiftPx.step}
                      precision={0}
                      value={masks.edgeValues.shiftPx}
                      disabled={!masks.supported}
                      busy={masks.busy}
                      resetKey={masks.resetKey}
                      onChange={(value) => masks.changeEdge('shiftPx', value)}
                      onCommit={masks.commitEdge}
                      onCancel={masks.cancel}
                    />
                    <p className={styles.hint}>
                      Photo pixels. + expands; − contracts. Preview updates when committed.
                    </p>
                  </InspectorSection>
                  <div className={styles.section}>
                    <h3>Manual correction</h3>
                    <div className={styles.brush} role="group" aria-label="Mask brush">
                      {(['add', 'subtract'] as const).map((mode) => (
                        <Button
                          key={mode}
                          aria-pressed={masks.workspace.brush && masks.workspace.mode === mode}
                          disabled={!masks.available}
                          onClick={() =>
                            masks.preference({
                              brush: !(masks.workspace.brush && masks.workspace.mode === mode),
                              mode,
                            })
                          }
                        >
                          {mode === 'add' ? 'Paint' : 'Erase'}
                        </Button>
                      ))}
                    </div>
                    <div hidden={!masks.workspace.brush}>
                      <AdjustmentInput
                        label="Brush size"
                        unit="%"
                        min={0.1}
                        max={100}
                        step={0.1}
                        precision={1}
                        value={masks.workspace.size}
                        disabled={!masks.supported}
                        resetKey={masks.resetKey}
                        onChange={(size) => masks.changeBrush('size', size)}
                        onCommit={masks.commitBrush}
                        onCancel={masks.cancelBrush}
                      />
                      <AdjustmentInput
                        label="Brush feather"
                        unit="%"
                        min={0}
                        max={100}
                        step={1}
                        precision={0}
                        value={masks.workspace.feather}
                        disabled={!masks.supported}
                        resetKey={masks.resetKey}
                        onChange={(feather) => masks.changeBrush('feather', feather)}
                        onCommit={masks.commitBrush}
                        onCancel={masks.cancelBrush}
                      />
                      <p className={styles.hint}>
                        Paint on the photograph. Arrow keys move the brush; Space starts or finishes
                        a stroke. Escape cancels.
                      </p>
                    </div>
                  </div>
                  {objectSelection && masks.selectedPart?.base && (
                    <div className={styles.section}>
                      <h3>Object selection</h3>
                      <Button
                        leadingIcon={ScanSearch}
                        disabled={!objectSelection.available || !masks.available}
                        onClick={() =>
                          void objectSelection.start({
                            kind: 'replace-component',
                            maskId: selected.id,
                            componentId: masks.selectedComponentId ?? undefined,
                          })
                        }
                      >
                        Refine object selection…
                      </Button>
                      <p className={styles.hint}>
                        Update the object selection while retaining manual corrections and
                        adjustments.
                      </p>
                    </div>
                  )}
                </>
              )}
            </TabPanel>
            <TabPanel id="adjustments" active={detailTab === 'adjustments'}>
              {selected && (
                <>
                  <InspectorSection
                    id="mask-light-controls"
                    title="Light"
                    expanded={lightExpanded}
                    onToggle={() => setLightExpanded((value) => !value)}
                    headerActions={
                      <IconButton
                        icon={RotateCcw}
                        label="Reset mask Light"
                        disabled={!masks.available}
                        onClick={() =>
                          masks.update({
                            kind: 'update',
                            id: selected.id,
                            light: { ...neutralMaskLight },
                          })
                        }
                      />
                    }
                  >
                    <div role="group" aria-label="Mask Light controls">
                      {controls.map(({ key, label }) => (
                        <AdjustmentInput
                          key={key}
                          label={`Local ${label}`}
                          value={selected.light[key]}
                          min={key === 'exposureEv' ? -5 : -100}
                          max={key === 'exposureEv' ? 5 : 100}
                          step={key === 'exposureEv' ? 0.01 : 1}
                          precision={key === 'exposureEv' ? 2 : 0}
                          unit={key === 'exposureEv' ? 'EV' : undefined}
                          resetKey={masks.resetKey}
                          disabled={!masks.supported}
                          busy={masks.busy}
                          onChange={(value) => masks.changeLight(key, value)}
                          onCommit={masks.commitLight}
                          onCancel={masks.cancel}
                        />
                      ))}
                    </div>
                  </InspectorSection>
                  <InspectorSection
                    id="mask-color-controls"
                    title="Color"
                    expanded={colorExpanded}
                    onToggle={() => setColorExpanded((value) => !value)}
                    headerActions={
                      <IconButton
                        icon={RotateCcw}
                        label="Reset mask Color"
                        disabled={!masks.available}
                        onClick={() =>
                          masks.update({
                            kind: 'update',
                            id: selected.id,
                            color: { ...neutralMaskColor },
                          })
                        }
                      />
                    }
                  >
                    <div role="group" aria-label="Mask Color controls">
                      {colorControls.map(({ key, label }) => (
                        <AdjustmentInput
                          key={key}
                          label={`Local ${label}`}
                          value={masks.colorValues[key]}
                          min={-100}
                          max={100}
                          step={1}
                          precision={0}
                          resetKey={masks.resetKey}
                          disabled={!masks.supported}
                          busy={masks.busy}
                          onChange={(value) => masks.changeColor(key, value)}
                          onCommit={masks.commitColor}
                          onCancel={masks.cancel}
                        />
                      ))}
                    </div>
                    <p className={styles.hint}>Relative balance; 0 preserves current color.</p>
                  </InspectorSection>
                </>
              )}
            </TabPanel>
          </div>
        </>
      )}
      {masks.error && (
        <p className={styles.error} role="alert">
          {masks.error}
        </p>
      )}
      {activeMenu?.kind === 'create' && (
        <CommandMenu
          key="create"
          id="mask-create-menu"
          label="Create mask"
          {...activeMenu}
          sections={[{ id: 'tools', actions: creationActions }]}
          onAction={create}
          onClose={closeMenu}
        />
      )}
      {activeMenu?.kind === 'mask' && (
        <CommandMenu
          key={activeMenu.maskId}
          id="mask-actions-menu"
          label={`Actions for ${targetMask?.name ?? 'mask'}`}
          {...activeMenu}
          sections={[{ id: 'mask', actions: rowActions }]}
          onAction={maskAction}
          onClose={closeMenu}
        />
      )}
    </section>
  )
}
