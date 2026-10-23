import { sameAdjustments } from '../../../shared/adjustments'
import type { HdrWorkingAsset } from '../../../shared/hdr'
import { reduceHdrMask } from '../../../shared/hdr-statistics'
import {
  NATIVE_HDR_MASK_VERSION,
  type NativeHdrMaskRequest,
  type NativeHdrMaskResult,
} from '../../../shared/native-hdr-mask'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const sha = /^[a-f0-9]{64}$/
/** Runs in the existing analysis worker. Abort never skips an in-flight digest. */
export async function receiveNativeHdrMask(
  result: NativeHdrMaskResult,
  request: NativeHdrMaskRequest,
  asset: HdrWorkingAsset,
  signal: AbortSignal,
) {
  if (
    result.version !== NATIVE_HDR_MASK_VERSION ||
    result.kind !== 'mask' ||
    result.requestId !== request.requestId ||
    result.sessionId !== request.sessionId ||
    result.generation !== request.generation ||
    result.settingsRevision !== request.expectedSettingsRevision ||
    result.comparison !== request.comparison ||
    result.domain !== request.domain ||
    JSON.stringify(result.source) !== JSON.stringify(request.source) ||
    !sameAdjustments(result.parameters, request.parameters) ||
    !uuid.test(result.maskId) ||
    !sha.test(result.sha256) ||
    !sha.test(result.arithmeticSha256) ||
    result.width !== asset.width ||
    result.height !== asset.height ||
    result.byteLength !== asset.width * asset.height ||
    result.format !== 'r8-hdr-mask-bits-v1'
  )
    throw new Error('Native mask result does not match its exact request/source.')
  for (const key of [
    'generation',
    'requested',
    'mode',
    'colorSpace',
    'peak',
    'headroom',
    'outputVersion',
  ] as const)
    if (result.target[key] !== request.target[key]) throw new Error('Native mask target changed.')
  const expectedUrl = `luma-photo://library/${request.source.photoId}/mask/${result.maskId}`
  if (result.url !== expectedUrl) throw new Error('Invalid native mask capability.')
  signal.throwIfAborted()
  const response = await fetch(result.url, { signal })
  if (!response.ok || Number(response.headers.get('content-length')) !== result.byteLength)
    throw new Error('Native mask response length mismatch.')
  const storage = new Uint8Array(result.byteLength),
    reader = response.body?.getReader()
  if (!reader) throw new Error('Native mask stream is missing.')
  let offset = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.length > storage.length)
        throw new Error('Native mask stream exceeds its descriptor.')
      storage.set(value, offset)
      offset += value.length
    }
    if (offset !== storage.length) throw new Error('Native mask stream is truncated.')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  // This real, noninterruptible operation remains owned until its completion.
  const digest = await crypto.subtle.digest('SHA-256', storage)
  const actual = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  if (actual !== result.sha256) throw new Error('Native mask body hash mismatch.')
  signal.throwIfAborted()
  for (const bits of storage) if (bits > 15) throw new Error('Invalid native mask bits.')
  // Keep the unchanged odd-edge OR reducer as the independent packing policy.
  const pyramid = reduceHdrMask(storage, asset.width, asset.height)
  signal.throwIfAborted()
  return pyramid
}
