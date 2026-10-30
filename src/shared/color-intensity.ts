import {
  workingToXyz,
  xyzToWorking,
  RGB_TO_XYZ,
  XYZ_TO_RGB,
  type ColorPrimaries,
  type ColorTriple,
} from './color-model'

export const COLOR_INTENSITY_VERSION = 'cie-lab-d65-chroma-v1'
export interface ColorIntensityParameters {
  saturation: number
  vibrance: number
}
export const D65_XYZ: ColorTriple = [3127 / 3290, 1, 3583 / 3290]

function labF(value: number): number {
  return value > 216 / 24389 ? Math.cbrt(value) : ((24389 / 27) * value + 16) / 116
}
function inverseLabF(value: number): number {
  return value > 6 / 29 ? value * value * value : (116 * value - 16) * (27 / 24389)
}
export { labF as cieLabF, inverseLabF as cieLabInverse }

/** CIE 1976 Lab relative to D65, extended without clipping signed or HDR channels. */
export function workingToCieLab(rgb: ColorTriple, primaries: ColorPrimaries): ColorTriple {
  const xyz = workingToXyz(rgb, primaries)
  const x = labF(xyz[0] / D65_XYZ[0]),
    y = labF(xyz[1]),
    z = labF(xyz[2] / D65_XYZ[2])
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** Preserve linear Y and CIE Lab hue; creative out-of-gamut channels stay unclipped. */
export function applyColorIntensity(
  rgb: ColorTriple,
  { saturation, vibrance }: ColorIntensityParameters,
  primaries: ColorPrimaries,
): ColorTriple {
  if ((saturation === 0 && vibrance === 0) || (rgb[0] === rgb[1] && rgb[1] === rgb[2])) return rgb
  const xyz = workingToXyz(rgb, primaries)
  if (saturation === -100) return [xyz[1], xyz[1], xyz[1]]
  const f = labF(xyz[1])
  const lightness = 116 * f - 16
  const a = 500 * (labF(xyz[0] / D65_XYZ[0]) - f)
  const b = 200 * (f - labF(xyz[2] / D65_XYZ[2]))
  const denominator = lightness * lightness + 4 * (a * a + b * b)
  const weight = denominator > 0 ? (lightness * lightness) / denominator : 0
  const gain = (1 + saturation / 100) * 2 ** ((vibrance / 100) * weight)
  if (gain === 1) return rgb
  return xyzToWorking(
    [
      D65_XYZ[0] * inverseLabF(f + (gain * a) / 500),
      xyz[1],
      D65_XYZ[2] * inverseLabF(f - (gain * b) / 200),
    ],
    primaries,
  )
}

const numeric = (value: number) => (Number.isInteger(value) ? `${value}.0` : String(value))
const row = (values: ColorTriple) => values.map(numeric).join(',')

/** The point operator shares matrix constants with CPU; HDR uses its canonical power helper. */
export function colorIntensityWgsl(primaries: ColorPrimaries, power = 'pow'): string {
  const forward = RGB_TO_XYZ[primaries],
    inverse = XYZ_TO_RGB[primaries]
  return `
fn colorLabF(v:f32)->f32 {
  if(v>216./24389.) { return ${power}(v,1./3.); }
  return ((24389./27.)*v+16.)/116.;
}
fn colorLabInverse(v:f32)->f32 {
  if(v>6./29.) { return v*v*v; }
  return (116.*v-16.)*(27./24389.);
}
// Evaluate a small chroma change without a lossy RGB/XYZ round trip.
fn colorLabDelta(v:f32,d:f32)->f32 {
  let next=v+d;
  if(v>6./29. && next>6./29.) { return d*(next*next+next*v+v*v); }
  if(v<=6./29. && next<=6./29.) { return d*(116.*27./24389.); }
  return colorLabInverse(next)-colorLabInverse(v);
}
fn applyColorIntensity(rgb:vec3f,color:vec2f)->vec3f {
  if(all(color==vec2f(0.)) || all(rgb==vec3f(rgb.x))) { return rgb; }
  let xyz=vec3f(dot(vec3f(${row(forward[0])}),rgb),dot(vec3f(${row(forward[1])}),rgb),dot(vec3f(${row(forward[2])}),rgb));
  if(color.x == -100.) { return vec3f(xyz.y); }
  let f=colorLabF(xyz.y);
  let lightness=116.*f-16.;
  let fx=colorLabF(xyz.x/${numeric(D65_XYZ[0])});
  let fz=colorLabF(xyz.z/${numeric(D65_XYZ[2])});
  let a=500.*(fx-f);
  let b=200.*(f-fz);
  let d=lightness*lightness+4.*(a*a+b*b);
  var w=0.; if(d>0.) { w=lightness*lightness/d; }
  let gain=(1.+color.x/100.)*${power}(2.,color.y/100.*w);
  if(gain==1.) { return rgb; }
  let dx=${numeric(D65_XYZ[0])}*colorLabDelta(fx,(gain-1.)*(fx-f));
  let dz=${numeric(D65_XYZ[2])}*colorLabDelta(fz,(gain-1.)*(fz-f));
  return rgb+vec3f(${numeric(inverse[0][0])},${numeric(inverse[1][0])},${numeric(inverse[2][0])})*dx+vec3f(${numeric(inverse[0][2])},${numeric(inverse[1][2])},${numeric(inverse[2][2])})*dz;
}
`
}

export function colorIntensityGlslFor(primaries: ColorPrimaries): string {
  return `
float colorLabF(float v) { return v>216.0/24389.0 ? pow(v,1.0/3.0) : ((24389.0/27.0)*v+16.0)/116.0; }
float colorLabInverse(float v) { return v>6.0/29.0 ? v*v*v : (116.0*v-16.0)*(27.0/24389.0); }
float colorLabDelta(float v,float d) {
  float next=v+d;
  if(v>6.0/29.0 && next>6.0/29.0) return d*(next*next+next*v+v*v);
  if(v<=6.0/29.0 && next<=6.0/29.0) return d*(116.0*27.0/24389.0);
  return colorLabInverse(next)-colorLabInverse(v);
}
vec3 applyColorIntensity(vec3 rgb,vec2 color) {
  if(all(equal(color,vec2(0))) || all(equal(rgb,vec3(rgb.r)))) return rgb;
  vec3 xyz=vec3(dot(vec3(${row(RGB_TO_XYZ[primaries][0])}),rgb),dot(vec3(${row(RGB_TO_XYZ[primaries][1])}),rgb),dot(vec3(${row(RGB_TO_XYZ[primaries][2])}),rgb));
  if(color.x == -100.0) return vec3(xyz.y);
  float f=colorLabF(xyz.y),lightness=116.0*f-16.0;
  float fx=colorLabF(xyz.x/${numeric(D65_XYZ[0])}),fz=colorLabF(xyz.z/${numeric(D65_XYZ[2])});
  float a=500.0*(fx-f),b=200.0*(f-fz);
  float d=lightness*lightness+4.0*(a*a+b*b),w=d>0.0 ? lightness*lightness/d : 0.0;
  float gain=(1.0+color.x/100.0)*pow(2.0,color.y/100.0*w);
  if(gain==1.0) return rgb;
  float dx=${numeric(D65_XYZ[0])}*colorLabDelta(fx,(gain-1.0)*(fx-f));
  float dz=${numeric(D65_XYZ[2])}*colorLabDelta(fz,(gain-1.0)*(fz-f));
  return rgb+vec3(${numeric(XYZ_TO_RGB[primaries][0][0])},${numeric(XYZ_TO_RGB[primaries][1][0])},${numeric(XYZ_TO_RGB[primaries][2][0])})*dx+vec3(${numeric(XYZ_TO_RGB[primaries][0][2])},${numeric(XYZ_TO_RGB[primaries][1][2])},${numeric(XYZ_TO_RGB[primaries][2][2])})*dz;
}
`
}
export const colorIntensityGlsl = colorIntensityGlslFor('srgb')

export const colorIntensityModule = {
  id: 'color-intensity',
  version: 1,
  parameters: {
    saturation: { min: -100, max: 100, step: 1, default: 0 },
    vibrance: { min: -100, max: 100, step: 1, default: 0 },
  },
  cpu: applyColorIntensity,
  glsl: colorIntensityGlsl,
  wgsl: colorIntensityWgsl('srgb'),
} as const
