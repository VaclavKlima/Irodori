import { transformMatrix, warpedPoint, tileOffset } from './matrix'
import { MergeError, MERGE_LIMITS, type MergeCrop, type MergeTransform } from '../../shared/merge'

export interface Plane {
  width: number
  height: number
  data: Float32Array
  mask?: Uint8Array
}
export const median = (values: number[]) => {
  const target = Math.floor(values.length / 2)
  let low = 0,
    high = values.length - 1
  // Select the same upper median without sorting every exposure sample.
  // The bounded fallback also covers adversarial ordering.
  for (let pass = 0; low < high && pass < 64; pass++) {
    const a = values[low],
      b = values[(low + high) >>> 1],
      c = values[high],
      pivot = a <= b ? (b <= c ? b : a <= c ? c : a) : a <= c ? a : b <= c ? c : b
    let i = low,
      j = high
    while (i <= j) {
      while (values[i] < pivot) i++
      while (values[j] > pivot) j--
      if (i <= j) {
        const v = values[i]
        values[i++] = values[j]
        values[j--] = v
      }
    }
    if (target <= j) high = j
    else if (target >= i) low = i
    else return values[target]
  }
  if (low < high) values.sort((a, b) => a - b)
  return values[target]
}
export function warp(x: number, y: number, width: number, height: number, t: MergeTransform) {
  return warpedPoint(t, width, height, x, y)
}
export function sample(p: Plane, x: number, y: number): number {
  if (x < 0 || y < 0 || x > p.width - 1 || y > p.height - 1) return NaN
  const ix = Math.floor(x),
    iy = Math.floor(y),
    dx = x - ix,
    dy = y - iy
  const nx = Math.min(ix + 1, p.width - 1),
    ny = Math.min(iy + 1, p.height - 1)
  if (
    p.mask &&
    [iy * p.width + ix, iy * p.width + nx, ny * p.width + ix, ny * p.width + nx].some(
      (i) => !p.mask![i],
    )
  )
    return NaN
  return (
    (p.data[iy * p.width + ix] * (1 - dx) + p.data[iy * p.width + nx] * dx) * (1 - dy) +
    (p.data[ny * p.width + ix] * (1 - dx) + p.data[ny * p.width + nx] * dx) * dy
  )
}
export function refineExposure(
  reference: Plane,
  source: Plane,
  t: MergeTransform,
  expected: number,
  excluded: (x: number, y: number) => boolean = () => false,
  sensorMasked = false,
): number {
  if (sensorMasked && (!reference.mask || !source.mask))
    throw new Error('Sensor-masked exposure overlap requires both clipping masks.')
  const ratios: number[] = [],
    edge = Math.max(2, Math.ceil(Math.max(reference.width, reference.height) / 256))
  // Masked exposure tiles suppress shot/read noise before estimating ratios.
  // Sensor-certified BRK planes may contain usable working values above white;
  // clipping comes from the masks. Metadata, residual and overlap gates remain.
  for (let top = 1; top + edge < reference.height; top += edge)
    for (let left = 1; left + edge < reference.width; left += edge) {
      let a = 0,
        b = 0,
        valid = 0
      for (let y = top; y < top + edge; y++)
        for (let x = left; x < left + edge; x++) {
          if (excluded(x, y)) continue
          const [sx, sy] = warp(x, y, reference.width, reference.height, t),
            av = reference.data[y * reference.width + x],
            bv = sample(source, sx, sy)
          if (
            (!reference.mask || reference.mask[y * reference.width + x]) &&
            av > 0.015 &&
            (sensorMasked || av < 0.85) &&
            bv > 0.015 &&
            (sensorMasked || bv < 0.85)
          ) {
            a += av
            b += bv
            valid++
          }
        }
      if (valid >= edge * edge * 0.75) ratios.push(Math.log2(b / a))
    }
  if (ratios.length < MERGE_LIMITS.minimumOverlapSamples)
    throw new Error('Disconnected usable exposure overlap.')
  const ev = median(ratios),
    deviations = ratios.map((v) => Math.abs(v - ev))
  if (
    Math.abs(ev - Math.log2(expected)) > MERGE_LIMITS.exposureToleranceEv ||
    median(deviations) > 0.1
  )
    throw new Error(
      `Exposure measurements disagree with capture metadata (${ev.toFixed(3)} EV measured, ${Math.log2(expected).toFixed(3)} EV expected; ${median(deviations).toFixed(3)} EV median residual).`,
    )
  return 2 ** ev
}
/** Exact maximal axis-aligned rectangle in the discrete shared-coverage mask. */
export function translationCoverage(width: number, height: number, transforms: MergeTransform[]) {
  const matrices = transforms.map((t) => transformMatrix(t, width, height))
  if (
    transforms.every(
      (t, i) =>
        !t.tiles &&
        matrices[i].every((v, k) => k === 2 || k === 5 || v === [1, 0, 0, 0, 1, 0, 0, 0, 1][k]),
    )
  ) {
    const mask = new Uint8Array(width * height)
    // Pure translations have an exact rectangular shared domain. Avoid testing
    // every source at every native pixel when the inequalities are analytic.
    const left = Math.max(0, Math.ceil(Math.max(...matrices.map((m) => -m[2])))),
      top = Math.max(0, Math.ceil(Math.max(...matrices.map((m) => -m[5])))),
      right = Math.min(width - 1, Math.floor(Math.min(...matrices.map((m) => width - 1 - m[2])))),
      bottom = Math.min(
        height - 1,
        Math.floor(Math.min(...matrices.map((m) => height - 1 - m[5]))),
      ),
      cw = Math.max(0, right - left + 1),
      ch = Math.max(0, bottom - top + 1)
    if ((cw * ch) / (width * height) < MERGE_LIMITS.coverage)
      throw new MergeError({
        code: 'coverage',
        message: 'Less than 70% shared coverage.',
        filenames: [],
        diagnostics: [],
      })
    for (let y = top; y <= bottom; y++) mask.fill(1, y * width + left, y * width + right + 1)
    return { mask, crop: { left, top, width: cw, height: ch } }
  }
}
export function coverage(width: number, height: number, transforms: MergeTransform[]) {
  const translated = translationCoverage(width, height, transforms)
  if (translated) return translated
  const mask = new Uint8Array(width * height),
    matrices = transforms.map((t) => transformMatrix(t, width, height))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ok = matrices.every((m, i) => {
        const w = m[6] * x + m[7] * y + m[8],
          delta = transforms[i].tiles ? tileOffset(transforms[i], x, y) : [0, 0],
          sx = (m[0] * x + m[1] * y + m[2]) / w + delta[0],
          sy = (m[3] * x + m[4] * y + m[5]) / w + delta[1]
        return sx >= 0 && sy >= 0 && sx <= width - 1 && sy <= height - 1
      })
      mask[y * width + x] = Number(ok)
    }
  }
  return cropCoverage(mask, width, height)
}
/** Exact maximal rectangle; the mask may come from independently checked GPU geometry. */
export function cropCoverage(mask: Uint8Array, width: number, height: number) {
  const heights = new Uint32Array(width),
    stack = new Uint32Array(width + 1)
  let valid = 0,
    crop: MergeCrop = { left: 0, top: 0, width: 0, height: 0 }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ok = mask[y * width + x]
      valid += Number(ok)
      heights[x] = ok ? heights[x] + 1 : 0
    }
    let used = 0
    for (let x = 0; x <= width; x++) {
      const h = x === width ? 0 : heights[x]
      while (used && heights[stack[used - 1]] > h) {
        const top = stack[--used],
          left = used ? stack[used - 1] + 1 : 0
        if (heights[top] * (x - left) > crop.width * crop.height)
          crop = { left, top: y - heights[top] + 1, width: x - left, height: heights[top] }
      }
      stack[used++] = x
    }
  }
  if (valid / (width * height) < MERGE_LIMITS.coverage)
    throw new MergeError({
      code: 'coverage',
      message: 'Less than 70% shared coverage.',
      filenames: [],
      diagnostics: [],
    })
  return { mask, crop }
}
export function noiseVariance(signal: number, scale: number, iso = 100): number {
  return (
    (MERGE_LIMITS.readNoise ** 2 * Math.max(1, iso / 100) +
      MERGE_LIMITS.shotNoise * Math.max(0, signal)) /
    scale ** 2
  )
}
export function motionDifferent(a: number, b: number, variance: number, strength: number): boolean {
  return strength > 0 && Math.abs(a - b) > (8 - strength * 0.04) * Math.sqrt(variance)
}
export function expandMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const horizontal = new Uint8Array(mask.length),
    result = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    let n = 0
    for (let x = -radius; x < width; x++) {
      if (x + radius < width) n += Number(!!mask[y * width + x + radius])
      if (x - radius - 1 >= 0) n -= Number(!!mask[y * width + x - radius - 1])
      if (x >= 0) horizontal[y * width + x] = Number(n > 0)
    }
  }
  for (let x = 0; x < width; x++) {
    let n = 0
    for (let y = -radius; y < height; y++) {
      if (y + radius < height) n += horizontal[(y + radius) * width + x]
      if (y - radius - 1 >= 0) n -= horizontal[(y - radius - 1) * width + x]
      if (y >= 0) result[y * width + x] = Number(n > 0)
    }
  }
  return result
}
