import {
  WHITE_BALANCE_MODEL,
  whiteBalanceMatrix,
  type WhiteBalance,
  type WhiteBalanceProfile,
} from './white-balance'
import { shadowsModule } from './shadows'
export { shadowsModule } from './shadows'
import { whitesModule } from './whites'
export { whitesModule } from './whites'
import { blacksModule } from './blacks'
export { blacksModule } from './blacks'
import { highlightsModule } from './highlights'
export { highlightsModule } from './highlights'
import { contrastModule } from './contrast'
export { contrastModule } from './contrast'

export interface AdjustmentParameters {
  whiteBalance?: WhiteBalance
  exposureEv: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
}
export const neutralAdjustments: Readonly<AdjustmentParameters> = {
  whiteBalance: { mode: 'as-shot' },
  exposureEv: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
}
export function sameAdjustments(
  a: AdjustmentParameters | undefined,
  b: AdjustmentParameters,
): boolean {
  return (
    JSON.stringify(a?.whiteBalance ?? { mode: 'as-shot' }) ===
      JSON.stringify(b.whiteBalance ?? { mode: 'as-shot' }) &&
    a?.exposureEv === b.exposureEv &&
    a?.contrast === b.contrast &&
    a?.highlights === b.highlights &&
    a?.shadows === b.shadows &&
    a?.whites === b.whites &&
    a?.blacks === b.blacks
  )
}
/** Display conversion is intentionally SDR; working pixels remain unclipped. */
export interface DisplayTransform {
  whiteBalance?: WhiteBalanceProfile
  white: number
  threshold: number
  offset: number
  quantize: boolean
}
export const exposureModule = {
  id: 'exposure',
  version: 1,
  parameters: { exposureEv: { min: -5, max: 5, step: 0.01, default: 0 } },
  cpu: (value: number, ev: number) => value * 2 ** ev,
  glsl: 'vec3 applyExposure(vec3 rgb, float exposureEv) { return rgb * exp2(exposureEv); }',
  wgsl: 'fn applyExposure(rgb: vec3f, exposureEv: f32) -> vec3f { return rgb * exp2(exposureEv); }',
} as const
// Processing order is explicit in every backend: Exposure → Contrast → Highlights → Shadows → Whites → Blacks → SDR.
export const adjustmentModules = [
  exposureModule,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
] as const
export const ADJUSTMENT_VERSION =
  `white-balance-${WHITE_BALANCE_MODEL}_` +
  adjustmentModules.map((module) => `${module.id}-${module.version}`).join('_')
export const srgbTransform: DisplayTransform = {
  white: 1,
  threshold: 0.0031308,
  offset: 0.055,
  quantize: false,
}
export function displayValue(value: number, ev: number, transform: DisplayTransform): number {
  let linear = exposureModule.cpu(value, ev)
  if (transform.quantize) linear = Math.trunc(Math.max(0, linear) * 65535) / 65535
  const r = Math.max(0, Math.min(1, linear / transform.white))
  const encoded =
    r < transform.threshold ? r * 12.92 : r ** (1 / 2.4) * (1 + transform.offset) - transform.offset
  return transform.quantize
    ? Math.min(255, Math.floor(65536 * encoded) >> 8)
    : Math.round(encoded * 255)
}
export function renderAdjustments(
  data: Float32Array,
  parameters: AdjustmentParameters,
  transform: DisplayTransform,
): Uint8ClampedArray<ArrayBuffer> {
  const output = new Uint8ClampedArray(data.length)
  const { exposureEv, contrast, highlights, shadows, whites, blacks } = parameters
  const wb = whiteBalanceMatrix(parameters.whiteBalance, transform.whiteBalance)
  const gain = 2 ** exposureEv
  const strength = 2 ** (contrast / 100)
  for (let i = 0; i < data.length; i += 4) {
    const r0 = data[i],
      g0 = data[i + 1],
      b0 = data[i + 2]
    const wr = wb ? wb[0] * r0 + wb[1] * g0 + wb[2] * b0 : r0
    const wg = wb ? wb[3] * r0 + wb[4] * g0 + wb[5] * b0 : g0
    const wbValue = wb ? wb[6] * r0 + wb[7] * g0 + wb[8] * b0 : b0
    if (
      !wb &&
      contrast === 0 &&
      highlights === 0 &&
      shadows === 0 &&
      whites === 0 &&
      blacks === 0
    ) {
      // Keep the existing neutral/exposure conversion exactly, including RAW quantization.
      for (let c = 0; c < 3; c++) output[i + c] = displayValue(data[i + c], exposureEv, transform)
    } else {
      const r = Math.max(0, wr * gain)
      const g = Math.max(0, wg * gain)
      const b = Math.max(0, wbValue * gain)
      const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / transform.white
      let scale = y > 0 && y < 1 ? contrastModule.cpu(y, contrast, strength) / y : 1
      if (highlights !== 0) {
        const contrastedY = y * scale
        if (contrastedY > 0.18) scale *= highlightsModule.cpu(contrastedY, highlights) / contrastedY
      }
      if (shadows !== 0) {
        const shadowY = y * scale
        if (shadowY > 0) scale *= shadowsModule.cpu(shadowY, shadows) / shadowY
      }
      if (whites !== 0) {
        const whiteY = y * scale
        if (whiteY > 0) scale *= whitesModule.cpu(whiteY, whites) / whiteY
      }
      let pedestal = 0
      if (blacks !== 0) {
        const blackY = y * scale
        if (blacks > 0)
          pedestal = 0.04 * (blacks / 100) * Math.max(1 - blackY / 0.18, 0) ** 3 * transform.white
        else if (blackY > 0) scale *= blacksModule.cpu(blackY, blacks) / blackY
      }
      output[i] = displayValue(r * scale + pedestal, 0, transform)
      output[i + 1] = displayValue(g * scale + pedestal, 0, transform)
      output[i + 2] = displayValue(b * scale + pedestal, 0, transform)
    }
    output[i + 3] = Math.round(data[i + 3] * 255)
  }
  return output
}
export interface WorkingFrame {
  cpuSource?: import('./native-cpu-preview').CpuPreviewSourceRef
  hdr?: import('./hdr').HdrWorkingAsset
  identity?: string
  data: Float32Array<ArrayBuffer>
  width: number
  height: number
  transform: DisplayTransform
}
