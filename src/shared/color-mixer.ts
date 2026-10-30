import type { ColorPrimaries, ColorTriple } from './color-model'
import {
  colorSmoothstep,
  creativeLab,
  creativeLabResult,
  labLightnessRatio,
  type CreativeLabValue,
} from './creative-color-lab'

export const COLOR_MIXER_VERSION = 'cie-lab-d65-reference-neighbor-v1'
export const colorRangeIds = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
] as const
export type ColorRangeId = (typeof colorRangeIds)[number]
export interface ColorRangeAmounts {
  readonly hue: number
  readonly saturation: number
  readonly luminance: number
}
export interface ColorMixerSettings {
  readonly version: 1
  readonly ranges: Readonly<Record<ColorRangeId, ColorRangeAmounts>>
}
export interface ColorMixerPatch {
  readonly version?: 1
  readonly ranges?: Partial<Record<ColorRangeId, Partial<ColorRangeAmounts>>>
}
const noAmounts: ColorRangeAmounts = Object.freeze({ hue: 0, saturation: 0, luminance: 0 })
export const neutralColorMixer: ColorMixerSettings = Object.freeze({
  version: 1,
  ranges: Object.freeze(
    Object.fromEntries(colorRangeIds.map((id) => [id, noAmounts])) as Record<
      ColorRangeId,
      ColorRangeAmounts
    >,
  ),
})

const nominalHues = [0, 30, 60, 120, 180, 240, 270, 300]
const encodedReferences: readonly ColorTriple[] = [
  [1, 0, 0],
  [1, 0.5, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
  [0.5, 0, 1],
  [1, 0, 1],
]
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export const colorRangeDefinitions = Object.freeze(
  colorRangeIds.map((id, index) => {
    const encoded = encodedReferences[index],
      lab = creativeLab([decode(encoded[0]), decode(encoded[1]), decode(encoded[2])], 'srgb'),
      length = Math.hypot(lab.a, lab.b),
      angle = (Math.atan2(lab.b, lab.a) * 180) / Math.PI
    return Object.freeze({
      id,
      nominalHue: nominalHues[index],
      labHue: (angle + 360) % 360,
      direction: Object.freeze([lab.a / length, lab.b / length]) as readonly [number, number],
      encoded: Object.freeze([...encoded]) as ColorTriple,
    })
  }),
)

const exactKeys = (value: object, expected: readonly string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',')
export function validateColorMixer(value: unknown): asserts value is ColorMixerSettings {
  const mixer = value as ColorMixerSettings | null
  if (
    !mixer ||
    typeof mixer !== 'object' ||
    Array.isArray(mixer) ||
    !exactKeys(mixer, ['version', 'ranges']) ||
    mixer.version !== 1 ||
    !mixer.ranges ||
    typeof mixer.ranges !== 'object' ||
    Array.isArray(mixer.ranges) ||
    !exactKeys(mixer.ranges, colorRangeIds)
  )
    throw new Error('Invalid color mixer settings.')
  for (const id of colorRangeIds) {
    const amounts = mixer.ranges[id]
    if (
      !amounts ||
      typeof amounts !== 'object' ||
      Array.isArray(amounts) ||
      !exactKeys(amounts, ['hue', 'saturation', 'luminance']) ||
      !Object.values(amounts).every(
        (v) => typeof v === 'number' && Number.isInteger(v) && v >= -100 && v <= 100,
      )
    )
      throw new Error('Color mixer amounts must be integers between -100 and +100.')
  }
}

/** Merge only declared fields; incomplete groups never enter processing or history. */
export function mergeColorMixer(
  base: ColorMixerSettings,
  value: ColorMixerPatch,
): ColorMixerSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['version', 'ranges'].includes(key)) ||
    ('version' in value && value.version !== 1) ||
    ('ranges' in value &&
      (!value.ranges ||
        typeof value.ranges !== 'object' ||
        Array.isArray(value.ranges) ||
        Object.keys(value.ranges).some((id) => !colorRangeIds.includes(id as ColorRangeId))))
  )
    throw new Error('Invalid color mixer patch.')
  const ranges = Object.fromEntries(
    colorRangeIds.map((id) => {
      const amounts = value.ranges?.[id]
      if (
        value.ranges &&
        id in value.ranges &&
        (!amounts ||
          typeof amounts !== 'object' ||
          Array.isArray(amounts) ||
          Object.keys(amounts).some((key) => !['hue', 'saturation', 'luminance'].includes(key)))
      )
        throw new Error('Invalid color mixer range patch.')
      return [id, { ...base.ranges[id], ...amounts }]
    }),
  ) as Record<ColorRangeId, ColorRangeAmounts>
  const result: ColorMixerSettings = { version: 1, ranges }
  validateColorMixer(result)
  return result
}
export function validateColorMixerPatch(value: unknown): asserts value is ColorMixerPatch {
  mergeColorMixer(neutralColorMixer, value as ColorMixerPatch)
}
export interface CompiledColorMixer {
  readonly active: boolean
  /** Rotation real delta/imaginary, saturation delta, and luminance EV. */
  readonly ranges: readonly (readonly [number, number, number, number])[]
}
export function compileColorMixer(settings: ColorMixerSettings): CompiledColorMixer {
  validateColorMixer(settings)
  return Object.freeze({
    active: colorRangeIds.some((id) => Object.values(settings.ranges[id]).some((v) => v !== 0)),
    ranges: Object.freeze(
      colorRangeIds.map((id) => {
        const v = settings.ranges[id],
          angle = (v.hue * Math.PI) / 600
        return Object.freeze([
          Math.cos(angle) - 1,
          Math.sin(angle),
          v.saturation / 100,
          v.luminance / 100,
        ] as const)
      }),
    ),
  })
}

