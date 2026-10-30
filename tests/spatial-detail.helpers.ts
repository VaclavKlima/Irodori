import type { ColorPrimaries } from '../src/shared/color-model'
import type {
  DetailRectangle,
  DetailSize,
  DetailSourceWindow,
  NoiseReductionSettings,
  DetailSharpeningSettings,
} from '../src/shared/spatial-detail'

export interface DetailReference {
  precision: number
  sources: Record<string, string>
  scenes: {
    name: string
    width: number
    height: number
    data: number[][]
    sha256: string
    cases: {
      primaries: ColorPrimaries
      operation: 'noise' | 'sharpen' | 'combined'
      noise?: NoiseReductionSettings
      settings: NoiseReductionSettings | DetailSharpeningSettings
      points: { x: number; y: number; output: number[] }[]
    }[]
  }[]
}
export function detailWindow(
  image: DetailSize,
  data: Float32Array,
  rect: DetailRectangle,
): DetailSourceWindow {
  const window = new Float32Array(rect.width * rect.height * 4)
  for (let y = 0; y < rect.height; y++) {
    const start = ((y + rect.top) * image.width + rect.left) * 4
    window.set(data.subarray(start, start + rect.width * 4), y * rect.width * 4)
  }
  return { ...rect, data: window }
}
