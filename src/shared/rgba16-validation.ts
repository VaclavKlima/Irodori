// Typed arrays use host byte order; the first-surface wire format is always little-endian.
const littleEndian = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02

/** Read only the owned byte view. Preserve every finite RGB value and require exact opaque alpha. */
export function assertOpaqueFiniteRgba16LE(bytes: Uint8Array<ArrayBuffer>): void {
  if (
    !(bytes instanceof Uint8Array) ||
    !(bytes.buffer instanceof ArrayBuffer) ||
    bytes.byteLength === 0 ||
    bytes.byteLength % 8 !== 0
  )
    throw new TypeError('Invalid owned RGBA16F byte view.')
  const { buffer, byteOffset, byteLength } = bytes
  if (littleEndian && byteOffset % 2 === 0) {
    const words = new Uint16Array(buffer, byteOffset, byteLength / 2)
    for (let index = 0; index < words.length; index += 4) {
      if (
        (words[index] & 0x7c00) === 0x7c00 ||
        (words[index + 1] & 0x7c00) === 0x7c00 ||
        (words[index + 2] & 0x7c00) === 0x7c00 ||
        words[index + 3] !== 0x3c00
      )
        throw new Error('First HDR surface contains invalid Float16 pixels.')
    }
  } else {
    // DataView supports unaligned Buffer subviews and explicit LE reads on any host.
    const view = new DataView(buffer, byteOffset, byteLength)
    for (let offset = 0; offset < byteLength; offset += 8) {
      if (
        (view.getUint16(offset, true) & 0x7c00) === 0x7c00 ||
        (view.getUint16(offset + 2, true) & 0x7c00) === 0x7c00 ||
        (view.getUint16(offset + 4, true) & 0x7c00) === 0x7c00 ||
        view.getUint16(offset + 6, true) !== 0x3c00
      )
        throw new Error('First HDR surface contains invalid Float16 pixels.')
    }
  }
}
