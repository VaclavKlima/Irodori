/** Exact area footprints in native pixel-edge coordinates; centers stay at i + 0.5. */
export function areaContributions(native: number, reduced: number): [number, number][][] {
  const scale = native / reduced
  return Array.from({ length: native }, (_, i) => {
    const first = Math.floor(i / scale)
    const last = Math.min(reduced - 1, Math.ceil((i + 1) / scale) - 1)
    const result: [number, number][] = []
    for (let cell = first; cell <= last; cell++) {
      const weight = Math.min(i + 1, (cell + 1) * scale) - Math.max(i, cell * scale)
      if (weight > 1e-10) result.push([cell, weight])
    }
    return result
  })
}

/** Keep the authoritative Float64 footprint values and their contribution order. */
export function flattenedAreaContributions(native: number, reduced: number) {
  const contributions = areaContributions(native, reduced),
    offsets = new Uint32Array(native + 1),
    count = contributions.reduce((sum, cells) => sum + cells.length, 0),
    targets = new Int32Array(count),
    weights = new Float64Array(count),
    last = new Int32Array(reduced).fill(-1)
  let next = 0
  for (let i = 0; i < native; i++) {
    offsets[i] = next
    for (const [target, weight] of contributions[i]) {
      targets[next] = target
      weights[next++] = weight
      last[target] = i
    }
  }
  offsets[native] = next
  return { offsets, targets, weights, last }
}
