import type { HdrAnalysisDomain } from './hdr-statistics'
import type { DisplayTarget, RGB } from './hdr'

export interface HdrPixel {
  width: number
  height: number
  x: number
  y: number
  domain: HdrAnalysisDomain
  colorSpace: 'rec2020' | 'srgb' | 'display-p3'
  referenceWhite: 1
  rgb: RGB
  alpha: number
  relativeLuminance: number
  stopsAboveReferenceWhite: number | null
  target?: DisplayTarget
}

export interface HdrPhotoPixel extends HdrPixel {
  photoId: string
  revision: number
  renderingIdentity: string
}
