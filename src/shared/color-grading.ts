import type { ColorPrimaries, ColorTriple } from './color-model'
import {
  colorSmoothstep,
  creativeLab,
  creativeLabResult,
  labLightness,
  labLightnessRatio,
  type CreativeLabValue,
} from './creative-color-lab'
import { gradingHueDirection } from './color-mixer'

export const COLOR_GRADING_VERSION = 'cie-lab-d65-three-way-stops-v1'
export const gradingToneIds = ['shadows', 'midtones', 'highlights'] as const
export type GradingToneId = (typeof gradingToneIds)[number]
export interface GradingTone {
  readonly hue: number
  readonly saturation: number
  readonly luminance: number
}
export interface ColorGradingSettings {
  readonly version: 1
  readonly tones: Readonly<Record<GradingToneId, GradingTone>>
  readonly blending: number
  readonly balance: number
}
export interface ColorGradingPatch {
  readonly version?: 1
  readonly tones?: Partial<Record<GradingToneId, Partial<GradingTone>>>
  readonly blending?: number
  readonly balance?: number
}
const neutralTone: GradingTone = Object.freeze({ hue: 0, saturation: 0, luminance: 0 })
export const neutralColorGrading: ColorGradingSettings = Object.freeze({
  version: 1,
  tones: Object.freeze({ shadows: neutralTone, midtones: neutralTone, highlights: neutralTone }),
  blending: 50,
  balance: 0,
})
const keys = (value: object, names: string[]) =>
  Object.keys(value).sort().join(',') === names.sort().join(',')
export function validateColorGrading(value: unknown): asserts value is ColorGradingSettings {
  const grade = value as ColorGradingSettings | null
  if (
    !grade ||
    typeof grade !== 'object' ||
    Array.isArray(grade) ||
    !keys(grade, ['version', 'tones', 'blending', 'balance']) ||
    grade.version !== 1 ||
    !grade.tones ||
    typeof grade.tones !== 'object' ||
    Array.isArray(grade.tones) ||
    !keys(grade.tones, [...gradingToneIds]) ||
    !Number.isInteger(grade.blending) ||
    grade.blending < 0 ||
    grade.blending > 100 ||
    !Number.isInteger(grade.balance) ||
    grade.balance < -100 ||
    grade.balance > 100
  )
    throw new Error('Invalid color grading settings.')
  for (const id of gradingToneIds) {
    const tone = grade.tones[id]
    if (
      !tone ||
      typeof tone !== 'object' ||
      Array.isArray(tone) ||
      !keys(tone, ['hue', 'saturation', 'luminance']) ||
      typeof tone.hue !== 'number' ||
      !Number.isFinite(tone.hue) ||
      tone.hue < 0 ||
      tone.hue >= 360 ||
      Math.abs(tone.hue * 10 - Math.round(tone.hue * 10)) > 1e-8 ||
      !Number.isInteger(tone.saturation) ||
      tone.saturation < 0 ||
      tone.saturation > 100 ||
      !Number.isInteger(tone.luminance) ||
      tone.luminance < -100 ||
      tone.luminance > 100
    )
      throw new Error('Invalid color grading tone.')
  }
}

