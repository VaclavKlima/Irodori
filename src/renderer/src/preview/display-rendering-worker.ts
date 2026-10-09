import {
  HDR_CONTENT_TARGET,
  prepareDisplayRendering,
  type RenderingTarget,
} from '../../../shared/display-rendering'
import { packAces } from '../../../shared/aces-data'
self.onmessage = ({
  data,
}: MessageEvent<{ target: RenderingTarget; generation: number; content?: boolean }>) => {
  try {
    if (data.content) {
      const packed = packAces(prepareDisplayRendering(HDR_CONTENT_TARGET))
      const sdr = Object.fromEntries(
        ['srgb', 'display-p3'].map((colorSpace) => [
          colorSpace,
          packAces(
            prepareDisplayRendering({
              mode: 'sdr',
              peak: 1,
              colorSpace: colorSpace as RenderingTarget['colorSpace'],
            }),
          ),
        ]),
      )
      self.postMessage(
        { packed, sdr },
        { transfer: [packed.buffer, ...Object.values(sdr).map((v) => v.buffer)] },
      )
      return
    }
    const packed = packAces(prepareDisplayRendering(data.target))
    self.postMessage({ generation: data.generation, packed }, { transfer: [packed.buffer] })
  } catch (error) {
    self.postMessage({ generation: data.generation, error: String(error) })
  }
}
