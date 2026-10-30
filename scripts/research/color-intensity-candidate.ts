import {
  workingToOklab,
  oklabToWorking,
  type ColorPrimaries,
  type ColorTriple,
} from '../../src/shared/color-model.ts'

/** Research only: saturated positive inputs can produce nonpositive linear Y.
 * Do not integrate this candidate into photo settings or rendering. See the
 * professional-editing processing decision record and retained domain evidence.
 */
export const COLOR_INTENSITY_VERSION = 'oklab-chroma-intensity-v1'
export interface ColorIntensityParameters {
  saturation: number
  vibrance: number
}

/** Preserve Oklab lightness/hue; no gamut mapping or clipping.
 * Saturation scales chroma linearly. Vibrance weights low relative chroma more,
 * with an exposure-independent gain from one-half to two; it does not detect skin.
 * Callers must supply integer -100…100 parameters.
 */
export function colorIntensity(
  rgb: ColorTriple,
  primaries: ColorPrimaries,
  { saturation, vibrance }: ColorIntensityParameters,
): ColorTriple {
  if ((saturation === 0 && vibrance === 0) || (rgb[0] === rgb[1] && rgb[1] === rgb[2])) return rgb
  const [lightness, a, b] = workingToOklab(rgb, primaries)
  if (saturation === -100) {
    const neutral = lightness ** 3
    return [neutral, neutral, neutral]
  }
  const lightnessSquared = lightness * lightness
  const denominator = lightnessSquared + 16 * (a * a + b * b)
  const weight = denominator > 0 ? lightnessSquared / denominator : 0
  const gain = (1 + saturation / 100) * 2 ** ((vibrance / 100) * weight)
  if (gain === 1) return rgb
  return oklabToWorking([lightness, a * gain, b * gain], primaries)
}
