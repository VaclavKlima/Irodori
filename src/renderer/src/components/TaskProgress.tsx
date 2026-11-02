import { Button } from './ui/Controls'
import { Check, ChevronUp, TriangleAlert } from 'lucide-react'
import { ProgressSpinner } from './ProgressSpinner'
import type { BackgroundTask } from '../../../shared/contracts'
import styles from './TaskProgress.module.css'

export function TaskProgress({
  task,
  expanded,
  onOpen,
  additionalCount = 0,
}: {
  task: BackgroundTask
  expanded: boolean
  onOpen: () => void
  additionalCount?: number
}) {
  const running = task.status === 'running' || task.status === 'cancelling'
  const percent =
    task.progress && task.progress.total > 0
      ? Math.min(
          task.status === 'completed' ? 100 : 99,
          Math.floor((task.progress.completed / task.progress.total) * 100),
        )
      : undefined
  return (
    <Button
      className={styles.indicator}
      data-testid="task-progress"
      aria-expanded={expanded}
      aria-controls="background-tasks"
      onClick={onOpen}
    >
      {running ? (
        <ProgressSpinner />
      ) : task.status === 'completed' ? (
        <Check size={12} />
      ) : (
        <TriangleAlert size={12} />
      )}
      <span className={styles.title} role="status">
        {task.title}
      </span>
      {running && (
        <span
          className={`${styles.track} ${percent === undefined ? styles.indeterminate : ''}`}
          role="progressbar"
          aria-label={task.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </span>
      )}
      {running && percent !== undefined && <span className={styles.percent}>{percent}%</span>}
      {additionalCount > 0 && <span>+{additionalCount}</span>}
      <ChevronUp size={11} />
    </Button>
  )
}
