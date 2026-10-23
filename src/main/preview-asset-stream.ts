import { createReadStream, read } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export interface PreviewAssetStreamLease {
  readonly path: string
  readonly file?: FileHandle
  readonly contentType: string
  readonly byteLength: number
  readonly release: () => void
}

export const PREVIEW_STREAM_CHUNK_BYTES = 1024 ** 2

/** A protocol stream retires its I/O before releasing the independently owned cache/file lease. */
export function createPreviewAssetStream(
  asset: PreviewAssetStreamLease,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  try {
    const options = { start, end, highWaterMark: PREVIEW_STREAM_CHUNK_BYTES }
    const stream = asset.file
      ? createReadStream(asset.path, {
          ...options,
          fd: asset.file.fd,
          // A number avoids FileHandle stream ownership. The lease closes the descriptor.
          fs: { read, close: (_fd, callback) => callback(null) },
        })
      : createReadStream(asset.path, options)
    const abort = () => stream.destroy()
    signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => {
      signal.removeEventListener('abort', abort)
      asset.release()
    })
    if (signal.aborted) stream.destroy()
    return stream
  } catch (error) {
    asset.release()
    throw error
  }
}
