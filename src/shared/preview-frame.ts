/** Shared protocol and disk-cache layout version. */
export const PREVIEW_ASSET_VERSION = 'v9'

/** RGBA8, straight alpha, sRGB. Limit allocations before reading untrusted cache metadata. */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024
export function frameByteLength(width: number, height: number): number {
  const bytes = width * height * 4
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32768 ||
    height > 32768 ||
    !Number.isSafeInteger(bytes) ||
    bytes > MAX_FRAME_BYTES
  )
    throw new Error('The preview dimensions exceed the supported display size.')
  return bytes
}
