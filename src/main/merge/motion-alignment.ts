import type { PreparedSource } from './prepare'
import type { MergeMatrix, MergeTransform } from '../../shared/merge'
import { ALIGNMENT_CONSTANTS as C } from '../../shared/merge'
import { alignmentFailure, normalizedPlane } from './alignment'
import { patches } from './native-alignment'
import {
  point,
  resizeMatrix,
  resizedTransform,
  validateGeometry,
  validateTransform,
  warpedPoint,
} from './matrix'
import { openCv } from './opencv'

type Observation = { x: number; y: number; sx: number; sy: number }
type Measurements = { points: Observation[]; matches: number[][] }
// Measurements depend on the initial warp. Keep a bounded set per prepared pair.
const cache = new WeakMap<
  PreparedSource,
  WeakMap<PreparedSource, Map<string, Promise<Measurements>>>
>()
const maskedPlanes = new WeakMap<PreparedSource, Float32Array>()
const fittedEvidence = new WeakMap<
  MergeTransform,
  { reference: PreparedSource; source: PreparedSource; key: string; measurements: Measurements }
>()
const hypothesisKey = (t: MergeTransform) =>
  JSON.stringify([t.matrix, t.tiles, t.diagnostics?.method === 'ecc-patches'])
function maskedPlane(source: PreparedSource) {
  let pixels = maskedPlanes.get(source)
  if (!pixels) {
    pixels = new Float32Array(source.plane.data)
    if (source.plane.mask)
      for (let i = 0; i < pixels.length; i++) if (!source.plane.mask[i]) pixels[i] = NaN
    maskedPlanes.set(source, pixels)
  }
  return pixels
}
async function coarseMeasurements(
  reference: PreparedSource,
  source: PreparedSource,
  t: MergeTransform,
  checkpoint: () => Promise<void>,
) {
  const { width, height } = reference.plane
  if (width !== source.plane.width || height !== source.plane.height)
    alignmentFailure('Incompatible registration pyramids.')
  const sx = width / reference.width,
    sy = height / reference.height,
    edge = Math.min(
      Math.floor(Math.min(width, height) / 4),
      Math.max(24, Math.round(C.motionPatchEdge * Math.min(sx, sy))),
    ),
    reduced = resizedTransform(t, reference.width, reference.height, width, height),
    cv = await openCv(),
    a = { data: maskedPlane(reference), first: 0, rows: height },
    b = { data: maskedPlane(source), first: 0, rows: height },
    measured = []
  for (let gy = 0; gy < C.motionTrainingGrid; gy++) {
    await checkpoint()
    const y = Math.round(((gy + 0.5) * height) / C.motionTrainingGrid),
      top = Math.max(0, Math.min(height - edge, y - Math.floor(edge / 2))),
      centers = Array.from({ length: C.motionTrainingGrid }, (_, gx) => {
        const x = Math.round(((gx + 0.5) * width) / C.motionTrainingGrid)
        return [Math.max(0, Math.min(width - edge, x - Math.floor(edge / 2))), top]
      })
    measured.push(
      ...cv.patches(a, b, width, height, reduced.matrix!, centers, edge, C.motionValidFraction),
    )
  }
  return measured.map((p) => ({
    ...p,
    x: (p.x + 0.5) / sx - 0.5,
    y: (p.y + 0.5) / sy - 0.5,
    dx: p.dx / sx,
    dy: p.dy / sy,
  }))
}
const residual = (m: MergeMatrix, p: Observation) => {
  const q = point(m, p.x, p.y)
  return Math.hypot(q[0] - p.sx, q[1] - p.sy)
}
const coordinates = (p: Observation) => [p.x, p.y, p.sx, p.sy]
const cell = (x: number, y: number, w: number, h: number) =>
  Math.min(3, Math.floor((x * 4) / w)) + 4 * Math.min(3, Math.floor((y * 4) / h))

async function rejectCompetingPlanes(points: Observation[], t: MergeTransform) {
  const cv = await openCv(),
    first = cv.fit(points.map(coordinates), false, C.motionConsensusPixels)
  if (!first) return
  const rest = points.filter((p) => residual(first.matrix, p) > C.motionConsensusPixels),
    second = cv.fit(rest.map(coordinates), false, C.motionConsensusPixels)
  if (
    second &&
    (points.length - rest.length) / points.length >= C.maximumCompetingSupport &&
    rest.filter((p) => residual(second.matrix, p) <= C.motionConsensusPixels).length /
      points.length >=
      C.maximumCompetingSupport
  )
    alignmentFailure(
      'Inconsistent geometric match: two substantial scene planes have different motion. Possible parallax.',
      [t.diagnostics!],
    )
}

