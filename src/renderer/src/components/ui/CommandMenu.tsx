import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import styles from '../PhotoActions.module.css'

export type MenuInitialFocus = 'preferred' | 'first' | 'last'

export interface CommandMenuAction<Id extends string = string> {
  id: Id
  label: string
  icon?: LucideIcon
  disabledReason?: string
  destructive?: boolean
  shortcut?: string
}

export interface CommandMenuSection<Id extends string = string> {
  id: string
  heading?: string
  actions: readonly CommandMenuAction<Id>[]
}

/** Presentation and keyboard behavior only; callers own targets and command availability. */
export function CommandMenu<Id extends string>({
  id,
  label,
  x,
  y,
  sections,
  initialFocus = 'preferred',
  pending = false,
  blockers: providedBlockers,
  statusesBeforeSection,
  idPrefix = id,
  emptyText = 'No actions available.',
  onAction,
  onClose,
}: {
  id: string
  label: string
  x: number
  y: number
  sections: readonly CommandMenuSection<Id>[]
  initialFocus?: MenuInitialFocus
  pending?: boolean
  blockers?: readonly string[]
  statusesBeforeSection?: string
  idPrefix?: string
  emptyText?: string
  onAction: (id: Id) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const initialized = useRef(false)
  const typeahead = useRef({ prefix: '', time: 0 })
  const [focused, setFocused] = useState<Id | null>(null)
  const actions = sections.flatMap((section) => section.actions)
  const blockers = providedBlockers ?? [
    ...new Set(actions.flatMap((action) => (action.disabledReason ? [action.disabledReason] : []))),
  ]
  const preferred =
    actions.find((action) => !action.destructive && !action.disabledReason) ??
    actions.find((action) => !action.disabledReason) ??
    actions[0]
  useLayoutEffect(() => {
    const element = menu.current!
    const box = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`
    // Existing action nodes retain DOM focus across availability updates.
    if (!initialized.current) {
      initialized.current = true
      const next =
        initialFocus === 'last'
          ? actions.at(-1)?.id
          : initialFocus === 'first'
            ? actions[0]?.id
            : preferred?.id
      if (next) element.querySelector<HTMLButtonElement>(`[data-action-id="${next}"]`)?.focus()
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
    const removeBlur = window.irodori.onWindowBlur(() => onClose(false))
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', resize)
    return () => {
      removeBlur()
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', resize)
    }
  }, [onClose])
  const focus = (index: number) => {
    const action = actions[(index + actions.length) % actions.length]
    if (action)
      menu.current?.querySelector<HTMLButtonElement>(`[data-action-id="${action.id}"]`)?.focus()
  }
  const statuses = (
    <div className={styles.statuses}>
      {blockers.map((reason, index) => (
        <p role="status" id={`${idPrefix}-blocker-${index}`} key={reason}>
          {reason}
        </p>
      ))}
      {pending && (
        <p role="status" id={`${idPrefix}-pending`}>
          Working…
        </p>
      )}
    </div>
  )
  return createPortal(
    <div
      id={id}
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      aria-busy={pending}
      className={styles.menu}
      style={{ left: x, top: y }}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLButtonElement) {
          setFocused(event.target.dataset.actionId as Id)
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
          if (!event.repeat && !pending && action && !action.disabledReason) onAction(action.id)
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
      {!actions.length && <p role="status">{emptyText}</p>}
      {sections.map((section) => (
        <div
          key={section.id}
          role="group"
          aria-labelledby={section.heading ? `${idPrefix}-${section.id}` : undefined}
          className={styles.section}
        >
          {section.id === statusesBeforeSection && (blockers.length > 0 || pending) && statuses}
          {section.heading && (
            <h2 id={`${idPrefix}-${section.id}`} title={section.heading}>
              {section.heading}
            </h2>
          )}
          {section.actions.map((action) => {
            const Icon = action.icon
            const reason = action.disabledReason
            const descriptions = [
              reason ? `${idPrefix}-blocker-${blockers.indexOf(reason)}` : '',
              pending ? `${idPrefix}-pending` : '',
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
                {Icon && <Icon size={16} aria-hidden="true" />}
                <span>{action.label}</span>
                {action.shortcut && <kbd aria-hidden="true">{action.shortcut}</kbd>}
              </button>
            )
          })}
        </div>
      ))}
      {!sections.some((section) => section.id === statusesBeforeSection) && statuses}
    </div>,
    document.body,
  )
}
