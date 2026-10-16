export function distribution(values: readonly number[]) {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw new Error('A distribution needs finite observations.')
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]
  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
    observations: [...values],
  }
}
export function detail(
  reference: Float32Array,
  actual: Float32Array,
  width: number,
  height: number,
  seamEdge = 64,
) {
  if (reference.length !== actual.length || reference.length !== width * height * 4)
    throw new Error('Detail comparison dimensions differ.')
  let absolute = 0,
    square = 0,
    maximum = 0,
    referenceEdges = 0,
    actualEdges = 0,
    seamError = 0,
    overshoot = 0
  let samples = 0,
    seamSamples = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * width + x) * 4 + c,
          error = Math.abs(reference[i] - actual[i])
        absolute += error
        square += error * error
        maximum = Math.max(maximum, error)
        samples++
        for (const d of [x ? 4 : 0, y ? width * 4 : 0]) {
          if (!d) continue
          referenceEdges += Math.abs(reference[i] - reference[i - d])
          actualEdges += Math.abs(actual[i] - actual[i - d])
          if ((d === 4 && x % seamEdge === 0) || (d !== 4 && y % seamEdge === 0)) {
            seamError += Math.abs(actual[i] - actual[i - d] - (reference[i] - reference[i - d]))
            seamSamples++
          }
        }
        const neighbors = [
          reference[i],
          reference[(y * width + Math.max(0, x - 1)) * 4 + c],
          reference[(y * width + Math.min(width - 1, x + 1)) * 4 + c],
        ]
        overshoot = Math.max(
          overshoot,
          actual[i] - Math.max(...neighbors),
          Math.min(...neighbors) - actual[i],
        )
      }
  return {
    meanAbsolute: absolute / samples,
    rmse: Math.sqrt(square / samples),
    maximumAbsolute: maximum,
    edgeEnergyRatio: referenceEdges ? actualEdges / referenceEdges : 1,
    seamGradientError: seamError / Math.max(1, seamSamples),
    localOvershoot: overshoot,
    units: 'display-linear; 1 = 100-nit reference white',
    visualReview: 'unreviewed',
  }
}
export interface InputEvent {
  serial: number
  at: number
}
export interface PresentedEvent {
  serial: number
  at: number
}
export function interaction(inputs: InputEvent[], presentations: PresentedEvent[]) {
  if (!inputs.length || !presentations.length) throw new Error('Interaction evidence is empty.')
  const byId = new Map(inputs.map((input) => [input.serial, input]))
  if (byId.size !== inputs.length) throw new Error('Input serials must be unique.')
  const latencies: number[] = [],
    ages: number[] = [],
    seen = new Set<number>()
  let regressions = 0,
    previous = -1
  for (const frame of presentations) {
    const input = byId.get(frame.serial)
    if (!input || frame.at < input.at) throw new Error('Invalid presentation identity/time.')
    latencies.push(frame.at - input.at)
    let newest = inputs[0]
    for (const event of inputs) {
      if (event.at <= frame.at) newest = event
      else break
    }
    ages.push(Math.max(0, newest.at - input.at))
    regressions += Number(frame.serial < previous)
    previous = frame.serial
    seen.add(frame.serial)
  }
  return {
    inputCount: inputs.length,
    presentationCount: presentations.length,
    missingPresentations: inputs.filter((event) => !seen.has(event.serial)).length,
    regressions,
    latencyMs: distribution(latencies),
    staleAgeMs: distribution(ages),
    meets33msTarget: distribution(latencies).p95 <= 33,
  }
}

/** Retains completed sharp tiles by rendering identity. Publication is all-or-nothing. */
export class SharpNavigationTiles {
  private tiles = new Map<string, { identity: string; value: Float32Array }>()
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid sharp tile capacity.')
  }
  put(identity: string, tile: string, value: Float32Array) {
    const key = `${identity}:${tile}`
    this.tiles.delete(key)
    this.tiles.set(key, { identity, value: value.slice() })
    while (this.tiles.size > this.capacity) this.tiles.delete(this.tiles.keys().next().value!)
  }
  select(identity: string, tiles: string[]) {
    const selected = tiles.map((tile) => this.tiles.get(`${identity}:${tile}`))
    if (selected.some((tile) => !tile || tile.identity !== identity)) return undefined
    return selected.map((tile) => tile!.value)
  }
}
