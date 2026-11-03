import type { JSHandle, Page } from '@playwright/test'
import type {
  MaskParityResult,
  MaskParityRuntimeStart,
  MaskParityStart,
} from './native-hdr-mask-parity.worker'
interface WorkerApi {
  start(value: MaskParityStart): Promise<MaskParityRuntimeStart>
  source(index: number, bytes: string): Promise<unknown>
  native(index: number, bytes: string): Promise<unknown>
  finish(): Promise<MaskParityResult>
  close(): void
}
export async function createOracle(page: Page, filename: string) {
  const handle: JSHandle<WorkerApi> = await page.evaluateHandle((name): WorkerApi => {
    const worker = new Worker(new URL(`assets/${name}`, location.href), { type: 'module' })
    let serial = 0
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >()
    const invoke = (command: unknown, transfer: Transferable[] = []) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++serial
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, command }, transfer)
      })
    const send = (kind: 'source' | 'native', index: number, base64: string) => {
      const decoded = atob(base64),
        bytes = new Uint8Array(decoded.length)
      for (let at = 0; at < decoded.length; at++) bytes[at] = decoded.charCodeAt(at)
      return invoke({ kind, index, bytes: bytes.buffer }, [bytes.buffer])
    }
    worker.onmessage = ({ data }) => {
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.error) entry.reject(new Error(data.error))
      else entry.resolve(data.result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      for (const entry of pending.values()) entry.reject(new Error(event.message))
      pending.clear()
    }
    return {
      start: (start) => invoke({ kind: 'start', start }) as Promise<MaskParityRuntimeStart>,
      source: (index, bytes) => send('source', index, bytes),
      native: (index, bytes) => send('native', index, bytes),
      finish: () => invoke({ kind: 'finish' }) as Promise<MaskParityResult>,
      close: () => {
        for (const entry of pending.values()) entry.reject(new Error('Parity worker closed.'))
        pending.clear()
        worker.terminate()
      },
    }
  }, filename)
  return {
    handle,
    close: async () => {
      try {
        if (!page.isClosed()) await handle.evaluate((control) => control.close())
      } finally {
        await handle.dispose()
      }
    },
  }
}
