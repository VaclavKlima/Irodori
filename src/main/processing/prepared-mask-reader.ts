import { createHash } from 'node:crypto'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { EXPORT_GPU_LIMIT_BYTES, validateExportAdmission } from '../../shared/export-resources'
import { localMaskAllocationBytes } from '../../shared/masks-gpu'
import {
  validatePreparedMaskStack,
  type PreparedMaskStackContext,
  type PreparedMaskStackRequest,
} from './prepared-mask-stack'

async function checkedFile(
  descriptor: { path: string; byteLength: number; sha256: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const before = await lstat(descriptor.path)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== descriptor.byteLength)
    throw new Error('Invalid prepared mask file.')
  const file = await open(descriptor.path, 'r')
  try {
    const after = await file.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size !== descriptor.byteLength
    )
      throw new Error('Prepared mask file changed during acquisition.')
    const digest = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false, signal }))
      digest.update(bytes)
    signal.throwIfAborted()
    if (digest.digest('hex') !== descriptor.sha256) throw new Error('Damaged prepared mask file.')
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

async function readBytes(file: FileHandle, offset: number, length: number, signal: AbortSignal) {
  const bytes = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    signal.throwIfAborted()
    const result = await file.read(bytes, read, length - read, offset + read)
    if (!result.bytesRead) throw new Error('Incomplete prepared mask file.')
    read += result.bytesRead
  }
  return bytes
}

/** Bounded file ownership shared by prepared preview and frozen renditions.
 * The actual legacy strip stream must hash to the receipt's parent before publication.
 */
export async function openPreparedMaskReader(
  request: PreparedMaskStackRequest,
  context: PreparedMaskStackContext,
  signal: AbortSignal,
  retainedBytes = 0,
) {
  const { stack, admission } = structuredClone(request)
  validatePreparedMaskStack(stack, context)
  validateExportAdmission(admission)
  const capacity = stack.candidate.width * Math.min(64, stack.candidate.height)
  // Candidate and union bands plus read/hash/upload snapshots coexist with the caller's input.
  const workRamBytes =
    capacity * 80 +
    16 * 1024 ** 2 +
    localMaskAllocationBytes(context.adjustments, {
      width: stack.candidate.width,
      height: stack.candidate.height,
    })
  const ramBytes = workRamBytes + retainedBytes
  const gpuLimitBytes = Math.min(
    EXPORT_GPU_LIMIT_BYTES,
    admission.policy.vram.effectiveBytes - admission.reservation.vramBytes,
  )
  if (
    !Number.isSafeInteger(retainedBytes) ||
    retainedBytes < 0 ||
    admission.reservation.ramBytes + ramBytes > admission.policy.ram.effectiveBytes ||
    gpuLimitBytes <= 0
  )
    throw new Error('Prepared mask consumption exceeds the frozen resource admission.')
  let candidate: FileHandle | undefined, union: FileHandle | undefined
  try {
    candidate = await checkedFile(stack.candidate, signal)
    union = await checkedFile(stack.union, signal)
  } catch (error) {
    await candidate?.close()
    throw error
  }
  let offset = 0,
    finished = false,
    closed = false
  const sourceHash = createHash('sha256'),
    candidateHash = createHash('sha256'),
    unionHash = createHash('sha256')
  return {
    gpuLimitBytes,
    ramBytes,
    workRamBytes,
    identity: { key: stack.key, consumed: stack.consumed, parentSha256: stack.parent.asset.sha256 },
    async read(legacy: Float32Array<ArrayBuffer>, pixelOffset: number) {
      signal.throwIfAborted()
      const count = legacy.length / 4
      if (
        closed ||
        finished ||
        pixelOffset !== offset ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > capacity ||
        offset + count > stack.candidate.width * stack.candidate.height
      )
        throw new Error('Invalid prepared mask strip sequence.')
      const pixels = await readBytes(candidate!, offset * 16, count * 16, signal)
      const coverage = await readBytes(union!, offset * 4, count * 4, signal)
      sourceHash.update(new Uint8Array(legacy.buffer, legacy.byteOffset, legacy.byteLength))
      candidateHash.update(pixels)
      unionHash.update(coverage)
      offset += count
      return {
        pixels: new Float32Array(
          pixels.buffer as ArrayBuffer,
          pixels.byteOffset,
          pixels.byteLength / 4,
        ),
        union: new Float32Array(
          coverage.buffer as ArrayBuffer,
          coverage.byteOffset,
          coverage.byteLength / 4,
        ),
      }
    },
    finish() {
      signal.throwIfAborted()
      if (closed || finished || offset !== stack.candidate.width * stack.candidate.height)
        throw new Error('Incomplete prepared mask consumption.')
      finished = true
      if (
        sourceHash.digest('hex') !== stack.parent.asset.sha256 ||
        candidateHash.digest('hex') !== stack.candidate.sha256 ||
        unionHash.digest('hex') !== stack.union.sha256
      )
        throw new Error('Prepared mask source or output changed during consumption.')
    },
    async close() {
      if (closed) return
      closed = true
      await Promise.all([candidate!.close(), union!.close()])
    },
  }
}

/** Holds the verified parent handle through consumption; never reopens a renderer path. */
export async function* preparedMaskParentStrips(
  request: PreparedMaskStackRequest,
  signal: AbortSignal,
) {
  const asset = request.stack.parent.asset
  const file = await checkedFile(asset, signal)
  try {
    for (let y = 0; y < asset.height; y += 64) {
      const bytes = await readBytes(
        file,
        y * asset.width * 16,
        asset.width * Math.min(64, asset.height - y) * 16,
        signal,
      )
      if (
        asset.hdr &&
        createHash('sha256').update(bytes).digest('hex') !== asset.hdr.strips[y / 64].sha256
      )
        throw new Error('Damaged prepared mask parent strip.')
      yield new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4)
    }
  } finally {
    await file.close()
  }
}
