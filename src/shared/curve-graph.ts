import {
  CURVE_POINT_SPACING,
  CURVE_POINT_LIMIT,
  curveAxis,
  inverseCurveAxis,
  compileToneCurve,
  evaluateToneCurve,
  type CurvePoint,
  type ToneCurve,
} from './tone-curves'

export type CurveView = 'standard' | 'hdr' | 'fit'
export interface CurveRange {
  min: number
  max: number
}
export function curveGraphRange(view: CurveView, points: ToneCurve): CurveRange {
  if (view === 'standard') return { min: 0, max: 1 }
  if (view === 'hdr') return { min: -0.18, max: 16 }
  return {
    min: Math.min(0, ...points.flatMap((p) => [p.input, p.output])),
    max: Math.max(1, ...points.flatMap((p) => [p.input, p.output])),
  }
}
export function curveGraphPosition(value: number, range: CurveRange): number {
  return (curveAxis(value) - curveAxis(range.min)) / (curveAxis(range.max) - curveAxis(range.min))
}
export function curveGraphValue(position: number, range: CurveRange): number {
  return inverseCurveAxis(
    curveAxis(range.min) + position * (curveAxis(range.max) - curveAxis(range.min)),
  )
}
export function moveCurvePoint(
  points: ToneCurve,
  index: number,
  patch: Partial<CurvePoint>,
): ToneCurve {
  const input = Math.max(
    index ? points[index - 1].input + CURVE_POINT_SPACING : -16,
    Math.min(
      index + 1 < points.length ? points[index + 1].input - CURVE_POINT_SPACING : 64,
      patch.input ?? points[index].input,
    ),
  )
  return points.map((point, i) =>
    i === index
      ? { input, output: Math.max(-16, Math.min(64, patch.output ?? point.output)) }
      : point,
  )
}
export function addCurvePoint(points: ToneCurve, input: number, output: number) {
  if (points.length >= CURVE_POINT_LIMIT)
    throw new Error(
      'This channel already has 16 points. Move or delete a point before adding another.',
    )
  if (points.some((p) => Math.abs(p.input - input) < CURVE_POINT_SPACING))
    throw new Error('Points need at least 0.01% input spacing. Select the nearby point instead.')
  const next = [...points, { input, output }].sort((a, b) => a.input - b.input)
  return { points: next, index: next.findIndex((p) => p.input === input) }
}
export function targetCurvePoint(
  points: ToneCurve,
  input: number,
  range: CurveRange,
  graphPixels: number,
) {
  let index = -1,
    distance = Infinity
  points.forEach((p, i) => {
    const d =
      Math.abs(curveGraphPosition(p.input, range) - curveGraphPosition(input, range)) * graphPixels
    if (d < distance) {
      distance = d
      index = i
    }
  })
  if (distance <= 6 || points.some((p) => Math.abs(p.input - input) < CURVE_POINT_SPACING))
    return { points, index, added: false }
  const output = evaluateToneCurve(compileToneCurve(points), input)
  return { ...addCurvePoint(points, input, output), added: true }
}
