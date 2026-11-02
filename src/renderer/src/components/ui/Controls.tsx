import type { ComponentPropsWithRef, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import styles from './Controls.module.css'

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger'
}) {
  return (
    <button
      type="button"
      {...props}
      className={`${styles.button} ${styles[variant]} ${className}`}
    />
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
  items: readonly { id: T; label: string; icon?: LucideIcon }[]
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
      {items.map(({ id, label: text, icon: Icon }, index) => (
        <button
          key={id}
          type="button"
          id={`tab-${id}`}
          role="tab"
          aria-selected={value === id}
          aria-controls={`panel-${id}`}
          tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            const nextKey = vertical ? 'ArrowDown' : 'ArrowRight',
              previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
            if (![nextKey, previousKey, 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === nextKey ? 1 : -1) + items.length) % items.length
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