export async function motionMeasurements(
  reference: PreparedSource,
  source: PreparedSource,
  t: MergeTransform,
  checkpoint: () => Promise<void>,
): Promise<Measurements> {
  let sources = cache.get(reference)
  if (!sources) cache.set(reference, (sources = new WeakMap()))
  let hypotheses = sources.get(source)
  if (!hypotheses) sources.set(source, (hypotheses = new Map()))
  const key = hypothesisKey(t)
  let pending = hypotheses.get(key)
  if (!pending) {
    pending = (async () => {
      const measured =
        t.diagnostics?.method === 'ecc-patches'
          ? await patches(reference, source, t, C.eccTrainingGrid, 0.25, checkpoint, {
              edge: C.eccPatchEdge,
              validFraction: C.motionValidFraction,
            })
          : Math.min(reference.plane.width, reference.plane.height) >= 128
            ? await coarseMeasurements(reference, source, t, checkpoint)
            : await patches(reference, source, t, C.motionTrainingGrid, 0.5, checkpoint, {
                edge: C.motionPatchEdge,
                validFraction: C.motionValidFraction,
                coarse: true,
              })
      const points = measured
        .filter((p) => p.correlation >= C.motionPatchCorrelation && Math.hypot(p.dx, p.dy) < 32)
        .map((p) => {
          const [sx, sy] = point(t.matrix!, p.x + p.dx, p.y + p.dy)
          return { x: p.x, y: p.y, sx, sy }
        })
      const cv = await openCv()
      return {
        points,
        matches: cv.matches(normalizedPlane(reference.plane), normalizedPlane(source.plane)),
      }
    })()
    if (hypotheses.size >= 4) hypotheses.delete(hypotheses.keys().next().value!)
    hypotheses.set(key, pending)
    pending.catch(() => hypotheses!.delete(key))
  }
  return pending
}

export async function patchRegistrationCandidate(
  reference: PreparedSource,
  source: PreparedSource,
  estimate: MergeTransform,
  checkpoint: () => Promise<void>,
): Promise<MergeTransform> {
  const measurements = await motionMeasurements(reference, source, estimate, checkpoint),
    { points } = measurements,
    cv = await openCv()
  let model = estimate.diagnostics!.model,
    fit = cv.fit(points.map(coordinates), model === 'projective', C.eccConsensusPixels)
  // An ECC start does not constrain the geometry established by independent
  // correspondences. Prefer similarity, but test projective geometry when a
  // broad field cannot follow one similarity transform. This adds no ECC run.
  let support = fit ? points.filter((p) => residual(fit!.matrix, p) <= C.eccConsensusPixels) : []
  if (model === 'similarity' && support.length / points.length < C.minimumPatchAgreement) {
    const projective = cv.fit(points.map(coordinates), true, C.eccConsensusPixels),
      projectiveSupport = projective
        ? points.filter((p) => residual(projective.matrix, p) <= C.eccConsensusPixels)
        : []
    if (
      projective &&
      projectiveSupport.length >= C.minimumInliers &&
      projectiveSupport.length / points.length >= C.minimumPatchAgreement &&
      new Set(projectiveSupport.map((p) => cell(p.x, p.y, reference.width, reference.height)))
        .size >= C.minimumCells
    ) {
      try {
        validateGeometry(projective.matrix, reference.width, reference.height)
        fit = projective
        support = projectiveSupport
        model = 'projective'
      } catch {
        /* Keep the similarity candidate when projective geometry is unsafe. */
      }
    }
  }
  const diagnostics = {
    ...estimate.diagnostics!,
    model,
    matches: points.length,
    patchSupport: support.length,
    inliers: support.length,
    cells: new Set(support.map((p) => cell(p.x, p.y, reference.width, reference.height))).size,
  }
  if (!fit || support.length < C.minimumInliers || diagnostics.cells < C.minimumCells) {
    diagnostics.reason =
      'Fewer than 30 coherent patches with correlation 0.98 spanning six grid cells.'
    alignmentFailure(diagnostics.reason, [diagnostics])
  }
  try {
    validateGeometry(fit.matrix, reference.width, reference.height)
  } catch (error) {
    alignmentFailure((error as Error).message, [diagnostics])
  }
  // Independent observations must also rule out competing substantial planes.
  const other = points.filter((p) => residual(fit.matrix, p) > C.motionConsensusPixels),
    alternative = cv.fit(other.map(coordinates), false, C.motionConsensusPixels)
  if (
    alternative &&
    support.length / points.length >= C.maximumCompetingSupport &&
    alternative.inliers.filter(Boolean).length / points.length >= C.maximumCompetingSupport
  )
    alignmentFailure('Two substantial scene planes have different motion. Possible parallax.', [
      diagnostics,
    ])
  const candidate = { ...estimate, matrix: fit.matrix, diagnostics }
  // The correspondences are absolute source/reference coordinates. Preserve
  // this fitted training evidence; subsequent native patches are independent.
  fittedEvidence.set(candidate, { reference, source, key: hypothesisKey(candidate), measurements })
  return candidate
}

