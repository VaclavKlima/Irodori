import {
  HDR_RENDERING_TABLES_VERSION,
  validateHdrRenderingTables,
  type HdrRenderingTables,
} from '../../../shared/hdr-rendering-tables'

export interface HdrRenderingTablePreparation {
  readonly state: 'cold' | 'pending' | 'ready'
  readonly tables: Promise<HdrRenderingTables>
}

/** One target-only preparation, independent of photo, display generation and GPU device. */
export class HdrRenderingTableCache {
  private pending?: Promise<HdrRenderingTables>
  private ready = false
  constructor(private prepare: () => Promise<HdrRenderingTables>) {}

  acquire(signal: AbortSignal): HdrRenderingTablePreparation {
    signal.throwIfAborted()
    const state = this.pending ? (this.ready ? 'ready' : 'pending') : 'cold'
    if (!this.pending) {
      const pending = Promise.resolve()
        .then(() => this.prepare())
        .then((tables) => {
          validateHdrRenderingTables(tables)
          this.ready = true
          return tables
        })
      this.pending = pending
      void pending.catch(() => {
        if (this.pending === pending) {
          this.pending = undefined
          this.ready = false
        }
      })
    }
    const pending = this.pending
    const tables = new Promise<HdrRenderingTables>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      void pending.then(
        (value) => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
    })
    return { state, tables }
  }
}

function prepareInWorker(): Promise<HdrRenderingTables> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./display-rendering-worker.ts', import.meta.url), {
      type: 'module',
    })
    const finish = () => {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      finish()
      try {
        if (data && typeof data === 'object' && 'error' in data) throw new Error(String(data.error))
        validateHdrRenderingTables(data)
        resolve(data)
      } catch (error) {
        reject(error)
      }
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message))
    }
    worker.onmessageerror = () => {
      finish()
      reject(new Error('Fixed HDR rendering table transfer failed.'))
    }
    try {
      worker.postMessage({ version: HDR_RENDERING_TABLES_VERSION })
    } catch (error) {
      finish()
      reject(error)
    }
  })
}

const fixedTables = new HdrRenderingTableCache(prepareInWorker)

export function prepareHdrRenderingTables(signal: AbortSignal): HdrRenderingTablePreparation {
  return fixedTables.acquire(signal)
}
