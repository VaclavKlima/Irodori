import {
  ALIGNMENT_CONSTANTS,
  MergeError,
  type AlignmentDiagnostics,
  type MergeTransform,
} from '../../shared/merge'
import { median, sample, type Plane } from './math'
import { identityMatrix, point, resizeMatrix, validateGeometry } from './matrix'
import { openCv } from './opencv'

export { ALIGNMENT_CONSTANTS } from '../../shared/merge'
const normalized = new WeakMap<Plane, Plane>(),
  pyramids = new WeakMap<Plane, Plane[]>()
export function normalizedPlane(p: Plane): Plane {
  const cached = normalized.get(p)
  if (cached) return cached
  const values: number[] = []
  for (let i = 0; i < p.data.length; i += 3)
    if ((!p.mask || p.mask[i]) && p.data[i] > 0.004) values.push(p.data[i])
  const scale = values.length ? median(values) : 1
  const data = new Float32Array(p.data.length),
    mask = new Uint8Array(p.data.length)
  for (let i = 0; i < data.length; i++) {
    const v = p.data[i]
    data[i] = Math.sqrt(Math.max(0, v) / scale) / 3
    mask[i] = (!p.mask || p.mask[i]) && v > 0.004 ? 255 : 0
  }
  const result = { width: p.width, height: p.height, data, mask }
  normalized.set(p, result)
  return result
}
export function reducePlane(p: Plane): Plane {
  const width = Math.floor(p.width / 2),
    height = Math.floor(p.height / 2),
    data = new Float32Array(width * height),
    mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const indices = [
        y * 2 * p.width + x * 2,
        y * 2 * p.width + x * 2 + 1,
        (y * 2 + 1) * p.width + x * 2,
        (y * 2 + 1) * p.width + x * 2 + 1,
      ]
      if (indices.every((i) => !p.mask || p.mask[i])) {
        data[y * width + x] = indices.reduce((v, i) => v + p.data[i], 0) / 4
        mask[y * width + x] = 255
      }
    }
  return { width, height, data, mask }
}
function cells(points: number[][], width: number, height: number): number {
  return new Set(
    points.map(
      (p) =>
        Math.min(3, Math.floor((p[0] * 4) / width)) +
        4 * Math.min(3, Math.floor((p[1] * 4) / height)),
    ),
  ).size
}
export function alignmentFailure(message: string, diagnostics: AlignmentDiagnostics[] = []): never {
  throw new MergeError({ code: 'alignment', message, filenames: [], diagnostics })
}
function pyramid(p: Plane): Plane[] {
  let levels = pyramids.get(p)
  if (!levels) {
    levels = [p]
    while (levels.at(-1)!.width > 320 && levels.at(-1)!.height > 240)
      levels.push(reducePlane(levels.at(-1)!))
    pyramids.set(p, levels)
  }
  return levels
}
function usableCoverage(a: Plane, b: Plane, matrix = identityMatrix()) {
  let count = 0
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const [sx, sy] = point(matrix, x, y)
      if (a.mask?.[y * a.width + x] && Number.isFinite(sample(b, sx, sy))) count++
    }
  return count / a.data.length
}

/** Local contrast keeps slowly changing illumination out of the ECC objective. */
function localContrast(p: Plane): Plane {
  const stride = p.width + 1,
    sums = new Float64Array(stride * (p.height + 1)),
    counts = new Uint32Array(sums.length),
    data = new Float32Array(p.data.length),
    radius = 5
  for (let y = 0; y < p.height; y++) {
    let sum = 0,
      count = 0
    for (let x = 0; x < p.width; x++) {
      const i = y * p.width + x,
        to = (y + 1) * stride + x + 1
      if (p.mask?.[i]) {
        sum += p.data[i]
        count++
      }
      sums[to] = sums[to - stride] + sum
      counts[to] = counts[to - stride] + count
    }
  }
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const left = Math.max(0, x - radius),
        right = Math.min(p.width, x + radius + 1),
        top = Math.max(0, y - radius),
        bottom = Math.min(p.height, y + radius + 1),
        a = top * stride + left,
        b = top * stride + right,
        c = bottom * stride + left,
        d = bottom * stride + right,
        count = counts[d] - counts[c] - counts[b] + counts[a],
        i = y * p.width + x
      if (p.mask?.[i] && count)
        data[i] = p.data[i] - (sums[d] - sums[c] - sums[b] + sums[a]) / count
    }
  return { ...p, data }
}

