import {
  renderAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../shared/adjustments'
import type { LensProfile, LensSettings, RadialTable } from '../../shared/lens'
import { appliedCorrections } from '../../shared/lens'
import type { LinearFrame } from './contracts'
import { displayTransform } from '../gpu/raw-source'
import { catmullRom } from '../../shared/reconstruction'

export const LENS_RENDER_VERSION = 'camera-linear-lens-bicubic-1'
export const CROP_POLICY = 'center-native-aspect-1'
export const LUT_SIZE = 4096
export interface CorrectionPlan {
  lut: Float32Array<ArrayBuffer>
  width: number
  height: number
  left: number
  top: number
  applied: LensSettings
}
export function interpolate(table: RadialTable | undefined, radius: number): number {
  if (!table) return 1
  let i = 0
  while (i < table.radii.length - 2 && radius > table.radii[i + 1]) i++
  const fraction = Math.max(
    0,
    Math.min(1, (radius - table.radii[i]) / (table.radii[i + 1] - table.radii[i])),
  )
  return table.values[i] * (1 - fraction) + table.values[i + 1] * fraction
}
export function radial(lut: Float32Array, radius: number, channel: number): number {
  const position = Math.max(0, Math.min(LUT_SIZE - 1, radius * (LUT_SIZE - 1)))
  const i = Math.min(LUT_SIZE - 2, Math.floor(position)),
    f = position - i
  return lut[i * 4 + channel] * (1 - f) + lut[(i + 1) * 4 + channel] * f
}
export function correctionPlan(
  width: number,
  height: number,
  profile: LensProfile,
  settings: LensSettings,
): CorrectionPlan {
  const applied = appliedCorrections(profile, settings)
  const lut = new Float32Array(LUT_SIZE * 4)
  for (let i = 0; i < LUT_SIZE; i++) {
    const r = i / (LUT_SIZE - 1)
    const d = applied.distortion ? interpolate(profile.distortion, r) : 1
    lut.set(
      [
        d * (applied.chromaticAberration ? interpolate(profile.chromaticAberration!.red, r) : 1),
        d,
        d * (applied.chromaticAberration ? interpolate(profile.chromaticAberration!.blue, r) : 1),
        applied.vignetting ? interpolate(profile.vignetting, r) : 1,
      ],
      i * 4,
    )
  }
  const cx = (width - 1) / 2,
    cy = (height - 1) / 2,
    radius = Math.hypot(cx, cy)
  // Check every pixel along all four edges, including non-monotonic radial profiles.
  // The provider also validates monotonic radial mappings so the interior is contained.
  const fits = (scale: number) => {
    for (let edge = 0; edge < 2; edge++) {
      const count = edge ? height : width
      for (let i = 0; i < count; i++) {
        const x = edge ? cx * scale : (i - cx) * scale
        const y = edge ? (i - cy) * scale : cy * scale
        const r = Math.hypot(x, y) / radius
        for (let c = 0; c < 3; c++) {
          const factor = radial(lut, r, c)
          if (Math.abs(x * factor) > cx || Math.abs(y * factor) > cy) return false
        }
      }
    }
    return true
  }
  let lower = 0,
    upper = 1
  if (fits(1)) lower = 1
  else
    for (let i = 0; i < 24; i++) {
      const mid = (lower + upper) / 2
      if (fits(mid)) lower = mid
      else upper = mid
    }
  const left = Math.ceil(((width - 1) * (1 - lower)) / 2),
    top = Math.ceil(((height - 1) * (1 - lower)) / 2)
  return { lut, width: width - 2 * left, height: height - 2 * top, left, top, applied }
}
/** Catmull-Rom bicubic kernel shared with WGSL; edge taps extend the border pixel. */
export const cubic = catmullRom
export function correctLinearCpu(frame: LinearFrame, plan: CorrectionPlan): WorkingFrame {
  const { width, height } = frame
  const cx = (width - 1) / 2,
    cy = (height - 1) / 2,
    radius = Math.hypot(cx, cy)
  const gain = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      gain[y * width + x] = radial(plan.lut, Math.hypot(x - cx, y - cy) / radius, 3)
  // 16-bit converted SDR values are temporary; the retained camera frame stays float.
  const converted = new Float32Array(plan.width * plan.height * 3)
  const histogram = new Uint32Array(3 * 8192)
  const weightsX = new Float64Array(4),
    weightsY = new Float64Array(4)
  const columns = new Int32Array(4)
  const geometric = plan.applied.distortion || plan.applied.chromaticAberration
  for (let y = 0; y < plan.height; y++)
    for (let x = 0; x < plan.width; x++) {
      const qx = x + plan.left - cx,
        qy = y + plan.top - cy,
        r = Math.hypot(qx, qy) / radius
      const rgb = [0, 0, 0]
      for (let c = 0; c < 3; c++) {
        if (!geometric) {
          const i = y * width + x
          rgb[c] = frame.data[i * 4 + c] * gain[i] * 65535
          continue
        }
        const scale = radial(plan.lut, r, c),
          sx = cx + qx * scale,
          sy = cy + qy * scale
        const ix = Math.floor(sx),
          iy = Math.floor(sy)
        for (let tap = 0; tap < 4; tap++) {
          weightsX[tap] = cubic(sx - ix - tap + 1)
          weightsY[tap] = cubic(sy - iy - tap + 1)
          columns[tap] = Math.max(0, Math.min(width - 1, ix + tap - 1))
        }
        let value = 0
        for (let dy = 0; dy < 4; dy++) {
          const row = Math.max(0, Math.min(height - 1, iy + dy - 1)) * width
          for (let dx = 0; dx < 4; dx++) {
            const i = row + columns[dx]
            value += frame.data[i * 4 + c] * gain[i] * weightsX[dx] * weightsY[dy]
          }
        }
        rgb[c] = value * 65535
      }
      const offset = (y * plan.width + x) * 3
      for (let c = 0; c < 3; c++) {
        const value =
          frame.matrix[c * 4] * rgb[0] +
          frame.matrix[c * 4 + 1] * rgb[1] +
          frame.matrix[c * 4 + 2] * rgb[2]
        converted[offset + c] = value / 65535
        histogram[c * 8192 + (Math.max(0, Math.min(65535, Math.trunc(value))) >> 3)]++
      }
    }
  const transform = displayTransform(histogram, plan.width * plan.height)
  const outWidth = frame.flip & 4 ? plan.height : plan.width,
    outHeight = frame.flip & 4 ? plan.width : plan.height
  const data = new Float32Array(outWidth * outHeight * 4)
  for (let y = 0; y < plan.height; y++)
    for (let x = 0; x < plan.width; x++) {
      let dx = frame.flip & 1 ? plan.width - 1 - x : x,
        dy = frame.flip & 2 ? plan.height - 1 - y : y
      if (frame.flip & 4) [dx, dy] = [dy, dx]
      const source = (y * plan.width + x) * 3,
        target = (dy * outWidth + dx) * 4
      for (let c = 0; c < 3; c++) data[target + c] = converted[source + c]
      data[target + 3] = 1
    }
  return { data, width: outWidth, height: outHeight, transform }
}

export function correctCpu(
  frame: LinearFrame,
  plan: CorrectionPlan,
  adjustments: AdjustmentParameters = neutralAdjustments,
) {
  const working = correctLinearCpu(frame, plan)
  return {
    data: Buffer.from(renderAdjustments(working.data, adjustments, working.transform)),
    width: working.width,
    height: working.height,
  }
}
