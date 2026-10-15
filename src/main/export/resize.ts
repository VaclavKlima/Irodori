import { open } from 'node:fs/promises'

function weights(input: number, output: number) {
  const scale = Math.max(1, input / output)
  const sinc = (v: number) => (Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v))
  return Array.from({ length: output }, (_, i) => {
    const center = ((i + 0.5) * input) / output - 0.5
    const entries = new Map<number, number>()
    for (let p = Math.ceil(center - 3 * scale); p <= Math.floor(center + 3 * scale); p++) {
      const x = (p - center) / scale
      const w = Math.abs(x) >= 3 ? 0 : sinc(x) * sinc(x / 3)
      if (!w) continue
      const key = Math.max(0, Math.min(input - 1, p))
      entries.set(key, (entries.get(key) ?? 0) + w)
    }
    const sum = [...entries.values()].reduce((a, b) => a + b, 0)
    return [...entries].map(([index, weight]) => ({ index, weight: weight / sum }))
  })
}
/** Separable Lanczos3 over linear-light floats. Only needed horizontal rows are retained. */
export async function resizeLinear(
  path: string,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: number,
  row: (data: Float32Array, y: number) => void,
) {
  const file = await open(path, 'r')
  const horizontal = weights(width, outWidth),
    vertical = weights(height, outHeight)
  const cache = new Map<number, Float32Array>()
  try {
    if ((await file.stat()).size !== width * height * channels * 4)
      throw new Error('Incomplete export rendition.')
    for (let y = 0; y < outHeight; y++) {
      const needed = new Set(vertical[y].map((w) => w.index))
      for (const key of cache.keys()) if (!needed.has(key)) cache.delete(key)
      const result = new Float32Array(outWidth * channels)
      for (const { index, weight } of vertical[y]) {
        let data = cache.get(index)
        if (!data) {
          const bytes = Buffer.alloc(width * channels * 4)
          let read = 0
          while (read < bytes.byteLength) {
            const part = await file.read(
              bytes,
              read,
              bytes.byteLength - read,
              index * bytes.byteLength + read,
            )
            if (!part.bytesRead) throw new Error('Incomplete export row.')
            read += part.bytesRead
          }
          const source = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
          data = new Float32Array(outWidth * channels)
          for (let x = 0; x < outWidth; x++)
            for (const tap of horizontal[x])
              for (let c = 0; c < channels; c++)
                data[x * channels + c] += source[tap.index * channels + c] * tap.weight
          cache.set(index, data)
        }
        for (let i = 0; i < result.length; i++) result[i] += data[i] * weight
      }
      row(result, y)
    }
  } finally {
    await file.close()
  }
}