export function mergeColorGrading(
  base: ColorGradingSettings,
  value: ColorGradingPatch,
): ColorGradingSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['version', 'tones', 'blending', 'balance'].includes(key)) ||
    ('version' in value && value.version !== 1) ||
    ('tones' in value &&
      (!value.tones ||
        typeof value.tones !== 'object' ||
        Array.isArray(value.tones) ||
        Object.keys(value.tones).some((id) => !gradingToneIds.includes(id as GradingToneId))))
  )
    throw new Error('Invalid color grading patch.')
  const tones = Object.fromEntries(
    gradingToneIds.map((id) => {
      const tone = value.tones?.[id]
      if (
        value.tones &&
        id in value.tones &&
        (!tone ||
          typeof tone !== 'object' ||
          Array.isArray(tone) ||
          Object.keys(tone).some((key) => !['hue', 'saturation', 'luminance'].includes(key)))
      )
        throw new Error('Invalid color grading tone patch.')
      return [id, { ...base.tones[id], ...tone }]
    }),
  ) as Record<GradingToneId, GradingTone>
  const result: ColorGradingSettings = {
    version: 1,
    tones,
    blending: 'blending' in value ? value.blending! : base.blending,
    balance: 'balance' in value ? value.balance! : base.balance,
  }
  validateColorGrading(result)
  return result
}
export function validateColorGradingPatch(value: unknown): asserts value is ColorGradingPatch {
  mergeColorGrading(neutralColorGrading, value as ColorGradingPatch)
}
export interface CompiledColorGrading {
  readonly active: boolean
  readonly tones: readonly (readonly [number, number, number])[]
  readonly width: number
  readonly balanceStops: number
}
export function compileColorGrading(settings: ColorGradingSettings): CompiledColorGrading {
  validateColorGrading(settings)
  return Object.freeze({
    active: gradingToneIds.some(
      (id) => settings.tones[id].saturation !== 0 || settings.tones[id].luminance !== 0,
    ),
    tones: Object.freeze(
      gradingToneIds.map((id) => {
        const tone = settings.tones[id],
          direction = gradingHueDirection(tone.hue)
        return Object.freeze([
          (direction[0] * tone.saturation) / 200,
          (direction[1] * tone.saturation) / 200,
          tone.luminance / 100,
        ] as const)
      }),
    ),
    width: 0.5 + (3.5 * settings.blending) / 100,
    balanceStops: settings.balance / 50,
  })
}

export function colorGradingWeights(
  y: number,
  grade: Pick<CompiledColorGrading, 'width' | 'balanceStops'>,
): readonly [number, number, number] {
  if (y <= 0) return [1, 0, 0]
  const z = Math.log2(y / 0.18) + grade.balanceStops,
    left = colorSmoothstep((z + 2 + grade.width) / (2 * grade.width)),
    right = colorSmoothstep((z - 2 + grade.width) / (2 * grade.width))
  return [1 - left, left - right, right]
}

/** Grade color preserves linear Y; explicit tone luminance uses fixed entering weights. */
export function applyColorGrading(
  rgb: ColorTriple,
  grade: CompiledColorGrading,
  primaries: ColorPrimaries,
): ColorTriple {
  if (!grade.active) return rgb
  const original = creativeLab(rgb, primaries),
    initial = { y: original.xyz[1], a: original.a, b: original.b },
    changed = colorGradingLab(initial, colorGradingAmounts(initial.y, grade))
  return creativeLabResult(rgb, primaries, original, changed.y, changed.a, changed.b)
}

export function colorGradingAmounts(
  y: number,
  grade: CompiledColorGrading,
): readonly [number, number, number] {
  if (!grade.active) return [0, 0, 0]
  const weights = colorGradingWeights(y, grade)
  let a = 0,
    b = 0,
    ev = 0
  for (let index = 0; index < 3; index++) {
    a += weights[index] * grade.tones[index][0]
    b += weights[index] * grade.tones[index][1]
    ev += weights[index] * grade.tones[index][2]
  }
  // Nonpositive lightness intentionally receives no additive tint.
  return [y > 0 ? a : 0, y > 0 ? b : 0, ev]
}

export function colorGradingLab(
  original: CreativeLabValue,
  amounts: readonly [number, number, number],
): CreativeLabValue {
  const [a, b, ev] = amounts
  if (a === 0 && b === 0 && ev === 0) return original
  const gain = ev === 0 ? 1 : 2 ** ev,
    y = original.y * gain,
    ratio = labLightnessRatio(original.y, y, gain),
    strength = Math.max(0, labLightness(y))
  return { y, a: original.a * ratio + strength * a, b: original.b * ratio + strength * b }
}
