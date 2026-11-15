// Research orchestration only: existing LLF, shared point operations and actual native consumer.
import { createHash } from 'node:crypto'
import { createTextureGpu } from './gpu.mjs'
import { createOrderedPointGpu } from './ordered-point.mjs'
import { consumedPolicy, pointContextIdentity, renderActualPoint } from './ordered-consumer.mjs'

const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const words = (data) => new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)
const digest = (data) =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex')

export function compareRgba(actual, expected, gates, label) {
  check(actual.length === expected.length, `${label}: shape differs`)
  const expected32 = Float32Array.from(expected),
    actualWords = words(actual),
    expectedWords = words(expected32)
  const result = { rgbFailures: 0, wordMismatches: 0, maxAbsoluteError: 0, maxToleranceRatio: 0 }
  for (let i = 0; i < actual.length; i++) {
    check(Number.isFinite(actual[i]), `${label}: nonfinite output`)
    if (i % 4 === 3) {
      if (actualWords[i] !== expectedWords[i]) result.wordMismatches++
      continue
    }
    const error = Math.abs(actual[i] - expected32[i]),
      bound = gates.absolute + gates.relative * Math.abs(expected32[i])
    result.maxAbsoluteError = Math.max(result.maxAbsoluteError, error)
    result.maxToleranceRatio = Math.max(result.maxToleranceRatio, error / bound)
    if (error > bound) result.rgbFailures++
  }
  check(
    result.rgbFailures === 0 && result.wordMismatches === 0,
    `${label}: ${JSON.stringify(result)}`,
  )
  return result
}

function exactRoot(previous, candidate, result, coverage) {
  const p = words(previous),
    t = words(candidate),
    next = words(result)
  let zeroCoveragePixels = 0,
    alphaZeroPixels = 0,
    alphaWords = 0
  for (let i = 0; i < coverage.length; i++) {
    check(coverage[i] >= 0 && coverage[i] <= 1, 'Invalid native coverage')
    check(next[i * 4 + 3] === p[i * 4 + 3], 'Root changed alpha word')
    alphaWords++
    if (coverage[i] === 0) {
      zeroCoveragePixels++
      for (let c = 0; c < 4; c++)
        check(next[i * 4 + c] === p[i * 4 + c], 'Zero-coverage root changed preceding word')
    }
    if (previous[i * 4 + 3] === 0) {
      alphaZeroPixels++
      for (let c = 0; c < 4; c++)
        check(t[i * 4 + c] === p[i * 4 + c], 'Texture changed hidden preceding words')
    }
  }
  return { zeroCoveragePixels, alphaZeroPixels, alphaWords, status: 'passed' }
}

/** Extra unblended candidate is deliberately materialized for this proof and charged.
 * The LLF owner drains before the final root point composite. No production stage is installed.
 */
