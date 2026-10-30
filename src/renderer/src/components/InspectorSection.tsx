import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import styles from '../App.module.css'

type BodyProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'id' | 'hidden' | 'className' | 'children'
> & {
  [key: `data-${string}`]: string | number | boolean | undefined
}

/** Disclosure bodies stay mounted so collapsing does not interrupt edits or subscriptions. */
export function InspectorSection({
  id,
  title,
  icon: Icon,
  expanded,
  onToggle,
  bodyClassName = styles.sectionContent,
  bodyProps,
  children,
}: {
  id: string
  title: string
  icon: LucideIcon
  expanded: boolean
  onToggle: () => void
  bodyClassName?: string
  bodyProps?: BodyProps
  children: ReactNode
}) {
  return (
    <section className={styles.adjustmentSection} aria-labelledby={`${id}-heading`}>
      <h3 className={styles.sectionHeading}>
        <button
          id={`${id}-heading`}
          type="button"
          className={styles.sectionToggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={onToggle}
        >
          <Icon size={14} aria-hidden="true" />
          {title}
          {expanded ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
        </button>
      </h3>
      <div {...bodyProps} id={id} hidden={!expanded} className={bodyClassName}>
        {children}
      </div>
    </section>
  )
}
