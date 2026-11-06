import type { FullPreview, LinearAsset } from './contracts'
import { validateExportOptions, type ExportOptions } from './export'
import { SDR_TARGET, type DisplayTarget } from './hdr'
import { linearHeadroom, type PreviewPreference } from './hdr-display'

export const OUTPUT_PROOF_VERSION = 'decoded-jpeg-proof-v1'
export interface OutputProofRequest {
  preparationId: string
  photoId: string
  options: ExportOptions
  token: string
}
export interface OutputProofPipeline {
  rendering: string
  codec: string
  display: string
  hdrContent: string
  adjustments: string
  lens: string
  sdrEncoder: string
  crop: { geometry: string; filter: string }
  detail: { stage: string; noiseReduction: string; detailSharpening: string }
  resize: { filter: string }
}
export interface OutputProof {
  readonly version: typeof OUTPUT_PROOF_VERSION
  readonly id: string
  readonly identity: string
  readonly photoId: string
  readonly revision: number
  readonly filename: string
  readonly output: 'sdr' | 'hdr'
  readonly quality: number
  readonly width: number
  readonly height: number
  readonly resizeMethod: 'original' | 'lanczos3'
  readonly pixelKey: string
  readonly pipeline: Readonly<OutputProofPipeline>
  readonly primary: FullPreview
  readonly linear?: LinearAsset
}
export interface OutputProofOverview extends Omit<OutputProof, 'primary' | 'linear' | 'id'> {
  readonly overview: {
    width: number
    height: number
    rendition: 'SDR overview of decoded JPEG primary; inspect full resolution in Output preview'
    mimeType: 'image/jpeg'
    byteLength: number
  }
  readonly data: string
}

export function validateOutputProofRequest(value: unknown): OutputProofRequest {
  const request = value as OutputProofRequest
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => !['preparationId', 'photoId', 'options', 'token'].includes(key),
    ) ||
    ![request.preparationId, request.token].every(
      (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id),
    ) ||
    !/^[a-f0-9]{64}$/.test(request.photoId)
  )
    throw new Error('Invalid output preview request.')
  return { ...request, options: validateExportOptions(request.options) }
}

/** Only changes that require another JPEG invalidate a proof. Keep property order canonical. */
export function outputProofPixelKey(options: ExportOptions, hdr: boolean): string {
  if (options.output === 'hdr' && !hdr)
    throw new Error('This photograph does not support HDR JPEG.')
  const size = options.size
  return JSON.stringify({
    output: options.output === 'sdr' || !hdr ? 'sdr' : 'hdr',
    quality: options.quality,
    size:
      size.mode === 'original'
        ? { mode: 'original' }
        : {
            mode: size.mode,
            ...(size.mode === 'longest'
              ? { edge: size.edge }
              : { width: size.width, height: size.height }),
            method: size.method ?? 'lanczos3',
            allowEnlargement: size.allowEnlargement ?? false,
          },
  })
}

/** A local presentation choice never changes the saved workspace preference. */
export function outputProofDisplayTarget(
  display: DisplayTarget,
  preference: PreviewPreference,
  generation: number,
): DisplayTarget {
  const caps = display.capabilities,
    headroom = linearHeadroom(caps?.headroomStops)
  const hdr =
    preference !== 'sdr' && !!caps?.hardware && !!caps.extended && headroom !== null && headroom > 1
  return {
    ...SDR_TARGET,
    capabilities: caps,
    generation,
    requested: preference,
    mode: hdr ? 'hdr' : 'sdr',
    colorSpace: hdr && caps?.p3 ? 'display-p3' : 'srgb',
    peak: hdr ? Math.min(100, headroom!) : 1,
    headroom,
    reason: hdr
      ? 'Authored HDR output; physical luminance is unverified.'
      : preference === 'sdr'
        ? 'Embedded SDR primary selected.'
        : caps?.reason || 'HDR presentation is unavailable; showing the embedded SDR primary.',
  }
}