/** Estimate the photometric scale from shared usable pixels, not separate histograms. */
function pairedEccPlanes(reference: Plane, source: Plane): [Plane, Plane] {
  const ratios: number[] = [],
    values: number[] = []
  for (let i = 0; i < reference.data.length; i += 3)
    if (
      (!reference.mask || reference.mask[i]) &&
      (!source.mask || source.mask[i]) &&
      reference.data[i] > 0.015 &&
      source.data[i] > 0.015
    ) {
      ratios.push(Math.log2(source.data[i] / reference.data[i]))
      values.push(reference.data[i])
    }
  const scale = values.length ? median(values) : 1,
    ratio = ratios.length ? 2 ** median(ratios) : 1
  return [reference, source].map((p, index) => {
    const normalized = normalizedPlane(p),
      mask = new Uint8Array(normalized.mask!),
      data = Float32Array.from(
        p.data,
        (v) => Math.sqrt(Math.max(0, v) / (scale * (index ? ratio : 1))) / 3,
      )
    // ECC's Gaussian derivative must not follow changing clipping/shadow edges.
    for (let y = 2; y < p.height - 2; y++)
      for (let x = 2; x < p.width - 2; x++) {
        const i = y * p.width + x
        for (let dy = -2; dy <= 2 && mask[i]; dy++)
          for (let dx = -2; dx <= 2; dx++)
            if (!normalized.mask![i + dy * p.width + dx]) {
              mask[i] = 0
              break
            }
      }
    return { ...normalized, data, mask }
  }) as [Plane, Plane]
}