/** Competing local motions are separated using training data, before held-out checks. */
export async function validateMotionNative(
  reference: PreparedSource,
  source: PreparedSource,
  t: MergeTransform,
  checkpoint: () => Promise<void>,
): Promise<MergeTransform> {
  const start = performance.now(),
    cv = await openCv()
  const fitted = fittedEvidence.get(t),
    { points, matches } =
      fitted?.reference === reference && fitted.source === source && fitted.key === hypothesisKey(t)
        ? fitted.measurements
        : await motionMeasurements(reference, source, t, checkpoint)
  const { width: w, height: h } = reference
  const consensus =
    t.diagnostics!.method === 'ecc-patches' ? C.eccConsensusPixels : C.motionConsensusPixels
  const trainingGrid =
      t.diagnostics!.method === 'ecc-patches' ? C.eccRefinementGrid : C.motionTrainingGrid,
    validationGrid =
      t.diagnostics!.method === 'ecc-patches' ? C.eccValidationGrid : C.motionValidationGrid
  // Detect two dominant rigid motions before a homography can bend between
  // them and mask the middle of the scene as if it were a moving object.
  await rejectCompetingPlanes(points, t)
  const candidates: MergeMatrix[] = []
  // Full-frame and peripheral samples prevent a large central subject from
  // exhausting RANSAC's hypotheses. Neither subset assumes a subject location.
  for (const peripheral of [false, true]) {
    let remaining = points.filter(
      (p) => !peripheral || p.x < w * 0.2 || p.x > w * 0.8 || p.y < h * 0.2 || p.y > h * 0.8,
    )
    for (let pass = 0; pass < 4; pass++) {
      await checkpoint()
      const fit = cv.fit(
        remaining.map(coordinates),
        t.diagnostics!.model === 'projective',
        consensus,
      )
      if (!fit) break
      remaining = remaining.filter((_, i) => !fit.inliers[i])
      try {
        validateGeometry(fit.matrix, w, h)
      } catch {
        continue
      }
      if (points.filter((p) => residual(fit.matrix, p) <= consensus).length >= C.minimumPatches)
        candidates.push(fit.matrix)
    }
  }
  let best = structuredClone(t.diagnostics!),
    bestAgreement = -1
  best.motionSupport = {
    observations: points.length,
    candidates: candidates.length,
    training: 0,
    heldOut: 0,
  }
  // Prefer broad training support, and avoid repeating equivalent hypotheses.
  const ranked = candidates.sort(
    (a, b) =>
      points.filter((p) => residual(b, p) <= consensus).length -
      points.filter((p) => residual(a, p) <= consensus).length,
  )
  const distinct = ranked.filter(
    (m, i) =>
      !ranked.slice(0, i).some((other) =>
        [
          [0, 0],
          [w - 1, 0],
          [0, h - 1],
          [w - 1, h - 1],
        ].every(([x, y]) => {
          const a = point(m, x, y),
            b = point(other, x, y)
          return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.15
        }),
      ),
  )
  for (let matrix of distinct) {
    await checkpoint()
    if (
      new Set(
        points.filter((p) => residual(matrix, p) <= consensus).map((p) => cell(p.x, p.y, w, h)),
      ).size < C.minimumNativeCells
    )
      continue
    const preview = resizeMatrix(matrix, reference.plane.width / w, reference.plane.height / h)
    const evidence =
      t.diagnostics!.method === 'ecc-patches' ? points.map((p) => [p.x, p.y, p.sx, p.sy]) : matches
    const support = evidence.filter((p) => {
      if (t.diagnostics!.method === 'ecc-patches') {
        const q = point(matrix, p[0], p[1])
        return Math.hypot(q[0] - p[2], q[1] - p[3]) <= consensus
      }
      const q = point(preview, p[0], p[1])
      return Math.hypot(q[0] - p[2], q[1] - p[3]) <= C.ransacPixels
    })
    const cells = new Set(
      support.map((p) =>
        cell(
          p[0],
          p[1],
          t.diagnostics!.method === 'ecc-patches' ? w : reference.plane.width,
          t.diagnostics!.method === 'ecc-patches' ? h : reference.plane.height,
        ),
      ),
    )
    if (support.length < C.minimumInliers || cells.size < C.minimumCells) {
      if (bestAgreement < 0)
        best.reason = `Motion training has ${support.length} coherent observations across ${cells.size} cells; 30 across six are required.`
      continue
    }
    const outliers = points.filter((p) => residual(matrix, p) > consensus)
    const alternative = cv.fit(outliers.map(coordinates), true, C.motionConsensusPixels)
    // Two coherent, substantial scene planes are ambiguous. Do not hide
    // unmodelled parallax by calling the less convenient plane subject motion.
    if (
      alternative &&
      outliers.filter((p) => residual(alternative.matrix, p) <= C.motionConsensusPixels).length /
        points.length >=
        C.maximumCompetingSupport
    )
      continue
    const fieldMatrix = [...matrix] as MergeMatrix
    const stable = (x: number, y: number) => {
      const nearest = points
        .map((p) => ({ p, distance: Math.hypot((p.x - x) / w, (p.y - y) / h) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3)
      return (
        nearest.length === 3 &&
        nearest.every(({ p }) => residual(fieldMatrix, p) <= C.maximumTileOffsetPixels)
      )
    }
    // Refine camera geometry using fresh training patches in the frozen static
    // field. Held-out validation centers never participate in this fit.
    const frozenStable = stable
    let nativeTraining: Observation[] = []
    for (
      let iteration = 0;
      iteration < (t.diagnostics!.method === 'ecc-patches' ? 3 : 2);
      iteration++
    ) {
      const training = await patches(
        reference,
        source,
        { ...t, matrix },
        trainingGrid,
        0.5,
        checkpoint,
        {
          edge: C.nativePatchEdge,
          validFraction: C.motionValidFraction,
          include: frozenStable,
          coarse: iteration === 0,
        },
      )
      const observations = training
        .filter((p) => p.correlation >= C.motionPatchCorrelation && Math.hypot(p.dx, p.dy) < 8)
        .map((p) => [p.x, p.y, ...point(matrix, p.x + p.dx, p.y + p.dy)])
      nativeTraining = observations.map(([x, y, sx, sy]) => ({ x, y, sx, sy }))
      const fit = cv.fit(observations, t.diagnostics!.model === 'projective', 0.65)
      if (!fit || fit.inliers.filter(Boolean).length < C.minimumPatches) break
      try {
        validateGeometry(fit.matrix, w, h)
        matrix = fit.matrix
      } catch {
        break
      }
    }
    // Smooth bounded camera residuals come only from training observations.
    // Unsupported regions use the reference; competing planes were rejected above.
    const frozenMatrix = [...matrix] as MergeMatrix
    // A poor initial warp can hide a second plane by lowering its patch
    // correlation. Remeasure the full scene after refinement, before exclusions.
    const refinedMeasurements = await motionMeasurements(
      reference,
      source,
      { ...t, matrix: frozenMatrix, tiles: undefined },
      checkpoint,
    )
    await rejectCompetingPlanes(refinedMeasurements.points, t)
    const validationStable = (x: number, y: number) => {
      if (!frozenStable(x, y)) return false
      const nearest = nativeTraining
        .map((p) => ({ p, d: Math.hypot((p.x - x) / w, (p.y - y) / h) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
      return (
        nearest.length === 3 &&
        nearest[0].d < 2 / trainingGrid &&
        nearest.every(({ p }) => {
          const q = warpedPoint({ ...t, matrix: frozenMatrix, tiles }, w, h, p.x, p.y)
          return Math.hypot(q[0] - p.sx, q[1] - p.sy) <= C.nativeAccuracy
        })
      )
    }
    const staticPoints = nativeTraining.filter(
      (p) => residual(frozenMatrix, p) <= C.maximumTileOffsetPixels,
    )
    const tiles = {
      columns: t.diagnostics!.method === 'ecc-patches' ? C.eccTrainingGrid : trainingGrid,
      rows: t.diagnostics!.method === 'ecc-patches' ? C.eccTrainingGrid : trainingGrid,
      width: w,
      height: h,
      offsets: [] as number[],
    }
    for (let y = 0; y < tiles.rows; y++)
      for (let x = 0; x < tiles.columns; x++) {
        const px = ((x + 0.5) * w) / tiles.columns - 0.5,
          py = ((y + 0.5) * h) / tiles.rows - 0.5
        const nearest = staticPoints
          .map((p) => ({ p, d: Math.hypot((p.x - px) / w, (p.y - py) / h) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 4)
        let ox = 0,
          oy = 0,
          total = 0
        for (const { p, d } of nearest) {
          const q = point(matrix, p.x, p.y),
            weight = 1 / Math.max(0.001, d) ** 2
          ox += (p.sx - q[0]) * weight
          oy += (p.sy - q[1]) * weight
          total += weight
        }
        tiles.offsets.push(total ? ox / total : 0, total ? oy / total : 0)
      }
    try {
      validateTransform({ ...t, matrix, tiles }, w, h)
    } catch {
      continue
    }
    // Freeze the exclusion field and tile warp before held-out validation.
    const measured = await patches(
      reference,
      source,
      { ...t, matrix, tiles },
      validationGrid,
      0.5,
      checkpoint,
      {
        edge: C.nativePatchEdge,
        validFraction: C.motionValidFraction,
        include: validationStable,
      },
    )
    const evaluated = measured.filter((p) => p.correlation >= C.motionPatchCorrelation)
    const nativePatches = evaluated.map((p) => ({
      ...p,
      accepted: Math.hypot(p.dx, p.dy) <= C.nativeAccuracy,
    }))
    const consistent = nativePatches.filter((p) => p.accepted)
    const nativeCells = new Set(consistent.map((p) => cell(p.x, p.y, w, h)))
    const agreement = evaluated.length ? consistent.length / evaluated.length : 0
    const diagnostics = {
      ...structuredClone(t.diagnostics!),
      inliers: support.length,
      cells: cells.size,
      nativePatches,
      runtimeMs: t.diagnostics!.runtimeMs + performance.now() - start,
      wasmMemoryBytes: cv.memory(),
      motionSupport: {
        observations: points.length,
        candidates: candidates.length,
        training: nativeTraining.length,
        heldOut: evaluated.length,
      },
    }
    diagnostics.reason =
      consistent.length < C.minimumPatches ||
      nativeCells.size < C.minimumNativeCells ||
      agreement < C.minimumPatchAgreement
        ? `${consistent.length}/${evaluated.length} held-out native patches agree across ${nativeCells.size} cells.`
        : undefined
    if (agreement > bestAgreement) {
      best = diagnostics
      bestAgreement = agreement
    }
    if (
      consistent.length < C.minimumPatches ||
      nativeCells.size < C.minimumNativeCells ||
      agreement < C.minimumPatchAgreement
    )
      continue
    const movingRegions = []
    // Use the same frozen field for deghosting. Entire unsupported cells use
    // the reference; sparse patch-sized rectangles would leave gaps around motion.
    for (let y = 0; y < trainingGrid; y++)
      for (let x = 0; x < trainingGrid; x++) {
        const left = Math.floor((x * w) / trainingGrid),
          top = Math.floor((y * h) / trainingGrid)
        const right = Math.ceil(((x + 1) * w) / trainingGrid),
          bottom = Math.ceil(((y + 1) * h) / trainingGrid)
        if (!validationStable((left + right) / 2, (top + bottom) / 2))
          movingRegions.push({ left, top, width: right - left, height: bottom - top })
      }
    diagnostics.movingRegions = movingRegions
    return { ...t, matrix, tiles, diagnostics }
  }
  alignmentFailure(
    `Inconsistent geometric match: ${best.nativePatches.filter((p) => p.accepted).length}/${best.nativePatches.length} independent static-scene patches agree within 0.5 pixels after motion separation.`,
    [best],
  )
}
