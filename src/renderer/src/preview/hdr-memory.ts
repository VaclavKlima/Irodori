import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import { HDR_CACHE_MAX_TILES, hdrCacheTileSize } from './hdr-render-cache'
export const HDR_PRESENTATION_BUDGET = 768 * 1024 ** 2
export const HDR_TRANSPORT_CHUNK_BYTES = 1024 * 1024
/** Upload buffers are released before analysis and the full presentation surface are allocated. */
export function hdrPresentationMemory(
  width: number,
  height: number,
  canvasWidth = 0,
  canvasHeight = 0,
  maximumLayers = HDR_CACHE_MAX_TILES,
) {
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
  const renderingBytes = ACES_DATA_BYTES * 3 + 176 * 2 + 1801 * 4 * 2
  const tileSize = hdrCacheTileSize(width, height)
  const tileBytes = (tileSize + 2) ** 2 * 16
  const cacheControlBytes =
    Math.ceil(width / tileSize) * Math.ceil(height / tileSize) * 8 + HDR_CACHE_MAX_TILES * 16
  const uploadPeak = textureBytes + uploadBytes + transportBytes + sampleBytes + renderingBytes
  const uncachedPresentationPeak =
    textureBytes +
    analysisBytes +
    canvasBytes +
    transportBytes +
    renderingBytes +
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
