import { creativeColorValues, type CompiledCreativeColor } from './creative-color'
import type { ColorPrimaries } from './color-model'
import { creativeColorPrecisionWgsl } from './creative-color-precision-wgsl'

/** Two headers, eight range rotations and three tone vectors, stored as high/low pairs.
 * Header 1's unused channels remain positive zero, including the WebGL rounding word. */
export const CREATIVE_COLOR_PARAMETER_VECTORS = 26
export const CREATIVE_COLOR_PARAMETER_FLOATS = CREATIVE_COLOR_PARAMETER_VECTORS * 4
export const CREATIVE_COLOR_PARAMETER_BYTES = CREATIVE_COLOR_PARAMETER_FLOATS * 4

export function packCreativeColor(
  controls: CompiledCreativeColor,
  target = new Float32Array(CREATIVE_COLOR_PARAMETER_FLOATS),
): Float32Array<ArrayBuffer> {
  if (target.length !== CREATIVE_COLOR_PARAMETER_FLOATS)
    throw new Error('Invalid creative-color parameter allocation.')
  target.fill(0)
  const values = creativeColorValues(controls)
  for (let index = 0; index < values.length; index++) {
    const at = Math.floor(index / 4) * 8 + (index % 4),
      value = values[index]
    target[at] = Math.fround(value)
    target[at + 4] = Math.fround(value - target[at])
  }
  return target
}

/** Fused point shader; neutral controls use the unchanged existing intensity operator. */
export function creativeColorWgsl(primaries: ColorPrimaries, binding = 8, power = 'pow'): string {
  if (!Number.isInteger(binding) || binding < 0 || binding > 15)
    throw new Error('Invalid creative-color binding.')
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(power)) throw new Error('Invalid GPU power function.')
  return creativeColorPrecisionWgsl(primaries, binding, power)
}
