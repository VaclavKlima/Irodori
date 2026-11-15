import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreparedMaskPresentation } from '../../shared/hdr'
import type { PreparedMaskStackRequest } from './prepared-mask-stack'

export type PreparedMaskFiles = Omit<PreparedMaskPresentation, 'candidate' | 'union'> & {
  candidate: Omit<PreparedMaskPresentation['candidate'], 'url'>
  union: Omit<PreparedMaskPresentation['union'], 'url'>
}

/** Hash bounded native bands for the existing browser stream-validation contract. */
async function describe(
  path: string,
  width: number,
  height: number,
  channels: number,
  expected: { byteLength: number; sha256: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size !== expected.byteLength)
      throw new Error('Incomplete Texture presentation source.')
    const whole = createHash('sha256'),
      strips: { byteLength: number; sha256: string }[] = []
    for (let y = 0; y < height; y += 64) {
      signal?.throwIfAborted()
      const bytes = Buffer.alloc(width * Math.min(64, height - y) * channels * 4)
      let read = 0
      while (read < bytes.length) {
        signal?.throwIfAborted()
        const next = await file.read(
          bytes,
          read,
          bytes.length - read,
          y * width * channels * 4 + read,
        )
        if (!next.bytesRead) throw new Error('Incomplete Texture presentation strip.')
        read += next.bytesRead
      }
      whole.update(bytes)
      strips.push({
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
    if (whole.digest('hex') !== expected.sha256)
      throw new Error('Texture presentation source changed.')
    return { byteLength: expected.byteLength, sha256: expected.sha256, strips }
  } finally {
    await file.close()
  }
}

export async function maskStackPresentationFiles(
  request: PreparedMaskStackRequest,
  pointKey: string,
  signal?: AbortSignal,
): Promise<PreparedMaskFiles> {
  const stack = request.stack,
    { width, height } = stack.candidate
  return {
    key: stack.key,
    context: stack.context,
    consumed: stack.consumed,
    parentSha256: stack.parent.asset.sha256,
    pointKey,
    candidate: await describe(stack.candidate.path, width, height, 4, stack.candidate, signal),
    union: await describe(stack.union.path, width, height, 1, stack.union, signal),
  }
}

/** Recheck a requested prefix before offering cached bytes to browser GPU retry/upload. */
export async function validateMaskStackPresentationBytes(
  directory: string,
  size: { width: number; height: number },
  files: PreparedMaskFiles,
  signal: AbortSignal,
) {
  for (const [name, descriptor, channels] of [
    ['mask-stack.f32', files.candidate, 4],
    ['mask-union.f32', files.union, 1],
  ] as const) {
    const actual = await describe(
      join(directory, name),
      size.width,
      size.height,
      channels,
      descriptor,
      signal,
    )
    if (
      actual.strips.some(
        (s, i) =>
          s.sha256 !== descriptor.strips[i]?.sha256 ||
          s.byteLength !== descriptor.strips[i]?.byteLength,
      )
    )
      throw new Error('Damaged cached Texture strip.')
  }
}

/** Prepared rendition files have their own lineage; they never enter ordinary source reuse. */
export async function validateMaskStackPresentationFiles(
  directory: string,
  size: { width: number; height: number },
  files: PreparedMaskFiles,
) {
  if (
    !files ||
    !/^[a-f0-9]{64}$/.test(files.key) ||
    !/^[a-f0-9]{64}$/.test(files.context) ||
    !/^[a-f0-9]{64}$/.test(files.parentSha256) ||
    files.consumed !== 'global-and-local-point-v1' ||
    typeof files.pointKey !== 'string'
  )
    throw new Error('Invalid Texture presentation identity.')
  for (const [name, descriptor, channels] of [
    ['mask-stack.f32', files.candidate, 4],
    ['mask-union.f32', files.union, 1],
  ] as const) {
    if (
      !descriptor ||
      descriptor.byteLength !== size.width * size.height * channels * 4 ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      descriptor.strips.length !== Math.ceil(size.height / 64) ||
      descriptor.strips.some(
        (s, i) =>
          s.byteLength !== size.width * Math.min(64, size.height - i * 64) * channels * 4 ||
          !/^[a-f0-9]{64}$/.test(s.sha256),
      )
    )
      throw new Error('Invalid Texture presentation descriptor.')
    const file = await open(join(directory, name), 'r')
    try {
      if ((await file.stat()).size !== descriptor.byteLength)
        throw new Error('Incomplete Texture presentation file.')
    } finally {
      await file.close()
    }
  }
}
