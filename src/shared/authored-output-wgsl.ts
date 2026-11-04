import { REC2020_TO_SRGB } from './hdr'
import { hdrAdjustmentShader } from './hdr-adjustments-wgsl'
import { rasterAdjustmentShader } from './raster-adjustments-shader'

export type PointRenderDomain = 'scene-linear' | 'raster' | 'authored-hdr'
export interface PointRenderOptions {
  readonly domain: PointRenderDomain
  readonly preserveAlpha?: boolean
  /** An independently authored SDR primary accompanies HDR content during export. */
  readonly primary?: boolean
  readonly transform?: {
    readonly white: number
    readonly threshold: number
    readonly offset: number
    readonly quantize: boolean
  }
}
const matrix = [0, 1, 2]
  .map((c) => `vec3f(${REC2020_TO_SRGB[c]},${REC2020_TO_SRGB[c + 3]},${REC2020_TO_SRGB[c + 6]})`)
  .join(',')

/** Authored images bypass scene-linear ACES tone rendering, including neutral inputs. */
export function authoredOutputShader(
  hdr: boolean,
  packed: boolean,
  creative: boolean,
  options: PointRenderOptions,
  workgroup: number,
) {
  const primary = !!options.primary,
    raster = options.domain === 'raster',
    channels = hdr ? 6 : 3
  // Namespace the independent source-domain helpers when both renditions are required.
  const rasterMath = rasterAdjustmentShader('wgsl', creative, 12)
  const hdrMath = hdrAdjustmentShader(creative, 13, 'pow')
  const declarations = new Set(
    [...hdrMath.matchAll(/\b(?:fn|struct|const)\s+([A-Za-z][A-Za-z0-9_]*)/g)].map(
      (match) => match[1],
    ),
  )
  for (const match of hdrMath.matchAll(/^@group[^\n]*\bvar<[^>]+>\s+([A-Za-z][A-Za-z0-9_]*)/gm))
    declarations.add(match[1])
  const namespacedHdr = hdrMath.replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, (name) =>
    declarations.has(name) ? `hdr_${name}` : name,
  )
  const encode = `fn rasterEncode(v:vec3f)->vec3f {
  return select(pow(v,vec3f(1./2.4))*(1.+u.values[8].z)-u.values[8].z,v*12.92,v<vec3f(u.values[8].y));
 }`
  return `
struct Params { values:array<vec4f,12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
struct Result { peak:atomic<u32>, values:array<u32> }
@group(0) @binding(2) var<storage,read_write> result:Result;
${primary ? '@group(0) @binding(6) var<storage,read> primary:array<vec4f>;' : ''}
${raster || primary ? rasterMath : ''}
${!raster ? namespacedHdr : ''}
${encode}
// Floating-point self-comparisons can be optimized under finite-math assumptions.
// Check the stored IEEE-754 exponent before adjustment or clamping can hide an invalid sample.
fn authoredFinite(value:vec4f)->bool {
 return all((bitcast<vec4u>(value)&vec4u(0x7f800000u))!=vec4u(0x7f800000u));
}
${hdr && packed ? `var<workgroup> peaks:array<f32,${workgroup}>;` : ''}
@compute @workgroup_size(${workgroup}) fn render(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32) {
 ${hdr && packed ? 'peaks[local]=0.;' : ''}
 if(id.x<u32(u.values[0].x)) {
  let pixel=input[id.x];
  if(!authoredFinite(pixel)${primary ? '||!authoredFinite(primary[id.x])' : ''}) { atomicMax(&result.peak,bitcast<u32>(1e30)); }
  ${!raster ? 'let content=max(hdr_adjusted(pixel.rgb),vec3f(0.));' : ''}
  var sdr=${raster || primary ? `rasterAdjusted(${primary ? 'primary[id.x].rgb' : 'pixel.rgb'},u.values[2],u.values[3].xy,u.values[11].xy,u.values[8].x)` : `mat3x3f(${matrix})*content`};
  if(u.values[8].w>0.) { sdr=floor(sdr*65535.)/65535.; }
  sdr=clamp(sdr/u.values[8].x,vec3f(0.),vec3f(1.));
  ${options.preserveAlpha ? '' : 'sdr=sdr*pixel.a+vec3f(1.-pixel.a);'}
  ${hdr ? `let hdr=clamp(content${options.preserveAlpha ? '' : '*pixel.a+vec3f(1.-pixel.a)'},vec3f(0.),vec3f(10.));` : ''}
  if(!authoredFinite(vec4f(sdr,0.))${hdr ? '||!authoredFinite(vec4f(hdr,0.))||any(hdr>vec3f(65504.))' : ''}) { atomicMax(&result.peak,bitcast<u32>(1e30)); }
  ${
    packed
      ? `let encoded=rasterEncode(sdr);
  var rgb=vec3u(floor(clamp(encoded,vec3f(0.),vec3f(1.))*255.+.5));
  if(u.values[8].w>0.) { rgb=vec3u(min(vec3f(255.),floor(clamp(encoded,vec3f(0.),vec3f(1.))*65536./256.))); }
  result.values[id.x*${hdr ? 3 : 1}u]=rgb.r|(rgb.g<<8u)|(rgb.b<<16u)${options.preserveAlpha ? '|(u32(floor(clamp(pixel.a,0.,1.)*255.+.5))<<24u)' : ''};
  ${hdr ? 'result.values[id.x*3u+1u]=pack2x16float(hdr.rg);result.values[id.x*3u+2u]=pack2x16float(vec2f(hdr.b,1.));peaks[local]=max(hdr.r,max(hdr.g,hdr.b));' : ''}`
      : `result.values[id.x*${channels}u]=bitcast<u32>(sdr.r);result.values[id.x*${channels}u+1u]=bitcast<u32>(sdr.g);result.values[id.x*${channels}u+2u]=bitcast<u32>(sdr.b);
  ${hdr ? 'result.values[id.x*6u+3u]=bitcast<u32>(hdr.r);result.values[id.x*6u+4u]=bitcast<u32>(hdr.g);result.values[id.x*6u+5u]=bitcast<u32>(hdr.b);' : ''}`
  }
 }
 ${
   hdr && packed
     ? `workgroupBarrier();
 for(var step=${workgroup / 2}u;step>0u;step/=2u) {if(local<step){peaks[local]=max(peaks[local],peaks[local+step]);} workgroupBarrier();}
 if(local==0u){atomicMax(&result.peak,bitcast<u32>(peaks[0]));}`
     : ''
 }
}`
}
