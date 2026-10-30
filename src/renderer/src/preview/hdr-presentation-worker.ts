import {
  sameAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
} from '../../../shared/adjustments'
import {
  adjustHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  contentHdr,
  encodeHdr,
  SDR_TARGET,
  type HdrWorkingAsset,
  type DisplayTarget,
} from '../../../shared/hdr'
import { collectHdrSample } from './hdr-sample'
import { streamHdr } from './hdr-stream'
import { hdrRangeColor } from './hdr-ranges'
import { prepareCreativeColor } from '../../../shared/creative-color'
interface Request {
  asset: HdrWorkingAsset
  beforeAsset?: HdrWorkingAsset
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
      const original =
        request.beforeAsset?.sha256 !== asset.sha256 ? request.beforeAsset : undefined
      if (
        original &&
        (original.width !== asset.width ||
          original.height !== asset.height ||
          JSON.stringify(original.source) !== JSON.stringify(asset.source) ||
          JSON.stringify(original.whiteBalance) !== JSON.stringify(asset.whiteBalance))
      )
        throw new Error('CPU comparison sources have incompatible geometry or rendering domains.')
      if (asset.width * asset.height * 16 + 64 * 1024 ** 2 > 512 * 1024 ** 2)
        throw new Error('CPU presentation exceeds its memory limit.')
      const draft = request.draft !== false && Math.max(asset.width, asset.height) > 1024
      const scale = draft ? 1024 / Math.max(asset.width, asset.height) : 1
      const width = Math.max(1, Math.round(asset.width * scale)),
        height = Math.max(1, Math.round(asset.height * scale))
      const after = new Uint8ClampedArray(width * height * 4),
        before = new Uint8ClampedArray(after.length)
      const sample = collectHdrSample(asset)
      const beforeSample = original ? collectHdrSample(original) : undefined
      const wb = hdrAdjustmentMatrix(parameters, asset.whiteBalance) ?? undefined
      const creative = prepareCreativeColor(parameters)
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
            const adjusted = adjustHdr(rgb, parameters, wb, creative)
            const afterOutput = outputHdr(adjusted, SDR_TARGET, asset.source)
            const beforeOutput = original
              ? undefined
              : neutralEdits
                ? afterOutput
                : outputHdr(rgb, SDR_TARGET, asset.source)
            const a = afterOutput.rgb
            const b = beforeOutput?.rgb
            const at = (nextRow * width + column) * 4
            const aRange = hdrRanges
              ? hdrRangeColor(
                  contentHdr(adjusted, asset.source).rgb,
                  request.target ?? SDR_TARGET,
                  x,
                  y,
                )
              : null
            const bRange = original
              ? null
              : neutralEdits
                ? aRange
                : hdrRanges
                  ? hdrRangeColor(
                      contentHdr(rgb, asset.source).rgb,
                      request.target ?? SDR_TARGET,
                      x,
                      y,
                    )
                  : null
            for (let c = 0; c < 3; c++) {
              after[at + c] = Math.round((aRange?.[c] ?? encodeHdr(a[c])) * 255)
              if (b) before[at + c] = Math.round((bRange?.[c] ?? encodeHdr(b[c])) * 255)
            }
            after[at + 3] = Math.round(data[i + 3] * 255)
            if (!original) before[at + 3] = after[at + 3]
          }
          nextRow++
        }
      }
      if (pending) continue
      // Sequential strip streams keep the ordinary source/transport peak bounded.
      if (original) {
        nextRow = 0
        for await (const { data, row } of streamHdr(original)) {
          if (pending) break
          beforeSample!.add(data, row)
          while (nextRow < height) {
            const y = Math.floor(((nextRow + 0.5) * original.height) / height)
            if (y >= row + data.length / 4 / original.width) break
            for (let column = 0; column < width; column++) {
              const x = Math.floor(((column + 0.5) * original.width) / width),
                i = ((y - row) * original.width + x) * 4,
                rgb: [number, number, number] = [data[i], data[i + 1], data[i + 2]],
                output = outputHdr(rgb, SDR_TARGET, original.source).rgb,
                range = hdrRanges
                  ? hdrRangeColor(
                      contentHdr(rgb, original.source).rgb,
                      request.target ?? SDR_TARGET,
                      x,
                      y,
                    )
                  : null,
                at = (nextRow * width + column) * 4
              for (let c = 0; c < 3; c++)
                before[at + c] = Math.round((range?.[c] ?? encodeHdr(output[c])) * 255)
              before[at + 3] = Math.round(data[i + 3] * 255)
            }
            nextRow++
          }
        }
      }
      if (pending) continue
      let bitmap: ImageBitmap | undefined, neutral: ImageBitmap | undefined
      try {
        bitmap = await createImageBitmap(new ImageData(after, width, height))
        neutral = await createImageBitmap(new ImageData(before, width, height))
        if (pending) continue
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
            beforeSha256: original?.sha256,
            beforeSample: beforeSample?.sample,
            beforeDraftSample: beforeSample?.draft,
          },
          {
            transfer: [
              bitmap,
              neutral,
              sample.sample.buffer,
              sample.draft.buffer,
              ...(beforeSample ? [beforeSample.sample.buffer, beforeSample.draft.buffer] : []),
            ],
          },
        )
        bitmap = neutral = undefined
      } finally {
        bitmap?.close()
        neutral?.close()
      }
      if (draft && !pending) pending = { ...request, draft: false }
    } catch (error) {
      self.postMessage({ error: String(error), generation: request.generation })
    }
  }
  busy = false
}
