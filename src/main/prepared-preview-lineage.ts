import { cropGeometry } from '../shared/crop'
import type { CropSettings } from '../shared/crop'
import type { ProcessingOptions } from '../shared/lens'
import type { FullPreviewResult } from './preview-types'
import {
  detailLineageKey,
  detailPreparationKey,
  resolveDetailSettings,
  type DetailSourceLineage,
} from './processing/detail-identity'
import {
  croppedWorkingIdentity,
  currentWorkingIdentity,
  workingSourceIdentity,
} from './working-assets'

export interface PreparedPreviewLineage {
  readonly baseSourceKey?: string
  readonly cropSettings?: CropSettings
  readonly detailSource?: DetailSourceLineage
}

/** Validate path-free lineage both before publication and when reopening disposable cache entries. */
export function validatePreparedPreviewLineage(
  frame: Pick<FullPreviewResult, 'width' | 'height' | 'linear' | 'crop' | 'detail'>,
  sourceKey: string | undefined,
  lineage: PreparedPreviewLineage,
): void {
  const detail = lineage.detailSource
  if (detail) {
    const key = detailLineageKey(detail),
      source = frame.crop?.source ?? frame
    if (
      source.width !== detail.asset.width ||
      source.height !== detail.asset.height ||
      (frame.crop ? lineage.baseSourceKey !== key : sourceKey !== key)
    )
      throw new Error('Invalid detail cache lineage.')
    if (frame.linear) {
      if (
        Boolean(frame.linear.hdr) !== Boolean(detail.asset.source) ||
        (frame.linear.hdr &&
          (JSON.stringify(frame.linear.hdr.source) !== JSON.stringify(detail.asset.source) ||
            JSON.stringify(frame.linear.hdr.whiteBalance) !==
              JSON.stringify(detail.asset.whiteBalance))) ||
        (!frame.linear.hdr &&
          JSON.stringify(frame.linear.transform) !== JSON.stringify(detail.asset.transform))
      )
        throw new Error('The detail cache source domain changed.')
    }
    if (
      frame.detail &&
      (frame.detail.key !== key ||
        frame.detail.sourceIdentity !== detail.sourceIdentity ||
        frame.detail.sourceSha256 !== detail.asset.sha256 ||
        detailPreparationKey(
          detail.sourceIdentity,
          detail.asset,
          frame.detail.noiseReduction,
          frame.detail.detailSharpening,
        ) !== key)
    )
      throw new Error('The detail worker returned inconsistent source identity.')
  } else if (frame.detail) throw new Error('Missing detail cache lineage.')

  if (frame.crop) {
    const geometry = cropGeometry(frame.crop.source, lineage.cropSettings!)
    if (
      !lineage.cropSettings ||
      !/^[a-f0-9]{64}$/.test(lineage.baseSourceKey ?? '') ||
      geometry.identity ||
      geometry.width !== frame.width ||
      geometry.height !== frame.height ||
      JSON.stringify(geometry) !== JSON.stringify(frame.crop) ||
      croppedWorkingIdentity(lineage.baseSourceKey!, geometry) !== sourceKey
    )
      throw new Error('Invalid crop cache lineage.')
  } else if (lineage.cropSettings || lineage.baseSourceKey)
    throw new Error('Unexpected crop cache lineage.')
}

/** Current controls must identify the exact filtered source before optional geometry is applied. */
export function preparedWorkingIdentity(
  id: string,
  options: ProcessingOptions,
  workingOnly: boolean,
  entry: Pick<FullPreviewResult, 'width' | 'height' | 'crop'> & PreparedPreviewLineage,
  uncropped = false,
): string | undefined {
  const settings = resolveDetailSettings(options),
    upstream = workingSourceIdentity(id, options, workingOnly)
  let key = upstream
  if (settings.active) {
    if (entry.detailSource?.sourceIdentity !== upstream) return
    key = detailPreparationKey(
      upstream,
      entry.detailSource.asset,
      settings.noiseReduction,
      settings.detailSharpening,
    )
  } else if (entry.detailSource) return
  return uncropped ? key : currentWorkingIdentity(key, entry.crop?.source ?? entry, options.crop)
}
