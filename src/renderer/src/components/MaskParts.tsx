import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Brush,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  maskCapabilities,
  type MaskOperation,
  type MaskOperator,
  type ResolvedMask,
  type ResolvedMaskOperand,
} from '../../../shared/masks'
import { maskCoverageNodes } from '../../../shared/masks-gpu'
import type { MasksController } from '../hooks/useMasks'
import type { ObjectSelectionController } from '../hooks/useObjectSelection'
import { Button, IconButton } from './ui/Controls'
import { CommandMenu, type CommandMenuAction } from './ui/CommandMenu'
import styles from './MaskParts.module.css'

type Menu = {
  scope: object
  trigger: HTMLButtonElement
  x: number
  y: number
  stage: 'operators' | 'methods' | 'sources' | 'part' | 'operation' | 'replace'
  nodeId?: string
  parentId?: string
  operator?: MaskOperator
}
type Drag = {
  id: string
  parentId: string
  ids: string[]
  pointer: number
  handle: HTMLButtonElement
  origin: number
  moved: boolean
}

/** Coverage navigation and management share the photo edit owner; selection is workspace-only. */
export function MaskParts({
  masks,
  objectSelection,
}: {
  masks: MasksController
  objectSelection?: ObjectSelectionController
}) {
  const root = masks.selected
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [rename, setRename] = useState<{ id: string; name: string; scope: object } | null>(null)
  const [ordering, setOrdering] = useState<{
    parentId: string
    ids: string[]
    resetKey: string
    draggedId: string
    targetId: string
  } | null>(null)
  const drag = useRef<Drag | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const nodes = root ? maskCoverageNodes(root, true) : []
  const selectedMenu =
    menu?.scope === masks.scope && (!menu.nodeId || nodes.some((node) => node.id === menu.nodeId))
      ? menu
      : null
  const close = useCallback(
    (restore = false) => {
      setMenu(null)
      if (restore && menu?.trigger.isConnected) menu.trigger.focus({ preventScroll: true })
    },
    [menu],
  )
  const cancelDrag = useCallback(() => {
    const value = drag.current
    drag.current = null
    setOrdering(null)
    if (value?.handle.hasPointerCapture(value.pointer))
      value.handle.releasePointerCapture(value.pointer)
  }, [])
  useEffect(() => {
    const off = window.irodori.onWindowBlur(cancelDrag)
    return () => {
      off()
      cancelDrag()
    }
  }, [cancelDrag])
  useEffect(() => {
    const value = drag.current
    drag.current = null
    if (value?.handle.hasPointerCapture(value.pointer))
      value.handle.releasePointerCapture(value.pointer)
  }, [masks.resetKey])
  useEffect(() => {
    if (rename) {
      input.current?.focus()
      input.current?.select()
    }
  }, [rename])
  if (!root) return null
  const blocked = !masks.available
    ? 'Wait for the photograph and current edit to be ready.'
    : undefined
  const full =
    nodes.length >= maskCapabilities.maxNodesPerMask
      ? 'A mask can have up to 32 coverage parts, including its starting coverage.'
      : undefined
  const open = (trigger: HTMLButtonElement, stage: Menu['stage'], extra: Partial<Menu> = {}) => {
    const box = trigger.getBoundingClientRect()
    setMenu({ scope: masks.scope, trigger, x: box.right - 270, y: box.bottom + 4, stage, ...extra })
  }
  const mutate = (operation: MaskOperation) => masks.update(operation)
  const parentOf = (id: string): ResolvedMask | ResolvedMaskOperand | undefined =>
    nodes.find((node) => node.operands?.some((child) => child.id === id))
  const siblings = (parentId?: string) =>
    nodes.find((node) => node.id === (parentId ?? root.id))?.operands ?? []
  const move = (id: string, offset: number) => {
    const parent = parentOf(id)
    if (!parent) return
    const ids = parent.operands!.map((child) => child.id),
      from = ids.indexOf(id),
      to = from + offset
    if (to < 0 || to >= ids.length) return
    ids.splice(from, 1)
    ids.splice(to, 0, id)
    mutate({ kind: 'component-reorder', id: root.id, parentId: parent.id, ids })
  }
  const finishName = (save: boolean) => {
    const value = rename
    setRename(null)
    if (
      !value ||
      value.scope !== masks.scope ||
      !save ||
      !value.name.trim() ||
      value.name.trim().length > 100
    )
      return
    mutate({
      kind: 'component-update',
      id: root.id,
      componentId: value.id,
      name: value.name.trim(),
    })
  }
  const strokeOrGradient = (
    kind: 'brush' | 'linear' | 'radial',
    operator: MaskOperator,
    parentId?: string,
  ) => masks.armComponent(operator, kind, parentId)
  const startObject = (
    operator: MaskOperator,
    parentId?: string,
    selection?: 'sky' | 'background',
  ) => {
    if (!objectSelection?.available) return
    void objectSelection.start(
      {
        kind: 'new-component',
        maskId: root.id,
        parentId,
        componentId: crypto.randomUUID(),
        name:
          selection === 'sky'
            ? 'Sky part'
            : selection === 'background'
              ? 'Background part'
              : 'Object part',
        operator,
      },
      selection,
    )
  }
  const actions: CommandMenuAction[] = !selectedMenu
    ? []
    : selectedMenu.stage === 'operators' || selectedMenu.stage === 'operation'
      ? ['add', 'subtract', 'intersect'].map((id) => ({
          id,
          label: id === 'add' ? 'Add' : id === 'subtract' ? 'Subtract' : 'Intersect',
          disabledReason: blocked,
        }))
      : selectedMenu.stage === 'methods' || selectedMenu.stage === 'replace'
        ? [
            {
              id: 'brush',
              label: selectedMenu.stage === 'replace' ? 'Empty brush' : 'Brush',
              icon: Brush,
              disabledReason: blocked ?? (selectedMenu.stage === 'replace' ? undefined : full),
            },
            {
              id: 'object',
              label: 'Select object…',
              disabledReason:
                blocked ??
                (!objectSelection?.available ? 'Object selection is unavailable.' : undefined) ??
                (selectedMenu.stage === 'replace' ? undefined : full),
            },
            ...(['sky', 'background'] as const).map((id) => ({
              id,
              label: id === 'sky' ? 'Select Sky' : 'Select Background',
              disabledReason:
                blocked ??
                (!objectSelection?.available ? 'Automatic selection is unavailable.' : undefined) ??
                (selectedMenu.stage === 'replace' ? undefined : full),
            })),
            {
              id: 'linear',
              label: 'Linear gradient',
              disabledReason: blocked ?? (selectedMenu.stage === 'replace' ? undefined : full),
            },
            {
              id: 'radial',
              label: 'Radial gradient',
              disabledReason: blocked ?? (selectedMenu.stage === 'replace' ? undefined : full),
            },
            {
              id: 'color-range',
              label: 'Color range…',
              disabledReason: blocked ?? (selectedMenu.stage === 'replace' ? undefined : full),
            },
            {
              id: 'luminance-range',
              label: 'Luminance range…',
              disabledReason: blocked ?? (selectedMenu.stage === 'replace' ? undefined : full),
            },
            ...(selectedMenu.stage === 'replace'
              ? []
              : [
                  {
                    id: 'copy',
                    label: 'Copy existing mask…',
                    icon: Copy,
                    disabledReason: blocked ?? full,
                  },
                ]),
          ]
        : selectedMenu.stage === 'sources'
          ? masks.masks.map((mask) => ({ id: mask.id, label: mask.name, disabledReason: blocked }))
          : (() => {
              const node = nodes.find((node) => node.id === selectedMenu.nodeId)!,
                parent = parentOf(node.id),
                index = parent?.operands?.findIndex((child) => child.id === node.id) ?? -1
              return [
                { id: 'rename', label: 'Rename', icon: Pencil, disabledReason: blocked },
                { id: 'replace', label: 'Replace starting coverage…', disabledReason: blocked },
                { id: 'clear', label: 'Clear to empty brush', disabledReason: blocked },
                {
                  id: 'combine',
                  label: 'Combine within this group…',
                  icon: Plus,
                  disabledReason: blocked ?? full,
                },
                {
                  id: 'invert',
                  label: node.inverted ? 'Uninvert' : 'Invert',
                  disabledReason: blocked,
                },
                ...(node.id === root.id
                  ? []
                  : [
                      { id: 'operator', label: 'Change operation…', disabledReason: blocked },
                      {
                        id: 'duplicate',
                        label: 'Duplicate part',
                        icon: Copy,
                        disabledReason: blocked ?? full,
                      },
                      {
                        id: 'up',
                        label: 'Move up',
                        icon: ArrowUp,
                        disabledReason:
                          blocked ??
                          (index <= 0 ? 'This part is already first in its parent.' : undefined),
                      },
                      {
                        id: 'down',
                        label: 'Move down',
                        icon: ArrowDown,
                        disabledReason:
                          blocked ??
                          (index === (parent?.operands?.length ?? 0) - 1
                            ? 'This part is already last in its parent.'
                            : undefined),
                      },
                      {
                        id: 'remove',
                        label: 'Remove part',
                        icon: Trash2,
                        destructive: true,
                        disabledReason: blocked,
                      },
                    ]),
              ]
            })()
  const action = (id: string) => {
    const target = selectedMenu
    if (!target || actions.find((action) => action.id === id)?.disabledReason) return
    if (target.stage === 'operators') {
      setMenu({ ...target, stage: 'methods', operator: id as MaskOperator })
      return
    }
    if (target.stage === 'operation') {
      close(true)
      mutate({
        kind: 'component-update',
        id: root.id,
        componentId: target.nodeId!,
        operator: id as MaskOperator,
      })
      return
    }
    if (target.stage === 'methods') {
      if (id === 'copy') {
        setMenu({ ...target, stage: 'sources' })
        return
      }
      close(true)
      if (id === 'color-range' || id === 'luminance-range')
        masks.addRangePart(
          id === 'color-range' ? 'color' : 'luminance',
          target.operator!,
          target.parentId,
        )
      else if (id === 'object' || id === 'sky' || id === 'background')
        startObject(target.operator!, target.parentId, id === 'object' ? undefined : id)
      else strokeOrGradient(id as 'brush' | 'linear' | 'radial', target.operator!, target.parentId)
      return
    }
    if (target.stage === 'sources') {
      close(true)
      mutate({
        kind: 'component-copy',
        id: root.id,
        componentId: crypto.randomUUID(),
        parentId: target.parentId,
        operator: target.operator!,
        sourceMaskId: id,
        name: `${masks.masks.find((mask) => mask.id === id)!.name.slice(0, 94)} copy`,
      })
      return
    }
    if (target.stage === 'replace') {
      close(true)
      if (id === 'color-range' || id === 'luminance-range')
        masks.replaceRangePart(id === 'color-range' ? 'color' : 'luminance', target.nodeId!)
      else if (id === 'object' || id === 'sky' || id === 'background')
        void objectSelection?.start(
          {
            kind: 'replace-component',
            maskId: root.id,
            componentId: target.nodeId,
            replacePrimary: true,
          },
          id === 'object' ? undefined : id,
        )
      else if (id === 'brush')
        mutate({
          kind: 'component-update',
          id: root.id,
          componentId: target.nodeId!,
          clearPrimary: true,
        })
      else {
        // Centered replacement uses the existing authoritative source-pixel geometry controls.
        const gradient =
          id === 'linear'
            ? { kind: 'linear' as const, start: { x: 0.5, y: 0.25 }, end: { x: 0.5, y: 0.75 } }
            : {
                kind: 'radial' as const,
                center: { x: 0.5, y: 0.5 },
                radiusX: 0.3,
                radiusY: 0.3,
                rotation: 0,
                feather: 50,
              }
        mutate({
          kind: 'component-update',
          id: root.id,
          componentId: target.nodeId!,
          clearPrimary: true,
          gradient,
        })
      }
      return
    }
    const node = nodes.find((node) => node.id === target.nodeId)!
    if (id === 'operator') {
      setMenu({ ...target, stage: 'operation' })
      return
    }
    if (id === 'replace') {
      setMenu({ ...target, stage: 'replace' })
      return
    }
    if (id === 'combine') {
      setMenu({ ...target, stage: 'operators', parentId: node.id })
      return
    }
    close(id !== 'rename')
    if (id === 'rename') setRename({ id: node.id, name: node.name, scope: masks.scope })
    else if (id === 'clear')
      mutate({ kind: 'component-update', id: root.id, componentId: node.id, clearPrimary: true })
    else if (id === 'invert')
      mutate({
        kind: 'component-update',
        id: root.id,
        componentId: node.id,
        inverted: !node.inverted,
      })
    else if (id === 'duplicate')
      mutate({
        kind: 'component-duplicate',
        id: root.id,
        componentId: node.id,
        newId: crypto.randomUUID(),
        name: `${node.name.slice(0, 94)} copy`,
      })
    else if (id === 'remove')
      mutate({ kind: 'component-remove', id: root.id, componentId: node.id })
    else move(node.id, id === 'up' ? -1 : 1)
  }
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const value = drag.current
    if (!value || value.pointer !== event.pointerId || !masks.available) return
    if (!value.moved && Math.abs(event.clientY - value.origin) < 4) return
    value.moved = true
    const rows = value.ids.map((id) =>
        list.current?.querySelector<HTMLElement>(`[data-part-id="${id}"]`),
      ),
      target = rows.reduce((nearest, row, index) => {
        if (!row) return nearest
        const center = (row.getBoundingClientRect().top + row.getBoundingClientRect().bottom) / 2,
          other = rows[nearest]?.getBoundingClientRect()
        return !other ||
          Math.abs(event.clientY - center) <
            Math.abs(event.clientY - (other.top + other.bottom) / 2)
          ? index
          : nearest
      }, 0)
    const ids = [...value.ids],
      from = ids.indexOf(value.id)
    ids.splice(from, 1)
    ids.splice(target, 0, value.id)
    setOrdering({
      parentId: value.parentId,
      ids,
      resetKey: masks.resetKey,
      draggedId: value.id,
      targetId: value.ids[target],
    })
  }
  const finishDrag = (commit: boolean) => {
    const value = drag.current,
      order = ordering?.resetKey === masks.resetKey ? ordering : null
    cancelDrag()
    if (commit && value?.moved && order && order.ids.some((id, index) => id !== value.ids[index]))
      mutate({ kind: 'component-reorder', id: root.id, parentId: order.parentId, ids: order.ids })
  }
  const renderNode = (node: ResolvedMask | ResolvedMaskOperand, depth: number) => {
    const fixed = node.id === root.id,
      isExpanded = fixed || expanded.has(node.id),
      childIds = node.operands?.map((child) => child.id) ?? [],
      dropTarget = ordering?.resetKey === masks.resetKey ? ordering.targetId : undefined
    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${masks.selectedComponentId === node.id ? styles.selected : ''} ${dropTarget === node.id && node.id !== ordering?.draggedId ? styles.dropTarget : ''}`}
          data-part-id={node.id}
          style={{ paddingLeft: depth * 10 }}
        >
          {!fixed ? (
            <button
              type="button"
              className={styles.handle}
              aria-label={`Reorder ${node.name}`}
              title="Drag to reorder; Alt+Up/Down within parent"
              disabled={!masks.available}
              onKeyDown={(event) => {
                if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault()
                  event.stopPropagation()
                  move(node.id, event.key === 'ArrowUp' ? -1 : 1)
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary || !masks.available) return
                event.preventDefault()
                event.currentTarget.focus({ preventScroll: true })
                const parent = parentOf(node.id)!
                drag.current = {
                  id: node.id,
                  parentId: parent.id,
                  ids: siblings(parent.id).map((child) => child.id),
                  pointer: event.pointerId,
                  handle: event.currentTarget,
                  origin: event.clientY,
                  moved: false,
                }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={pointerMove}
              onPointerUp={() => finishDrag(true)}
              onPointerCancel={() => finishDrag(false)}
              onLostPointerCapture={() => {
                if (drag.current) finishDrag(false)
              }}
            >
              <GripVertical size={12} />
            </button>
          ) : (
            <span className={styles.fixed} />
          )}
          {!fixed && !!node.operands?.length ? (
            <IconButton
              icon={isExpanded ? ChevronDown : ChevronRight}
              label={`Expand ${node.name}`}
              aria-expanded={isExpanded}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(node.id)) next.delete(node.id)
                  else next.add(node.id)
                  return next
                })
              }
            />
          ) : (
            <span className={styles.fixed} />
          )}
          {rename?.scope === masks.scope && rename.id === node.id ? (
            <input
              ref={input}
              className={styles.name}
              value={rename.name}
              aria-label="Part name"
              maxLength={100}
              onChange={(event) => setRename({ ...rename, name: event.target.value })}
              onBlur={() => finishName(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  event.preventDefault()
                  finishName(event.key === 'Enter')
                }
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.pick}
              aria-pressed={masks.selectedComponentId === node.id}
              title={fixed ? 'Starting coverage' : node.name}
              disabled={!masks.canNavigate}
              onClick={() => void masks.selectComponent(node.id)}
            >
              <span className={styles.operator}>
                {fixed
                  ? ''
                  : 'operator' in node
                    ? node.operator === 'add'
                      ? '+'
                      : node.operator === 'subtract'
                        ? '−'
                        : '∩'
                    : ''}
              </span>
              <span>{fixed ? 'Starting coverage' : node.name}</span>
            </button>
          )}
          {!fixed && (
            <IconButton
              icon={node.enabled ? Eye : EyeOff}
              label={`${node.enabled ? 'Disable' : 'Enable'} part ${node.name}`}
              disabled={!masks.available}
              onClick={() =>
                mutate({
                  kind: 'component-update',
                  id: root.id,
                  componentId: node.id,
                  enabled: !node.enabled,
                })
              }
            />
          )}
          <IconButton
            icon={MoreHorizontal}
            label={`Part actions for ${fixed ? 'Starting coverage' : node.name}`}
            disabled={!masks.available}
            onClick={(event) => open(event.currentTarget, 'part', { nodeId: node.id })}
          />
        </div>
        {isExpanded &&
          childIds.map((id) =>
            renderNode(
              node.operands!.find((child) => child.id === id)!,
              depth + 1,
            ),
          )}
      </div>
    )
  }
  return (
    <section className={styles.section} aria-label="Compound coverage">
      <div className={styles.heading}>
        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}Coverage parts
        </button>
        <Button
          aria-haspopup="menu"
          aria-expanded={!!selectedMenu && selectedMenu.stage === 'operators'}
          disabled={!masks.available}
          onClick={(event) => open(event.currentTarget, 'operators')}
        >
          Combine…
        </Button>
      </div>
      <div
        ref={list}
        className={styles.parts}
        hidden={collapsed}
        aria-label="Coverage parts"
        data-testid="mask-parts-list"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drag.current) {
            event.preventDefault()
            cancelDrag()
          }
        }}
      >
        <button
          type="button"
          className={`${styles.result} ${masks.selectedComponentId === null ? styles.selected : ''}`}
          aria-pressed={masks.selectedComponentId === null}
          onClick={() => void masks.selectComponent(null)}
        >
          Result <span>Completed combination</span>
        </button>
        {renderNode(root, 0)}
      </div>
      {masks.addingPart && (
        <p className={styles.hint}>
          Complete the first stroke or place the gradient to add this part. Escape cancels.
        </p>
      )}
      {selectedMenu && (
        <CommandMenu
          key={`${selectedMenu.stage}:${selectedMenu.nodeId ?? ''}`}
          id="mask-combine-menu"
          label={
            selectedMenu.stage === 'operators'
              ? 'Combine coverage'
              : selectedMenu.stage === 'methods'
                ? 'New coverage part'
                : selectedMenu.stage === 'sources'
                  ? 'Copy existing mask'
                  : selectedMenu.stage === 'operation'
                    ? 'Part operation'
                    : selectedMenu.stage === 'replace'
                      ? 'Replace starting coverage'
                      : 'Coverage part actions'
          }
          x={selectedMenu.x}
          y={selectedMenu.y}
          sections={[{ id: 'parts', actions }]}
          onAction={action}
          onClose={close}
        />
      )}
    </section>
  )
}
