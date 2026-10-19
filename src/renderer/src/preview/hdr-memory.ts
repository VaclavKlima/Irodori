import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import { HDR_CACHE_MAX_TILES, hdrCacheTileSize } from './hdr-render-cache'
export const HDR_PRESENTATION_BUDGET = 768 * 1024 ** 2
export const HDR_TRANSPORT_CHUNK_BYTES = 1024 * 1024
/** Native canvas backing can overlap upload only when an exact cached presentation was restored. */
export function hdrRestoredUploadMemory(width: number, height: number) {
  return width * height * 32 + 1024 ** 2 * 4 + 64 * 1024
}
/** Upload buffers are released before analysis and the full presentation surface are allocated. */
export function hdrPresentationMemory(
  width: number,
  height: number,
  canvasWidth = 0,
  canvasHeight = 0,
  maximumLayers = HDR_CACHE_MAX_TILES,
  diagnosticBytes = 0,
  retainedPresentationBytes = 0,
  restoredUploadBytes = 0,
) {
  if (!Number.isSafeInteger(retainedPresentationBytes) || retainedPresentationBytes < 0)
    throw new Error('Invalid retained HDR presentation reservation.')
  if (!Number.isSafeInteger(restoredUploadBytes) || restoredUploadBytes < 0)
    throw new Error('Invalid restored HDR upload reservation.')
  let textureBytes = 0,
    maskBytes = 0
  for (
    let w = width, h = height;
    ;
    w = Math.max(1, Math.floor(w / 2)), h = Math.max(1, Math.floor(h / 2))
  ) {
    textureBytes += w * h * 16
    if (w === 1 && h === 1) break
  }
  for (let w = width, h = height; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
    maskBytes += w * h
    if (w === 1 && h === 1) break
  }
  const stripBytes = width * Math.min(64, height) * 16
  const uploadBytes = stripBytes * 6
  const retainedSamples =
    (Math.min(65536, width * height) + Math.min(8192, width * height)) * 16 * 3
  const analysisBytes = maskBytes + stripBytes + retainedSamples
  const canvasBytes = canvasWidth * canvasHeight * 32
  const transportBytes = HDR_TRANSPORT_CHUNK_BYTES * 2
  const sampleBytes = retainedSamples
  const renderingBytes = ACES_DATA_BYTES * 3 + 176 * 2 + 1801 * 4 * 2 + diagnosticBytes
  const tileSize = hdrCacheTileSize(width, height)
  const tileBytes = (tileSize + 2) ** 2 * 16
  const cacheControlBytes =
    Math.ceil(width / tileSize) * Math.ceil(height / tileSize) * 8 + HDR_CACHE_MAX_TILES * 16
  const uploadPeak =
    textureBytes +
    uploadBytes +
    transportBytes +
    sampleBytes +
    renderingBytes +
    retainedPresentationBytes +
    restoredUploadBytes
  const uncachedPresentationPeak =
    textureBytes +
    analysisBytes +
    canvasBytes +
    transportBytes +
    renderingBytes +
    retainedPresentationBytes +
    1024 ** 2 * 4 +
    64 * 1024
  const maximumSlots = Math.min(
    Math.min(HDR_CACHE_MAX_TILES, maximumLayers),
    Math.ceil(width / tileSize) * Math.ceil(height / tileSize) * 4,
  )
  const cacheSlots = Math.max(
    1,
    Math.min(
      maximumSlots,
      Math.floor(
        (HDR_PRESENTATION_BUDGET - uncachedPresentationPeak - cacheControlBytes) / tileBytes,
      ),
    ),
  )
  const cacheBytes = cacheSlots * tileBytes + cacheControlBytes
  const presentationPeak = uncachedPresentationPeak + cacheBytes
  return {
    textureBytes,
    uploadBytes,
    analysisBytes,
    canvasBytes,
    transportBytes,
    renderingBytes,
    retainedPresentationBytes,
    restoredUploadBytes,
    cacheSlots,
    cacheBytes,
    tileSize,
    tileBytes,
    minimumPresentationPeak: uncachedPresentationPeak - canvasBytes + cacheControlBytes + tileBytes,
    uploadPeak,
    presentationPeak,
    total: Math.max(uploadPeak, presentationPeak),
  }
}

interface RetainedPresentationMemory {
  readonly budget: number
  pauseRetaining: () => () => void
  clearAndDrain: () => Promise<void>
}

/** Cache headroom must never reject a frame that fits the ordinary presentation budget. */
export class HdrPresentationHeadroom {
  private bypass = false
  private closed = false
  private draining?: Promise<void>
  private resumeRetaining?: () => void
  constructor(private cache: RetainedPresentationMemory | null) {}
  get bypassed() {
    return this.bypass
  }
  get eligible() {
    return !!this.cache && !this.bypass && !this.closed
  }
  get reservationBytes() {
    return this.eligible ? this.cache!.budget : 0
  }
  /** Fitting plans stay synchronous; every ordinary plan waits for outstanding cache leases. */
  plan(
    width: number,
    height: number,
    canvasWidth = 0,
    canvasHeight = 0,
    maximumLayers = HDR_CACHE_MAX_TILES,
    diagnosticBytes = 0,
    restoredUploadBytes = 0,
  ) {
    if (this.closed) throw new Error('HDR presentation headroom is closed.')
    const memory = () =>
      hdrPresentationMemory(
        width,
        height,
        canvasWidth,
        canvasHeight,
        maximumLayers,
        diagnosticBytes,
        this.reservationBytes,
        restoredUploadBytes,
      )
    const reserved = memory()
    if (this.eligible && reserved.total > HDR_PRESENTATION_BUDGET) {
      // Bypass is sticky for this presenter, including subsequent smaller viewports.
      this.bypass = true
      this.resumeRetaining = this.cache!.pauseRetaining()
      this.draining = this.cache!.clearAndDrain()
    }
    return this.draining ? this.draining.then(memory) : reserved
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    const resume = this.resumeRetaining
    this.resumeRetaining = undefined
    // A disposed presenter cannot let new retained surfaces prevent its pending drain.
    if (resume) void this.draining!.then(resume, resume)
  }
}
