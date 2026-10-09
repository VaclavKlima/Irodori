import { acesWgsl } from './aces-wgsl'
import { REC2020_TO_ACES } from './display-rendering'
const inputMatrix =
  'mat3x3f(' + REC2020_TO_ACES.map((row) => 'vec3f(' + row.join(',') + ')').join(',') + ')'
/** Shared scene rendering and single transfer encoding for live presentation and worker proofs. */
export const displayEncodingWgsl = `
fn encodeDisplayRgb(v:vec3f)->vec3f {
  let a=abs(v);
  return sign(v)*select(1.055*pow(a,vec3f(1./2.4))-.055,12.92*a,a<=vec3f(.0031308));
}`
export const displayRenderingWgsl = `
${acesWgsl}
fn renderDisplayRgb(rgb:vec3f,peak:f32)->vec3f {
  return clamp(outputTransform_fwd(${inputMatrix}*rgb),vec3f(0.),vec3f(peak));
}
${displayEncodingWgsl}`
