import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { halfFloat, loadUltraHdr } from '../src/main/export/codec'

/** Original synthetic reference chart. No third-party image or camera metadata. */
export async function hdrJpegFixture(directory: string, orientation = 1) {
  const width = 321,
    height = 65
  const patches = [
    [0, 0, 0],
    [0.18, 0.18, 0.18],
    [1, 1, 1],
    [4, 4, 4],
    [3, 0.2, 0.05],
  ]
  const primary = Buffer.alloc(width * height * 3),
    half = new Uint16Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * width + x,
        p = Math.min(4, Math.floor(x / 64))
      for (let c = 0; c < 3; c++) {
        half[index * 4 + c] = halfFloat(patches[p][c])
        // A distinct authored SDR image detects accidental second tone mapping.
        primary[index * 3 + c] = [0, 60, 170, 240, 110][p]
      }
      half[index * 4 + 3] = halfFloat(1)
    }
  const sdr = await sharp(primary, { raw: { width, height, channels: 3 } })
    .withIccProfile('srgb')
    .withMetadata({ orientation })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer()
  const bytes = (await loadUltraHdr()).encode(new Uint8Array(half.buffer), width, height, sdr, 100)
  const path = join(directory, 'authored-hdr.jpg')
  await writeFile(path, bytes)
  return { path, bytes, sdr, width, height, patches }
}