/** ECC proposes geometry only; spatial correspondence and native proof follow. */
export async function eccHypothesis(
  reference: Plane,
  source: Plane,
  projective: boolean,
  checkpoint: () => Promise<void>,
): Promise<MergeTransform> {
  const start = performance.now(),
    cv = await openCv(),
    [a, b] = pairedEccPlanes(reference, source),
    ap = pyramid(a),
    bp = pyramid(b)
  const diagnostics: AlignmentDiagnostics = {
    algorithm: ALIGNMENT_CONSTANTS.version,
    model: projective ? 'projective' : 'similarity',
    method: 'ecc-patches',
    matches: 0,
    inliers: 0,
    cells: 0,
    usableCoverage: usableCoverage(a, b),
    nativePatches: [],
    movingRegions: [],
    runtimeMs: 0,
    wasmMemoryBytes: cv.memory(),
  }
  let matrix = identityMatrix(),
    correlation = -1
  try {
    if (a.width !== b.width || a.height !== b.height)
      throw new Error('Incompatible registration pyramids.')
    // A sparse feature fit can initialize ECC; it cannot establish the required
    // correspondence count or authorize a merge before independent native proof.
    const seed = cv.fit(
      cv.matches(normalizedPlane(reference), normalizedPlane(source)),
      projective,
      ALIGNMENT_CONSTANTS.ransacPixels,
    )
    if (seed)
      try {
        validateGeometry(seed.matrix, a.width, a.height)
        matrix = seed.matrix
      } catch {
        /* Start this same ECC hypothesis at identity when its seed is unsafe. */
      }
    for (let level = ap.length - 1; level >= 0; level--) {
      const aa = localContrast(ap[level]),
        bb = localContrast(bp[level])
      let local = resizeMatrix(matrix, aa.width / a.width, aa.height / a.height)
      for (let iteration = 0; iteration < 3; iteration++) {
        await checkpoint()
        const mask = new Uint8Array(aa.mask!),
          residuals: number[] = []
        for (let y = 0; y < aa.height; y += 3)
          for (let x = 0; x < aa.width; x += 3) {
            const [sx, sy] = point(local, x, y),
              value = sample(bb, sx, sy)
            if (mask[y * aa.width + x] && Number.isFinite(value))
              residuals.push(Math.abs(aa.data[y * aa.width + x] - value))
          }
        const threshold = Math.max(0.06, (residuals.length ? median(residuals) : 1) * 5)
        for (let y = 0; y < aa.height; y++)
          for (let x = 0; x < aa.width; x++) {
            const [sx, sy] = point(local, x, y),
              value = sample(bb, sx, sy),
              i = y * aa.width + x
            if (!Number.isFinite(value) || Math.abs(aa.data[i] - value) > threshold) mask[i] = 0
          }
        // A rigid ECC start avoids photometric scale/geometry ambiguity. Native
        // spatial correspondences subsequently fit all similarity parameters.
        const next = cv.ecc({ ...aa, mask }, bb, local, projective ? 3 : 1, 60)
        if (next.correlation < 0) break
        if (!projective) {
          const c = (next.matrix[0] + next.matrix[4]) / 2,
            s = (next.matrix[3] - next.matrix[1]) / 2
          next.matrix = [c, -s, next.matrix[2], s, c, next.matrix[5], 0, 0, 1]
        }
        validateGeometry(next.matrix, aa.width, aa.height)
        local = next.matrix
        correlation = next.correlation
      }
      matrix = resizeMatrix(local, a.width / aa.width, a.height / aa.height)
    }
    if (correlation < 0) throw new Error('Masked pyramid ECC could not estimate geometry.')
    diagnostics.usableCoverage = usableCoverage(a, b, matrix)
    return { x: 0, y: 0, angle: 0, correlation, matrix, diagnostics }
  } catch (error) {
    diagnostics.reason = (error as Error).message
    alignmentFailure(diagnostics.reason, [diagnostics])
  } finally {
    diagnostics.runtimeMs = performance.now() - start
    diagnostics.wasmMemoryBytes = cv.memory()
  }
}
/** Independent candidates; the caller validates native patches before preferring similarity. */
export async function registrationCandidates(
  reference: Plane,
  source: Plane,
  projectiveOnly?: boolean,
  coarseOnly = false,
): Promise<MergeTransform[]> {
  const start = performance.now(),
    cv = await openCv(),
    a = normalizedPlane(reference),
    b = normalizedPlane(source)
  const matches = cv.matches(a, b),
    candidates: MergeTransform[] = [],
    rejected: AlignmentDiagnostics[] = []
  for (const projective of projectiveOnly === undefined ? [false, true] : [projectiveOnly]) {
    const fit = cv.fit(matches, projective, ALIGNMENT_CONSTANTS.ransacPixels)
    const support = fit ? matches.filter((_, i) => fit.inliers[i]) : []
    const diagnostics: AlignmentDiagnostics = {
      algorithm: ALIGNMENT_CONSTANTS.version,
      model: projective ? 'projective' : 'similarity',
      method: 'orb',
      matches: matches.length,
      inliers: support.length,
      cells: cells(support, a.width, a.height),
      usableCoverage: usableCoverage(a, b, fit?.matrix),
      nativePatches: [],
      movingRegions: [],
      runtimeMs: 0,
      wasmMemoryBytes: cv.memory(),
    }
    if (!fit || support.length < 30 || diagnostics.cells < 6) {
      diagnostics.reason = 'Fewer than 30 consistent features spanning six grid cells.'
      diagnostics.runtimeMs = performance.now() - start
      rejected.push(diagnostics)
      continue
    }
    let matrix = fit.matrix,
      correlation = 0
    try {
      validateGeometry(matrix, a.width, a.height)
    } catch (error) {
      diagnostics.reason = (error as Error).message
      diagnostics.runtimeMs = performance.now() - start
      rejected.push(diagnostics)
      continue
    }
    // ORB outliers spatially identify moving content; intensity residuals then
    // exclude changing pixels in both template and source before each ECC pass.
    const ap = pyramid(a),
      bp = pyramid(b)
    for (let level = ap.length - 1; level >= 0; level--) {
      if (coarseOnly && level < ap.length - 1) break
      const aa = ap[level],
        bb = bp[level]
      let local = resizeMatrix(matrix, aa.width / a.width, aa.height / a.height)
      for (let iteration = 0; iteration < 3; iteration++) {
        const mask = new Uint8Array(aa.mask!),
          residuals: number[] = []
        for (let y = 0; y < aa.height; y += 3)
          for (let x = 0; x < aa.width; x += 3) {
            const [sx, sy] = point(local, x, y),
              v = sample(bb, sx, sy),
              i = y * aa.width + x
            if (mask[i] && Number.isFinite(v)) residuals.push(Math.abs(aa.data[i] - v))
          }
        const threshold = Math.max(0.06, (residuals.length ? median(residuals) : 1) * 5)
        for (let y = 0; y < aa.height; y++)
          for (let x = 0; x < aa.width; x++) {
            const [sx, sy] = point(local, x, y),
              v = sample(bb, sx, sy),
              i = y * aa.width + x
            if (!Number.isFinite(v) || Math.abs(aa.data[i] - v) > threshold) mask[i] = 0
          }
        const refined = cv.ecc({ ...aa, mask }, bb, local, projective ? 3 : 2, coarseOnly ? 20 : 60)
        if (refined.correlation < 0) break
        let next = refined.matrix
        if (!projective) {
          // Project affine ECC onto the four-parameter similarity family.
          const c = (next[0] + next[4]) / 2,
            s = (next[3] - next[1]) / 2
          next = [c, -s, next[2], s, c, next[5], 0, 0, 1]
        }
        try {
          validateGeometry(next, aa.width, aa.height)
        } catch {
          break
        }
        local = next
        correlation = refined.correlation
      }
      matrix = resizeMatrix(local, a.width / aa.width, a.height / aa.height)
    }
    diagnostics.runtimeMs = performance.now() - start
    diagnostics.wasmMemoryBytes = cv.memory()
    candidates.push({ x: 0, y: 0, angle: 0, correlation, matrix, diagnostics })
  }
  if (!candidates.length)
    alignmentFailure(
      'Low-confidence alignment: fewer than 30 consistent features spanning six grid cells. More texture or usable exposure overlap is required.',
      rejected,
    )
  return candidates
}
export function identityTransform(): MergeTransform {
  return { x: 0, y: 0, angle: 0, correlation: 1, matrix: identityMatrix() }
}
