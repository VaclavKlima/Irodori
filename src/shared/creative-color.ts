import {
  applyColorIntensity,
  COLOR_INTENSITY_VERSION,
  type ColorIntensityParameters,
} from './color-intensity'
import {
  colorMixerLab,
  colorMixerSelection,
  compileColorMixer,
  COLOR_MIXER_VERSION,
  colorRangeIds,
  neutralColorMixer,
  validateColorMixer,
  type ColorMixerSettings,
  type CompiledColorMixer,
} from './color-mixer'
import {
  colorGradingAmounts,
  colorGradingLab,
  compileColorGrading,
  COLOR_GRADING_VERSION,
  gradingToneIds,
  neutralColorGrading,
  validateColorGrading,
  type ColorGradingSettings,
  type CompiledColorGrading,
} from './color-grading'
import {
  creativeLab,
  creativeLabResult,
  labLightness,
  type CreativeLabValue,
} from './creative-color-lab'
import type { ColorPrimaries, ColorTriple } from './color-model'

export const CREATIVE_COLOR_VERSION = `${COLOR_MIXER_VERSION}_${COLOR_INTENSITY_VERSION}_${COLOR_GRADING_VERSION}`
export interface CompiledCreativeColor {
  readonly mixer: CompiledColorMixer
  readonly grading: CompiledColorGrading
  readonly intensity: Readonly<ColorIntensityParameters>
}
export interface CreativeColorSettings extends ColorIntensityParameters {
  colorMixer?: ColorMixerSettings
  colorGrading?: ColorGradingSettings
}

export function creativeColorActive(
  color: CompiledCreativeColor | undefined,
): color is CompiledCreativeColor {
  return Boolean(color?.mixer.active || color?.grading.active)
}

/** Authored controls, including powerless hues, in stable order. Neutral omits the extension. */
export function creativeColorIdentity(
  settings: CreativeColorSettings,
): readonly number[] | undefined {
  if (settings.colorMixer === undefined && settings.colorGrading === undefined) return undefined
  if (settings.colorMixer !== undefined) validateColorMixer(settings.colorMixer)
  if (settings.colorGrading !== undefined) validateColorGrading(settings.colorGrading)
  if (sameCreativeColor(settings, { saturation: 0, vibrance: 0 })) return undefined
  const m = settings.colorMixer ?? neutralColorMixer,
    g = settings.colorGrading ?? neutralColorGrading
  return [
    m.version,
    ...colorRangeIds.flatMap((id) => [
      m.ranges[id].hue,
      m.ranges[id].saturation,
      m.ranges[id].luminance,
    ]),
    g.version,
    g.blending,
    g.balance,
    ...gradingToneIds.flatMap((id) => [
      g.tones[id].hue,
      g.tones[id].saturation,
      g.tones[id].luminance,
    ]),
  ]
}

/** Frame/band callers retain this snapshot outside their pixel loop. */
export function prepareCreativeColor(
  settings: CreativeColorSettings,
): CompiledCreativeColor | undefined {
  if (settings.colorMixer === undefined && settings.colorGrading === undefined) return undefined
  return compileCreativeColor(
    settings.colorMixer === undefined ? neutralColorMixer : settings.colorMixer,
    settings,
    settings.colorGrading === undefined ? neutralColorGrading : settings.colorGrading,
  )
}

/** Compare persisted controls, including a powerless hue; object key order is irrelevant. */
export function sameCreativeColor(
  a: CreativeColorSettings | undefined,
  b: CreativeColorSettings,
): boolean {
  if (a?.colorMixer === b.colorMixer && a?.colorGrading === b.colorGrading) return true
  const am = a?.colorMixer ?? neutralColorMixer,
    bm = b.colorMixer ?? neutralColorMixer,
    ag = a?.colorGrading ?? neutralColorGrading,
    bg = b.colorGrading ?? neutralColorGrading
  return (
    am.version === bm.version &&
    ag.version === bg.version &&
    ag.blending === bg.blending &&
    ag.balance === bg.balance &&
    colorRangeIds.every(
      (id) =>
        am.ranges[id].hue === bm.ranges[id].hue &&
        am.ranges[id].saturation === bm.ranges[id].saturation &&
        am.ranges[id].luminance === bm.ranges[id].luminance,
    ) &&
    gradingToneIds.every(
      (id) =>
        ag.tones[id].hue === bg.tones[id].hue &&
        ag.tones[id].saturation === bg.tones[id].saturation &&
        ag.tones[id].luminance === bg.tones[id].luminance,
    )
  )
}

export const CREATIVE_COLOR_COMPONENTS = 52

/** Canonical logical layout shared by GPU packing and the bounded native request. */
export function creativeColorValues(controls: CompiledCreativeColor): Float64Array<ArrayBuffer> {
  const values = new Float64Array(CREATIVE_COLOR_COMPONENTS)
  values.set([
    controls.intensity.saturation,
    controls.intensity.vibrance,
    Number(controls.mixer.active),
    Number(controls.grading.active),
    controls.grading.width,
    controls.grading.balanceStops,
  ])
  for (const [index, vector] of controls.mixer.ranges.entries()) values.set(vector, 8 + index * 4)
  for (const [index, vector] of controls.grading.tones.entries()) values.set(vector, 40 + index * 4)
  return values
}
export function compileCreativeColor(
  mixer: ColorMixerSettings,
  intensity: ColorIntensityParameters,
  grading: ColorGradingSettings,
): CompiledCreativeColor {
  if (
    ![intensity.saturation, intensity.vibrance].every(
      (value) => Number.isInteger(value) && value >= -100 && value <= 100,
    )
  )
    throw new Error('Invalid global color intensity.')
  return Object.freeze({
    mixer: compileColorMixer(mixer),
    grading: compileColorGrading(grading),
    intensity: Object.freeze({ saturation: intensity.saturation, vibrance: intensity.vibrance }),
  })
}

function intensityLab(
  value: CreativeLabValue,
  intensity: ColorIntensityParameters,
): CreativeLabValue {
  if (intensity.saturation === 0 && intensity.vibrance === 0) return value
  if (intensity.saturation === -100) return { ...value, a: 0, b: 0 }
  const l = labLightness(value.y),
    denominator = l * l + 4 * (value.a * value.a + value.b * value.b),
    weight = denominator > 0 ? (l * l) / denominator : 0,
    gain = (1 + intensity.saturation / 100) * 2 ** ((intensity.vibrance / 100) * weight)
  return gain === 1 ? value : { ...value, a: value.a * gain, b: value.b * gain }
}

/** One Lab reconstruction for all creative operators; old neutral processing stays exact. */
export function applyCreativeColor(
  rgb: ColorTriple,
  controls: CompiledCreativeColor,
  primaries: ColorPrimaries,
): ColorTriple {
  if (!controls.mixer.active && !controls.grading.active)
    return applyColorIntensity(rgb, controls.intensity, primaries)
  const original = creativeLab(rgb, primaries),
    initial: CreativeLabValue = { y: original.xyz[1], a: original.a, b: original.b },
    mixed = controls.mixer.active
      ? colorMixerLab(initial, controls.mixer, colorMixerSelection(rgb, primaries))
      : initial,
    grade = colorGradingAmounts(mixed.y, controls.grading)
  if (mixed === initial && grade.every((v) => v === 0))
    return applyColorIntensity(rgb, controls.intensity, primaries)
  const colored = intensityLab(mixed, controls.intensity),
    result = colorGradingLab(colored, grade)
  return creativeLabResult(rgb, primaries, original, result.y, result.a, result.b)
}
