import { rawDecoder } from '../processing/decoders'
import { correctionPlan, type CorrectionPlan } from '../processing/lens-correction'
import { automaticLensSettings } from '../../shared/lens'
import {
  MERGE_PIPELINE,
  verifiedBracket,
  type MergePreparation,
  type MergeSettings,
  type MergeSource,
  type MergeMeasurements,
} from '../../shared/merge'

/** Probe one decoder at a time; catalog dimensions never define the common crop. */
export async function mergePreparation(
  paths: string[],
  sources: MergeSource[],
  settings: MergeSettings,
  checkpoint: () => Promise<void>,
  measurement?: NonNullable<MergeMeasurements['preparationProbe']>,
): Promise<MergePreparation | undefined> {
  const start = performance.now()
  const capture = settings.mode === 'hdr' ? verifiedBracket(sources) : null
  if (!capture) return
  const dimensions: MergePreparation['sources'] = [],
    plans: CorrectionPlan[] = []
  for (let index = 0; index < sources.length; index++) {
    await checkpoint()
    const source = sources[index],
      decoder = rawDecoder(paths[index])
    if (!decoder) throw new Error(`${source.photo.filename}: a RAW decoder is required.`)
    const opening = performance.now(),
      session = await decoder.open(paths[index])
    if (measurement) {
      measurement.opens++
      measurement.openingMs += performance.now() - opening
    }
    try {
      const raw = session.dimensions
      if (!session.metadata.hdrEligible)
        throw new Error(`${source.photo.filename}: unverified Sony RAW recording mode.`)
      if (
        dimensions.length &&
        (raw.width !== dimensions[0].width ||
          raw.height !== dimensions[0].height ||
          raw.flip !== dimensions[0].flip)
      )
        throw new Error(
          `${source.photo.filename}: decoded dimensions or orientation differ from ${sources[0].photo.filename}.`,
        )
      dimensions.push({
        id: source.photo.id,
        width: raw.width,
        height: raw.height,
        flip: raw.flip,
        lensIdentity: source.metadata.lensProfile.identity,
      })
      plans.push(
        correctionPlan(raw.width, raw.height, source.metadata.lensProfile, automaticLensSettings),
      )
    } finally {
      session.close()
    }
  }
  const left = Math.max(...plans.map((p) => p.left)),
    top = Math.max(...plans.map((p) => p.top))
  if (measurement) measurement.runtimeMs = performance.now() - start
  return {
    policy: MERGE_PIPELINE.preparation,
    capture,
    commonCrop: {
      left,
      top,
      width: dimensions[0].width - left * 2,
      height: dimensions[0].height - top * 2,
    },
    sources: dimensions,
  }
}

export function sourceCorrectionPlan(
  width: number,
  height: number,
  flip: number,
  source: MergeSource,
  reference: MergeSource,
  preparation?: MergePreparation,
): CorrectionPlan {
  const plan = correctionPlan(
    width,
    height,
    (preparation ? source : reference).metadata.lensProfile,
    automaticLensSettings,
  )
  if (!preparation) return plan
  const decoded = preparation.sources.find((s) => s.id === source.photo.id),
    crop = preparation.commonCrop
  if (
    !decoded ||
    decoded.width !== width ||
    decoded.height !== height ||
    decoded.flip !== flip ||
    decoded.lensIdentity !== source.metadata.lensProfile.identity ||
    crop.left < plan.left ||
    crop.top < plan.top ||
    crop.left * 2 + crop.width !== width ||
    crop.top * 2 + crop.height !== height ||
    crop.width < 1 ||
    crop.height < 1
  )
    throw new Error(`${source.photo.filename}: incompatible common lens crop.`)
  return { ...plan, ...crop }
}
