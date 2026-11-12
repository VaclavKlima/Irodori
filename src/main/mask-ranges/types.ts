import type { ColorPrimaries } from '../../shared/color-model'

/** Main-owned canonical source; paths never enter public photo operations. */
export interface MaskRangeSource {
  path: string
  width: number
  height: number
  byteLength: number
  sha256: string
  identity: string
  primaries: ColorPrimaries
}
