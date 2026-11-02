import { ChevronDown, ChevronRight } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import styles from './Inspector.module.css'

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
  heading = title,
  expanded,
  onToggle,
  className = '',
  headerActions,
  bodyClassName = styles.sectionContent,
  bodyProps,
  children,
}: {
  id: string
  title: string
  heading?: string
  expanded: boolean
  onToggle: () => void
  className?: string
  headerActions?: ReactNode
  bodyClassName?: string
  bodyProps?: BodyProps
  children: ReactNode
}) {
  return (
    <section className={`${styles.section} ${className}`} aria-labelledby={`${id}-heading`}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionHeading}>
          <button
            id={`${id}-heading`}
            type="button"
            className={styles.sectionToggle}
            aria-label={heading === title ? undefined : title}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={onToggle}
          >
            {heading}
            {expanded ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
          </button>
        </h3>
        {headerActions && <div className={styles.headerActions}>{headerActions}</div>}
      </div>
      <div {...bodyProps} id={id} hidden={!expanded} className={bodyClassName}>
        {children}
      </div>
    </section>
  )
}
