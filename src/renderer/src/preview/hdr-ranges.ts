import { luminance, type DisplayTarget, type RGB } from '../../../shared/hdr'

/** Diagnostic colors are SDR encoded colors, independent of the photograph's tone curve. */
export function hdrRangeColor(rgb: RGB, target: DisplayTarget, x: number, y: number): RGB | null {
  const maximum = luminance(rgb)
  if (maximum <= 1) return null
  if (target.headroom !== null && maximum > target.headroom)
    return (Math.floor(x) + Math.floor(y)) % 8 < 4 ? [1, 0, 0] : [0.35, 0.02, 0.02]
  if (maximum <= 2) return [0, 1, 1]
  if (maximum <= 4) return [0, 0, 1]
  if (maximum <= 8) return [0.6, 0, 1]
  return [1, 0, 1]
}

export const hdrRangesWgsl = /* wgsl */ `
fn hdrRangeColor(rgb:vec3f, point:vec2f)->vec4f {
  let maximum=dot(rgb,vec3f(.2627002120112671,.6779980715188708,.059301716469862));
  if(maximum<=1.) { return vec4f(0.); }
  if(u.values[10].z>0. && maximum>u.values[10].w) {
    let stripe=(u32(floor(point.x))+u32(floor(point.y)))%8u<4u;
    return vec4f(select(vec3f(.35,.02,.02),vec3f(1.,0.,0.),stripe),1.);
  }
  if(maximum<=2.) { return vec4f(0.,1.,1.,1.); }
  if(maximum<=4.) { return vec4f(0.,0.,1.,1.); }
  if(maximum<=8.) { return vec4f(.6,0.,1.,1.); }
  return vec4f(1.,0.,1.,1.);
}`