export async function runOrderedStack(job, signal) {
  const { width, height, domain, maskParameters, amounts, admission, expected, gates } = job
  check(maskParameters.localMasks.length === amounts.length, 'Amounts do not match top-first roots')
  const parentSha256 = digest(job.data),
    gridPolicy = job.gridPolicy ?? 'masked-texture-cropped-stack-v1'
  const lineage = {
    parentSha256,
    gridPolicy,
    amounts: [...amounts],
    context: pointContextIdentity({ ...job, parentSha256, gridPolicy }),
  }
  const point = await createOrderedPointGpu(),
    steps = [],
    textures = [],
    textureCoverage = []
  let current,
    textureJobs = 0,
    adapter = point.adapter
  try {
    const anyTexture = amounts.some(
      (amount, i) => amount !== 0 && maskParameters.localMasks[i].enabled,
    )
    if (!anyTexture) {
      const legacy = await point.legacy(job, signal)
      if (expected)
        compareRgba(legacy.data, expected.expected, gates, `${expected.id}/legacy-prepoint`)
      return {
        ...lineage,
        data: legacy.data,
        coverage: new Float32Array(width * height),
        textureJobs: 0,
        steps,
        adapter,
        mode: 'legacy-only',
        memory: legacy.memory,
      }
    }
    const global = await point.global(job, signal)
    adapter = global.adapter
    current = global.data
    const globalQa = expected
      ? compareRgba(current, expected.expectedGlobal, gates, `${expected.id}/global`)
      : undefined
    const fullCoverage = new Float32Array(width * height).fill(1)
    for (let index = maskParameters.localMasks.length - 1; index >= 0; index--) {
      signal.throwIfAborted()
      const root = maskParameters.localMasks[index],
        amount = amounts[index]
      const wanted = expected?.steps.find((step) => step.rootId === root.id)
      if (
        !root.enabled ||
        (amount === 0 &&
          !Object.values(root.light).some(Boolean) &&
          !Object.values(root.color).some(Boolean))
      ) {
        steps.push({ rootId: root.id, amount, skipped: true })
        continue
      }
      // Coverage is evaluated with the actual shared program before spatial work.
      // For point-only/M0 roots this probe is already the final point result.
      const before = current
      const probe = await point.root(
        { ...job, previous: before, candidate: before, maskIndex: index },
        signal,
      )
      let candidate = before,
        result = probe
      if (amount !== 0 && probe.coverage.some((value) => value > 0)) {
        const texture = await createTextureGpu()
        try {
          const preparation = await texture.prepare(
            {
              data: before,
              width,
              height,
              primaries: domain === 'raster' ? 'srgb' : 'rec2020',
              admission,
            },
            signal,
          )
          const unblended = await texture.apply({ amount, coverage: fullCoverage }, signal)
          candidate = unblended.data
          textureJobs++
          textures.push({ rootId: root.id, preparation })
          adapter = unblended.adapter
        } finally {
          await texture.close()
        }
        result = await point.root({ ...job, previous: before, candidate, maskIndex: index }, signal)
        textureCoverage.push(result.coverage)
      }
      const qa = exactRoot(before, candidate, result.data, result.coverage)
      if (expected) {
        const rootReference = expected.roots.find((item) => item.id === root.id)
        for (let p = 0; p < result.coverage.length; p++) {
          const v = rootReference.coverage[p],
            tolerance = gates.absolute + gates.relative * Math.abs(v)
          check(
            Math.abs(result.coverage[p] - v) <= tolerance,
            `${expected.id}/${root.id}: canonical coverage differs`,
          )
        }
        if (wanted && !wanted.skipped) {
          qa.unblended = compareRgba(
            candidate,
            wanted.expectedUnblended,
            gates,
            `${expected.id}/${root.id}/unblended`,
          )
          qa.composite = compareRgba(
            result.data,
            wanted.expected,
            gates,
            `${expected.id}/${root.id}/single-blend`,
          )
        }
      }
      steps.push({
        rootId: root.id,
        amount,
        skipped: false,
        qa,
        inputSha256: digest(before),
        unblendedSha256: digest(candidate),
        outputSha256: digest(result.data),
        memory: result.memory,
      })
      current = result.data
    }
    const union = textureCoverage.length
      ? await point.union({ ...job, coverages: textureCoverage }, signal)
      : { coverage: new Float32Array(width * height) }
    // Materialization can change rounding outside Texture. Preserve the single-pass
    // shared point prefix there, separately from the actual native rendition guard.
    const legacyPoint = await point.legacy(job, signal)
    const selectedPoint = await point.select(
      {
        ...job,
        legacy: words(legacyPoint.data),
        candidate: words(current),
        coverage: union.coverage,
        alpha: job.data,
        wordsPerPixel: 4,
      },
      signal,
    )
    const workingCompatibility = {
      outsidePixels: 0,
      outsideDifferences: 0,
      alphaZeroPixels: 0,
      alphaZeroDifferences: 0,
      insideCandidateDifferences: 0,
      rawOutsideDifferences: 0,
      baseline: 'single-pass-actual-shared-point-prefix',
      status: 'passed',
    }
    const legacyWords = words(legacyPoint.data),
      rawWords = words(current)
    for (let i = 0; i < width * height; i++) {
      const outside = union.coverage[i] === 0,
        hidden = job.data[i * 4 + 3] === 0
      if (outside) workingCompatibility.outsidePixels++
      if (hidden) workingCompatibility.alphaZeroPixels++
      for (let c = 0; c < 4; c++) {
        const k = i * 4 + c
        if (outside && rawWords[k] !== legacyWords[k]) workingCompatibility.rawOutsideDifferences++
        if (outside && selectedPoint.data[k] !== legacyWords[k])
          workingCompatibility.outsideDifferences++
        if (hidden && selectedPoint.data[k] !== legacyWords[k])
          workingCompatibility.alphaZeroDifferences++
        if (!outside && !hidden && selectedPoint.data[k] !== rawWords[k])
          workingCompatibility.insideCandidateDifferences++
      }
    }
    check(
      workingCompatibility.outsideDifferences === 0 &&
        workingCompatibility.alphaZeroDifferences === 0 &&
        workingCompatibility.insideCandidateDifferences === 0,
      'Shared point-prefix working-word compatibility failed',
    )
    return {
      ...lineage,
      data: new Float32Array(
        selectedPoint.data.buffer,
        selectedPoint.data.byteOffset,
        selectedPoint.data.length,
      ),
      coverage: union.coverage,
      textureJobs,
      steps,
      textures,
      globalQa,
      workingCompatibility,
      workingEvidence: expected ? { legacy: legacyPoint.data, raw: current } : undefined,
      adapter,
      mode: textureJobs ? 'ordered' : 'legacy-compatible-zero-coverage',
    }
  } finally {
    await point.close()
  }
}

