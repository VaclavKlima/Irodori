import type { MessagePort } from 'node:worker_threads'
import type { CatalogRequest, CatalogResponse } from './contracts'
import { CatalogMutations } from './domain'
import { CatalogConnectionError } from './transaction'

const operations = new Set([
  'processing.publish',
  'edits.commit',
  'edit-application.accept',
  'edit-application.result',
  'edit-application.task',
  'edit-application.dismiss',
  'workspace.save',
  'stack.group',
  'stack.ungroup',
  'stack.remove',
  'stack.cover',
  'stack.expanded',
  'capture.publish',
  'capture.reconcile',
  'original.publish',
  'source.record',
  'camera.record',
  'camera.sample',
  'removal.journal',
  'removal.clear',
  'removal.finish',
  'merge.journal',
  'merge.publish',
  'export.authorize',
  'export.accept',
  'export.file',
  'export.task',
  'export.dismiss',
])

/** Shared transport seam for the real worker and a separately owned lifecycle fixture. */
export function serveCatalog(port: MessagePort, domain: CatalogMutations): void {
  let closed = false,
    previous = 0
  const send = (value: CatalogResponse) => port.postMessage(value)
  const fatal = (error: unknown): never => {
    closed = true
    try {
      if (domain.db.isOpen) domain.db.close()
    } finally {
      port.close()
    }
    throw error
  }
  port.on('message', (value: CatalogRequest) => {
    if (closed) return
    if (!value || typeof value !== 'object') return fatal(new Error('Invalid catalog request.'))
    if (value.type === 'close') {
      if (Object.keys(value).length !== 1) return fatal(new Error('Invalid catalog close.'))
      closed = true
      domain.db.close()
      send({ type: 'closed' })
      port.close()
      return
    }
    if (
      value.type !== 'mutate' ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== previous + 1 ||
      Object.keys(value).some((key) => !['type', 'sequence', 'command'].includes(key)) ||
      !value.command ||
      typeof value.command !== 'object' ||
      !operations.has(value.command.operation) ||
      Object.keys(value.command).some((key) => !['operation', 'payload'].includes(key)) ||
      !value.command.payload ||
      typeof value.command.payload !== 'object' ||
      Array.isArray(value.command.payload)
    )
      return fatal(new Error('Invalid catalog mutation envelope.'))
    previous = value.sequence
    let result: unknown
    try {
      result = domain.execute(value.command)
    } catch (error) {
      if (error instanceof CatalogConnectionError || !domain.db.isOpen || domain.db.isTransaction)
        return fatal(error)
      send({
        type: 'rejected',
        sequence: value.sequence,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (!domain.db.isOpen || domain.db.isTransaction)
      return fatal(new CatalogConnectionError('Catalog mutation did not finish its transaction.'))
    try {
      send({ type: 'result', sequence: value.sequence, value: result })
    } catch (error) {
      fatal(error)
    }
  })
  send({ type: 'ready' })
}
