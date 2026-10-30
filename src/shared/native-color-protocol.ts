import { neutralColorMixer } from './color-mixer'
import { neutralColorGrading } from './color-grading'
import {
  CREATIVE_COLOR_COMPONENTS,
  compileCreativeColor,
  creativeColorValues,
  type CreativeColorSettings,
} from './creative-color'

export const NATIVE_COLOR_PACKET_BYTES = CREATIVE_COLOR_COMPONENTS * 8
export const NATIVE_CPU_COLOR_OFFSET = 416
export const NATIVE_MASK_COLOR_OFFSET = 432
export const NATIVE_CPU_REQUEST_BYTES = NATIVE_CPU_COLOR_OFFSET + NATIVE_COLOR_PACKET_BYTES
export const NATIVE_MASK_REQUEST_BYTES = NATIVE_MASK_COLOR_OFFSET + NATIVE_COLOR_PACKET_BYTES

/** A request owns its complete compiled packet, including neutral operators. */
export function nativeColorValues(settings: CreativeColorSettings): Float64Array<ArrayBuffer> {
  return creativeColorValues(
    compileCreativeColor(
      settings.colorMixer ?? neutralColorMixer,
      settings,
      settings.colorGrading ?? neutralColorGrading,
    ),
  )
}
