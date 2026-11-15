import type { DetailAdmission } from '../../shared/detail-resources'
export interface TextureGpuPreparation {
  adapter: string
  estimatedGpuBytes: number
  estimatedRamBytes: number
  preparationMs: number
  referenceAnchors: number
  backend: 'gpu'
  cpuFeatureFallback: false
}
export function createTextureGpu(): Promise<{
  adapter: string
  prepare(
    job: {
      data: Float32Array<ArrayBuffer>
      width: number
      height: number
      primaries: 'srgb' | 'rec2020'
      admission: DetailAdmission
    },
    signal: AbortSignal,
  ): Promise<TextureGpuPreparation>
  apply(
    job: { amount: number; coverage: Float32Array<ArrayBuffer> },
    signal: AbortSignal,
  ): Promise<{
    data: Float32Array<ArrayBuffer>
    coverage: Float32Array<ArrayBuffer>
    adapter: string
    backend: 'gpu'
    preparationMs: number
    referenceAnchors: number
    cpuFeatureFallback: false
  }>
  close(): Promise<void>
}>