/** One circular input selection; no atan2, cascading range edits or luminance division. */
export function colorMixerSelection(rgb: ColorTriple, primaries: ColorPrimaries) {
  const empty = { first: 0, second: 1, blend: 0, protection: 0 }
  if (rgb[0] === rgb[1] && rgb[1] === rgb[2]) return empty
  const peak = Math.max(Math.abs(rgb[0]), Math.abs(rgb[1]), Math.abs(rgb[2]))
  if (peak === 0) return empty
  const lab = creativeLab([rgb[0] / peak, rgb[1] / peak, rgb[2] / peak], primaries),
    chroma2 = lab.a * lab.a + lab.b * lab.b,
    denominator = lab.l * lab.l + 4 * chroma2,
    protection = colorSmoothstep(((denominator > 0 ? chroma2 / denominator : 0) - 0.0004) / 0.006)
  if (protection === 0) return empty
  const cross = (direction: readonly [number, number]) =>
      direction[0] * lab.b - direction[1] * lab.a,
    firstCross = cross(colorRangeDefinitions[0].direction)
  let left = firstCross
  for (let index = 0; index < colorRangeIds.length; index++) {
    const next = (index + 1) % colorRangeIds.length,
      nextCross = next === 0 ? firstCross : cross(colorRangeDefinitions[next].direction),
      right = -nextCross
    if (left >= 0 && right >= 0 && left + right > 0)
      return {
        first: index,
        second: next,
        blend: colorSmoothstep(left / (left + right)),
        protection,
      }
    left = nextCross
  }
  throw new Error('The color mixer hue has no reference interval.')
}

/** Hue/saturation preserve linear Y; explicit luminance amount scales Y by up to one stop. */
export function applyColorMixer(
  rgb: ColorTriple,
  mixer: CompiledColorMixer,
  primaries: ColorPrimaries,
): ColorTriple {
  if (!mixer.active) return rgb
  const selected = colorMixerSelection(rgb, primaries)
  if (selected.protection === 0) return rgb
  const original = creativeLab(rgb, primaries),
    initial = { y: original.xyz[1], a: original.a, b: original.b },
    changed = colorMixerLab(initial, mixer, selected)
  return creativeLabResult(rgb, primaries, original, changed.y, changed.a, changed.b)
}

/** Lab stage shared by standalone references and the fused point kernel. */
export function colorMixerLab(
  original: CreativeLabValue,
  mixer: CompiledColorMixer,
  selected: ReturnType<typeof colorMixerSelection>,
): CreativeLabValue {
  if (!mixer.active || selected.protection === 0) return original
  const a = mixer.ranges[selected.first],
    b = mixer.ranges[selected.second],
    weight = selected.blend,
    p = selected.protection,
    dr = p * (a[0] * (1 - weight) + b[0] * weight),
    imaginary = p * (a[1] * (1 - weight) + b[1] * weight),
    saturation = p * (a[2] * (1 - weight) + b[2] * weight),
    ev = p * (a[3] * (1 - weight) + b[3] * weight)
  if (dr === 0 && imaginary === 0 && saturation === 0 && ev === 0) return original
  const real = 1 + dr,
    length = Math.hypot(real, imaginary),
    cosineDelta = (-imaginary * imaginary) / (length * (real + length)),
    sine = imaginary / length,
    gain = ev === 0 ? 1 : 2 ** ev,
    y = original.y * gain,
    scale = (1 + saturation) * labLightnessRatio(original.y, y, gain),
    nextA = (original.a + cosineDelta * original.a - sine * original.b) * scale,
    nextB = (original.b + sine * original.a + cosineDelta * original.b) * scale
  return { y, a: nextA, b: nextB }
}

/** Familiar nominal wheel colors compile to bounded Lab directions once per tone edit. */
export function gradingHueDirection(hue: number): readonly [number, number] {
  const wrapped = ((hue % 360) + 360) % 360
  for (let index = 0; index < colorRangeDefinitions.length; index++) {
    const a = colorRangeDefinitions[index],
      next = (index + 1) % colorRangeDefinitions.length,
      b = colorRangeDefinitions[next],
      end = next === 0 ? 360 : b.nominalHue
    if (wrapped >= a.nominalHue && wrapped <= end) {
      const amount = (wrapped - a.nominalHue) / (end - a.nominalHue),
        x = a.direction[0] * (1 - amount) + b.direction[0] * amount,
        y = a.direction[1] * (1 - amount) + b.direction[1] * amount,
        length = Math.hypot(x, y)
      return [x / length, y / length]
    }
  }
  throw new Error('Invalid grading hue.')
}
