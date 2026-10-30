import type { WhiteBalanceSampleJob } from '../preview-types'
import {
  proposeNeutralWhiteBalance,
  whiteBalanceSampleArea,
  type SampledWhiteBalanceProposal,
} from '../../shared/white-balance-picker'
import { readHdrStrips } from './hdr-processing'

/** Read at most two authenticated strips and copy a bounded, pre-creative-edit region. */
export async function sampleNeutralWhiteBalance(
  path: string,
  { asset, sample }: WhiteBalanceSampleJob,
): Promise<SampledWhiteBalanceProposal> {
  const area = whiteBalanceSampleArea(sample, asset.width, asset.height)
  if (asset.source.display || asset.source.composite || !asset.whiteBalance)
    return { ...proposeNeutralWhiteBalance(new Float32Array(0), undefined, undefined), area }
  const pixels = new Float32Array(area.width * area.height * 4)
  const first = Math.floor(area.y / 64),
    last = Math.floor((area.y + area.height - 1) / 64)
  for (let strip = first; strip <= last; strip++)
    for await (const data of readHdrStrips(path, asset, strip))
      for (
        let y = Math.max(area.y, strip * 64);
        y < Math.min(area.y + area.height, (strip + 1) * 64);
        y++
      ) {
        const start = ((y - strip * 64) * asset.width + area.x) * 4
        pixels.set(data.subarray(start, start + area.width * 4), (y - area.y) * area.width * 4)
      }
  return {
    ...proposeNeutralWhiteBalance(pixels, asset.whiteBalance, asset.source.normalization),
    area,
  }
}
