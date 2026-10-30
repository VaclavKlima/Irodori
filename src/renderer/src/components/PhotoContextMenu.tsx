import { useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpFromLine,
  CheckSquare,
  Copy,
  ClipboardPaste,
  Image,
  Layers,
  ScanLine,
  Trash2,
  Ungroup,
  Unlink,
} from 'lucide-react'
import {
  buildPhotoMenu,
  type PhotoActionId,
  type PhotoActionsContext,
} from '../../../shared/photo-actions'
import styles from './PhotoActions.module.css'

const icons = {
  copy: Copy,
  paste: ClipboardPaste,
  export: ArrowUpFromLine,
  cover: Image,
  remove: Unlink,
  merge: Layers,
  group: ScanLine,
  select: CheckSquare,
  ungroup: Ungroup,
  trash: Trash2,
}
export type MenuInitialFocus = 'preferred' | 'first' | 'last'

export function PhotoContextMenu({
  x,
  y,
  context,
  toolbar,
  initialFocus,
  pending,
  onAction,
  onClose,
}: {
  x: number
  y: number
  context: PhotoActionsContext
  toolbar: boolean
  initialFocus: MenuInitialFocus
  pending: boolean
  onAction: (id: PhotoActionId) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const typeahead = useRef({ prefix: '', time: 0 })
  const [focused, setFocused] = useState<PhotoActionId | null>(null)
  const model = buildPhotoMenu(context, toolbar)
  const actions = model.sections.flatMap((section) => section.actions)
  const preferred =
    actions.find((action) => !action.destructive && action.availability.kind === 'applicable') ??
    actions.find((action) => action.availability.kind === 'applicable') ??
    actions[0]
  useLayoutEffect(() => {
    const element = menu.current!
    const box = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`
    // Existing action nodes retain DOM focus across availability updates.
    if (!initialized.current) {
      initialized.current = true
      const id =
        initialFocus === 'last'
          ? actions.at(-1)?.id
          : initialFocus === 'first'
            ? actions[0]?.id
            : preferred?.id
      if (id) element.querySelector<HTMLButtonElement>(`[data-action-id="${id}"]`)?.focus()
      else element.focus()
    } else if (focused && !actions.some((action) => action.id === focused)) {
      if (preferred)
        element.querySelector<HTMLButtonElement>(`[data-action-id="${preferred.id}"]`)?.focus()
      else element.focus()
    }
  })
  useLayoutEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false)
    }
    const resize = () => onClose(true)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
    }
  }, [onClose])
  const focus = (index: number) => {
    const action = actions[(index + actions.length) % actions.length]
    if (action)
      menu.current?.querySelector<HTMLButtonElement>(`[data-action-id="${action.id}"]`)?.focus()
  }
  return (
    <div
      id="photo-actions-menu"
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label="Photo actions"
      aria-busy={pending}
      className={styles.menu}
      style={{ left: x, top: y }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLButtonElement) {
          setFocused(event.target.dataset.actionId as PhotoActionId)
          event.target.scrollIntoView({ block: 'nearest' })
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
          return
        }
        if (event.key === 'Tab') {
          // Let the browser traverse from the restored invocation point in either direction.
          menu.current?.querySelectorAll('button').forEach((button) => {
            button.tabIndex = -1
          })
          onClose(true)
          return
        }
        const index = actions.findIndex((action) => action.id === focused)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          focus(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? actions.length - 1
                : index + (event.key === 'ArrowUp' ? -1 : 1),
          )
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const action = actions[index]
          if (!event.repeat && !pending && action?.availability.kind === 'applicable')
            onAction(action.id)
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const now = Date.now()
          const previous = now - typeahead.current.time < 1000 ? typeahead.current.prefix : ''
          const prefix = previous + event.key.toLowerCase()
          typeahead.current = { prefix, time: now }
          const repeated = [...prefix].every((character) => character === prefix[0])
          const search = repeated ? prefix[0] : prefix
          const start = previous && !repeated ? index : index + 1
          for (let step = 0; step < actions.length; step++) {
            const candidate = (start + step + actions.length) % actions.length
            if (actions[candidate].label.toLowerCase().startsWith(search)) {
              focus(candidate)
              break
            }
          }
        }
      }}
    >
      {!actions.length && <p role="status">No photo actions available.</p>}
      {model.sections.map((section) => (
        <div
          key={section.id}
          role="group"
          aria-labelledby={`photo-menu-${section.id}`}
          className={styles.section}
        >
          {section.id === 'trash' && (model.blockers.length > 0 || pending) && (
            <div className={styles.statuses}>
              {model.blockers.map((reason, index) => (
                <p role="status" id={`photo-menu-blocker-${index}`} key={reason}>
                  {reason}
                </p>
              ))}
              {pending && (
                <p role="status" id="photo-menu-pending">
                  Working…
                </p>
              )}
            </div>
          )}
          <h2 id={`photo-menu-${section.id}`} title={section.heading}>
            {section.heading}
          </h2>
          {section.actions.map((action) => {
            const Icon = icons[action.icon]
            const reason =
              action.availability.kind === 'blocked' ? action.availability.reason : undefined
            const descriptions = [
              reason ? `photo-menu-blocker-${model.blockers.indexOf(reason)}` : '',
              pending ? 'photo-menu-pending' : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                data-action-id={action.id}
                className={action.destructive ? styles.trash : undefined}
                tabIndex={action.id === (focused ?? preferred?.id) ? 0 : -1}
                aria-disabled={pending || !!reason}
                aria-describedby={descriptions || undefined}
                onPointerMove={() => {
                  if (
                    document.activeElement !==
                    menu.current?.querySelector(`[data-action-id="${action.id}"]`)
                  )
                    menu.current
                      ?.querySelector<HTMLButtonElement>(`[data-action-id="${action.id}"]`)
                      ?.focus({ preventScroll: true })
                }}
                onClick={() => {
                  if (!pending && !reason) onAction(action.id)
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{action.label}</span>
                {action.shortcut && <kbd aria-hidden="true">{action.shortcut}</kbd>}
              </button>
            )
          })}
        </div>
      ))}
      {!model.sections.some((section) => section.id === 'trash') && (
        <div className={styles.statuses}>
          {model.blockers.map((reason, index) => (
            <p role="status" id={`photo-menu-blocker-${index}`} key={reason}>
              {reason}
            </p>
          ))}
          {pending && (
            <p role="status" id="photo-menu-pending">
              Working…
            </p>
          )}
        </div>
      )}
    </div>
  )
}
