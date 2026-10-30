import { workingToXyz, xyzToWorking, type ColorPrimaries, type ColorTriple } from './color-model'
import { D65_XYZ, cieLabF, cieLabInverse } from './color-intensity'

export const TONE_CURVE_VERSION = 'linear-pchip-rational-tail-v1'
export const CURVE_POINT_LIMIT = 16
export const CURVE_POINT_SPACING = 1e-4
export const curveChannels = ['master', 'red', 'green', 'blue'] as const
export type CurveChannel = (typeof curveChannels)[number]
export interface CurvePoint {
  readonly input: number
  readonly output: number
}
export type ToneCurve = readonly CurvePoint[]
export type ToneCurves = { readonly version: 1 } & Readonly<Record<CurveChannel, ToneCurve>>
const identity: ToneCurve = Object.freeze([
  Object.freeze({ input: 0, output: 0 }),
  Object.freeze({ input: 1, output: 1 }),
])
export const identityToneCurves: ToneCurves = Object.freeze({
  version: 1,
  master: identity,
  red: identity,
  green: identity,
  blue: identity,
})

export interface CurveSegment {
  readonly input: number
  readonly end: number
  readonly inverseSpan: number
  /** Normalized-t cubic: ((a*t+b)*t+c)*t+d. */
  readonly coefficients: readonly [number, number, number, number]
}
export interface CompiledCurve {
  readonly identity: boolean
  readonly segments: readonly CurveSegment[]
  readonly first: CurvePoint
  readonly last: CurvePoint
  readonly startSlope: number
  readonly endSlope: number
}
export type CompiledToneCurves = Readonly<Record<CurveChannel, CompiledCurve>> & {
  readonly identity: boolean
}

export function validateToneCurve(value: unknown): asserts value is ToneCurve {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > CURVE_POINT_LIMIT ||
    value.some(
      (point, i) =>
        !point ||
        typeof point !== 'object' ||
        Object.keys(point).sort().join(',') !== 'input,output' ||
        ![point.input, point.output].every(
          (v) => typeof v === 'number' && Number.isFinite(v) && v >= -16 && v <= 64,
        ) ||
        (i > 0 && point.input - value[i - 1].input < CURVE_POINT_SPACING - 1e-14),
    )
  )
    throw new Error(
      'A curve needs 2–16 finite points between −16 and +64, ordered by input with at least 0.0001 spacing.',
    )
}
export function validateToneCurves(value: unknown): asserts value is ToneCurves {
  const curves = value as ToneCurves | null
  if (
    !curves ||
    curves.version !== 1 ||
    Object.keys(curves).sort().join(',') !== 'blue,green,master,red,version'
  )
    throw new Error('Unsupported tone-curve settings.')
  for (const channel of curveChannels) validateToneCurve(curves[channel])
}
function endpoint(h0: number, h1: number, d0: number, d1: number) {
  const slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (Math.sign(slope) !== Math.sign(d0)) return 0
  return Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0) ? 3 * d0 : slope
}
export function compileToneCurve(points: ToneCurve): CompiledCurve {
  validateToneCurve(points)
  const spans = points.slice(1).map((p, i) => p.input - points[i].input)
  const secants = spans.map((h, i) => (points[i + 1].output - points[i].output) / h)
  const slopes = new Array<number>(points.length).fill(0)
  if (points.length === 2) slopes.fill(secants[0])
  else {
    slopes[0] = endpoint(spans[0], spans[1], secants[0], secants[1])
    const n = spans.length
    slopes[n] = endpoint(spans[n - 1], spans[n - 2], secants[n - 1], secants[n - 2])
    for (let i = 1; i < n; i++) {
      if (
        secants[i - 1] === 0 ||
        secants[i] === 0 ||
        Math.sign(secants[i - 1]) !== Math.sign(secants[i])
      )
        continue
      const a = 2 * spans[i] + spans[i - 1],
        b = spans[i] + 2 * spans[i - 1]
      slopes[i] = (a + b) / (a / secants[i - 1] + b / secants[i])
    }
  }
  return {
    identity: points.every((p) => p.input === p.output),
    first: { ...points[0] },
    last: { ...points.at(-1)! },
    startSlope: slopes[0],
    endSlope: slopes.at(-1)!,
    segments: spans.map((h, i) => {
      const delta = points[i + 1].output - points[i].output,
        start = h * slopes[i],
        end = h * slopes[i + 1]
      return {
        input: points[i].input,
        end: points[i + 1].input,
        inverseSpan: 1 / h,
        coefficients: [
          start + end - 2 * delta,
          3 * delta - 2 * start - end,
          start,
          points[i].output,
        ] as const,
      }
    }),
  }
}
export function evaluateToneCurve(curve: CompiledCurve, value: number): number {
  if (!Number.isFinite(value)) throw new Error('A curve requires a finite working value.')
  if (curve.identity) return value
  if (value < curve.first.input || value > curve.last.input) {
    const right = value > curve.last.input,
      point = right ? curve.last : curve.first
    const segment = right ? curve.segments.at(-1)! : curve.segments[0]
    const d = Math.abs(value - point.input),
      h = segment.end - segment.input,
      m = right ? curve.endSlope : curve.startSlope
    const distance = d + (m - 1) * h * (d / (h + d))
    return point.output + (right ? distance : -distance)
  }
  let index = 0
  while (index < curve.segments.length - 1 && value > curve.segments[index].end) index++
  const segment = curve.segments[index]
  const t = (value - segment.input) * segment.inverseSpan,
    [a, b, c, d] = segment.coefficients
  return ((a * t + b) * t + c) * t + d
}
export function compileToneCurves(curves: ToneCurves): CompiledToneCurves {
  validateToneCurves(curves)
  const result = Object.fromEntries(
    curveChannels.map((channel) => [channel, compileToneCurve(curves[channel])]),
  ) as Record<CurveChannel, CompiledCurve>
  return { ...result, identity: curveChannels.every((channel) => result[channel].identity) }
}

/** Master retains Lab a/b while mapping linear Y; RGB curves intentionally operate independently. */
export function applyToneCurves(
  rgb: ColorTriple,
  curves: CompiledToneCurves,
  primaries: ColorPrimaries,
): ColorTriple {
  if (curves.identity) return rgb
  let next: ColorTriple = rgb
  if (!curves.master.identity) {
    const xyz = workingToXyz(rgb, primaries),
      y = evaluateToneCurve(curves.master, xyz[1])
    if (y !== xyz[1]) {
      const delta = cieLabF(y) - cieLabF(xyz[1])
      next = xyzToWorking(
        [
          D65_XYZ[0] * cieLabInverse(cieLabF(xyz[0] / D65_XYZ[0]) + delta),
          y,
          D65_XYZ[2] * cieLabInverse(cieLabF(xyz[2] / D65_XYZ[2]) + delta),
        ],
        primaries,
      )
    }
  }
  return [
    evaluateToneCurve(curves.red, next[0]),
    evaluateToneCurve(curves.green, next[1]),
    evaluateToneCurve(curves.blue, next[2]),
  ]
}

/** Graph coordinates only; saved and evaluated points remain linear reference-white values. */
export const curveAxis = (value: number) => Math.sign(value) * Math.log2(1 + Math.abs(value) / 0.18)
export const inverseCurveAxis = (value: number) =>
  Math.sign(value) * 0.18 * (2 ** Math.abs(value) - 1)
