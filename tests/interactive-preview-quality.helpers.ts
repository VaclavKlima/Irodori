import { fromHalf } from './export-reference'

export const photographPreviewBudget = {
  maximumEncodedError: 1 / 1024,
  p99EncodedError: 1 / 2048,
  encodedRms: 1 / 8192,
  maximumGradientDifference: 1 / 1024,
  maximumEdgeEnergyRelativeDifference: 0.005,
  minimumLuminanceSsim: 0.99999,
}

const quantileScale = 65536
function accumulator() {
  return { count: 0, maximum: 0, squares: 0, histogram: new Uint32Array(quantileScale + 1) }
}
function add(value: ReturnType<typeof accumulator>, difference: number) {
  value.count++
  value.maximum = Math.max(value.maximum, difference)
  value.squares += difference * difference
  value.histogram[Math.min(quantileScale, Math.ceil(difference * quantileScale))]++
}
function finish(value: ReturnType<typeof accumulator>) {
  let cumulative = 0,
    p99 = 0
  for (let i = 0; i < value.histogram.length; i++) {
    cumulative += value.histogram[i]
    if (cumulative >= Math.ceil(value.count * 0.99)) {
      p99 = i / quantileScale
      break
    }
  }
  return {
    samples: value.count,
    maximumEncodedError: value.maximum,
    p99EncodedErrorUpperBound: p99,
    encodedRms: Math.sqrt(value.squares / Math.max(1, value.count)),
  }
}

/** Display-space error and texture retention, separate from human visual acceptance. */
export function photographPreviewMetrics(
  reference: Uint16Array,
  candidate: Uint16Array,
  sourceAlpha: Float32Array,
  width: number,
  height: number,
  peak: number,
  colorSpace: 'srgb' | 'display-p3',
) {
  if (reference.length !== width * height * 4 || candidate.length !== reference.length)
    throw new Error('Photographic comparison dimensions differ.')
  const aggregate = accumulator()
  const classes = {
    highlight: accumulator(),
    shadow: accumulator(),
    edge: accumulator(),
    flat: accumulator(),
    clipped: accumulator(),
    partialCoverage: accumulator(),
  }
  const classValues = [
    classes.clipped,
    classes.partialCoverage,
    classes.highlight,
    classes.shadow,
    classes.edge,
    classes.flat,
  ]
  const weights =
    colorSpace === 'srgb'
      ? [0.2126390059, 0.7151686788, 0.0721923154]
      : [0.2289745641, 0.6917385218, 0.0792869141]
  const flags = new Uint8Array(width * height)
  const differences = new Float32Array(width * height * 3)
  const lumaReference = new Float32Array(width * height),
    lumaCandidate = new Float32Array(width * height)
  let maximumGradientDifference = 0,
    baselineEdges = 0,
    candidateEdges = 0,
    nonfinite = 0,
    displayAlphaMismatches = 0,
    worstPixel = 0,
    largestError = -1
  const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x,
        offset = pixel * 4
      let edge = 0,
        light = 0
      for (let c = 0; c < 3; c++) {
        const a = fromHalf(reference[offset + c]),
          b = fromHalf(candidate[offset + c])
        const difference = Math.abs(a - b)
        nonfinite += Number(!Number.isFinite(a) || !Number.isFinite(b))
        differences[pixel * 3 + c] = b - a
        lumaReference[pixel] += a * weights[c]
        lumaCandidate[pixel] += b * weights[c]
        light += linear(a) * weights[c]
        if (sourceAlpha[pixel] > 0) add(aggregate, difference)
        if (difference > largestError) {
          largestError = difference
          worstPixel = pixel
        }
        for (let axis = 0; axis < 2; axis++) {
          const previous = axis === 0 ? (x ? offset - 4 : -1) : y ? offset - width * 4 : -1
          if (previous < 0) continue
          const aEdge = a - fromHalf(reference[previous + c]),
            bEdge = b - fromHalf(candidate[previous + c])
          edge = Math.max(edge, Math.abs(aEdge))
          maximumGradientDifference = Math.max(maximumGradientDifference, Math.abs(aEdge - bEdge))
          baselineEdges += Math.abs(aEdge)
          candidateEdges += Math.abs(bEdge)
        }
      }
      displayAlphaMismatches += Number(reference[offset + 3] !== candidate[offset + 3])
      const mask = sourceAlpha[pixel]
      // Flags preserve the actual sampler's photographic coverage, not canvas alpha.
      flags[pixel] =
        Number(mask === 0) |
        (Number(mask > 0 && mask < 1) << 1) |
        (Number(mask > 0 && light >= (peak > 1 ? 1 : 0.75)) << 2) |
        (Number(mask > 0 && light < 0.02) << 3) |
        (Number(mask > 0 && edge >= 0.04) << 4) |
        (Number(mask > 0 && edge < 0.01) << 5)
      for (let group = 0; group < classValues.length; group++)
        if (flags[pixel] & (1 << group))
          for (let c = 0; c < 3; c++) add(classValues[group], Math.abs(differences[pixel * 3 + c]))
    }
  let totalSsim = 0,
    windows = 0,
    minimumWindowSsim = 1
  // Local 8x8 luminance SSIM in encoded display space; constants use peak code value.
  const codePeak = peak <= 0.0031308 ? peak * 12.92 : 1.055 * peak ** (1 / 2.4) - 0.055
  const c1 = (0.01 * codePeak) ** 2,
    c2 = (0.03 * codePeak) ** 2
  for (let top = 0; top < height; top += 8)
    for (let left = 0; left < width; left += 8) {
      let count = 0,
        a = 0,
        b = 0,
        aa = 0,
        bb = 0,
        ab = 0
      for (let y = top; y < Math.min(height, top + 8); y++)
        for (let x = left; x < Math.min(width, left + 8); x++) {
          const i = y * width + x,
            r = lumaReference[i],
            c = lumaCandidate[i]
          if (sourceAlpha[i] <= 0) continue
          count++
          a += r
          b += c
          aa += r * r
          bb += c * c
          ab += r * c
        }
      if (!count) continue
      const ma = a / count,
        mb = b / count
      const va = Math.max(0, aa / count - ma * ma),
        vb = Math.max(0, bb / count - mb * mb),
        covariance = ab / count - ma * mb
      const ssim =
        ((2 * ma * mb + c1) * (2 * covariance + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
      totalSsim += ssim
      minimumWindowSsim = Math.min(minimumWindowSsim, ssim)
      windows++
    }
  return {
    report: {
      ...finish(aggregate),
      classes: Object.fromEntries(
        Object.entries(classes).map(([name, value]) => [name, finish(value)]),
      ),
      nonfinite,
      displayAlphaMismatches,
      maximumGradientDifference,
      edgeEnergyRelativeDifference: Math.abs(candidateEdges / Math.max(1e-20, baselineEdges) - 1),
      meanLuminanceSsim: totalSsim / windows,
      minimumWindowLuminanceSsim: minimumWindowSsim,
      worstPixel: { x: worstPixel % width, y: Math.floor(worstPixel / width) },
      flags: { clipped: 1, partialCoverage: 2, highlight: 4, shadow: 8, edge: 16, flat: 32 },
      limitations:
        'Encoded error and SSIM constrain color/detail changes; neither proves imperceptibility.',
    },
    differences,
    flags,
  }
}
