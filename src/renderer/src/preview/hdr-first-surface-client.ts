import {
  hdrFirstSurfaceOfferMatches,
  type HdrFirstSurfaceOffer,
} from '../../../shared/hdr-first-surface'
import {
  RESOURCE_POLICY_VERSION,
  type ResourcePolicySnapshot,
} from '../../../shared/resource-policy'
import { assertOpaqueFiniteRgba16LE } from '../../../shared/rgba16-validation'

/** The producing request freezes one policy for both native and browser ownership. */
export function freezeFirstSurfacePolicy(policy: ResourcePolicySnapshot): ResourcePolicySnapshot {
  if (
    policy.version !== RESOURCE_POLICY_VERSION ||
    policy.scope !== 'managed-image-resources' ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 0 ||
    !Number.isSafeInteger(policy.ram.effectiveBytes) ||
    policy.ram.effectiveBytes < 0 ||
    !Number.isSafeInteger(policy.vram.effectiveBytes) ||
    policy.vram.effectiveBytes < 0
  )
    throw new Error('Invalid first HDR surface resource policy.')
  return Object.freeze({
    ...policy,
    ram: Object.freeze({ ...policy.ram }),
    vram: Object.freeze({ ...policy.vram }),
  })
}

export function checkedFirstSurfaceOffer(offer: HdrFirstSurfaceOffer): HdrFirstSurfaceOffer {
  const copy = structuredClone(offer)
  if (
    !/^[a-f0-9]{64}$/.test(copy.photoId) ||
    !copy.requestId ||
    copy.identity.image.width > 32768 ||
    copy.identity.image.height > 32768 ||
    !hdrFirstSurfaceOfferMatches(
      copy,
      { ...copy.identity, rendererReservation: { ramBytes: 0, vramBytes: 0 } },
      copy.photoId,
      copy.requestId,
    )
  )
    throw new Error('Invalid first HDR surface descriptor.')
  return copy
}

/** Own the bounded receiver through its real digest, including cancellation after hashing starts. */
export async function readFirstSurface(
  offer: HdrFirstSurfaceOffer,
  signal: AbortSignal,
  observe?: (timings: Readonly<Record<string, number>>) => void,
): Promise<ArrayBuffer> {
  const started = performance.now(),
    timings: Record<string, number> = {}
  signal.throwIfAborted()
  const response = await fetch(offer.url, { signal, cache: 'no-store', redirect: 'error' })
  timings.fetchHeadersMs = performance.now() - started
  const reader = response.body?.getReader()
  let complete = false
  try {
    if (
      !response.ok ||
      Number(response.headers.get('content-length')) !== offer.byteLength ||
      !reader
    )
      throw new Error('Incomplete first HDR surface.')
    const bytes = new ArrayBuffer(offer.byteLength)
    const output = new Uint8Array(bytes)
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > output.byteLength - offset)
        throw new Error('Oversized first HDR surface.')
      output.set(value, offset)
      offset += value.byteLength
    }
    complete = true
    timings.receiveMs = performance.now() - started - timings.fetchHeadersMs
    if (offset !== output.byteLength) throw new Error('Incorrect first HDR surface length.')
    signal.throwIfAborted()
    const hashing = performance.now()
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    timings.hashMs = performance.now() - hashing
    const actual = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')
    if (actual !== offer.sha256) throw new Error('Damaged first HDR surface.')
    signal.throwIfAborted()
    const validation = performance.now()
    assertOpaqueFiniteRgba16LE(output)
    timings.pixelValidationMs = performance.now() - validation
    timings.validated = 1
    return bytes
  } finally {
    try {
      if (!complete) await reader?.cancel()
    } finally {
      reader?.releaseLock()
      timings.totalMs = performance.now() - started
      observe?.(Object.freeze({ ...timings }))
    }
  }
}
