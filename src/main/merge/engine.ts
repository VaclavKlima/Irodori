import { identityTransform } from './alignment'
import { AlignmentPool } from './alignment-pool'
import { resizedTransform, validateTransform, multiply, inverse } from './matrix'
import { band, bandData, resetMergeReads, mergeReadBytes } from './sampling'
import { mergeReadMeasurements } from './read-metrics'
import { loadPreparation, savePreparation } from './preparation-cache'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { accumulateGpu } from './gpu-accumulation'
import { gpuOutput } from './gpu-output'
import { coverageGpu } from './gpu-coverage'
import { excludedBand, excludedCenters, sourceExclusionBand, taperExclusions } from './exclusions'
import { createHash } from 'node:crypto'
import { open, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { prepareSource, prepareReferenceFallback, type PreparedSource } from './prepare'
import { mergePreparation } from './preparation-policy'
import { estimateBracketExposure } from './exposure'
import {
  coverage,
  translationCoverage,
  expandMask,
  motionDifferent,
  noiseVariance,
  refineExposure,
} from './math'
import {
  MERGE_VERSION,
  MERGE_PIPELINE,
  ALIGNMENT_CONSTANTS,
  BRK_EXPOSURE_POLICY,
  MergeError,
  mergeFailure,
  MERGE_LIMITS,
  exposure,
  type MergeSource,
  type MergeSettings,
  type MergeRecipe,
  type MergeTransform,
  type MergeMeasurements,
  type ExposureDiagnostics,
} from '../../shared/merge'
import {
  HDR_SOURCE_VERSION,
  hdrWhiteBalance,
  outputHdr,
  encodeHdr,
  SDR_TARGET,
  luminance,
  type HdrWorkingAsset,
} from '../../shared/hdr'

export interface MergeJob {
  directory: string
  paths: string[]
  sources: MergeSource[]
  settings: MergeSettings
  output: string
  recipe?: MergeRecipe
  comparisons?: boolean
}
export interface MergeResult {
  asset: HdrWorkingAsset
  recipe: MergeRecipe
  runtimeMs: number
  peakMemoryBytes: number
  measurements: MergeMeasurements
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const reviewPngCompressionLevel = { result: 0, reference: 0, overlay: 1 } as const
const send = (value: unknown) => {
  if (process.connected) process.send?.(value)
}
let paused = false
let activeAlignment: AlignmentPool | undefined
export function pauseMerge(value: boolean) {
  paused = value
  activeAlignment?.pause(value)
}
function displayLinear(pixels: Float32Array) {
  const bytes = Buffer.alloc(pixels.length)
  for (let k = 0; k < pixels.length; k += 4) {
    const rgb = outputHdr([pixels[k], pixels[k + 1], pixels[k + 2]], SDR_TARGET).rgb
    for (let c = 0; c < 3; c++) bytes[k + c] = Math.round(encodeHdr(rgb[c]) * 255)
    bytes[k + 3] = Math.round(pixels[k + 3] * 255)
  }
  return bytes
}
async function checkpoint() {
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (paused) await new Promise((resolve) => setTimeout(resolve, 25))
}

export async function runMerge(job: MergeJob): Promise<MergeResult> {
  const gpu = new RawGpuRenderer(),
    alignment = new AlignmentPool()
  const measurements: MergeMeasurements = {
      stages: {
        decoding: 0,
        preparation: 0,
        matching: 0,
        nativeValidation: 0,
        accumulation: 0,
        output: 0,
        publication: 0,
      },
      preparation: [],
      accumulation: { backend: 'cpu' },
      attempts: [],
      disk: { readBytes: 0, writtenBytes: 0 },
      peak: { workerBytes: 0, gpuBytes: 0, wasmBytes: 0 },
      runtimeMs: 0,
    },
    start = performance.now()
  activeAlignment = alignment
  alignment.pause(paused)
  try {
    return await runMergeInternal(job, gpu, alignment, measurements)
  } catch (error) {
    const failure = mergeFailure(error)
    measurements.reads = structuredClone(mergeReadMeasurements())
    measurements.runtimeMs = performance.now() - start
    measurements.peak.workerBytes = process.resourceUsage().maxRSS * 1024
    measurements.peak.wasmBytes = Math.max(
      alignment.wasmBytes,
      ...failure.diagnostics.map((d) => d.wasmMemoryBytes),
    )
    failure.measurements = measurements
    throw new MergeError(failure)
  } finally {
    gpu.close()
    await alignment.close()
    activeAlignment = undefined
  }
}
async function runMergeInternal(
  job: MergeJob,
  gpu: RawGpuRenderer,
  alignment: AlignmentPool,
  measurements: MergeMeasurements,
): Promise<MergeResult> {
  const start = performance.now(),
    { directory, settings, sources, output } = job
  resetMergeReads()
  await mkdir(output, { recursive: true })
  const referenceIndex = sources.findIndex((s) => s.photo.id === settings.referenceId),
    reference = sources[referenceIndex]
  const prepared: PreparedSource[] = []
  let fallbackReference: PreparedSource | undefined
  const probe = { runtimeMs: 0, openingMs: 0, opens: 0 }
  measurements.preparationProbe = probe
  const preparation = await mergePreparation(job.paths, sources, settings, checkpoint, probe)
  const registrationKey = JSON.stringify({
    pipeline: MERGE_PIPELINE,
    alignment: ALIGNMENT_CONSTANTS,
    exposure: BRK_EXPOSURE_POLICY,
    reference: settings.referenceId,
    autoAlign: settings.autoAlign,
    preparation,
    sources: sources.map((s) => ({
      id: s.photo.id,
      capture: s.capture,
      captureMetadata: s.captureMetadata,
      lens: s.metadata.lensProfile.identity,
      wb: s.metadata.whiteBalance?.asShotGains,
    })),
  })
  let cachedRegistration: { key: string; sha256: string; data: string } | undefined
  try {
    const bytes = await readFile(join(directory, 'registration.json'), 'utf8')
    measurements.disk.readBytes += Buffer.byteLength(bytes)
    cachedRegistration = JSON.parse(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (
    cachedRegistration &&
    (cachedRegistration.key !== registrationKey ||
      hash(Buffer.from(cachedRegistration.data)) !== cachedRegistration.sha256)
  )
    cachedRegistration = undefined
  const early = new Map<
    number,
    Promise<{ result?: Awaited<ReturnType<AlignmentPool['run']>>; failure?: unknown }>
  >()
  const preparationOrder = [
    referenceIndex,
    ...sources.map((_, i) => i).filter((i) => i !== referenceIndex),
  ]
  for (const i of preparationOrder) {
    await checkpoint()
    send({ phase: 'Decoding originals', completed: i, total: sources.length })
    const metadataPath = join(directory, `source-${i}.json`)
    const identity = hash(
      Buffer.from(
        JSON.stringify({
          policy: MERGE_PIPELINE.preparation,
          cameraRegistration: ALIGNMENT_CONSTANTS.cameraRegistrationPolicy,
          id: sources[i].photo.id,
          lens: (preparation ? sources[i] : reference).metadata.lensProfile.identity,
          wb: reference.metadata.whiteBalance?.asShotGains,
          preparation,
        }),
      ),
    )
    const cacheLookup = performance.now()
    let p = await loadPreparation(
      directory,
      i,
      settings.referenceId,
      (bytes) => {
        measurements.disk.readBytes += bytes
      },
      identity,
    )
    const cacheLookupMs = performance.now() - cacheLookup,
      reused = !!p
    let cacheWriteMs = 0
    if (!p) {
      // Cancelled decoding can leave an incomplete, unindexed scratch frame.
      await rm(join(directory, `source-${i}.f32`), { force: true })
      await rm(join(directory, `source-${i}.camera.f32`), { force: true })
      await rm(metadataPath, { force: true })
      p = await prepareSource(
        job.paths[i],
        directory,
        i,
        sources[i],
        reference,
        gpu,
        checkpoint,
        preparation,
      )
      p.identity = identity
      measurements.disk.readBytes +=
        (await stat(job.paths[i])).size * (p.measurement?.fallback ? 2 : 1)
      const cacheWrite = performance.now()
      measurements.disk.writtenBytes += await savePreparation(directory, i, settings.referenceId, p)
      cacheWriteMs = performance.now() - cacheWrite
      measurements.disk.writtenBytes +=
        p.width * p.height * 16 * (p.cameraRegistration ? 2 : 1) +
        (p.sensor ? p.sensor.sensor.bytes + p.sensor.alpha.bytes + p.sensor.lens.bytes : 0)
    }
    if (
      p.path !== join(directory, `source-${i}.f32`) ||
      !Number.isSafeInteger(p.width) ||
      !Number.isSafeInteger(p.height) ||
      p.width < 1 ||
      p.height < 1 ||
      p.width * p.height > MERGE_LIMITS.maxPixels ||
      !Number.isSafeInteger(p.plane.width) ||
      !Number.isSafeInteger(p.plane.height) ||
      p.plane.width < 1 ||
      p.plane.height < 1 ||
      Math.max(p.plane.width, p.plane.height) > MERGE_LIMITS.previewEdge ||
      p.plane.data.length !== p.plane.width * p.plane.height ||
      !p.plane.data.every(Number.isFinite) ||
      (p.plane.mask &&
        (p.plane.mask.length !== p.plane.data.length ||
          !p.plane.mask.every((v) => v === 0 || v === 255)))
    )
      throw new Error('Invalid source preparation.')
    prepared[i] = p
    if (i === referenceIndex && preparation && p.normalization.sourceSaturation?.saturatedSites) {
      const safeDirectory = join(directory, 'reference-fallback'),
        safeIdentity = hash(
          Buffer.from(JSON.stringify({ identity, policy: MERGE_PIPELINE.referenceFallback })),
        )
      await mkdir(safeDirectory, { recursive: true })
      fallbackReference = await loadPreparation(
        safeDirectory,
        0,
        settings.referenceId,
        (bytes) => {
          measurements.disk.readBytes += bytes
        },
        safeIdentity,
      )
      const reusedFallback = !!fallbackReference
      if (!fallbackReference) {
        await rm(join(safeDirectory, 'source-0.f32'), { force: true })
        await rm(join(safeDirectory, 'source-0.json'), { force: true })
        fallbackReference = await prepareReferenceFallback(
          job.paths[i],
          safeDirectory,
          0,
          sources[i],
          reference,
          checkpoint,
          preparation,
        )
        fallbackReference.identity = safeIdentity
        measurements.disk.readBytes += (await stat(job.paths[i])).size
        measurements.disk.writtenBytes += await savePreparation(
          safeDirectory,
          0,
          settings.referenceId,
          fallbackReference,
        )
        measurements.disk.writtenBytes += p.width * p.height * 16
      }
      if (fallbackReference.width !== p.width || fallbackReference.height !== p.height)
        throw new Error('Highlight fallback reference dimensions differ.')
      measurements.referenceFallback = {
        backend: 'cpu',
        reused: reusedFallback,
        decodingMs: reusedFallback ? 0 : (fallbackReference.measurement?.decodingMs ?? 0),
        preparationMs: reusedFallback ? 0 : (fallbackReference.measurement?.preparationMs ?? 0),
        decoder: reusedFallback ? undefined : fallbackReference.measurement?.decoder,
        work: reusedFallback ? undefined : fallbackReference.measurement?.work,
      }
    }
    if (i !== referenceIndex && settings.autoAlign && !job.recipe && !cachedRegistration)
      early.set(
        i,
        alignment
          .run(
            [settings.referenceId, prepared[referenceIndex]],
            [settings.referenceId, prepared[referenceIndex]],
            [sources[i].photo.id, p],
            identityTransform(),
          )
          .then(
            (result) => ({ result }),
            (failure) => ({ failure }),
          ),
      )
    const m: MergeMeasurements['preparation'][number] = {
      ...(p.measurement ?? { backend: 'cpu' as const, decodingMs: 0, preparationMs: 0 }),
      reused,
      cacheLookupMs,
      cacheWriteMs,
    }
    if (reused) {
      m.decodingMs = 0
      m.preparationMs = 0
      m.work = undefined
      m.gpu = undefined
      m.decoder = undefined
    }
    measurements.preparation[i] = m
    measurements.stages.decoding += m.decodingMs
    measurements.stages.preparation += m.preparationMs
    measurements.peak.gpuBytes = Math.max(measurements.peak.gpuBytes, p.gpuBytes ?? 0)
  }
  const ref = prepared[referenceIndex]
  measurements.stages.decoding += measurements.referenceFallback?.decodingMs ?? 0
  measurements.stages.preparation += measurements.referenceFallback?.preparationMs ?? 0
  const { width, height } = ref
  if (prepared.some((p) => p.width !== width || p.height !== height))
    throw new Error('Prepared native dimensions differ.')
  send({ phase: 'Aligning and checking exposures', completed: 0, total: sources.length })
  const transforms: MergeTransform[] = [],
    scales: number[] = [],
    photometry: (ExposureDiagnostics | undefined)[] = []
  const measureBracket = (i: number, j: number) => {
    const a = prepared[j],
      b = prepared[i],
      excludedA = excludedCenters(transforms[j], a.plane.width, a.plane.height, width, height),
      excludedB = excludedCenters(transforms[i], a.plane.width, a.plane.height, width, height),
      measured = estimateBracketExposure(
        a.plane,
        b.plane,
        resizedTransform(transforms[i], width, height, a.plane.width, a.plane.height),
        exposure(sources[i].capture) / exposure(sources[j].capture),
        (x, y) => !!(excludedA[y * a.plane.width + x] || excludedB[y * a.plane.width + x]),
        j === referenceIndex
          ? undefined
          : resizedTransform(transforms[j], width, height, a.plane.width, a.plane.height),
      )
    photometry[i] = { ...measured.diagnostics, referenceId: sources[j].photo.id }
    if (measured.excludedRegions.length) {
      const t = transforms[i]
      t.diagnostics ??= {
        algorithm: ALIGNMENT_CONSTANTS.version,
        model: 'identity',
        matches: 0,
        inliers: 0,
        cells: 0,
        nativePatches: [],
        movingRegions: [],
        runtimeMs: 0,
        wasmMemoryBytes: 0,
      }
      t.diagnostics.movingRegions.push(
        ...measured.excludedRegions.map((r) => ({
          left: (r.left * width) / a.plane.width,
          top: (r.top * height) / a.plane.height,
          width: (r.width * width) / a.plane.width,
          height: (r.height * height) / a.plane.height,
        })),
      )
    }
    return measured.scale
  }
  const order = sources
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Math.abs(Math.log2(exposure(sources[a].capture) / exposure(reference.capture))) -
        Math.abs(Math.log2(exposure(sources[b].capture) / exposure(reference.capture))),
    )
  if (cachedRegistration && !job.recipe) {
    const recorded = JSON.parse(cachedRegistration.data) as {
      transforms: MergeTransform[]
      scales: number[]
      checksums: string[][]
      photometry?: (ExposureDiagnostics | undefined)[]
    }
    if (
      JSON.stringify(recorded.checksums) === JSON.stringify(prepared.map((p) => p.strips)) &&
      recorded.transforms.length === sources.length &&
      recorded.scales.length === sources.length &&
      recorded.scales.every((v) => Number.isFinite(v) && v > 0)
    ) {
      for (let i = 0; i < sources.length; i++) {
        validateTransform(recorded.transforms[i], width, height)
        transforms[i] = recorded.transforms[i]
        scales[i] = recorded.scales[i]
        photometry[i] = recorded.photometry?.[i]
      }
    }
  }
  const pendingFailures = new Map<number, MergeError>()
  const attempted = new Set<string>()
  for (let pass = 0; pass < sources.length; pass++) {
    let progressed = false
    for (const i of order) {
      if (transforms[i] && scales[i]) continue
      await checkpoint()
      if (job.recipe) {
        const recorded = job.recipe.sources[i]
        if (
          job.recipe.version !== MERGE_VERSION ||
          JSON.stringify(job.recipe.pipeline) !== JSON.stringify(MERGE_PIPELINE) ||
          JSON.stringify(job.recipe.constants) !== JSON.stringify(MERGE_LIMITS) ||
          JSON.stringify(job.recipe.alignment) !== JSON.stringify(ALIGNMENT_CONSTANTS) ||
          JSON.stringify(job.recipe.settings) !== JSON.stringify(settings) ||
          JSON.stringify(job.recipe.preparation) !== JSON.stringify(preparation) ||
          job.recipe.width !== width ||
          job.recipe.height !== height ||
          recorded?.id !== sources[i].photo.id ||
          recorded.decoder !== prepared[i].decoder ||
          recorded.cameraProfile !== prepared[i].cameraProfile ||
          recorded.lensIdentity !== sources[i].metadata.lensProfile.identity ||
          !Number.isFinite(recorded.scale) ||
          recorded.scale <= 0
        )
          throw new Error('Recipe is incompatible with these sources or algorithms.')
        const t = recorded.transform
        if (!t.matrix) throw new Error('Missing recorded matrix.')
        validateTransform(t, width, height)
        scales[i] = recorded.scale
        photometry[i] = recorded.photometry
        transforms[i] = structuredClone(t)
        progressed = true
        continue
      }
      if (i === referenceIndex || !settings.autoAlign) transforms[i] = identityTransform()
      else {
        const neighbors = order
          .filter((j) => j !== i && transforms[j] && !attempted.has(`${j}:${i}`))
          .sort(
            (a, b) =>
              (early.has(i) ? Number(b === referenceIndex) - Number(a === referenceIndex) : 0) ||
              Math.abs(Math.log2(exposure(sources[a].capture) / exposure(sources[i].capture))) -
                Math.abs(Math.log2(exposure(sources[b].capture) / exposure(sources[i].capture))),
          )
        const failures: import('../../shared/merge').MergeFailure[] = []
        for (const neighbor of neighbors) {
          if (Array.from(attempted).filter((key) => key.endsWith(`:${i}`)).length >= 3) break
          attempted.add(`${neighbor}:${i}`)
          const attemptStart = performance.now(),
            attempt: MergeMeasurements['attempts'][number] = {
              sourceId: sources[i].photo.id,
              referenceId: sources[neighbor].photo.id,
              success: false,
              runtimeMs: 0,
            }
          measurements.attempts.push(attempt)
          let workerRuntime: number | undefined
          try {
            const pending = neighbor === referenceIndex ? early.get(i) : undefined
            const precomputed = pending ? await pending : undefined
            if (precomputed?.failure) throw precomputed.failure
            const result =
              precomputed?.result ??
              (await alignment.run(
                [settings.referenceId, ref],
                [sources[neighbor].photo.id, prepared[neighbor]],
                [sources[i].photo.id, prepared[i]],
                transforms[neighbor],
              ))
            measurements.stages.matching += result.timings.matching
            measurements.stages.nativeValidation += result.timings.nativeValidation
            measurements.disk.readBytes += result.readBytes
            workerRuntime = result.runtimeMs
            attempt.patches = result.patches
            attempt.lane = result.lane
            attempt.queuedMs = result.queuedMs
            attempt.reads = result.reads
            attempt.diagnostics = result.diagnostics
            transforms[i] = result.transform
            if (neighbor !== referenceIndex)
              transforms[i].diagnostics!.via = sources[neighbor].photo.id
            attempt.success = true
            break
          } catch (error) {
            const work = error as {
              timings?: { matching: number; nativeValidation: number }
              readBytes?: number
              runtimeMs?: number
              patches?: MergeMeasurements['attempts'][number]['patches']
              lane?: number
              queuedMs?: number
              reads?: MergeMeasurements['reads']
            }
            measurements.stages.matching += work.timings?.matching ?? 0
            measurements.stages.nativeValidation += work.timings?.nativeValidation ?? 0
            measurements.disk.readBytes += work.readBytes ?? 0
            workerRuntime = work.runtimeMs
            attempt.patches = work.patches
            attempt.lane = work.lane
            attempt.queuedMs = work.queuedMs
            attempt.reads = work.reads
            const failure = mergeFailure(error)
            attempt.diagnostics = failure.diagnostics
            attempt.reason = failure.message
            failures.push(failure)
          } finally {
            attempt.runtimeMs = workerRuntime ?? performance.now() - attemptStart
            if (neighbor === referenceIndex && early.has(i)) {
              const work = await early.get(i)!
              const completed = work.result ?? (work.failure as { runtimeMs?: number })
              if (completed?.runtimeMs !== undefined) attempt.runtimeMs = completed.runtimeMs
            }
          }
        }
        if (!transforms[i]) {
          const last = failures.at(-1)
          if (failures.length || !pendingFailures.has(i))
            pendingFailures.set(
              i,
              new MergeError({
                code: 'alignment',
                message: `${sources[i].photo.filename}: ${last?.message ?? 'No consistent alignment path.'}`,
                filenames: [reference.photo.filename, sources[i].photo.filename],
                diagnostics: [
                  ...(pendingFailures.get(i)?.failure.diagnostics ?? []),
                  ...failures.flatMap((f) => f.diagnostics),
                ],
              }),
            )
          continue
        }
      }
      const exposureStart = performance.now()
      if (i === referenceIndex) scales[i] = 1
      else {
        try {
          const small = resizedTransform(
            transforms[i],
            width,
            height,
            ref.plane.width,
            ref.plane.height,
          )
          const excluded = excludedCenters(
            transforms[i],
            ref.plane.width,
            ref.plane.height,
            width,
            height,
          )
          scales[i] = preparation
            ? measureBracket(i, referenceIndex)
            : refineExposure(
                ref.plane,
                prepared[i].plane,
                small,
                exposure(sources[i].capture) / exposure(reference.capture),
                (x, y) => !!excluded[y * ref.plane.width + x],
                !!preparation &&
                  !!ref.normalization.sourceSaturation &&
                  !!prepared[i].normalization.sourceSaturation,
              )
        } catch (error) {
          // Exposure extremes can connect through an already validated neighboring exposure.
          let connected = false
          for (const j of order.filter((j) => j !== i && scales[j])) {
            try {
              const relative = {
                ...transforms[i],
                matrix: multiply(transforms[i].matrix!, inverse(transforms[j].matrix!)),
              }
              const small = resizedTransform(
                relative,
                width,
                height,
                ref.plane.width,
                ref.plane.height,
              )
              scales[i] =
                scales[j] *
                (preparation
                  ? measureBracket(i, j)
                  : refineExposure(
                      prepared[j].plane,
                      prepared[i].plane,
                      small,
                      exposure(sources[i].capture) / exposure(sources[j].capture),
                      undefined,
                      !!preparation &&
                        !!prepared[j].normalization.sourceSaturation &&
                        !!prepared[i].normalization.sourceSaturation,
                    ))
              connected = true
              break
            } catch {
              /* Try the next verified overlap. */
            }
          }
          if (!connected)
            throw new MergeError({
              code: 'exposure',
              message: `${sources[i].photo.filename}: ${(error as Error).message}`,
              filenames: [sources[i].photo.filename],
              diagnostics: transforms[i].diagnostics ? [transforms[i].diagnostics!] : [],
            })
        }
      }
      measurements.stages.nativeValidation += performance.now() - exposureStart
      progressed = true
    }
    if (order.every((i) => transforms[i] && scales[i])) break
    if (!progressed)
      throw pendingFailures.values().next().value ?? new Error('Disconnected alignment graph.')
  }
  if (order.some((i) => !transforms[i] || !scales[i]))
    throw pendingFailures.values().next().value ?? new Error('Disconnected alignment graph.')
  if (
    settings.mode === 'noise' &&
    Math.log2(Math.max(...scales) / Math.min(...scales)) > MERGE_LIMITS.noiseSpreadEv
  )
    throw new Error('Measured exposures differ by more than 0.1 EV.')
  const registrationData = JSON.stringify({
    transforms,
    scales,
    photometry,
    checksums: prepared.map((p) => p.strips),
  })
  const registrationJson = JSON.stringify({
    key: registrationKey,
    sha256: hash(Buffer.from(registrationData)),
    data: registrationData,
  })
  measurements.disk.writtenBytes += Buffer.byteLength(registrationJson)
  await writeFile(join(directory, 'registration.json'), registrationJson)
  const coverageStart = performance.now()
  let common: ReturnType<typeof coverage>
  try {
    const analytic = translationCoverage(width, height, transforms)
    if (analytic) {
      common = analytic
      measurements.coverage = { backend: 'cpu' }
    } else if (process.env.LUMA_MERGE_BACKEND !== 'cpu') {
      try {
        const checked = await coverageGpu(gpu, width, height, transforms, checkpoint)
        common = checked
        measurements.coverage = { backend: 'gpu' }
        measurements.peak.gpuBytes = Math.max(measurements.peak.gpuBytes, checked.peakBytes)
      } catch (error) {
        measurements.coverage = { backend: 'cpu', fallback: mergeFailure(error).message }
        common = coverage(width, height, transforms)
      }
    } else {
      measurements.coverage = { backend: 'cpu' }
      common = coverage(width, height, transforms)
    }
  } finally {
    measurements.stages.nativeValidation += performance.now() - coverageStart
  }
  const crop = settings.autoCrop ? common.crop : { left: 0, top: 0, width, height }
  const nativeGeometry = { width, height, crop, transforms: transforms.map((t) => ({ ...t })) }
  const motion = new Uint8Array(width * height)
  if (
    settings.deghost &&
    settings.strength > 0 &&
    transforms.every(
      (t, i) => i === referenceIndex || (t.diagnostics?.movingRegions?.length ?? 0) > 0,
    )
  ) {
    // Uncertainty in one source must not discard another independently validated source.
    for (let top = 0; top < height; top += 256) {
      const rows = Math.min(256, height - top),
        unsupported = new Uint8Array(width * rows).fill(1)
      for (let s = 0; s < transforms.length; s++) {
        if (s === referenceIndex) continue
        const excluded = excludedBand(
          transforms[s],
          width,
          height,
          nativeGeometry.width,
          nativeGeometry.height,
          top,
          rows,
        )
        for (let k = 0; k < unsupported.length; k++) unsupported[k] &= excluded[k]
      }
      motion.set(unsupported, top * width)
    }
  }
  const mergedPath = join(output, 'accumulation.f32'),
    referencePath = join(output, 'reference.f32')
  const accumulationStart = performance.now()
  let usedGpu = false
  if (process.env.LUMA_MERGE_BACKEND !== 'cpu') {
    try {
      // Commit GPU motion only after every batch and validation scope succeeds.
      // A partial device failure must not contaminate the independent CPU fallback.
      const gpuMotion = motion.slice()
      const result = await accumulateGpu(
        gpu,
        prepared,
        sources,
        transforms,
        scales,
        settings,
        common.mask,
        gpuMotion,
        nativeGeometry,
        output,
        checkpoint,
        preparation ? BRK_EXPOSURE_POLICY.sourceExclusionFeatherPixels : 0,
      )
      measurements.accumulation = {
        backend: 'gpu',
        kernel: result.kernel,
        referenceReused: result.referenceReused,
        adapter: result.adapter,
        batches: result.batches,
      }
      measurements.peak.gpuBytes = Math.max(measurements.peak.gpuBytes, result.peakBytes)
      motion.set(gpuMotion)
      usedGpu = true
    } catch (error) {
      measurements.accumulation.fallback = mergeFailure(error).message
      gpu.close()
      for (const path of [mergedPath, referencePath]) {
        const partial = await stat(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        })
        // A linked immutable reference transfers no pixel bytes.
        if (partial && (path !== referencePath || partial.nlink === 1))
          measurements.disk.writtenBytes += partial.size
      }
      await rm(mergedPath, { force: true })
      await rm(referencePath, { force: true })
    }
  }
  if (!usedGpu) {
    const temporary = await open(mergedPath, 'wx'),
      referenceFile = await open(referencePath, 'wx')
    try {
      for (let top = 0; top < height; top += 64) {
        await checkpoint()
        send({ phase: 'Combining linear samples', completed: top, total: height })
        const rows = Math.min(64, height - top),
          count = width * rows,
          refPixels = new Float32Array(count * 4),
          sum = new Float64Array(count * 4)
        const refBand = await band(ref, transforms[referenceIndex], top, rows),
          pixel = [0, 0, 0, 0]
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < width; x++) {
            refBand(x, top + y, pixel)
            refPixels.set(pixel, (y * width + x) * 4)
          }
        for (let s = 0; s < sources.length; s++) {
          const get = await band(prepared[s], transforms[s], top, rows),
            scale = scales[s],
            excluded =
              settings.deghost && settings.strength > 0 && s !== referenceIndex
                ? sourceExclusionBand(
                    transforms[s],
                    width,
                    height,
                    nativeGeometry.width,
                    nativeGeometry.height,
                    top,
                    rows,
                    preparation ? BRK_EXPOSURE_POLICY.sourceExclusionFeatherPixels : 0,
                  )
                : undefined
          for (let y = 0; y < rows; y++)
            for (let x = 0; x < width; x++) {
              const k = y * width + x,
                i = k * 4
              const confidence = excluded
                ? preparation
                  ? 1 - excluded[k] / 255
                  : 1 - excluded[k]
                : 1
              if (!confidence || !common.mask[(top + y) * width + x] || !get(x, top + y, pixel))
                continue
              const rawY = luminance(pixel),
                value = rawY / scale,
                refY = luminance([refPixels[i], refPixels[i + 1], refPixels[i + 2]])
              const variance = noiseVariance(rawY, scale, sources[s].capture.iso)
              if (
                s !== referenceIndex &&
                pixel[3] &&
                refPixels[i + 3] &&
                settings.deghost &&
                motionDifferent(
                  value,
                  refY,
                  variance + noiseVariance(refY, 1, reference.capture.iso),
                  settings.strength,
                )
              )
                motion[(top + y) * width + x] = 1
              if (!pixel[3]) continue
              const weight = confidence / Math.max(1e-12, variance)
              for (let c = 0; c < 3; c++) sum[i + c] += (pixel[c] / scale) * weight
              sum[i + 3] += weight
            }
        }
        const data = new Float32Array(count * 4)
        for (let k = 0; k < count; k++) {
          const i = k * 4
          if (!common.mask[top * width + k]) continue
          for (let c = 0; c < 3; c++)
            data[i + c] = sum[i + 3] ? sum[i + c] / sum[i + 3] : refPixels[i + c]
          data[i + 3] = Number(sum[i + 3] > 0)
        }
        await temporary.writeFile(Buffer.from(data.buffer))
        await referenceFile.writeFile(Buffer.from(refPixels.buffer))
      }
    } finally {
      await temporary.close()
      await referenceFile.close()
    }
  }
  measurements.stages.accumulation = performance.now() - accumulationStart
  const outputStart = performance.now(),
    outputWork: NonNullable<NonNullable<MergeMeasurements['output']>['work']> = {
      validityMs: 0,
      maskMs: 0,
      readingMs: 0,
      compositionMs: 0,
      thumbnailMs: 0,
      referenceMs: 0,
      writingMs: 0,
      hashingMs: 0,
      syncMs: 0,
      closingMs: 0,
      cpuConversionMs: 0,
      png: {},
      jpeg: {},
    }
  measurements.output = { backend: 'cpu', work: outputWork }
  if (preparation) {
    // Missing fusion samples need the same conservative boundary as motion.
    // Freeze them before dilation and tapering, rather than adding hard edges
    // while writing the final master.
    const accumulated = await open(mergedPath, 'r'),
      bytes = Buffer.alloc(width * Math.min(64, height) * 16)
    try {
      for (let top = 0; top < height; top += 64) {
        await checkpoint()
        const length = width * Math.min(64, height - top) * 16
        if ((await accumulated.read(bytes, 0, length, top * width * 16)).bytesRead !== length)
          throw new Error('Damaged accumulation validity strip.')
        measurements.disk.readBytes += length
        const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, length / 4)
        for (let k = 0; k < pixels.length / 4; k++) {
          const alpha = pixels[k * 4 + 3],
            global = top * width + k
          if (alpha !== 0 && alpha !== 1) throw new Error('Invalid accumulation validity.')
          if (!alpha && common.mask[global]) motion[global] = 1
        }
      }
    } finally {
      await accumulated.close()
    }
  }
  outputWork.validityMs = performance.now() - outputStart
  const maskStart = performance.now(),
    rejected = expandMask(motion, width, height, MERGE_LIMITS.maskRadius),
    mask = preparation
      ? taperExclusions(rejected, width, height, BRK_EXPOSURE_POLICY.sourceExclusionFeatherPixels)
      : rejected
  outputWork.maskMs = performance.now() - maskStart
  let affected = 0,
    clipped = 0,
    covered = 0
  const asset: HdrWorkingAsset = {
    kind: 'hdr-working-v1',
    width: crop.width,
    height: crop.height,
    byteLength: crop.width * crop.height * 16,
    sha256: '',
    strips: [],
    whiteBalance: hdrWhiteBalance(reference.metadata.whiteBalance),
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      normalization: { ...ref.normalization, sourceSaturation: null },
      decoder: MERGE_VERSION,
      cameraProfile: ref.cameraProfile,
      orientation: 'applied-once',
      composite: { kind: settings.mode, sourceCount: sources.length },
    },
  }
  const outputFile = await open(join(output, 'linear.f32'), 'wx'),
    accum = await open(mergedPath, 'r'),
    refFile = await open(referencePath, 'r'),
    referenceProof =
      job.comparisons && fallbackReference
        ? await open(join(output, 'reference-linear.f32'), 'wx')
        : undefined,
    digest = createHash('sha256')
  const thumbScale = Math.min(1, 1024 / Math.max(crop.width, crop.height)),
    tw = Math.max(1, Math.floor(crop.width * thumbScale)),
    th = Math.max(1, Math.floor(crop.height * thumbScale))
  const nativeResult = job.comparisons ? await open(join(output, 'result.rgba'), 'wx') : undefined,
    nativeReference = job.comparisons
      ? await open(join(output, 'reference.rgba'), 'wx')
      : undefined,
    nativeOverlay = job.comparisons ? await open(join(output, 'overlay.rgba'), 'wx') : undefined
  let converter: Awaited<ReturnType<typeof gpuOutput>> | undefined
  if (usedGpu) {
    try {
      converter = await gpuOutput(gpu, Math.max(crop.width * 64, tw * th))
      measurements.output = { backend: 'gpu', conversion: converter.timings, work: outputWork }
      measurements.peak.gpuBytes = Math.max(measurements.peak.gpuBytes, converter.peakBytes)
    } catch (error) {
      measurements.output = {
        backend: 'cpu',
        fallback: mergeFailure(error).message,
        work: outputWork,
      }
    }
  }
  const preview = Buffer.alloc(tw * th * 4),
    previewLinear = converter ? new Float32Array(tw * th * 4) : undefined
  const stripBytes = width * Math.min(64, crop.height) * 16,
    pixelBuffer = Buffer.allocUnsafe(stripBytes),
    referenceBuffer = Buffer.allocUnsafe(stripBytes),
    outputPixels = new Float32Array(crop.width * Math.min(64, crop.height) * 4),
    referencePixels =
      job.comparisons && (converter || referenceProof)
        ? new Float32Array(outputPixels.length)
        : undefined,
    overlayBuffer = Buffer.allocUnsafe(job.comparisons ? outputPixels.length : 0)
  try {
    for (let top = 0; top < crop.height; top += 64) {
      await checkpoint()
      const rows = Math.min(64, crop.height - top),
        bytes = pixelBuffer.subarray(0, width * rows * 16),
        refBytes = referenceBuffer.subarray(0, bytes.length),
        reading = performance.now()
      for (const [file, buffer] of [
        [accum, bytes],
        [refFile, refBytes],
      ] as const) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          buffer.length,
          (top + crop.top) * width * 16,
        )
        if (bytesRead !== buffer.length) throw new Error('Damaged accumulation strip.')
      }
      if (fallbackReference) {
        const safe = await bandData(fallbackReference, identityTransform(), top + crop.top, rows)
        const original = new Float32Array(
            refBytes.buffer,
            refBytes.byteOffset,
            refBytes.length / 4,
          ),
          corrected = safe.data.subarray((top + crop.top - safe.first) * width * 4)
        for (let i = 0; i < original.length; i += 4)
          if (!original[i + 3]) {
            for (let c = 0; c < 3; c++) original[i + c] = corrected[i + c]
          }
      }
      outputWork.readingMs += performance.now() - reading
      const composition = performance.now()
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
        referenceData = new Float32Array(
          refBytes.buffer,
          refBytes.byteOffset,
          refBytes.byteLength / 4,
        ),
        out = outputPixels.subarray(0, crop.width * rows * 4)
      for (let y = 0; y < rows; y++)
        out.set(
          data.subarray((y * width + crop.left) * 4, (y * width + crop.left + crop.width) * 4),
          y * crop.width * 4,
        )
      const native = Buffer.alloc(job.comparisons && !converter ? crop.width * rows * 4 : 0),
        nativeRef = Buffer.alloc(native.length),
        nativeMask = overlayBuffer.subarray(0, job.comparisons ? crop.width * rows * 4 : 0)
      nativeMask.fill(0)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < crop.width; x++) {
          const global = (top + crop.top + y) * width + crop.left + x,
            i = (y * width + crop.left + x) * 4,
            j = (y * crop.width + x) * 4,
            missing = !!preparation && !data[i + 3] && !!common.mask[global]
          if (missing && mask[global] !== 255)
            throw new Error('Missing accumulation samples were not frozen for reference fallback.')
          const m = mask[global] && common.mask[global]
          if (common.mask[global]) covered++
          if (m) {
            affected++
            if (!referenceData[i + 3]) clipped++
          }
          if (m) {
            const fallback = preparation ? mask[global] / 255 : 1
            for (let c = 0; c < 3; c++)
              out[j + c] = out[j + c] * (1 - fallback) + referenceData[i + c] * fallback
          }
          out[j + 3] = Number(common.mask[global])
          if (job.comparisons && !converter) {
            const nrgb = outputHdr([out[j], out[j + 1], out[j + 2]], SDR_TARGET).rgb,
              nref = outputHdr(
                [referenceData[i], referenceData[i + 1], referenceData[i + 2]],
                SDR_TARGET,
              ).rgb
            for (let c = 0; c < 3; c++) {
              native[j + c] = Math.round(encodeHdr(nrgb[c]) * 255)
              nativeRef[j + c] = Math.round(encodeHdr(nref[c]) * 255)
            }
            native[j + 3] = nativeRef[j + 3] = out[j + 3] * 255
          }
          if (job.comparisons) {
            nativeMask[j] = 255
            nativeMask[j + 2] = 180
            nativeMask[j + 3] = m ? Math.round(160 * (preparation ? mask[global] / 255 : 1)) : 0
          }
        }
      outputWork.compositionMs += performance.now() - composition
      const thumbnail = performance.now()
      // Visit only thumbnail sample centers; native pixels need no preview-coordinate arithmetic.
      for (
        let py = Math.max(0, Math.ceil((top * th) / crop.height - 0.5));
        py < Math.min(th, Math.ceil(((top + rows) * th) / crop.height - 0.5));
        py++
      ) {
        const y = Math.floor(((py + 0.5) * crop.height) / th) - top
        for (let px = 0; px < tw; px++) {
          const x = Math.floor(((px + 0.5) * crop.width) / tw),
            j = (y * crop.width + x) * 4
          const k = (py * tw + px) * 4
          if (previewLinear) previewLinear.set(out.subarray(j, j + 4), k)
          else {
            const rgb = outputHdr([out[j], out[j + 1], out[j + 2]], SDR_TARGET).rgb
            for (let c = 0; c < 3; c++) preview[k + c] = Math.round(encodeHdr(rgb[c]) * 255)
          }
          preview[k + 3] = out[j + 3] * 255
        }
      }
      outputWork.thumbnailMs += performance.now() - thumbnail
      if (converter && job.comparisons) {
        const referenceStart = performance.now(),
          referenceOut = referencePixels!.subarray(0, out.length)
        for (let y = 0; y < rows; y++) {
          referenceOut.set(
            referenceData.subarray(
              (y * width + crop.left) * 4,
              (y * width + crop.left + crop.width) * 4,
            ),
            y * crop.width * 4,
          )
        }
        for (let i = 3; i < referenceOut.length; i += 4) referenceOut[i] = out[i]
        outputWork.referenceMs += performance.now() - referenceStart
        const proofWrite = performance.now()
        await referenceProof?.writeFile(
          Buffer.from(referenceOut.buffer, referenceOut.byteOffset, referenceOut.byteLength),
        )
        outputWork.writingMs += performance.now() - proofWrite
        let resultBytes: Buffer, referenceBytes: Buffer
        try {
          if ((out.length + referenceOut.length) / 4 <= converter.capacity) {
            // Pack adjacent independent images into the existing allocation.
            // The shader still evaluates every RGBA pixel by the same policy.
            const both = await converter.convert(out, referenceOut)
            resultBytes = both.subarray(0, out.length)
            referenceBytes = both.subarray(out.length)
          } else {
            resultBytes = await converter.convert(out)
            referenceBytes = await converter.convert(referenceOut)
          }
        } catch (error) {
          measurements.output = {
            ...measurements.output,
            backend: 'cpu',
            fallback: mergeFailure(error).message,
          }
          converter.close()
          converter = undefined
          const cpu = performance.now()
          resultBytes = displayLinear(out)
          referenceBytes = displayLinear(referenceOut)
          outputWork.cpuConversionMs += performance.now() - cpu
        }
        const writing = performance.now()
        await nativeResult!.writeFile(resultBytes)
        await nativeReference!.writeFile(referenceBytes)
        outputWork.writingMs += performance.now() - writing
      } else {
        if (referenceProof) {
          const referenceStart = performance.now(),
            referenceOut = referencePixels!.subarray(0, out.length)
          for (let y = 0; y < rows; y++)
            referenceOut.set(
              referenceData.subarray(
                (y * width + crop.left) * 4,
                (y * width + crop.left + crop.width) * 4,
              ),
              y * crop.width * 4,
            )
          for (let i = 3; i < referenceOut.length; i += 4) referenceOut[i] = out[i]
          outputWork.referenceMs += performance.now() - referenceStart
          const writing = performance.now()
          await referenceProof.writeFile(
            Buffer.from(referenceOut.buffer, referenceOut.byteOffset, referenceOut.byteLength),
          )
          outputWork.writingMs += performance.now() - writing
        }
        const writing = performance.now()
        await nativeResult?.writeFile(native)
        await nativeReference?.writeFile(nativeRef)
        outputWork.writingMs += performance.now() - writing
      }
      const writing = performance.now()
      await nativeOverlay?.writeFile(nativeMask)
      const outputBytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength)
      await outputFile.writeFile(outputBytes)
      outputWork.writingMs += performance.now() - writing
      const hashing = performance.now()
      digest.update(outputBytes)
      asset.strips.push({ byteLength: outputBytes.length, sha256: hash(outputBytes) })
      outputWork.hashingMs += performance.now() - hashing
    }
    if (previewLinear) {
      try {
        if (!converter) throw new Error(measurements.output?.fallback ?? 'GPU output unavailable.')
        preview.set(await converter.convert(previewLinear))
      } catch (error) {
        measurements.output = {
          ...measurements.output,
          backend: 'cpu',
          fallback: mergeFailure(error).message,
        }
        const cpu = performance.now()
        preview.set(displayLinear(previewLinear))
        outputWork.cpuConversionMs += performance.now() - cpu
      }
    }
    const syncing = performance.now()
    await outputFile.sync()
    outputWork.syncMs += performance.now() - syncing
  } finally {
    const closing = performance.now()
    await outputFile.close()
    await accum.close()
    await refFile.close()
    await referenceProof?.close()
    await nativeResult?.close()
    await nativeReference?.close()
    await nativeOverlay?.close()
    converter?.close()
    outputWork.closingMs += performance.now() - closing
  }
  if (covered && affected / covered > 0.95)
    throw new Error(
      'Almost the entire image requires the reference. Choose another reference or reduce deghost strength.',
    )
  for (const name of job.comparisons ? (['result', 'reference', 'overlay'] as const) : []) {
    const encoding = performance.now(),
      encoded = await sharp(await readFile(join(output, `${name}.rgba`)), {
        raw: { width: crop.width, height: crop.height, channels: 4 },
      })
        .png({ compressionLevel: reviewPngCompressionLevel[name] })
        .toFile(join(output, `${name}.png`))
    outputWork.png[name] = {
      ms: performance.now() - encoding,
      bytes: encoded.size,
      compressionLevel: reviewPngCompressionLevel[name],
    }
  }
  asset.sha256 = digest.digest('hex')
  await writeFile(join(output, 'motion.mask'), mask)
  const thumbnailStart = performance.now(),
    thumbnailOutput = await sharp(preview, { raw: { width: tw, height: th, channels: 4 } })
      .resize({ width: 256, height: 256, fit: 'inside' })
      .flatten({ background: '#171717' })
      .jpeg()
      .toFile(join(output, 'thumb.jpg'))
  outputWork.jpeg.thumbnail = {
    ms: performance.now() - thumbnailStart,
    bytes: thumbnailOutput.size,
  }
  const previewStart = performance.now(),
    previewOutput = await sharp(preview, { raw: { width: tw, height: th, channels: 4 } })
      .flatten({ background: '#171717' })
      .jpeg()
      .toFile(join(output, 'preview.jpg'))
  outputWork.jpeg.preview = { ms: performance.now() - previewStart, bytes: previewOutput.size }
  const recipe: MergeRecipe = {
    resolution: 'native',
    maskDimensions: { width, height },
    version: MERGE_VERSION,
    constants: MERGE_LIMITS,
    alignment: ALIGNMENT_CONSTANTS,
    pipeline: MERGE_PIPELINE,
    preparation,
    measurements,
    settings,
    sources: sources.map((s, i) => ({
      id: s.photo.id,
      filename: s.photo.filename,
      capture: s.capture,
      scale: scales[i],
      transform: nativeGeometry.transforms[i],
      decoder: prepared[i].decoder,
      cameraProfile: prepared[i].cameraProfile,
      lensIdentity: s.metadata.lensProfile.identity,
      photometry: photometry[i],
    })),
    width: nativeGeometry.width,
    height: nativeGeometry.height,
    crop: nativeGeometry.crop,
    affectedPercent: covered ? (affected / covered) * 100 : 0,
    referenceClippedPercent: covered ? (clipped / covered) * 100 : 0,
    maskSha256: hash(mask),
  }
  if (job.recipe?.resolution === 'native' && job.recipe.maskSha256 !== recipe.maskSha256)
    throw new Error('Recipe motion mask could not be reproduced.')
  measurements.stages.output = performance.now() - outputStart
  measurements.disk.readBytes += mergeReadBytes() + crop.height * width * 32
  measurements.disk.writtenBytes +=
    width * height * (measurements.accumulation.referenceReused ? 16 : 32) +
    asset.byteLength +
    mask.length
  for (const name of [
    'thumb.jpg',
    'preview.jpg',
    ...(job.comparisons ? ['result.png', 'reference.png', 'overlay.png'] : []),
  ])
    measurements.disk.writtenBytes += (await stat(join(output, name))).size
  if (job.comparisons) {
    if (referenceProof)
      measurements.disk.writtenBytes += (await stat(join(output, 'reference-linear.f32'))).size
    measurements.disk.readBytes += crop.width * crop.height * 12
    measurements.disk.writtenBytes += crop.width * crop.height * 12
  }
  measurements.peak.workerBytes = process.resourceUsage().maxRSS * 1024
  measurements.peak.wasmBytes = Math.max(
    alignment.wasmBytes,
    ...transforms.map((t) => t.diagnostics?.wasmMemoryBytes ?? 0),
  )
  measurements.runtimeMs = performance.now() - start
  measurements.reads = structuredClone(mergeReadMeasurements())
  return {
    asset,
    recipe,
    runtimeMs: performance.now() - start,
    peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
    measurements,
  }
}
