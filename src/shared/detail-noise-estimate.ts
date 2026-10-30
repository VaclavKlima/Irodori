import type { ColorPrimaries } from './color-model'
import { frameByteLength, MAX_FRAME_BYTES } from './preview-frame'
import { DETAIL_REFERENCE, detailLuminance, type DetailSize } from './spatial-detail'

/** Research foundation only: no public noise-reduction version selects this estimator. */
export const DETAIL_NOISE_ESTIMATE_VERSION = 'frozen-global-directional-mad-v1'
export const DETAIL_NOISE_ESTIMATE_MAX_PAIRS = 65_536
const MIN_PAIRS = 16
const NORMAL_MAD = 0.6744897501960817 * Math.sqrt(2)
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const
const EXACT_LIMBS = 15
const EXACT_UNIT_EXPONENT = -320
const WORD_BASE = 2 ** 32
// One signed exact accumulator serves both three-product luminance and weight totals.
const SCRATCH_BYTES = 2 * EXACT_LIMBS * 4 + 8 + 6 * 8

export interface DetailNoiseSource extends DetailSize {
  readonly identity: string
  readonly sha256: string
  readonly primaries: ColorPrimaries
  /**
   * Fill one complete native RGBA Float32 row. The caller owns the immutable
   * source lease, full-source/strip hash verification and any external row cache.
   * This interface does not authenticate the supplied source bytes.
   */
  readRow(row: number, destination: Float32Array, signal: AbortSignal): Promise<void>
}
export interface DetailNoiseEstimateMemory {
  readonly maximumPairs: number
  readonly statisticsBytes: number
  readonly rowBytes: number
  readonly scratchBytes: number
  /** Owned numeric storage only; excludes the caller's source/cache and runtime heap. */
  readonly workingBytes: number
}
type Triple = readonly [number, number, number]
type OptionalTriple = readonly [number | null, number | null, number | null]
export interface DetailNoiseDirection {
  readonly direction: readonly [number, number]
  readonly availablePairs: number
  readonly stratifiedPairs: number
  readonly validPairs: number
  readonly centers: OptionalTriple
  readonly sigma: OptionalTriple
}
export interface DetailNoiseEstimate {
  readonly version: typeof DETAIL_NOISE_ESTIMATE_VERSION
  readonly source: Readonly<
    DetailSize & {
      identity: string
      sha256: string
      primaries: ColorPrimaries
      verification: 'caller-owned-source-lease-and-hashes'
    }
  >
  readonly directions: readonly DetailNoiseDirection[]
  readonly sigma: Triple
  readonly variance: Triple
  readonly available: boolean
  readonly memory: DetailNoiseEstimateMemory
  readonly limits: 'Empirical global minimum, not calibrated sensor noise or an unbiased estimate.'
}

/** Validate and charge storage before constructing any row or statistics plane. */
export function detailNoiseEstimateMemory(image: DetailSize): DetailNoiseEstimateMemory {
  if (frameByteLength(image.width, image.height) * 4 > MAX_FRAME_BYTES)
    throw new Error('Noise estimation source exceeds the floating-point image limit.')
  const maximumPairs = Math.min(
    DETAIL_NOISE_ESTIMATE_MAX_PAIRS,
    Math.max(
      ...DIRECTIONS.map(
        ([dx, dy]) =>
          Math.max(0, image.width - Math.abs(dx)) * Math.max(0, image.height - Math.abs(dy)),
      ),
    ),
  )
  const statisticsBytes = maximumPairs * (3 * 8 + 8 + 4),
    rowBytes = image.width * 2 * 4 * 4,
    workingBytes = statisticsBytes + rowBytes + SCRATCH_BYTES
  return Object.freeze({
    maximumPairs,
    statisticsBytes,
    rowBytes,
    scratchBytes: SCRATCH_BYTES,
    workingBytes,
  })
}

/**
 * Exact sum of bounded Float64 products, rounded once to nearest-even. Binary32
 * alpha products are multiples of 2^-298; RGB*luminance products have no bits
 * below 2^-206. Fifteen 32-bit limbs at 2^-320 cover both through 2^159. No
 * BigInt, per-sample heap arrays or uncharged sorting/expansion plane is needed.
 */
