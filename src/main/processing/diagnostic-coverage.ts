import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { endianness } from 'node:os'
import { CLIPPING_COVERAGE_ROWS } from '../../shared/clipping-coverage'
import type { ClippingCoverageResult } from '../clipping-coverage/types'

const sha = /^[a-f0-9]{64}$/

/** Stream the exact selection from the existing GPU coverage owner. */
export async function openDiagnosticCoverage(
  coverage: ClippingCoverageResult,
  { width, height }: { width: number; height: number },
  signal?: AbortSignal,
) {
  const byteLength = width * height * 4
  if (
    endianness() !== 'LE' ||
    coverage.width !== width ||
    coverage.height !== height ||
    coverage.maskCount !== 1 ||
    coverage.byteLength !== byteLength ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 4 ||
    byteLength > 128 * 1024 ** 2 ||
    !sha.test(coverage.sha256) ||
    !Array.isArray(coverage.stripSha256) ||
    coverage.stripSha256.length !== Math.ceil(height / CLIPPING_COVERAGE_ROWS) ||
    coverage.stripSha256.some((hash) => !sha.test(hash))
  )
    throw new Error('Saved-mask coverage does not match the diagnostic grid.')
  signal?.throwIfAborted()
  const file = await open(coverage.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== byteLength)
      throw new Error('Saved-mask diagnostic coverage is incomplete.')
    const buffer = Buffer.alloc(width * Math.min(height, CLIPPING_COVERAGE_ROWS) * 4)
    const digest = createHash('sha256')
    let next = 0
    return {
      async strip(top: number, rows: number) {
        signal?.throwIfAborted()
        if (top !== next || rows !== Math.min(height - top, CLIPPING_COVERAGE_ROWS))
          throw new Error('Saved-mask diagnostic strip does not match the scan.')
        const length = width * rows * 4
        for (let offset = 0; offset < length;) {
          const { bytesRead } = await file.read(
            buffer,
            offset,
            length - offset,
            top * width * 4 + offset,
          )
          signal?.throwIfAborted()
          if (!bytesRead) throw new Error('Saved-mask diagnostic coverage is incomplete.')
          offset += bytesRead
        }
        const bytes = buffer.subarray(0, length)
        if (
          createHash('sha256').update(bytes).digest('hex') !==
          coverage.stripSha256[top / CLIPPING_COVERAGE_ROWS]
        )
          throw new Error('Saved-mask diagnostic coverage strip hash changed.')
        const values = new Float32Array(buffer.buffer, buffer.byteOffset, length / 4)
        if (values.some((value) => !(value >= 0 && value <= 1)))
          throw new Error('Saved-mask diagnostic coverage is outside zero through one.')
        digest.update(bytes)
        next += rows
        return values
      },
      finish() {
        signal?.throwIfAborted()
        if (next !== height || digest.digest('hex') !== coverage.sha256)
          throw new Error('Saved-mask diagnostic coverage hash changed.')
      },
      close: () => file.close(),
    }
  } catch (error) {
    await file.close()
    throw error
  }
}
