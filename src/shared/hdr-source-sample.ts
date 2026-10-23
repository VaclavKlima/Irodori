import type { HdrWorkingAsset } from './hdr'

export function collectHdrSample(asset: Pick<HdrWorkingAsset, 'width' | 'height'>) {
  const total = asset.width * asset.height,
    count = Math.min(65536, total)
  const sample = new Float32Array(count * 4)
  const draft = new Float32Array(Math.min(8192, total) * 4)
  const samplers = [sample, draft].map((data) => ({ data, next: 0 }))
  return {
    sample,
    draft,
    add(data: Float32Array, row: number) {
      const start = row * asset.width,
        end = start + data.length / 4
      for (const sampler of samplers) {
        const count = sampler.data.length / 4
        while (sampler.next < count) {
          const position = Math.floor(((sampler.next + 0.5) * total) / count)
          if (position >= end) break
          sampler.data.set(
            data.subarray((position - start) * 4, (position - start) * 4 + 4),
            sampler.next++ * 4,
          )
        }
      }
    },
  }
}
