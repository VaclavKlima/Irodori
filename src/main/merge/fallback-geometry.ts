import type { LinearFrame } from '../processing/contracts'
import { radial, type CorrectionPlan } from '../processing/lens-correction'
import {
  createAreaReducer,
  createFallbackGeometryKernel,
  FALLBACK_GEOMETRY_CHANNEL_WORDS,
  FALLBACK_GEOMETRY_PIXEL_WORDS,
  type AreaReductionSize,
  type CpuKernelMeasurement,
} from './cpu-kernels'

export { FALLBACK_GEOMETRY_CHANNEL_WORDS, FALLBACK_GEOMETRY_PIXEL_WORDS }
export type FallbackGeometryFrame = Pick<LinearFrame, 'width' | 'height' | 'flip'>

/** Three 24-byte channel records per pixel: ix:i32, iy:i32, dxHi:f32,
 * dxLo:f32, dyHi:f32, dyLo:f32. All views are borrowed until the next read/close.
 */
export interface FallbackGeometryStrip {
  top: number
  rows: number
  geometry: Uint32Array<ArrayBuffer>
  /** Exact union-saturation validity, one 0/1 value per output pixel. */
  alpha: Uint8Array<ArrayBuffer>
}
export interface FallbackGeometryProvider {
  readonly width: number
  readonly height: number
  readonly reduction?: ReturnType<typeof createAreaReducer>
  /** Original Float64 coordinate for a selected repair; no RGB is read. */
  coordinate(
    x: number,
    y: number,
    channel: number,
  ): { ix: number; iy: number; dx: number; dy: number }
  read(top: number, rows: number, signal?: AbortSignal): FallbackGeometryStrip
  close(): void
}

function dimensions(frame: FallbackGeometryFrame, plan: CorrectionPlan) {
  const width = frame.flip & 4 ? plan.height : plan.width,
    height = frame.flip & 4 ? plan.width : plan.height,
    cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2,
    radius = Math.hypot(cx, cy)
  if (
    ![frame.width, frame.height, width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    frame.width * frame.height > 24_000_000 ||
    width * height > 24_000_000 ||
    !Number.isInteger(frame.flip) ||
    frame.flip < 0 ||
    frame.flip > 7 ||
    ![plan.left, plan.top].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    plan.left + plan.width > frame.width ||
    plan.top + plan.height > frame.height ||
    !(radius > 0) ||
    plan.lut.length !== 4096 * 4 ||
    !plan.lut.every(Number.isFinite)
  )
    throw new Error('Unsupported fallback geometry.')
  return { width, height, cx, cy, radius }
}

function sourcePosition(
  frame: FallbackGeometryFrame,
  plan: CorrectionPlan,
  x: number,
  y: number,
  cx: number,
  cy: number,
  radius: number,
) {
  let sx = frame.flip & 4 ? y : x,
    sy = frame.flip & 4 ? x : y
  if (frame.flip & 1) sx = plan.width - 1 - sx
  if (frame.flip & 2) sy = plan.height - 1 - sy
  const qx = sx + plan.left - cx,
    qy = sy + plan.top - cy
  return { qx, qy, radius: Math.hypot(qx, qy) / radius }
}

function channelCoordinate(
  plan: CorrectionPlan,
  position: ReturnType<typeof sourcePosition>,
  cx: number,
  cy: number,
  channel: number,
) {
  const scale = radial(plan.lut, position.radius, channel),
    px = cx + position.qx * scale,
    py = cy + position.qy * scale
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    px < -2147483647 ||
    px >= 2147483646 ||
    py < -2147483647 ||
    py >= 2147483646
  )
    throw new Error('Unsupported fallback source coordinate.')
  const ix = Math.floor(px),
    iy = Math.floor(py)
  return { ix, iy, dx: px - ix, dy: py - iy }
}

/** Exact Float64 recovery for a selected channel; never samples RGB or vignette gains.
 * Two Float32 fraction components preserve at least 48 significant bits. A repair
 * requiring the original final Float64 bits can request this coordinate directly.
 */
export function fallbackGeometryCoordinate(
  frame: FallbackGeometryFrame,
  plan: CorrectionPlan,
  x: number,
  y: number,
  channel: number,
) {
  const g = dimensions(frame, plan)
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= g.width ||
    y >= g.height ||
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel > 2
  )
    throw new Error('Invalid fallback geometry coordinate.')
  return channelCoordinate(
    plan,
    sourcePosition(frame, plan, x, y, g.cx, g.cy, g.radius),
    g.cx,
    g.cy,
    channel,
  )
}

/** Geometry planning keeps the unchanged, already dilated union sensor mask.
 * No input RGB, gain cache, white balance or color matrix enters this provider.
 */
