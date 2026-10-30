// These are the existing owners moved out of HdrPresenter, not additional caches.
import { HdrPresentationCache } from './hdr-presentation-cache'
import { HdrSourceCache } from './hdr-source-cache'
import { HDR_BITMAP_RESERVATION } from './hdr-memory'
import type { HdrFirstSurfaceManagedBytes } from '../../../shared/hdr-first-surface'
import { presentationBitmapBytes } from './frame-cache'
import { hdrSampleMemory } from './hdr-sample'

export const presentationCache = new HdrPresentationCache<GPUTexture>()
export const sourceCache = new HdrSourceCache<GPUTexture>()
/** Current cache owners plus conservative browser mirrors; presenter peaks are added separately. */
export function rendererImageResources(): HdrFirstSurfaceManagedBytes {
  const source = sourceCache.memory(),
    bitmapBytes = presentationBitmapBytes()
  return {
    ramBytes:
      source.ramBytes +
      bitmapBytes +
      hdrSampleMemory((buffer) => sourceCache.ownsSampleBuffer(buffer)),
    vramBytes: source.vramBytes + presentationCache.bytes + bitmapBytes,
  }
}
/** Only suppresses optional first-surface work; ordinary source validation stays authoritative. */
export function hdrHasCompletedPhoto(photoId: string): boolean {
  return sourceCache.hasCompletedPhoto(photoId)
}
export function hdrForgetCompletedPhoto(photoId: string): void {
  sourceCache.forgetPhoto(photoId)
}
// Disposed GPU and CPU presenters retain all submitted reads/receivers until drain.
export const retiredPreviewOwners = new Set<Promise<void>>()

/** Capture only earlier owners: never resample after registering this owner's drain. */
export function captureHdrPreviewRetirement(): Promise<void> {
  return Promise.all([...retiredPreviewOwners]).then(() => undefined)
}
export function retainHdrPreviewRetirement(retired: Promise<void>): void {
  retiredPreviewOwners.add(retired)
  void retired.then(
    () => retiredPreviewOwners.delete(retired),
    () => retiredPreviewOwners.delete(retired),
  )
}
/** Called after earlier presenters drain, before admitting native first-surface work. */
export function hdrFirstSurfaceExistingOwners(photoId?: string): HdrFirstSurfaceManagedBytes {
  if (photoId) sourceCache.preparePhoto(photoId)
  const source = sourceCache.memory()
  return {
    ramBytes:
      source.ramBytes +
      HDR_BITMAP_RESERVATION.ramBytes +
      hdrSampleMemory((buffer) => sourceCache.ownsSampleBuffer(buffer)),
    vramBytes: source.vramBytes + presentationCache.bytes + HDR_BITMAP_RESERVATION.vramBytes,
  }
}
/** Exceptional CPU fallback releases optional GPU owners only while its owner is current. */
export async function prepareHdrCpuFallback(previous: Promise<void>, signal: AbortSignal) {
  await previous
  signal.throwIfAborted()
  await sourceCache.clearAndDrain()
  signal.throwIfAborted()
  await presentationCache.clearAndDrain()
  signal.throwIfAborted()
}
