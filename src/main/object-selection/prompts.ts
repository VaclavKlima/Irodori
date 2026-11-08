import type { ObjectSelectionPrompts } from './types'

export function packObjectSelectionPrompts(prompts: ObjectSelectionPrompts) {
  if (typeof prompts.key !== 'string' || !prompts.key || prompts.key.length > 1024)
    throw new Error('Object selection requires a frozen source identity.')
  const points: { coordinates: readonly [number, number]; label: number }[] = []
  const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1
  if (prompts.box) {
    const [x0, y0, x1, y1] = prompts.box
    if (prompts.box.length !== 4 || !prompts.box.every(valid) || x0 >= x1 || y0 >= y1)
      throw new Error('Object selection box must be within the canonical photograph.')
    points.push({ coordinates: [x0, y0], label: 2 }, { coordinates: [x1, y1], label: 3 })
  }
  for (const [list, label] of [
    [prompts.positivePoints ?? [], 1],
    [prompts.negativePoints ?? [], 0],
  ] as const) {
    if (!Array.isArray(list)) throw new Error('Object selection points are invalid.')
    for (const coordinates of list) {
      if (!Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(valid))
        throw new Error('Object selection points must be within the canonical photograph.')
      points.push({ coordinates: [coordinates[0], coordinates[1]], label })
    }
  }
  if (!prompts.box && !prompts.positivePoints?.length)
    throw new Error('Indicate an object with a box or positive point first.')
  if (points.length > 6)
    throw new Error(
      'Object selection accepts six prompt slots; a box uses two. Remove an earlier point before refining.',
    )
  const coordinates = new Float32Array(12)
  const labels = new Float32Array(6).fill(-1)
  points.forEach((point, index) => {
    coordinates[index * 2] = point.coordinates[0] * 1024
    coordinates[index * 2 + 1] = point.coordinates[1] * 1024
    labels[index] = point.label
  })
  return { coordinates, labels }
}
