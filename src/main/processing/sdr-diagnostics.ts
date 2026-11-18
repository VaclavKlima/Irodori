import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { validateNativeInspectionBounds } from '../../shared/inspection'
import { frameByteLength } from '../../shared/preview-frame'
import { addVisibleSdrPixel, emptyImageStatistics } from '../../shared/statistics'
import type { SdrDiagnosticsJob } from '../preview-types'

export async function scanSdrDiagnostics(
  path: string,
  frame: { width: number; height: number; sha256: string },
  job: SdrDiagnosticsJob,
) {
  const length = frameByteLength(frame.width, frame.height),
    { bounds, size } = job
  validateNativeInspectionBounds(bounds, frame.width, frame.height)
  if (
    ![size.width, size.height].every(Number.isSafeInteger) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > Math.min(bounds.width, 1024) ||
    size.height > Math.min(bounds.height, 1024)
  )
    throw new Error('Invalid SDR diagnostic mask dimensions.')
  const statistics = emptyImageStatistics(),
    mask = new Uint8Array(size.width * size.height),
    digest = createHash('sha256'),
    stride = frame.width * 4,
    strip = Buffer.alloc(Math.min(64, frame.height) * stride)
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size !== length) throw new Error('Invalid statistics frame.')
    for (let top = 0; top < frame.height; top += 64) {
      const rows = Math.min(64, frame.height - top),
        bytes = rows * stride
      let read = 0
      while (read < bytes) {
        const { bytesRead } = await file.read(strip, read, bytes - read, top * stride + read)
        if (!bytesRead) throw new Error('Incomplete statistics frame.')
        read += bytesRead
      }
      digest.update(strip.subarray(0, bytes))
      const first = Math.max(top, bounds.y),
        end = Math.min(top + rows, bounds.y + bounds.height)
      for (let y = first; y < end; y++) {
        const outputRow = Math.floor(((y - bounds.y) * size.height) / bounds.height) * size.width
        let at = (y - top) * stride + bounds.x * 4
        for (let x = 0; x < bounds.width; x++, at += 4) {
          if (!strip[at + 3]) continue
          const bits = addVisibleSdrPixel(statistics, strip[at], strip[at + 1], strip[at + 2])
          if (bits) mask[outputRow + Math.floor((x * size.width) / bounds.width)] |= bits
        }
      }
    }
    if (digest.digest('hex') !== frame.sha256) throw new Error('Damaged statistics frame.')
    return { ...statistics, mask }
  } finally {
    await file.close()
  }
}
