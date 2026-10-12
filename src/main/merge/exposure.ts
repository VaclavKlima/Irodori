import { BRK_EXPOSURE_POLICY as P, MERGE_LIMITS, type MergeTransform } from '../../shared/merge'
import { median, sample, warp, type Plane } from './math'

type Pair = { ev: number; weight: number; samples: number }
type Tile = { x: number; y: number; training: Pair; validation: Pair }
const average = (pairs: Pair[]): Pair => {
  const weight = pairs.reduce((sum, p) => sum + p.weight, 0)
  return {
    ev: pairs.reduce((sum, p) => sum + p.ev * p.weight, 0) / weight,
    weight,
    samples: pairs.reduce((sum, p) => sum + p.samples, 0),
  }
}

/** Linear RAW exposure ratios: balanced tiles, signal weights, independent validation.
 * Hanji and Mantiuk (2023), https://arxiv.org/abs/2308.02968.
 * The metadata remains a bounded prior; it is not a calibrated RAW gain.
 */
export function estimateBracketExposure(
  reference: Plane,
  source: Plane,
  transform: MergeTransform,
  expected: number,
  excluded: (x: number, y: number) => boolean,
  referenceTransform?: MergeTransform,
) {
  if (!reference.mask || !source.mask)
    throw new Error('BRK exposure estimation requires both sensor clipping masks.')
  const { width, height } = reference,
    grid = Math.min(P.grid, Math.floor(Math.min(width, height) / 12)),
    edge = Math.max(2, Math.ceil(Math.max(width, height) / 256)),
    groups = new Map<number, [Pair[], Pair[]]>()
  for (let gy = 0, top = 1; top + edge < height; gy++, top += edge)
    for (let gx = 0, left = 1; left + edge < width; gx++, left += edge) {
      let a = 0,
        b = 0,
        valid = 0
      for (let y = top; y < top + edge; y++)
        for (let x = left; x < left + edge; x++) {
          if (excluded(x, y)) continue
          const [sx, sy] = warp(x, y, width, height, transform),
            av = referenceTransform
              ? sample(reference, ...warp(x, y, width, height, referenceTransform))
              : reference.mask[y * width + x]
                ? reference.data[y * width + x]
                : NaN,
            bv = sample(source, sx, sy)
          // Fixed sensor-white normalization and masks permit working values
          // above one. Ignore the noise floor rather than applying a display ceiling.
          if (av > 0.015 && bv > 0.015 && Number.isFinite(av + bv)) {
            a += av
            b += bv
            valid++
          }
        }
      if (valid < edge * edge * 0.75) continue
      const x = Math.min(grid - 1, Math.floor(((left + edge / 2) * grid) / width)),
        y = Math.min(grid - 1, Math.floor(((top + edge / 2) * grid) / height)),
        key = y * grid + x
      let group = groups.get(key)
      if (!group) groups.set(key, (group = [[], []]))
      // Harmonic signal weights approximate inverse log-domain shot variance
      // without claiming a measured camera noise calibration.
      group[(gx + gy) % 2].push({ ev: Math.log2(b / a), weight: (a * b) / (a + b), samples: 1 })
    }
  const tiles: Tile[] = []
  for (const [key, halves] of groups) {
    if (halves.some((pairs) => pairs.length < P.minimumTileSamples)) continue
    const [training, validation] = halves.map((pairs) =>
      average(pairs.sort((a, b) => b.weight - a.weight).slice(0, P.samplesPerTile)),
    )
    tiles.push({ x: key % grid, y: Math.floor(key / grid), training, validation })
  }
  const nominalEv = Math.log2(expected),
    coherent = (ev: number) => tiles.filter((t) => Math.abs(t.training.ev - ev) <= P.residualEv)
  // A bounded mode search gives each spatial tile one vote. Strong bright
  // objects cannot dominate merely because they supply more samples.
  const candidates = tiles
    .filter((t) => Math.abs(t.training.ev - nominalEv) <= P.maximumMetadataDeltaEv)
    .map((t) => ({ ev: t.training.ev, support: coherent(t.training.ev) }))
    .sort(
      (a, b) =>
        b.support.length - a.support.length ||
        Math.abs(a.ev - nominalEv) - Math.abs(b.ev - nominalEv),
    )
  const best = candidates[0]
  if (
    !best ||
    best.support.length < P.minimumTiles ||
    best.support.length / tiles.length < P.minimumSupport
  )
    throw new Error('Disconnected or spatially inconsistent usable BRK exposure overlap.')
  const competing = candidates.find(
    (c) =>
      Math.abs(c.ev - best.ev) > 3 * P.residualEv &&
      c.support.length / tiles.length >= P.minimumSupport,
  )
  if (competing)
    throw new Error(
      'Two substantial regions have incompatible BRK exposure ratios; illumination is ambiguous.',
    )
  // Cap each tile's weight to preserve spatial balance, then freeze the fit and
  // eligibility before consulting the held-out checkerboard samples.
  const weightCap = median(best.support.map((t) => t.training.weight)),
    weights = best.support.map((t) => Math.min(weightCap, t.training.weight)),
    measuredEv =
      best.support.reduce((sum, t, i) => sum + t.training.ev * weights[i], 0) /
      weights.reduce((sum, w) => sum + w, 0),
    support = best.support,
    residuals = support.map((t) => Math.abs(t.validation.ev - measuredEv)),
    consistent = support.filter((_, i) => residuals[i] <= P.residualEv),
    cells = new Set(
      consistent.map((t) => Math.floor((t.x * 4) / grid) + 4 * Math.floor((t.y * 4) / grid)),
    ),
    agreement = consistent.length / support.length,
    trainingSamples = support.reduce((sum, t) => sum + t.training.samples, 0),
    validationSamples = support.reduce((sum, t) => sum + t.validation.samples, 0),
    medianResidualEv = median(residuals)
  if (
    trainingSamples < MERGE_LIMITS.minimumOverlapSamples ||
    validationSamples < MERGE_LIMITS.minimumOverlapSamples ||
    consistent.length < P.minimumTiles ||
    cells.size < P.minimumCells ||
    agreement < P.minimumAgreement ||
    medianResidualEv > P.residualEv ||
    Math.abs(measuredEv - nominalEv) > P.maximumMetadataDeltaEv
  )
    throw new Error(
      `BRK exposure validation failed (${consistent.length}/${support.length} held-out tiles across ${cells.size} cells, ${medianResidualEv.toFixed(3)} EV median residual).`,
    )
  const retained = new Set(support),
    excludedRegions = tiles
      .filter((t) => !retained.has(t))
      .map((t) => ({
        left: (t.x * width) / grid,
        top: (t.y * height) / grid,
        width: width / grid,
        height: height / grid,
      }))
  return {
    scale: 2 ** measuredEv,
    excludedRegions,
    diagnostics: {
      policy: P,
      nominalEv,
      measuredEv,
      metadataDeltaEv: measuredEv - nominalEv,
      usableTiles: tiles.length,
      trainingTiles: support.length,
      trainingSamples,
      validationSamples,
      validationCells: cells.size,
      agreement,
      medianResidualEv,
      excludedTiles: excludedRegions.length,
    },
  }
}
