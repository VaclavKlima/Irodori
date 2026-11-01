export interface ResizeWeight {
  readonly index: number
  readonly weight: number
}

/** Parameter construction shared by the existing reference route and GPU resize. */
export function resizeWeights(input: number, output: number): readonly (readonly ResizeWeight[])[] {
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 1 ||
    output < 1 ||
    input > 32768 ||
    output > 32768
  )
    throw new Error('Invalid export resize axis.')
  if (input === output) return Array.from({ length: output }, (_, index) => [{ index, weight: 1 }])
  const scale = Math.max(1, input / output)
  const sinc = (v: number) => (Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v))
  return Array.from({ length: output }, (_, i) => {
    const center = ((i + 0.5) * input) / output - 0.5
    const entries = new Map<number, number>()
    for (let p = Math.ceil(center - 3 * scale); p <= Math.floor(center + 3 * scale); p++) {
      const x = (p - center) / scale
      const w = Math.abs(x) >= 3 ? 0 : sinc(x) * sinc(x / 3)
      if (!w) continue
      const key = Math.max(0, Math.min(input - 1, p))
      entries.set(key, (entries.get(key) ?? 0) + w)
    }
    const sum = [...entries.values()].reduce((a, b) => a + b, 0)
    return [...entries].map(([index, weight]) => ({ index, weight: weight / sum }))
  })
}
