import { registrationCandidates, eccHypothesis } from './alignment'
import { validateGlobalNative } from './native-alignment'
import { patchRegistrationCandidate, validateMotionNative } from './motion-alignment'
import { multiply, resizedTransform, validateGeometry } from './matrix'
import {
  MergeError,
  mergeFailure,
  type MergeFailure,
  type MergeTransform,
} from '../../shared/merge'
import type { PreparedSource } from './prepare'
import { ALIGNMENT_CONSTANTS } from '../../shared/merge'
import { identityTransform } from './alignment'
import { registrationSources } from './camera-registration'

/** Similarity first; projective work is deferred until native evidence requires it. */
async function registerEvidence(
  reference: PreparedSource,
  neighbor: PreparedSource,
  source: PreparedSource,
  neighborTransform: MergeTransform,
  checkpoint: () => Promise<void>,
  paths = { features: true, ecc: true },
) {
  const rejected = (error: unknown, candidate?: MergeTransform): MergeFailure => {
    const failure = mergeFailure(error)
    if (!failure.diagnostics.length && candidate?.diagnostics)
      failure.diagnostics.push(structuredClone(candidate.diagnostics))
    for (const diagnostics of failure.diagnostics) diagnostics.reason ??= failure.message
    return failure
  }
  const failures: MergeFailure[] = [],
    motionCandidates: MergeTransform[] = [],
    timings = { matching: 0, nativeValidation: 0 }
  if (
    reference.width === source.width &&
    reference.height === source.height &&
    reference.strips.length === source.strips.length &&
    reference.strips.every((sha, i) => sha === source.strips[i])
  ) {
    const start = performance.now(),
      transform = await validateGlobalNative(
        reference,
        source,
        {
          ...identityTransform(),
          diagnostics: {
            algorithm: ALIGNMENT_CONSTANTS.version,
            model: 'identity',
            method: 'identical',
            matches: 0,
            inliers: 0,
            cells: 0,
            nativePatches: [],
            movingRegions: [],
            runtimeMs: 0,
            wasmMemoryBytes: 0,
          },
        },
        checkpoint,
      )
    timings.nativeValidation = performance.now() - start
    return { transform, timings, diagnostics: [] }
  }
  for (const projective of paths.features ? [false, true] : []) {
    await checkpoint()
    let candidate: MergeTransform
    const start = performance.now()
    try {
      candidate = (await registrationCandidates(neighbor.plane, source.plane, projective, true))[0]
    } catch (error) {
      failures.push(rejected(error))
      continue
    } finally {
      timings.matching += performance.now() - start
    }
    const native = resizedTransform(
      candidate,
      neighbor.plane.width,
      neighbor.plane.height,
      reference.width,
      reference.height,
    )
    native.matrix = multiply(native.matrix!, neighborTransform.matrix!)
    try {
      validateGeometry(native.matrix, reference.width, reference.height)
    } catch (error) {
      failures.push(rejected(error, native))
      continue
    }
    const validation = performance.now()
    try {
      const result = await validateGlobalNative(reference, source, native, checkpoint, true)
      return { transform: result, timings, diagnostics: failures.flatMap((f) => f.diagnostics) }
    } catch (error) {
      failures.push(rejected(error, native))
    } finally {
      timings.nativeValidation += performance.now() - validation
    }
    motionCandidates.unshift(native)
  }
  // A failed global similarity needs projective evidence before spending native
  // work on competing subject/camera motions. Keep similarity as a validated fallback.
  for (const native of motionCandidates) {
    const motion = performance.now()
    try {
      return {
        transform: await validateMotionNative(reference, source, native, checkpoint),
        timings,
        diagnostics: failures.flatMap((f) => f.diagnostics),
      }
    } catch (error) {
      failures.push(rejected(error, native))
    } finally {
      timings.nativeValidation += performance.now() - motion
    }
  }
  // Two additional starting estimates, only on the direct reference path.
  // Neither ECC nor identity can authorize publication without spatial/native proof.
  if (paths.ecc && neighbor === reference)
    for (const projective of [false, true]) {
      await checkpoint()
      let native: MergeTransform
      const start = performance.now()
      try {
        const estimate = await eccHypothesis(reference.plane, source.plane, projective, checkpoint)
        native = resizedTransform(
          estimate,
          reference.plane.width,
          reference.plane.height,
          reference.width,
          reference.height,
        )
        native = await patchRegistrationCandidate(reference, source, native, checkpoint)
      } catch (error) {
        failures.push(rejected(error))
        continue
      } finally {
        timings.matching += performance.now() - start
      }
      const validation = performance.now()
      try {
        try {
          const transform = await validateGlobalNative(reference, source, native, checkpoint)
          return { transform, timings, diagnostics: failures.flatMap((f) => f.diagnostics) }
        } catch (error) {
          failures.push(rejected(error, native))
        }
        const transform = await validateMotionNative(reference, source, native, checkpoint)
        return { transform, timings, diagnostics: failures.flatMap((f) => f.diagnostics) }
      } catch (error) {
        failures.push(rejected(error, native))
      } finally {
        timings.nativeValidation += performance.now() - validation
      }
    }
  throw Object.assign(
    new MergeError({
      code: 'alignment',
      message: failures.at(-1)?.message ?? 'No validated registration path.',
      filenames: [],
      diagnostics: failures.flatMap((f) => f.diagnostics),
    }),
    { timings },
  )
}

/** Try surviving-channel features when RGB features cannot prove geometry.
 * The two ECC starting hypotheses retain RGB's combined signal. Every path
 * requires the same independent native and motion evidence.
 */
export async function registerNative(
  reference: PreparedSource,
  neighbor: PreparedSource,
  source: PreparedSource,
  neighborTransform: MergeTransform,
  checkpoint: () => Promise<void>,
) {
  const original = [reference, neighbor, source],
    selected = registrationSources(original)
  if (!selected.channel)
    return registerEvidence(reference, neighbor, source, neighborTransform, checkpoint)
  const attempts = [
      { sources: original, channel: undefined, features: true, ecc: false },
      { ...selected, features: true, ecc: false },
      ...(neighbor === reference
        ? [{ sources: original, channel: undefined, features: false, ecc: true }]
        : []),
    ],
    failures: MergeFailure[] = [],
    timings = { matching: 0, nativeValidation: 0 }
  for (const attempt of attempts) {
    const [a, b, c] = attempt.sources
    try {
      const result = await registerEvidence(a, b, c, neighborTransform, checkpoint, attempt)
      if (attempt.channel) {
        if (result.transform.diagnostics)
          result.transform.diagnostics.registrationChannel = attempt.channel
        for (const d of result.diagnostics) d.registrationChannel = attempt.channel
      }
      result.timings.matching += timings.matching
      result.timings.nativeValidation += timings.nativeValidation
      result.diagnostics.unshift(...failures.flatMap((f) => f.diagnostics))
      return result
    } catch (error) {
      const failure = mergeFailure(error),
        work = error as { timings?: typeof timings }
      if (attempt.channel)
        for (const d of failure.diagnostics) d.registrationChannel = attempt.channel
      timings.matching += work.timings?.matching ?? 0
      timings.nativeValidation += work.timings?.nativeValidation ?? 0
      failures.push(failure)
    }
  }
  throw Object.assign(
    new MergeError({
      code: 'alignment',
      message: failures.at(-1)?.message ?? 'No validated registration path.',
      filenames: [],
      diagnostics: failures.flatMap((f) => f.diagnostics),
    }),
    { timings },
  )
}
