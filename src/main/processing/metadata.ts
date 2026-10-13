import { PROCESSING_METADATA_VERSION } from '../../shared/lens'
import type { ProcessingMetadata, LensProfile } from '../../shared/lens'
import type { LensCorrectionProvider } from './contracts'
import { sonyEmbedded } from './lenses/sony-embedded'

export const lensProviders: readonly LensCorrectionProvider[] = [sonyEmbedded]
export const unavailableProfile: LensProfile = {
  provider: 'none',
  version: '1',
  identity: 'none-1',
  label: 'No verified lens profile',
  unavailable: {
    distortion: 'No verified distortion data.',
    vignetting: 'No verified vignetting data.',
    chromaticAberration: 'No verified color-fringe data.',
  },
}
export function processingMetadata(
  tags: Record<string, unknown>,
  providers = lensProviders,
): ProcessingMetadata {
  const string = (key: string) =>
    typeof tags[key] === 'string' ? (tags[key] as string) : undefined
  const number = (key: string) =>
    typeof tags[key] === 'number' && Number.isFinite(tags[key]) ? (tags[key] as number) : undefined
  const metadata = {
    version: PROCESSING_METADATA_VERSION,
    capturedAt: string('ExifIFD:DateTimeOriginal'),
    make: string('IFD0:Make'),
    model: string('IFD0:Model'),
    lens: string('ExifIFD:LensModel'),
    focalLength: number('ExifIFD:FocalLength'),
    aperture: number('ExifIFD:FNumber'),
    orientation: number('IFD0:Orientation'),
  }
  return {
    ...metadata,
    capture:
      number('ExifIFD:ExposureTime') &&
      number('ExifIFD:ISO') &&
      metadata.aperture &&
      metadata.focalLength
        ? {
            shutterSeconds: number('ExifIFD:ExposureTime')!,
            iso: number('ExifIFD:ISO')!,
            aperture: metadata.aperture,
            focalLength: metadata.focalLength,
            focusDistance: number('Sony:FocusDistance2'),
          }
        : undefined,
    lensProfile:
      providers
        .map((provider) => provider.resolve(metadata, tags))
        .find((profile) => profile !== null) ?? unavailableProfile,
  }
}
