import type { HdrNormalization, RGB } from '../../shared/hdr'

// LibRaw 0.22.1 blend_highlights adapted under CDDL-1.0. See third_party/libraw.
// Copyright 2019–2025 LibRaw LLC; dcraw portions Copyright 1997–2018 Dave Coffin.
export interface SensorBlendParameters {
  saturation: RGB
  white: RGB
  clip: number
}

/** Thresholds and nominal white in the normalized, white-balanced camera frame. */
export function sensorBlendParameters(normal?: HdrNormalization): SensorBlendParameters | null {
  const thresholds = normal?.sourceSaturation?.thresholds
  if (
    !normal ||
    !thresholds ||
    thresholds.length !== 4 ||
    normal.black.length !== 4 ||
    normal.gains.length !== 4 ||
    !Number.isFinite(normal.maximum) ||
    normal.maximum <= 0 ||
    !normal.gains.every((v) => Number.isFinite(v) && v > 0)
  )
    return null
  const maximumGain = Math.max(...normal.gains)
  const white = normal.gains.map((v) => Math.fround(v / maximumGain))
  const saturation = thresholds.map((v, c) =>
    Math.fround(((v - normal.black[c]) / normal.maximum) * white[c]),
  )
  if (!saturation.every((v, c) => Number.isFinite(v) && v > 0 && white[c] - v > white[c] / 65535))
    return null
  return {
    saturation: [saturation[0], Math.min(saturation[1], saturation[3]), saturation[2]],
    white: [white[0], Math.min(white[1], white[3]), white[2]],
    clip: Math.min(...white),
  }
}

/** Preserve camera intensity while reducing chroma toward LibRaw's clipped-highlight chroma. */
export function sensorBlendRgb(rgb: RGB, p: SensorBlendParameters | null): RGB {
  if (!p) return rgb
  let t = 0
  for (let c = 0; c < 3; c++)
    t = Math.max(t, (rgb[c] - p.saturation[c]) / (p.white[c] - p.saturation[c]))
  if (t <= 0) return rgb
  t = Math.min(1, t)
  const weight = t * t * (3 - 2 * t)
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3
  const clipped = rgb.map((v) => Math.min(v, p.clip))
  const clippedMean = (clipped[0] + clipped[1] + clipped[2]) / 3
  const chroma = rgb.reduce((sum, v) => sum + (v - mean) ** 2, 0)
  if (chroma <= 1e-20) return rgb
  const clippedChroma = clipped.reduce((sum, v) => sum + (v - clippedMean) ** 2, 0)
  const ratio = Math.min(1, Math.sqrt(clippedChroma / chroma))
  const factor = 1 + weight * (ratio - 1)
  return rgb.map((v) => mean + (v - mean) * factor) as RGB
}

export const sensorBlendWgsl = /* wgsl */ `
fn sensorBlendRgb(rgb:vec3f, saturation:vec3f, white:vec3f, clip:f32)->vec3f {
  let progress=(rgb-saturation)/(white-saturation);
  let t=clamp(max(progress.x,max(progress.y,progress.z)),0.,1.);
  if(t<=0.) { return rgb; }
  let mean=(rgb.x+rgb.y+rgb.z)/3.;
  let clipped=min(rgb,vec3f(clip));
  let clippedMean=(clipped.x+clipped.y+clipped.z)/3.;
  let delta=rgb-vec3f(mean); let clippedDelta=clipped-vec3f(clippedMean);
  let chroma=dot(delta,delta);
  if(chroma<=1e-20) { return rgb; }
  let ratio=min(1.,sqrt(dot(clippedDelta,clippedDelta)/chroma));
  return vec3f(mean)+delta*(1.+t*t*(3.-2.*t)*(ratio-1.));
}`
