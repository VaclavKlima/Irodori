import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { MaskBaseContent } from '../../src/shared/masks'

/** Independent, filter-zero grayscale PNG generator for numeric tests only. */
export function generatedMask(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): MaskBaseContent {
  const chunk = (kind: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(kind, 4, 'ascii')
    data.copy(result, 8)
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13),
    rows = Buffer.alloc((width + 1) * height)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows[y * (width + 1) + x + 1] = pixel(x, y)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return {
    version: 1,
    hash: createHash('sha256').update(png).digest('hex'),
    width,
    height,
    pngBase64: png.toString('base64'),
  }
}
