import { WHITE_BALANCE_MODEL, type WhiteBalanceProfile } from '../src/shared/white-balance'
import type { HdrNormalization } from '../src/shared/hdr'

export const profile: WhiteBalanceProfile = {
  provider: 'synthetic',
  version: '1',
  identity: 'independent-neutral-patches-v1',
  model: WHITE_BALANCE_MODEL,
  asShotGains: [2, 1, 1.5],
  xyzToCamera: [0.7, 0.2, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8],
  cameraToWorking: [1.4, -0.3, -0.1, -0.1, 1.2, -0.1, 0, -0.1, 1.1],
  ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
  estimate: { kelvin: 6500, tint: 0 },
}
export const normalization: HdrNormalization = {
  black: [0, 0, 0, 0],
  maximum: 1,
  gains: [2, 1, 1.5, 1],
  restoreGain: 2,
  referenceWhite: 1,
  sourceSaturation: { thresholds: [1, 1, 1, 1], saturatedSites: 0, totalSites: 49 },
}
export const product = (m: number[], v: number[]) =>
  [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2])
export function patch(camera: number[], count = 49, alpha = 1) {
  const rgb = product(
    profile.cameraToWorking,
    camera.map((v, c) => v * profile.asShotGains[c]),
  )
  return new Float32Array(Array.from({ length: count }, () => [...rgb, alpha]).flat())
}
