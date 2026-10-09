import {
  sameAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
import {
  adjustHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  encodeHdr,
  SDR_TARGET,
  type HdrWorkingAsset,
  type DisplayTarget,
} from '../../../shared/hdr'
import { collectHdrSample } from './hdr-sample'
import { streamHdr } from './hdr-stream'
import { hdrRangeColor } from './hdr-ranges'
import { renderHdrContent } from '../../../shared/display-rendering'
interface Request {
  asset: HdrWorkingAsset
  parameters: AdjustmentParameters
  generation: number
  hdrRanges: boolean
  target?: DisplayTarget
  draft?: boolean
}
let pending: Request | undefined
let busy = false
self.onmessage = ({ data }: MessageEvent<Request>) => {
  pending = data
  if (!busy) void run()
}
async function run() {
  busy = true
  while (pending) {
    const request = pending
    pending = undefined
    try {
      const { asset, parameters, generation, hdrRanges } = request
      if (asset.width * asset.height * 16 + 64 * 1024 ** 2 > 512 * 1024 ** 2)
        throw new Error('CPU presentation exceeds its memory limit.')
      const draft = request.draft !== false && Math.max(asset.width, asset.height) > 1024
      const scale = draft ? 1024 / Math.max(asset.width, asset.height) : 1
      const width = Math.max(1, Math.round(asset.width * scale)),
        height = Math.max(1, Math.round(asset.height * scale))
      const after = new Uint8ClampedArray(width * height * 4),
        before = new Uint8ClampedArray(after.length)
      const sample = collectHdrSample(asset)
      const wb = hdrAdjustmentMatrix(parameters, asset.whiteBalance) ?? undefined
      const neutralEdits = sameAdjustments(parameters, neutralAdjustments)
      let nextRow = 0
      for await (const { data, row } of streamHdr(asset)) {
        if (pending) break
        sample.add(data, row)
        while (nextRow < height) {
          const y = Math.floor(((nextRow + 0.5) * asset.height) / height)
          if (y >= row + data.length / 4 / asset.width) break
          for (let column = 0; column < width; column++) {
            const x = Math.floor(((column + 0.5) * asset.width) / width)
            const i = ((y - row) * asset.width + x) * 4
            const rgb: [number, number, number] = [data[i], data[i + 1], data[i + 2]]
            const adjusted = adjustHdr(rgb, parameters, wb)
            const afterOutput = outputHdr(adjusted, SDR_TARGET)
            const beforeOutput = neutralEdits ? afterOutput : outputHdr(rgb, SDR_TARGET)
            const a = afterOutput.rgb
            const b = beforeOutput.rgb
            const at = (nextRow * width + column) * 4
            const aRange = hdrRanges
              ? hdrRangeColor(renderHdrContent(adjusted).rgb, request.target ?? SDR_TARGET, x, y)
              : null
            const bRange = neutralEdits
              ? aRange
              : hdrRanges
                ? hdrRangeColor(renderHdrContent(rgb).rgb, request.target ?? SDR_TARGET, x, y)
                : null
            for (let c = 0; c < 3; c++) {
              after[at + c] = Math.round((aRange?.[c] ?? encodeHdr(a[c])) * 255)
              before[at + c] = Math.round((bRange?.[c] ?? encodeHdr(b[c])) * 255)
            }
            after[at + 3] = before[at + 3] = Math.round(data[i + 3] * 255)
          }
          nextRow++
        }
      }
      if (pending) continue
      const bitmap = await createImageBitmap(new ImageData(after, width, height))
      const neutral = await createImageBitmap(new ImageData(before, width, height))
      self.postMessage(
        {
          bitmap,
          neutral,
          generation,
          parameters,
          hdrRanges,
          draft,
          sample: sample.sample,
          draftSample: sample.draft,
        },
        { transfer: [bitmap, neutral, sample.sample.buffer, sample.draft.buffer] },
      )
      if (draft && !pending) pending = { ...request, draft: false }
    } catch (error) {
      self.postMessage({ error: String(error), generation: request.generation })
    }
  }
  busy = false
}
