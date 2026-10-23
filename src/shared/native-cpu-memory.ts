export interface CpuManagedBytes {
  readonly ramBytes: number
  readonly gpuBytes: number
}
export interface CpuMemoryRequest {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly outputWidth: number
  readonly outputHeight: number
  readonly canvasWidth: number
  readonly canvasHeight: number
  readonly threads: 1 | 4 | 8
  readonly oldPairBytes: number
  readonly existingOwners: CpuManagedBytes
}
export interface CpuMemoryLimits {
  readonly ramBytes: number
  readonly gpuBytes: number
  readonly revision: number
}
function count(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`)
  return value
}
function product(label: string, ...values: number[]) {
  return values.reduce((result, value) => count(result * count(value, label), label), 1)
}
function sum(...values: number[]) {
  return values.reduce((total, value) => count(total + value, 'managed sum'), 0)
}

export function nativeCpuMemory(request: CpuMemoryRequest, limits: CpuMemoryLimits) {
  const dimensions = [
    request.sourceWidth,
    request.sourceHeight,
    request.outputWidth,
    request.outputHeight,
    request.canvasWidth,
    request.canvasHeight,
  ]
  if (
    dimensions.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 32768) ||
    ![1, 4, 8].includes(request.threads)
  )
    throw new Error('Invalid CPU presentation geometry.')
  const policy = Object.freeze({
    ramBytes: count(limits.ramBytes, 'RAM limit'),
    gpuBytes: count(limits.gpuBytes, 'GPU limit'),
    revision: count(limits.revision, 'policy revision'),
  })
  const sourcePixels = product('source pixels', request.sourceWidth, request.sourceHeight)
  const outputPixels = product('output pixels', request.outputWidth, request.outputHeight)
  const canvasPixels = product('canvas pixels', request.canvasWidth, request.canvasHeight)
  if (product('source bytes', sourcePixels, 16) > 512 * 1024 ** 2)
    throw new Error('Unsupported CPU source size.')
  const draftScale = 1024 / Math.max(request.sourceWidth, request.sourceHeight)
  const draftWidth = Math.max(1, Math.round(request.sourceWidth * draftScale)),
    draftHeight = Math.max(1, Math.round(request.sourceHeight * draftScale))
  if (
    !(
      request.outputWidth === request.sourceWidth && request.outputHeight === request.sourceHeight
    ) &&
    !(
      Math.max(request.sourceWidth, request.sourceHeight) > 1024 &&
      request.outputWidth === draftWidth &&
      request.outputHeight === draftHeight
    )
  )
    throw new Error('CPU output must preserve full or existing draft geometry.')
  const sourceStrip = product(
    'source strip',
    request.sourceWidth,
    Math.min(64, request.sourceHeight),
    16,
  )
  const outputStripPair = product(
    'output strip pair',
    request.outputWidth,
    Math.min(64, request.outputHeight),
    8,
  )
  const samplePair = product(
    'source samples',
    Math.min(65536, sourcePixels) + Math.min(8192, sourcePixels),
    16,
  )
  const oldPair = count(request.oldPairBytes, 'old pair bytes')
  const existing = Object.freeze({
    ramBytes: count(request.existingOwners.ramBytes, 'existing RAM'),
    gpuBytes: count(request.existingOwners.gpuBytes, 'existing GPU'),
  })
  const owners = Object.freeze({
    // Main leased-input buffer + native input buffer. Node hashing is synchronous.
    input: sourceStrip * 2,
    // Native pair + main parser/write pair. File/pipe writers retain buffers until callbacks.
    output: outputStripPair * 2,
    // Conservative stream queues, contexts and bookkeeping; not process heap/RSS.
    nativeAndTransportAllowance: sum(1024 ** 2, request.threads * 512 * 1024, 6 * 64 * 1024),
    // Old/new source sets, main collector/file staging, renderer digest and
    // analysis handoff can overlap; keep six sets until the real phase proof.
    samples: samplePair * 6,
    // Sequential fetch + sequential WebCrypto digest + bitmap creation. This
    // upper allowance includes a possible host mirror; no concurrent plane loads.
    newPairConstruction: outputPixels * 16,
    oldPair,
    // Align with the current conservative opaque browser-canvas allowance.
    canvas: canvasPixels * 32,
    retainedRecovery: 4 * 1024 ** 2,
  })
  const commonRam = sum(existing.ramBytes, oldPair, owners.canvas, owners.retainedRecovery)
  const nativeRam = sum(
    commonRam,
    owners.input,
    owners.output,
    owners.nativeAndTransportAllowance,
    owners.samples,
  )
  const bitmapRam = sum(commonRam, owners.newPairConstruction, owners.samples)
  const gpuPeak = sum(existing.gpuBytes, oldPair, outputPixels * 8, owners.canvas)
  const ramPeak = Math.max(nativeRam, bitmapRam)
  return Object.freeze({
    limits: policy,
    owners,
    nativePeak: Object.freeze({
      ramBytes: nativeRam,
      gpuBytes: sum(existing.gpuBytes, oldPair, owners.canvas),
    }),
    bitmapPeak: Object.freeze({ ramBytes: bitmapRam, gpuBytes: gpuPeak }),
    peak: Object.freeze({ ramBytes: ramPeak, gpuBytes: gpuPeak }),
    accepted: ramPeak <= policy.ramBytes && gpuPeak <= policy.gpuBytes,
    scope: 'managed-cpu-preview-and-explicit-existing-owners' as const,
  })
}

/** Same conservative analysis/overlay and bitmap-cache allowances as the
 * existing renderer. The caller drains old GPU/raw owners first. */
export function nativeCpuExistingOwners(
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
): CpuManagedBytes {
  if (
    [width, height, canvasWidth, canvasHeight].some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 32768,
    ) ||
    product('source bytes', width, height, 16) > 512 * 1024 ** 2
  )
    throw new Error('Invalid CPU existing-owner geometry.')
  let masks = 0
  for (let w = width, h = height; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
    masks = sum(masks, product('mask mip', w, h))
    if (w === 1 && h === 1) break
  }
  const source = product('source pixels', width, height),
    canvas = product('canvas pixels', canvasWidth, canvasHeight)
  const strip = product('analysis strip', width, Math.min(height, 64), 16)
  const histograms = (256 + 512 * 3 + 9) * 4
  const bitmapCache = 256 * 1024 ** 2
  return Object.freeze({
    ramBytes: sum(bitmapCache, masks * 2, strip * 2, histograms * 2, source * 8, canvas * 4),
    gpuBytes: sum(bitmapCache, source * 4, canvas * 4),
  })
}

/** After construction/ACK there are no native strips, RGBA fetch buffers or old
 * pair. Resize admits only the actual resident pair plus the new canvas extent. */
export function nativeCpuResidentMemory(request: CpuMemoryRequest, limits: CpuMemoryLimits) {
  const validated = nativeCpuMemory(request, limits)
  const ramBytes = sum(
    request.existingOwners.ramBytes,
    request.outputWidth * request.outputHeight * 8,
    validated.owners.samples,
    validated.owners.canvas,
    validated.owners.retainedRecovery,
  )
  const gpuBytes = sum(
    request.existingOwners.gpuBytes,
    request.outputWidth * request.outputHeight * 8,
    validated.owners.canvas,
  )
  return Object.freeze({
    limits: validated.limits,
    peak: Object.freeze({ ramBytes, gpuBytes }),
    accepted: ramBytes <= limits.ramBytes && gpuBytes <= limits.gpuBytes,
    scope: 'managed-cpu-preview-and-explicit-existing-owners' as const,
  })
}
