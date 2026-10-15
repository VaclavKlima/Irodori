import { TaskErrors } from './TaskErrors'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { type BackgroundTask, type TaskErrorPage } from '../../../shared/contracts'
import { TaskProgress } from './TaskProgress'
import styles from './TaskProgress.module.css'

interface TaskCenterProps {
  onOpenResult: (id: string) => Promise<void>
  tasks: BackgroundTask[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCancel: (id: string) => Promise<void>
  onDismiss: (id: string) => Promise<void>
  getErrors: (id: string, offset: number) => Promise<TaskErrorPage>
}

export function TaskCenter({
  tasks,
  open,
  onOpenChange,
  onCancel,
  onDismiss,
  getErrors,
  onOpenResult,
}: TaskCenterProps) {
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const latest =
    tasks.find(
      (task) =>
        (task.kind === 'merge' || task.kind === 'delete') &&
        (task.status === 'running' || task.status === 'cancelling'),
    ) ??
    tasks.find((task) => task.status === 'running' || task.status === 'cancelling') ??
    tasks.at(-1)
  useEffect(() => {
    if (!open) return
    button.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, onOpenChange])
  if (!latest) return null
  return (
    <div
      ref={root}
      className={styles.center}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onOpenChange(false)
          root.current?.querySelector<HTMLButtonElement>('[data-testid="task-progress"]')?.focus()
        }
      }}
    >
      <TaskProgress
        task={latest}
        expanded={open}
        additionalCount={tasks.length - 1}
        onOpen={() => onOpenChange(!open)}
      />
      {
        <section
          hidden={!open}
          inert={!open}
          className={styles.popover}
          id="background-tasks"
          aria-label="Background tasks"
          data-testid="task-details"
        >
          <header>
            <strong>Background tasks</strong>
            <button
              ref={button}
              aria-label="Close task details"
              onClick={() => {
                onOpenChange(false)
                root.current
                  ?.querySelector<HTMLButtonElement>('[data-testid="task-progress"]')
                  ?.focus()
              }}
            >
              <X size={14} />
            </button>
          </header>
          <div className={styles.taskList}>
            {[...tasks].reverse().map((task) => (
              <TaskDetails
                key={task.id}
                active={open}
                task={task}
                onCancel={onCancel}
                onDismiss={onDismiss}
                getErrors={getErrors}
                onOpenResult={onOpenResult}
              />
            ))}
          </div>
        </section>
      }
    </div>
  )
}

function TaskDetails({
  task,
  active: detailsActive,
  onCancel,
  onDismiss,
  getErrors,
  onOpenResult,
}: Pick<TaskCenterProps, 'onCancel' | 'onDismiss' | 'getErrors' | 'onOpenResult'> & {
  task: BackgroundTask
  active: boolean
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [errorsOpen, setErrorsOpen] = useState(false)
  const active = task.status === 'running' || task.status === 'cancelling'
  async function act(action: () => Promise<void>) {
    setPending(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(String(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <article className={styles.task} data-testid={`task-${task.id}`} data-status={task.status}>
      <strong role="status">{task.title}</strong>
      {task.phase && <p>{task.phase}</p>}
      {task.waitingReason && (
        <p role="status">
          {task.waitingReason === 'foreground'
            ? 'Waiting for photo editing or preview'
            : task.waitingReason === 'export'
              ? 'Waiting for JPEG export'
              : task.waitingReason === 'library-operation'
                ? 'Waiting for merge or deletion'
                : task.waitingReason === 'pipeline-capacity'
                  ? 'Waiting for preparation'
                  : 'Waiting for RAW preparation'}
        </p>
      )}
      {task.detail && (
        <p className={styles.filename} title={task.detail}>
          {task.detail}
        </p>
      )}
      {task.items && (
        <p>
          {task.items.completed} / {task.items.total} {task.items.label}
        </p>
      )}
      {task.outcomes && (
        <p>
          {task.outcomes.processed} processed · {task.outcomes.imported} imported ·{' '}
          {task.outcomes.duplicates} duplicates skipped · {task.outcomes.failed} failed
        </p>
      )}
      {task.export && (
        <p>
          {task.export.exported} exported · {task.export.skipped} skipped · {task.export.failed}{' '}
          failed{task.export.cancelled > 0 && ` · ${task.export.cancelled} cancelled`}
        </p>
      )}
      {task.skippedAfterDeletion !== undefined && task.skippedAfterDeletion > 0 && (
        <p>{task.skippedAfterDeletion} Skipped after deletion</p>
      )}
      {!!task.unprocessed && (
        <p>{task.unprocessed} photos unprocessed after source disconnection</p>
      )}
      {task.transfer && (
        <>
          <p>
            {task.transfer.copied} copied · {task.transfer.prepared} prepared
          </p>
          <p data-testid="task-byte-progress">
            {bytes(task.transfer.bytes)} / {bytes(task.transfer.totalBytes)} transferred
            {task.transfer.bytesPerSecond > 0 ? ` · ${bytes(task.transfer.bytesPerSecond)}/s` : ''}
          </p>
        </>
      )}
      {task.progress && !task.transfer && (
        <p data-testid="task-byte-progress">
          {task.progress.unit === 'bytes'
            ? `${bytes(task.progress.completed)} / ${bytes(task.progress.total)} transferred`
            : `${task.progress.completed} / ${task.progress.total} items`}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {task.export && (
          <button
            disabled={pending}
            onClick={() => void act(() => window.luma.showExportFolder(task.id))}
          >
            Show in folder
          </button>
        )}
        {task.resultPhotoId && (
          <button onClick={() => void act(() => onOpenResult(task.resultPhotoId!))}>
            Open result
          </button>
        )}
        {task.errorCount > 0 && (
          <button aria-expanded={errorsOpen} onClick={() => setErrorsOpen(!errorsOpen)}>
            {errorsOpen ? 'Hide' : 'Show'} {task.errorCount} errors
          </button>
        )}
        {active ? (
          <button
            disabled={pending || task.status === 'cancelling'}
            onClick={() => void act(() => onCancel(task.id))}
          >
            {task.status === 'cancelling' ? 'Cancelling…' : 'Cancel task'}
          </button>
        ) : (
          <button disabled={pending} onClick={() => void act(() => onDismiss(task.id))}>
            Dismiss
          </button>
        )}
      </div>
      {task.errorCount > 0 && (
        <TaskErrors
          id={task.id}
          total={task.errorCount}
          active={detailsActive && errorsOpen}
          getErrors={getErrors}
        />
      )}
    </article>
  )
}

function bytes(value: number) {
  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(0)} KB`
    : `${(value / 1024 / 1024).toFixed(1)} MB`
}
