import { open } from 'node:fs/promises'
import sharp from 'sharp'
import { encodeHdr, outputHdr, SDR_TARGET } from '../src/shared/hdr'

/** Independent CPU proof: one Float32 master pixel per PNG pixel, no resampling. */
export async function nativeMasterCrop(
  path: string,
  dimensions: { width: number; height: number },
  crop: { left: number; top: number; width: number; height: number },
  output: string,
) {
  const file = await open(path, 'r'),
    rgba = Buffer.alloc(crop.width * crop.height * 4),
    row = Buffer.alloc(crop.width * 16)
  try {
    if ((await file.stat()).size !== dimensions.width * dimensions.height * 16)
      throw new Error('Invalid native proof master dimensions.')
    for (let y = 0; y < crop.height; y++) {
      const { bytesRead } = await file.read(
        row,
        0,
        row.length,
        ((crop.top + y) * dimensions.width + crop.left) * 16,
      )
      if (bytesRead !== row.length) throw new Error('Incomplete native proof crop.')
      const pixels = new Float32Array(row.buffer, row.byteOffset, row.byteLength / 4)
      for (let x = 0; x < crop.width; x++) {
        const index = x * 4,
          rgb = outputHdr([pixels[index], pixels[index + 1], pixels[index + 2]], SDR_TARGET).rgb,
          target = (y * crop.width + x) * 4
        for (let c = 0; c < 3; c++) rgba[target + c] = Math.round(encodeHdr(rgb[c]) * 255)
        rgba[target + 3] = 255
      }
    }
  } finally {
    await file.close()
  }
  await sharp(rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } })
    .png()
    .toFile(output)
}
