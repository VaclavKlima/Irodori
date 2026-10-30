import { colorIntensityWgsl } from './color-intensity'
import { creativeColorWgsl } from './creative-color-gpu'

/** Shared scene-linear white balance, Light and Color operators for preview and export. */
export function hdrAdjustmentShader(creative = false, binding = 12): string {
  return `
${creative ? creativeColorWgsl('rec2020', binding, 'acesPow') : colorIntensityWgsl('rec2020', 'acesPow')}
const irodori = vec3f(.2627002120112671, .6779980715188708, .059301716469862);
fn adjusted(input: vec3f) -> vec3f {
  var rgb = input;
  if (u.values[4].w > 0.) { rgb = vec3f(dot(u.values[5].xyz,rgb), dot(u.values[6].xyz,rgb), dot(u.values[7].xyz,rgb)); }
  rgb *= exp2(u.values[2].x);
  var y = dot(rgb,irodori);
  let contrast = u.values[2].y;
  if (contrast != 0. && y > 0. && y < 1.) {
    var next = .18 * pow(y/.18,exp2(contrast/100.));
    if (y > .18) { next = 1. - .82 * pow((1.-y)/.82,exp2(contrast/100.)); }
    rgb *= next/y;
  }
  y = dot(rgb,irodori);
  let h = u.values[2].z/100.;
  if (h != 0. && y > .18) { rgb *= ((1.+h)*y-h*(.18+.82*(y-.18)/(.82+y-.18)))/y; }
  y = dot(rgb,irodori);
  if (u.values[2].w != 0. && y > 0. && y < .18) { rgb *= exp2(2.*u.values[2].w/100.*pow(1.-y/.18,2.)); }
  y = dot(rgb,irodori);
  if (u.values[3].x != 0. && y > 0.) { let t = clamp((y-.18)/.82,0.,1.); rgb *= exp2(u.values[3].x/100.*t*t*(3.-2.*t)); }
  y = dot(rgb,irodori);
  let b = u.values[3].y/100.;
  if (b != 0. && y >= 0.) {
    let d = .04*b*pow(max(1.-y/.18,0.),3.);
    if (b > 0.) { rgb += vec3f(d); } else if (y > 0.) { rgb *= max(0.,y+d)/y; }
  }
  return ${creative ? 'applyCreativeColor(rgb)' : 'applyColorIntensity(rgb,u.values[11].xy)'};
}
`
}
export const hdrAdjustmentsWgsl = hdrAdjustmentShader()
