import { open } from 'node:fs/promises'
import { compileResizeGpu } from '../../shared/export-resize-gpu'
import {
  exportResizeGpuAllocation,
  requireExportAllocation,
  type ExportAdmission,
} from '../../shared/export-resources'
import { createResizeGpu } from '../gpu/export-resize'

/** Production resize: CPU file I/O and coefficients, bounded GPU convolution, no fallback. */
export async function resizeLinearGpu(
  path: string,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: 3 | 6,
  row: (data: Float32Array, y: number) => void,
  admission: ExportAdmission,
  signal = new AbortController().signal,
) {
  signal.throwIfAborted()
  const allocation = exportResizeGpuAllocation(
    width,
    height,
    outWidth,
    outHeight,
    channels,
    admission,
  )
  requireExportAllocation(allocation)
  const plan = compileResizeGpu(width, height, outWidth, outHeight, channels)
  if (plan.hostBytes > allocation.bytes.ramBytes || plan.gpuBytes > allocation.bytes.vramBytes)
    throw new Error('GPU export resize exceeds its frozen allocation.')
  const owner = createResizeGpu(plan, allocation.gpuLimitBytes)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    if ((await file.stat()).size !== width * height * channels * 4)
      throw new Error('Incomplete export rendition.')
    await owner.run(
      async (index, signal) => {
        const data = new Float32Array(width * channels),
          bytes = Buffer.from(data.buffer)
        let read = 0
        while (read < bytes.byteLength) {
          signal.throwIfAborted()
          const part = await file!.read(
            bytes,
            read,
            bytes.byteLength - read,
            index * bytes.byteLength + read,
          )
          if (!part.bytesRead) throw new Error('Incomplete export row.')
          read += part.bytesRead
        }
        return data
      },
      row,
      signal,
    )
    return {
      renderer: 'gpu' as const,
      adapter: owner.adapter,
      gpuMemoryBytes: owner.bytes,
      peakCachedRows: owner.peakCachedRows,
    }
  } finally {
    try {
      await owner.close()
    } finally {
      await file?.close()
    }
  }
}
