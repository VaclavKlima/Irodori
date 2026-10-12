import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'

export interface CopyControl {
  checkpoint?: () => Promise<boolean>
  resumed?: () => Promise<void>
  chunk?: <T>(work: () => Promise<T>) => Promise<T>
  active?: (milliseconds: number) => void
}

export async function copyOriginal(
  source: string,
  destination: string,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  control: CopyControl = {},
): Promise<string> {
  signal.throwIfAborted()
  const hash = createHash('sha256')
  const output = await open(destination, 'wx')
  const input = createReadStream(source, { signal, highWaterMark: 1024 * 1024 })
  const iterator = input[Symbol.asyncIterator]()
  const run = control.chunk ?? (async <T>(work: () => Promise<T>) => work())
  try {
    while (true) {
      const paused = await control.checkpoint?.()
      const done = await run(async () => {
        signal.throwIfAborted()
        if (paused) await control.resumed?.()
        const at = performance.now()
        try {
          const part = await iterator.next()
          if (part.done) return true
          const chunk = part.value as Buffer
          let offset = 0
          while (offset < chunk.length) {
            signal.throwIfAborted()
            const written = await output.write(chunk, offset, chunk.length - offset)
            if (!written.bytesWritten) throw new Error('Copying the original made no progress.')
            offset += written.bytesWritten
          }
          hash.update(chunk)
          onProgress(chunk.length)
          return false
        } finally {
          control.active?.(performance.now() - at)
        }
      })
      if (done) break
    }
    await run(async () => {
      signal.throwIfAborted()
      const at = performance.now()
      try {
        await output.sync()
      } finally {
        control.active?.(performance.now() - at)
      }
    })
    return hash.digest('hex')
  } finally {
    input.destroy()
    await output.close()
  }
}
