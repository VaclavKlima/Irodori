import type { ComponentPropsWithRef, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import styles from './Controls.module.css'

export function Button({
  variant = 'secondary',
  className = '',
  leadingIcon: LeadingIcon,
  children,
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
  leadingIcon?: LucideIcon
}) {
  return (
    <button
      type="button"
      {...props}
      className={`${styles.button} ${styles[variant]} ${LeadingIcon ? styles.withIcon : ''} ${className}`}
    >
      {LeadingIcon && <LeadingIcon size={16} aria-hidden="true" />}
      {children}
    </button>
  )
}
export function IconButton({
  icon: Icon,
  label,
  ...props
}: Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  icon: LucideIcon
  label: string
}) {
  return (
    <Button
      variant="quiet"
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={`${styles.icon} ${props.className ?? ''}`}
    >
      <Icon size={16} aria-hidden="true" />
    </Button>
  )
}
/** Navigation owns no edit history. Owners flush drafts before accepting a new tab. */
export function Tabs<T extends string>({
  label,
  value,
  items,
  onChange,
  vertical = false,
}: {
  label: string
  value: T
  items: readonly { id: T; label: string; icon?: LucideIcon; disabledReason?: string }[]
  onChange: (id: T) => void
  vertical?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={vertical ? styles.rail : styles.tabs}
    >
      {items.map(({ id, label: text, icon: Icon, disabledReason }, index) => (
        <button
          key={id}
          type="button"
          id={`tab-${id}`}
          role="tab"
          aria-selected={value === id}
          aria-controls={`panel-${id}`}
          aria-disabled={disabledReason ? true : undefined}
          aria-description={disabledReason}
          title={disabledReason}
          tabIndex={value === id ? 0 : -1}
          onClick={() => {
            if (!disabledReason) onChange(id)
          }}
          onKeyDown={(event) => {
            if (disabledReason && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              return
            }
            const nextKey = vertical ? 'ArrowDown' : 'ArrowRight',
              previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
            if (![nextKey, previousKey, 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const available = items.flatMap((item, position) =>
              item.disabledReason ? [] : [position],
            )
            if (!available.length) return
            const direction = event.key === previousKey ? -1 : 1
            let next = index
            if (event.key === 'Home') next = available[0]
            else if (event.key === 'End') next = available.at(-1)!
            else {
              do next = (next + direction + items.length) % items.length
              while (items[next].disabledReason)
            }
            onChange(items[next].id)
            event.currentTarget.parentElement
              ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus()
          }}
        >
          {Icon && <Icon size={17} aria-hidden="true" />}
          {text}
        </button>
      ))}
    </div>
  )
}
export function TabPanel({
  id,
  active,
  children,
}: {
  id: string
  active: boolean
  children: ReactNode
}) {
  return (
    <div id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={!active}>
      {children}
    </div>
  )
}