class ExactProductSum {
  private readonly positive = new Uint32Array(EXACT_LIMBS)
  private readonly negative = new Uint32Array(EXACT_LIMBS)
  private readonly bits = new DataView(new ArrayBuffer(8))

  clear(): void {
    this.positive.fill(0)
    this.negative.fill(0)
  }
  private addLimb(destination: Uint32Array, index: number, value: number): void {
    while (value) {
      if (index >= destination.length)
        throw new Error('Noise estimator exact sum exceeds its bound.')
      const total = destination[index] + value
      destination[index++] = total >>> 0
      value = total >= WORD_BASE ? 1 : 0
    }
  }
  private addWord(destination: Uint32Array, value: number, shift: number): void {
    if (!value) return
    if (shift < 0) {
      const divisor = 2 ** -shift
      if (value % divisor !== 0)
        throw new Error('Noise estimator product is outside its exact range.')
      value /= divisor
      shift = 0
    }
    const index = Math.floor(shift / 32),
      shifted = value * 2 ** (shift % 32)
    this.addLimb(destination, index, shifted % WORD_BASE)
    this.addLimb(destination, index + 1, Math.floor(shifted / WORD_BASE))
  }
  add(value: number): void {
    if (value === 0) return
    this.bits.setFloat64(0, value)
    const high = this.bits.getUint32(0),
      exponent = (high >>> 20) & 0x7ff
    if (exponent === 0 || exponent === 0x7ff)
      throw new Error('Noise estimator product is outside its finite normal range.')
    const shift = exponent - 1023 - 52 - EXACT_UNIT_EXPONENT,
      destination = high >>> 31 ? this.negative : this.positive
    this.addWord(destination, this.bits.getUint32(4), shift)
    this.addWord(destination, (high & 0xfffff) | 0x100000, shift + 32)
  }
  private bit(values: Uint32Array, index: number): number {
    return (values[Math.floor(index / 32)] >>> (index % 32)) & 1
  }
  finish(): number {
    let comparison = 0
    for (let i = EXACT_LIMBS - 1; i >= 0 && comparison === 0; i--)
      comparison = Math.sign(this.positive[i] - this.negative[i])
    if (comparison === 0) return 0
    const larger = comparison > 0 ? this.positive : this.negative,
      smaller = comparison > 0 ? this.negative : this.positive
    let borrow = 0
    for (let i = 0; i < EXACT_LIMBS; i++) {
      const difference = larger[i] - smaller[i] - borrow
      larger[i] = difference < 0 ? difference + WORD_BASE : difference
      borrow = difference < 0 ? 1 : 0
    }
    let word = EXACT_LIMBS - 1
    while (larger[word] === 0) word--
    const top = word * 32 + 31 - Math.clz32(larger[word]),
      discarded = Math.max(0, top - 52)
    let mantissa = 0
    for (let i = top; i >= discarded; i--) mantissa = mantissa * 2 + this.bit(larger, i)
    if (discarded > 0 && this.bit(larger, discarded - 1)) {
      let sticky = false
      const complete = Math.floor((discarded - 1) / 32),
        partial = (discarded - 1) % 32
      for (let i = 0; i < complete; i++) sticky ||= larger[i] !== 0
      sticky ||= larger[complete] % 2 ** partial !== 0
      if (sticky || mantissa % 2 !== 0) mantissa++
    }
    const value = mantissa * 2 ** (discarded + EXACT_UNIT_EXPONENT)
    return comparison < 0 ? -value : value
  }
}

async function yieldEstimator(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  signal.throwIfAborted()
}

