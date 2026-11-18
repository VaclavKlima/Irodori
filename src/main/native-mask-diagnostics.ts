import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { DisplayTarget } from '../shared/hdr'
import { validateNativeInspectionBounds, type InspectionBounds } from '../shared/inspection'
import type { ClippingCoverageResult } from './clipping-coverage/types'
import { openDiagnosticCoverage } from './processing/diagnostic-coverage'

interface MaskGrid {
  width: number
  height: number
}

export interface HdrDiagnosticMask {
  mask: Uint8Array
  aboveWhite: number
  exceedingHeadroom: number | null
  outputClipped: number
  gamutLimited: number
}

export async function reduceNativeHdrMask(
  path: string,
  native: MaskGrid & { byteLength: number; sha256: string },
  bounds: InspectionBounds,
  size: MaskGrid,
  target: DisplayTarget,
  signal: AbortSignal,
  selection?: ClippingCoverageResult,
): Promise<HdrDiagnosticMask> {
  validateNativeInspectionBounds(bounds, native.width, native.height)
  if (
    ![size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0) ||
    size.width > Math.min(bounds.width, 1024) ||
    size.height > Math.min(bounds.height, 1024) ||
    native.byteLength !== native.width * native.height ||
    native.byteLength > 32 * 1024 ** 2
  )
    throw new Error('Invalid HDR diagnostic mask geometry.')

  signal.throwIfAborted()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let coverage: Awaited<ReturnType<typeof openDiagnosticCoverage>> | undefined
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size !== native.byteLength)
      throw new Error('The native HDR diagnostic mask is incomplete.')
    if (selection) coverage = await openDiagnosticCoverage(selection, native, signal)

    const output = target.mode === 'hdr',
      knownHeadroom = output && target.headroom !== null,
      maskFlags = output ? (knownHeadroom ? 15 : 13) : 4,
      mask = new Uint8Array(size.width * size.height),
      digest = createHash('sha256'),
      stripRows = Math.min(64, native.height),
      strip = Buffer.alloc(native.width * stripRows)
    let aboveWhite = 0,
      exceedingHeadroom = 0,
      outputClipped = 0,
      gamutLimited = 0
    for (let row = 0; row < native.height; row += stripRows) {
      signal.throwIfAborted()
      const rows = Math.min(stripRows, native.height - row),
        length = rows * native.width
      for (let offset = 0; offset < length;) {
        const { bytesRead } = await file.read(
          strip,
          offset,
          length - offset,
          row * native.width + offset,
        )
        signal.throwIfAborted()
        if (!bytesRead) throw new Error('The native HDR diagnostic mask is incomplete.')
        offset += bytesRead
      }
      digest.update(strip.subarray(0, length))
      const include = await coverage?.strip(row, rows)
      for (
        let y = Math.max(bounds.y, row);
        y < Math.min(bounds.y + bounds.height, row + rows);
        y++
      ) {
        const sourceRow = (y - row) * native.width,
          outputRow = Math.floor(((y - bounds.y) * size.height) / bounds.height) * size.width
        for (let x = 0; x < bounds.width; x++) {
          const index = sourceRow + bounds.x + x
          if (include && include[index] <= 0) continue
          // The native sink already validated the mask flags. Authenticate those
          // same bytes below, and suppress target-specific bits in working HDR.
          const flags = strip[index] & maskFlags
          aboveWhite += Number((flags & 4) !== 0)
          exceedingHeadroom += Number((flags & 2) !== 0)
          outputClipped += Number((flags & 1) !== 0)
          gamutLimited += Number((flags & 8) !== 0)
          mask[outputRow + Math.floor((x * size.width) / bounds.width)] |= flags
        }
      }
    }
    signal.throwIfAborted()
    if (digest.digest('hex') !== native.sha256)
      throw new Error('The native HDR diagnostic mask hash did not match.')
    coverage?.finish()
    return {
      mask,
      aboveWhite,
      exceedingHeadroom: knownHeadroom ? exceedingHeadroom : null,
      outputClipped,
      gamutLimited,
    }
  } finally {
    await Promise.all([file.close(), coverage?.close()])
  }
}