export async function renderCompatible(job, signal) {
  const { data, stack, width, height, admission } = job
  const parentSha256 = digest(data),
    gridPolicy = job.gridPolicy ?? 'masked-texture-cropped-stack-v1'
  const boundJob = { ...job, parentSha256, gridPolicy }
  check(
    stack.parentSha256 === parentSha256 &&
      stack.gridPolicy === gridPolicy &&
      stack.context === pointContextIdentity(boundJob),
    'Prepared stack parent/grid/point context mismatch; refuse stale consumption',
  )
  const legacy = await renderActualPoint(boundJob, signal)
  let candidate = legacy
  if (stack.textureJobs) {
    const consumed = {
      policy: consumedPolicy,
      context: pointContextIdentity(boundJob),
      sha256: digest(stack.data),
    }
    candidate = await renderActualPoint({ ...boundJob, data: stack.data, consumed }, signal)
  }
  const point = await createOrderedPointGpu()
  try {
    const selected = await point.select(
      {
        width,
        height,
        admission,
        legacy: legacy.data,
        candidate: candidate.data,
        coverage: stack.coverage,
        alpha: data,
        wordsPerPixel: legacy.wordsPerPixel,
      },
      signal,
    )
    const format = job.packed ? 'rgba8' : 'float32-sdr',
      counters = {
        id: job.id ?? 'native-consumer',
        format,
        outsideUnionPixels: 0,
        outsideUnionDifferences: 0,
        alphaZeroPixels: 0,
        alphaZeroDifferences: 0,
        allZeroPixels: 0,
        allZeroDifferences: 0,
        insideUnionCandidateDifferences: 0,
        changedInsideUnionPixels: 0,
      }
    let selectedPixels = 0
    for (let i = 0; i < width * height; i++) {
      const outside = stack.coverage[i] === 0,
        hidden = data[i * 4 + 3] === 0
      if (outside) counters.outsideUnionPixels++
      if (hidden) counters.alphaZeroPixels++
      if (!stack.textureJobs) counters.allZeroPixels++
      let differs = false
      for (let c = 0; c < legacy.wordsPerPixel; c++)
        if (
          selected.data[i * legacy.wordsPerPixel + c] !== legacy.data[i * legacy.wordsPerPixel + c]
        )
          differs = true
      if (!outside && !hidden) {
        if (differs) counters.changedInsideUnionPixels++
        for (let c = 0; c < legacy.wordsPerPixel; c++)
          if (
            selected.data[i * legacy.wordsPerPixel + c] !==
            candidate.data[i * legacy.wordsPerPixel + c]
          )
            counters.insideUnionCandidateDifferences++
      }
      if (differs) {
        selectedPixels++
        if (outside) counters.outsideUnionDifferences++
        if (hidden) counters.alphaZeroDifferences++
        if (!stack.textureJobs) counters.allZeroDifferences++
      }
    }
    check(
      counters.outsideUnionDifferences === 0 &&
        counters.alphaZeroDifferences === 0 &&
        counters.allZeroDifferences === 0 &&
        counters.insideUnionCandidateDifferences === 0,
      'Actual native legacy compatibility failed',
    )
    return {
      data: selected.data,
      legacyData: legacy.data,
      candidateData: candidate.data,
      adapter: legacy.adapter,
      legacyChecks: [counters],
      wordsPerPixel: legacy.wordsPerPixel,
      selectedPixels,
      receipt: {
        legacy: legacy.receipt,
        consumed: candidate.receipt,
        selection: {
          memory: selected.memory,
          legacyPixels: selected.legacyPixels,
          selectedPixels: selected.selectedPixels,
        },
        legacyPeakBytes: legacy.peakBytes,
        candidatePeakBytes: candidate.peakBytes,
      },
    }
  } finally {
    await point.close()
  }
}