/** Heap-sort indices in place; equal-value weights follow Python tuple ordering. */
async function sortSamples(
  values: Float64Array,
  weights: Float64Array,
  indices: Uint32Array,
  count: number,
  signal: AbortSignal,
): Promise<void> {
  const greater = (left: number, right: number) =>
      values[left] > values[right] ||
      (values[left] === values[right] &&
        (weights[left] > weights[right] || (weights[left] === weights[right] && left > right))),
    sift = (start: number, end: number) => {
      let parent = start
      while (2 * parent + 1 < end) {
        let child = 2 * parent + 1
        if (child + 1 < end && greater(indices[child + 1], indices[child])) child++
        if (!greater(indices[child], indices[parent])) break
        const temporary = indices[parent]
        indices[parent] = indices[child]
        indices[child] = temporary
        parent = child
      }
    }
  for (let i = 0; i < count; i++) indices[i] = i
  for (let i = Math.floor(count / 2) - 1; i >= 0; i--) {
    sift(i, count)
    if (i % 8192 === 0) await yieldEstimator(signal)
  }
  for (let end = count - 1; end > 0; end--) {
    const temporary = indices[0]
    indices[0] = indices[end]
    indices[end] = temporary
    sift(0, end)
    if (end % 8192 === 0) await yieldEstimator(signal)
  }
  signal.throwIfAborted()
}

function weightedMedian(
  values: Float64Array,
  weights: Float64Array,
  indices: Uint32Array,
  count: number,
  half: number,
): number {
  let cumulative = 0
  for (let i = 0; i < count; i++) {
    cumulative += weights[indices[i]]
    if (cumulative === half && i + 1 < count)
      return (values[indices[i]] + values[indices[i + 1]]) / 2
    if (cumulative > half) return values[indices[i]]
  }
  return values[indices[count - 1]]
}

/**
 * Full native source only. The caller must admit its own source/cache separately
 * and retain/verify that source until this operation settles. This function only
 * freezes the supplied source provenance; it never certifies a source hash.
 */
