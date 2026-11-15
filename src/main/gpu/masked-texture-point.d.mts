import type { AdjustmentParameters, DisplayTransform } from '../../shared/adjustments'
import type { DetailAdmission } from '../../shared/detail-resources'
export interface TexturePointJob {
  width: number
  height: number
  domain: 'raster' | 'scene-linear' | 'authored-hdr'
  data: Float32Array<ArrayBuffer>
  adjustments: AdjustmentParameters
  maskParameters: AdjustmentParameters
  transform?: DisplayTransform
  whiteBalance?: readonly number[]
  admission: DetailAdmission
}
export interface TexturePointResult {
  data: Float32Array<ArrayBuffer>
  memory: { gpuBytes: number; ramBytes: number }
  adapter: string
  backend: 'gpu'
  cpuFeatureFallback: false
}
export function createOrderedPointGpu(): Promise<{
  adapter: string
  global(job: TexturePointJob, signal: AbortSignal): Promise<TexturePointResult>
  legacy(job: TexturePointJob, signal: AbortSignal): Promise<TexturePointResult>
  root(
    job: TexturePointJob & {
      previous: Float32Array<ArrayBuffer>
      candidate: Float32Array<ArrayBuffer>
      maskIndex: number
    },
    signal: AbortSignal,
  ): Promise<TexturePointResult & { coverage: Float32Array<ArrayBuffer> }>
  union(
    job: TexturePointJob & { coverages: Float32Array<ArrayBuffer>[] },
    signal: AbortSignal,
  ): Promise<Omit<TexturePointResult, 'data'> & { coverage: Float32Array<ArrayBuffer> }>
  select(
    job: TexturePointJob & {
      legacy: Uint32Array<ArrayBuffer>
      candidate: Uint32Array<ArrayBuffer>
      coverage: Float32Array<ArrayBuffer>
      alpha: Float32Array<ArrayBuffer>
      wordsPerPixel: number
    },
    signal: AbortSignal,
  ): Promise<
    Omit<TexturePointResult, 'data'> & {
      data: Uint32Array<ArrayBuffer>
      legacyPixels: number
      selectedPixels: number
    }
  >
  close(): Promise<void>
}>
