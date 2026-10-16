import { createHash } from 'node:crypto'

/** Identity of JPEG coding bytes and authored metadata, excluding container APP additions. */
export function jpegIdentity(bytes: Buffer) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) throw new Error('Invalid JPEG start.')
  const coding = createHash('sha256'),
    icc = createHash('sha256'),
    exif = createHash('sha256')
  let offset = 2,
    scans = 0,
    iccCount = 0,
    exifCount = 0
  const sampling: number[] = []
  while (offset < bytes.length) {
    const start = offset
    if (bytes[offset++] !== 255) throw new Error('Invalid JPEG marker.')
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 217) {
      if (!scans) throw new Error('Missing JPEG scan.')
      return {
        coding: coding.digest('hex'),
        icc: icc.digest('hex'),
        exif: exif.digest('hex'),
        iccCount,
        exifCount,
        sampling,
      }
    }
    if (
      marker === 0 ||
      marker === 216 ||
      marker === 1 ||
      (marker >= 208 && marker <= 215) ||
      offset + 2 > bytes.length
    )
      throw new Error('Unexpected JPEG marker.')
    const length = bytes.readUInt16BE(offset)
    const end = offset + length
    if (length < 2 || end > bytes.length) throw new Error('Invalid JPEG segment length.')
    const payload = bytes.subarray(offset + 2, end)
    if (marker === 192 || marker === 193 || marker === 194) {
      if (payload.length < 6 || payload.length !== 6 + payload[5] * 3)
        throw new Error('Invalid JPEG frame header.')
      for (let c = 0; c < payload[5]; c++) sampling.push(payload[7 + c * 3])
    }
    if (marker === 226 && payload.subarray(0, 12).equals(Buffer.from('ICC_PROFILE\0'))) {
      icc.update(payload)
      iccCount++
    }
    if (marker === 225 && payload.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) {
      exif.update(payload)
      exifCount++
    }
    // Adobe APP14 controls RGB/YCbCr interpretation and is part of pixel identity.
    if ((!(marker >= 224 && marker <= 239) && marker !== 254) || marker === 238)
      coding.update(bytes.subarray(start, end))
    offset = end
    if (marker !== 218) continue
    scans++
    const entropyStart = offset
    while (offset < bytes.length) {
      const next = bytes.indexOf(255, offset)
      if (next < 0 || next + 1 >= bytes.length) throw new Error('Unterminated JPEG scan.')
      let p = next + 1
      while (bytes[p] === 255) p++
      if (p >= bytes.length) throw new Error('Unterminated JPEG marker.')
      if (bytes[p] === 0 || (bytes[p] >= 208 && bytes[p] <= 215)) {
        offset = p + 1
        continue
      }
      coding.update(bytes.subarray(entropyStart, next))
      offset = next
      break
    }
  }
  throw new Error('Missing JPEG end.')
}

export function validatePrimary(output: Buffer, supplied: Buffer) {
  const actual = jpegIdentity(output),
    expected = jpegIdentity(supplied)
  if (
    actual.coding !== expected.coding ||
    actual.icc !== expected.icc ||
    actual.exif !== expected.exif ||
    actual.iccCount !== expected.iccCount ||
    actual.exifCount !== expected.exifCount
  )
    throw new Error('HDR packaging changed the supplied SDR primary.')
}