export async function estimateDetailNoise(
  source: DetailNoiseSource,
  admission: { readonly maxWorkingBytes: number },
  signal: AbortSignal,
): Promise<DetailNoiseEstimate> {
  signal.throwIfAborted()
  const image = { width: source.width, height: source.height },
    provenance = Object.freeze({
      ...image,
      identity: source.identity,
      sha256: source.sha256,
      primaries: source.primaries,
      verification: 'caller-owned-source-lease-and-hashes' as const,
    }),
    coefficients = Object.freeze([...detailLuminance(provenance.primaries)]),
    readRow = source.readRow.bind(source),
    memory = detailNoiseEstimateMemory(image),
    budget = admission.maxWorkingBytes
  if (!/^[a-f0-9]{64}$/.test(provenance.identity) || !/^[a-f0-9]{64}$/.test(provenance.sha256))
    throw new Error('Invalid noise estimator source identity.')
  if (!Number.isSafeInteger(budget) || budget < memory.workingBytes)
    throw new Error('Noise estimation exceeds the admitted working bytes.')
  const statistics = new ArrayBuffer(memory.statisticsBytes),
    components = [0, 1, 2].map(
      (c) => new Float64Array(statistics, c * memory.maximumPairs * 8, memory.maximumPairs),
    ),
    weights = new Float64Array(statistics, 3 * memory.maximumPairs * 8, memory.maximumPairs),
    indices = new Uint32Array(statistics, 4 * memory.maximumPairs * 8, memory.maximumPairs),
    rows = new Float32Array(image.width * 8),
    firstRow = rows.subarray(0, image.width * 4),
    secondRow = rows.subarray(image.width * 4),
    rowBuffers = [firstRow, secondRow],
    rowNumbers = [-1, -1],
    features = new Float64Array(6),
    exact = new ExactProductSum()
  const load = async (number: number, slot: number) => {
    signal.throwIfAborted()
    const row = rowBuffers[slot]
    row.fill(NaN)
    await readRow(number, row, signal)
    signal.throwIfAborted()
    if (row.length !== image.width * 4 || row.buffer.byteLength !== memory.rowBytes)
      throw new Error('Incomplete noise estimator source row.')
    for (let i = 0; i < row.length; i += 4) {
      const alpha = row[i + 3]
      if (
        !Number.isFinite(alpha) ||
        alpha < 0 ||
        alpha > 1 ||
        (alpha > 0 &&
          (!Number.isFinite(row[i]) ||
            !Number.isFinite(row[i + 1]) ||
            !Number.isFinite(row[i + 2])))
      )
        throw new Error('Invalid noise estimator source row.')
    }
    rowNumbers[slot] = number
  }
  const encode = (row: Float32Array, at: number, offset: number) => {
    exact.clear()
    for (let c = 0; c < 3; c++) exact.add(row[at + c] * coefficients[c])
    const y = exact.finish(),
      scale = Math.hypot(y, DETAIL_REFERENCE)
    features[offset] = Math.asinh(y / DETAIL_REFERENCE)
    features[offset + 1] = Math.asinh((row[at] - y) / scale)
    features[offset + 2] = Math.asinh((row[at + 2] - y) / scale)
  }
  const directions: DetailNoiseDirection[] = []
  for (const [dx, dy] of DIRECTIONS) {
    const pairWidth = Math.max(0, image.width - Math.abs(dx)),
      pairHeight = Math.max(0, image.height - Math.abs(dy)),
      availablePairs = pairWidth * pairHeight,
      stratifiedPairs = Math.min(availablePairs, DETAIL_NOISE_ESTIMATE_MAX_PAIRS)
    let validPairs = 0
    for (let sample = 0; sample < stratifiedPairs; sample++) {
      const index = Math.floor(((2 * sample + 1) * availablePairs) / (2 * stratifiedPairs)),
        x = Math.max(0, -dx) + (index % pairWidth),
        y = Math.max(0, -dy) + Math.floor(index / pairWidth),
        otherY = y + dy
      let firstSlot = rowNumbers.indexOf(y)
      if (firstSlot === -1) {
        firstSlot = rowNumbers[0] === otherY ? 1 : 0
        await load(y, firstSlot)
      }
      let secondSlot = rowNumbers.indexOf(otherY)
      if (secondSlot === -1) {
        secondSlot = 1 - firstSlot
        await load(otherY, secondSlot)
      }
      const left = rowBuffers[firstSlot],
        right = rowBuffers[secondSlot],
        p = x * 4,
        q = (x + dx) * 4,
        weight = left[p + 3] * right[q + 3]
      if (weight > 0) {
        encode(left, p, 0)
        encode(right, q, 3)
        for (let c = 0; c < 3; c++) components[c][validPairs] = features[c] - features[c + 3]
        weights[validPairs++] = weight
      }
      if (sample > 0 && sample % 2048 === 0) await yieldEstimator(signal)
    }
    const centers: (number | null)[] = [null, null, null],
      sigmas: (number | null)[] = [null, null, null]
    if (validPairs) {
      exact.clear()
      for (let i = 0; i < validPairs; i++) exact.add(weights[i])
      const half = exact.finish() / 2
      for (let c = 0; c < 3; c++) {
        const values = components[c]
        await sortSamples(values, weights, indices, validPairs, signal)
        const center = weightedMedian(values, weights, indices, validPairs, half)
        centers[c] = center
        for (let i = 0; i < validPairs; i++) values[i] = Math.abs(values[i] - center)
        await sortSamples(values, weights, indices, validPairs, signal)
        if (validPairs >= MIN_PAIRS)
          sigmas[c] = weightedMedian(values, weights, indices, validPairs, half) / NORMAL_MAD
      }
    }
    directions.push(
      Object.freeze({
        direction: Object.freeze([dx, dy]) as readonly [number, number],
        availablePairs,
        stratifiedPairs,
        validPairs,
        centers: Object.freeze(centers) as OptionalTriple,
        sigma: Object.freeze(sigmas) as OptionalTriple,
      }),
    )
  }
  signal.throwIfAborted()
  const sigma = [0, 1, 2].map((c) => {
    const candidates = directions
      .map((direction) => direction.sigma[c])
      .filter((v): v is number => v !== null)
    return candidates.length ? Math.min(...candidates) : 0
  }) as [number, number, number]
  return Object.freeze({
    version: DETAIL_NOISE_ESTIMATE_VERSION,
    source: provenance,
    directions: Object.freeze(directions),
    sigma: Object.freeze(sigma),
    variance: Object.freeze(sigma.map((v) => v * v)) as Triple,
    available: directions.some((direction) => direction.sigma[0] !== null),
    memory,
    limits: 'Empirical global minimum, not calibrated sensor noise or an unbiased estimate.',
  })
}
