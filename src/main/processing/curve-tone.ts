import { open } from 'node:fs/promises'
import { readHdrStrips } from './hdr-processing'
import { curveToneArea, sampledCurveTone } from '../../shared/curve-tone'
import type { CurveToneJob } from '../preview-types'

export async function sampleCurveTone(path: string, job: CurveToneJob) {
  const { width, height, linear, sample, adjustments } = job,
    area = curveToneArea(sample, width, height),
    pixels = new Float32Array(area.width * area.height * 4)
  if (linear.hdr) {
    const first = Math.floor(area.y / 64),
      last = Math.floor((area.y + area.height - 1) / 64)
    for (let strip = first; strip <= last; strip++)
      for await (const data of readHdrStrips(path, linear.hdr, strip))
        for (
          let y = Math.max(area.y, strip * 64);
          y < Math.min(area.y + area.height, (strip + 1) * 64);
          y++
        ) {
          const start = ((y - strip * 64) * width + area.x) * 4
          pixels.set(data.subarray(start, start + area.width * 4), (y - area.y) * area.width * 4)
        }
  } else {
    const file = await open(path, 'r')
    try {
      if (
        (await file.stat()).size !== width * height * 16 ||
        linear.byteLength !== width * height * 16
      )
        throw new Error('Curve sampling source is incomplete.')
      for (let row = 0; row < area.height; row++) {
        const bytes = Buffer.alloc(area.width * 16)
        const { bytesRead } = await file.read(
          bytes,
          0,
          bytes.length,
          ((area.y + row) * width + area.x) * 16,
        )
        if (bytesRead !== bytes.length) throw new Error('Curve sampling source is incomplete.')
        pixels.set(
          new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
          row * area.width * 4,
        )
      }
    } finally {
      await file.close()
    }
  }
  return {
    ...sampledCurveTone(
      pixels,
      adjustments,
      {
        ...linear.transform,
        whiteBalance: linear.hdr?.whiteBalance ?? linear.transform.whiteBalance,
      },
      !!linear.hdr,
      sample.channel,
    ),
    area,
    width,
    height,
    referenceWhite: 1 as const,
  }
}