export async function createFallbackGeometryProvider(
  frame: FallbackGeometryFrame,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  measurement: CpuKernelMeasurement = {
    backend: 'scalar',
    heapBytes: 0,
    copyMs: 0,
    processingMs: 0,
  },
  module?: WebAssembly.Module,
  reduced?: AreaReductionSize,
): Promise<FallbackGeometryProvider> {
  const g = dimensions(frame, plan)
  if (saturated.length !== frame.width * frame.height)
    throw new Error('Invalid fallback geometry mask.')
  if (
    reduced &&
    (![reduced.width, reduced.height].every((value) => Number.isSafeInteger(value) && value > 0) ||
      reduced.width > g.width ||
      reduced.height > g.height)
  )
    throw new Error('Unsupported fallback reduction geometry.')
  const kernel = await createFallbackGeometryKernel(
      frame,
      plan,
      saturated,
      measurement,
      module,
      reduced,
    ),
    reduction =
      kernel?.reduction ??
      (reduced ? createAreaReducer(g.width, g.height, reduced, 'luminance') : undefined)
  let accelerated = kernel,
    staging: { geometry: Uint32Array<ArrayBuffer>; alpha: Uint8Array<ArrayBuffer> } | undefined,
    closed = false
  return {
    width: g.width,
    height: g.height,
    reduction,
    coordinate(x, y, channel) {
      if (closed) throw new Error('Fallback geometry provider is closed.')
      if (
        !Number.isSafeInteger(x) ||
        !Number.isSafeInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= g.width ||
        y >= g.height ||
        !Number.isInteger(channel) ||
        channel < 0 ||
        channel > 2
      )
        throw new Error('Invalid fallback geometry coordinate.')
      return channelCoordinate(
        plan,
        sourcePosition(frame, plan, x, y, g.cx, g.cy, g.radius),
        g.cx,
        g.cy,
        channel,
      )
    },
    read(top, rows, signal) {
      if (closed) throw new Error('Fallback geometry provider is closed.')
      signal?.throwIfAborted()
      if (
        !Number.isSafeInteger(top) ||
        !Number.isSafeInteger(rows) ||
        top < 0 ||
        rows < 1 ||
        rows > 64 ||
        top + rows > g.height
      )
        throw new Error('Invalid fallback geometry strip.')
      if (accelerated)
        try {
          return accelerated.read(top, rows, signal)
        } catch {
          signal?.throwIfAborted()
          accelerated = undefined
          measurement.backend = 'scalar'
        }
      const native = kernel?.storage(top, rows)
      if (!native)
        staging ??= {
          geometry: new Uint32Array(
            g.width * Math.min(64, g.height) * FALLBACK_GEOMETRY_PIXEL_WORDS,
          ),
          alpha: new Uint8Array(g.width * Math.min(64, g.height)),
        }
      const output = native ?? {
          top,
          rows,
          geometry: staging!.geometry.subarray(0, g.width * rows * FALLBACK_GEOMETRY_PIXEL_WORDS),
          alpha: staging!.alpha.subarray(0, g.width * rows),
        },
        integers = new Int32Array(
          output.geometry.buffer,
          output.geometry.byteOffset,
          output.geometry.length,
        ),
        fractions = new Float32Array(
          output.geometry.buffer,
          output.geometry.byteOffset,
          output.geometry.length,
        ),
        processing = performance.now()
      try {
        for (let row = 0; row < rows; row++) {
          signal?.throwIfAborted()
          for (let x = 0; x < g.width; x++) {
            const pixel = row * g.width + x,
              position = sourcePosition(frame, plan, x, top + row, g.cx, g.cy, g.radius)
            let clipped = false
            for (let c = 0; c < 3; c++) {
              const coordinate = channelCoordinate(plan, position, g.cx, g.cy, c),
                { ix, iy, dx, dy } = coordinate,
                at = pixel * FALLBACK_GEOMETRY_PIXEL_WORDS + c * FALLBACK_GEOMETRY_CHANNEL_WORDS,
                dxHi = Math.fround(dx),
                dyHi = Math.fround(dy)
              integers[at] = ix
              integers[at + 1] = iy
              fractions[at + 2] = dxHi
              fractions[at + 3] = dx - dxHi
              fractions[at + 4] = dyHi
              fractions[at + 5] = dy - dyHi
              for (let yy = 0; yy < 2; yy++)
                for (let xx = 0; xx < 2; xx++)
                  if (
                    (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy) > 0 &&
                    saturated[
                      Math.max(0, Math.min(frame.height - 1, iy + yy)) * frame.width +
                        Math.max(0, Math.min(frame.width - 1, ix + xx))
                    ]
                  )
                    clipped = true
            }
            output.alpha[pixel] = Number(!clipped)
          }
        }
      } finally {
        measurement.processingMs += performance.now() - processing
      }
      signal?.throwIfAborted()
      return output
    },
    close() {
      if (closed) return
      closed = true
      accelerated = undefined
      staging = undefined
      kernel?.close()
    },
  }
}
