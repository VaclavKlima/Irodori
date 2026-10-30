import { randomUUID } from 'node:crypto'
import { validateManagedImageBytes, type ManagedImageBytes } from '../shared/resource-policy'

export interface ImageResourceQueryTransport {
  send(token: string): void
  /** The Electron adapter filters sender and main-frame identity before invoking the listener. */
  subscribe(listener: (token: string, value: unknown, error?: string) => void): () => void
}

/** Fresh, specific renderer inventory; cancellation/timeouts never fabricate empty ownership. */
export function queryImageResources(
  transport: ImageResourceQueryTransport,
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<ManagedImageBytes> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const token = randomUUID()
    const cleanup: { unsubscribe?: () => void; timer?: ReturnType<typeof setTimeout> } = {}
    let settled = false
    const finish = (value?: ManagedImageBytes, error?: unknown) => {
      if (settled) return
      settled = true
      cleanup.unsubscribe?.()
      clearTimeout(cleanup.timer)
      signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(Object.freeze({ ramBytes: value!.ramBytes, vramBytes: value!.vramBytes }))
    }
    const abort = () =>
      finish(undefined, signal.reason ?? new Error('Image resource query cancelled.'))
    cleanup.unsubscribe = transport.subscribe((returned, value, error) => {
      if (returned !== token || settled) return
      try {
        if (error) throw new Error(error)
        validateManagedImageBytes(value as ManagedImageBytes)
        finish(value as ManagedImageBytes)
      } catch (cause) {
        finish(undefined, cause)
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    cleanup.timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error('The editor image resource inventory is unavailable. Try again.'),
        ),
      timeoutMs,
    )
    try {
      signal.throwIfAborted()
      transport.send(token)
    } catch (error) {
      finish(undefined, error)
    }
  })
}
