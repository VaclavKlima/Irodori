import { hdrRangesWgsl } from './hdr-ranges'
import { hdrAdjustmentShader } from '../../../shared/hdr-adjustments-wgsl'
import { displayRenderingWgsl, displayEncodingWgsl } from '../../../shared/display-rendering-wgsl'
import { REC2020_TO_P3, REC2020_TO_SRGB } from '../../../shared/hdr'
import { acesWgsl } from '../../../shared/aces-wgsl'
import {
  acesPreviewWgsl,
  acesSdrPreviewWgsl,
  ACES_SDR_INTERACTIVE_PREVIEW_VERSION,
  type AcesPreviewPolicy,
} from '../../../shared/aces-preview-wgsl'
const primaryMatrix = (m: number[]) =>
  [0, 1, 2].map((c) => `vec3f(${m[c]},${m[c + 3]},${m[c + 6]})`).join(',')
export const hdrPresentationWgsl = `
fn canvasRgb(rgb:vec3f)->vec3f {
  let srgb=mat3x3f(${primaryMatrix(REC2020_TO_SRGB)});
  let p3=mat3x3f(${primaryMatrix(REC2020_TO_P3)});
  return select(srgb*rgb,p3*rgb,u.values[9].z>1.);
}
fn presentationRgb(rgb:vec3f)->vec3f {
  if(u.values[9].w==0.) { return rgb; }
  return clamp(canvasRgb(rgb),vec3f(0.),vec3f(u.values[9].y));
}`

export function hdrRenderingShader(creative = false): string {
  return `
struct Params { values: array<vec4f, 12> }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var pixels: texture_2d<f32>;
${displayRenderingWgsl}
${hdrAdjustmentShader(creative)}
fn outputRgb(rgb: vec3f) -> vec3f {
  if(u.values[7].w>0.) { return max(rgb,vec3f(0.)); }
  return renderDisplayRgb(rgb,u.values[3].z);
}
fn encoded(v:vec3f)->vec3f {return encodeDisplayRgb(v);}
`
}
export const hdrRenderingWgsl = hdrRenderingShader()

export type HdrCacheKernelKind = 'linear64'

/** The accepted invocation mapping and its matching host dispatch stay together. */
export function hdrCacheKernel(precision: AcesPreviewPolicy = 'reference', creative = false) {
  const math =
    precision === 'reference'
      ? acesWgsl
      : precision === ACES_SDR_INTERACTIVE_PREVIEW_VERSION
        ? acesSdrPreviewWgsl
        : acesPreviewWgsl
  const shader = `
${hdrRenderingShader(creative).replace(acesWgsl, math)}
@group(0) @binding(3) var cached: texture_storage_2d_array<rgba32float,write>;
@group(0) @binding(5) var<storage,read> jobs:array<vec4u>;
@compute @workgroup_size(64) fn renderTile(@builtin(global_invocation_id) p:vec3u) {
  let size=vec2i(textureDimensions(cached));
  if(p.x>=u32(size.x*size.y)) { return; }
  let at=vec2i(i32(p.x)%size.x,i32(p.x)/size.x);
  let job=jobs[p.z];
  let point=vec2i(job.xy)*(size-2)+at-1;
  let pixel=textureLoad(pixels,clamp(point,vec2i(0),vec2i(textureDimensions(pixels))-1),0);
  var rgb=pixel.rgb;
  if(job.w==0u) { rgb=adjusted(rgb); }
  textureStore(cached,at,i32(job.z),vec4f(outputRgb(rgb),pixel.a));
}`
  return {
    kind: 'linear64' as const,
    policy: precision,
    shader,
    dispatch(extent: number, jobs: number): [number, number, number] {
      return [Math.ceil((extent * extent) / 64), 1, jobs]
    },
  }
}

// Pan/zoom presentation deliberately contains no ACES evaluation.
export const hdrShader = `
struct Params { values: array<vec4f, 12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(2) var<storage,read> lookup:array<i32>;
@group(0) @binding(3) var cached:texture_2d_array<f32>;
${hdrRangesWgsl}
${displayEncodingWgsl}
${hdrPresentationWgsl}
fn encoded(v:vec3f)->vec3f { return encodeDisplayRgb(v); }
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let positions=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
  return vec4f(positions[i],0.,1.);
}
fn sampleCached(point:vec2f,before:bool)->vec4f {
  let size=vec2i(textureDimensions(cached))-2;
  let base=vec2i(floor(point));
  let tile=clamp(base,vec2i(0),vec2i(u.values[8].zw)-1)/size;
  let index=tile.y*i32(u.values[8].x)+tile.x+select(0,i32(u.values[8].y),before);
  let layer=lookup[index];
  if(layer<0) { return vec4f(0.,0.,0.,-1.); }
  let local=base-tile*size+1;
  let a=textureLoad(cached,local,layer,0);
  if(u.values[1].z>=1. && u.values[10].x==0.) { return a; }
  let b=textureLoad(cached,local+vec2i(1,0),layer,0);
  let c=textureLoad(cached,local+vec2i(0,1),layer,0);
  let d=textureLoad(cached,local+vec2i(1,1),layer,0);
  let f=fract(point);
  let pixel=mix(mix(vec4f(a.rgb*a.a,a.a),vec4f(b.rgb*b.a,b.a),f.x),mix(vec4f(c.rgb*c.a,c.a),vec4f(d.rgb*d.a,d.a),f.x),f.y);
  return vec4f(select(vec3f(0.),pixel.rgb/max(pixel.a,1e-20),pixel.a>0.),pixel.a);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let css=position.xy/u.values[1].w;
  let source=(css-u.values[0].xy*.5-u.values[1].xy)/u.values[1].z+u.values[0].zw*.5;
  if(any(source<vec2f(0.)) || any(source>=u.values[0].zw)) { return vec4f(.059,.063,.067,1.); }
  let before=u.values[4].x==1. || (u.values[4].x==2. && css.x<u.values[0].x*u.values[4].y);
  var point=source;
  if(u.values[1].z<1. || u.values[10].x>0.) { point=source/u.values[0].zw*u.values[8].zw-.5; }
  let pixel=sampleCached(point,before);
  if(pixel.a<0.) { discard; }
  let rgb=pixel.rgb;
  var result=encoded(mix(vec3f(.00478,.0052,.00563),presentationRgb(rgb),pixel.a));
  if(u.values[10].y>0.) {
    let range=hdrRangeColor(rgb,source);
    if(range.a==0. || pixel.a==0.) { discard; }
    return vec4f(range.rgb,1.);
  }
  if(u.values[3].w>0. && pixel.a>0.) {
    let range=hdrRangeColor(rgb,source);
    result=mix(result,range.rgb,range.a*pixel.a);
  }
  if(u.values[1].z>=8.) {
    let edge=min(fract(source),1.-fract(source))*u.values[1].z;
    let coverage=clamp((.5+.5/u.values[1].w-min(edge.x,edge.y))*u.values[1].w,0.,1.);
    result=mix(result,vec3f(.5),clamp((u.values[1].z-4.)/12.,0.,1.)*.22*coverage);
  }
  return vec4f(result,1.);
}`

function mipShader(declarations: string, dimensions: string, sample: string): string {
  return `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float,write>;
${declarations}@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) p:vec3u) {
  if(any(p.xy>=textureDimensions(destination))) { return; }
  ${dimensions}; var sum=vec4f(0.);
  for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
    ${sample};
    sum+=vec4f(v.rgb*v.a,v.a);
  }}
  textureStore(destination,p.xy,vec4f(select(vec3f(0.),sum.rgb/max(sum.a,1e-20),sum.a>0.),sum.a*.25));
}`
}

// Keep the ordinary program byte-for-byte stable; both programs share its ordered reduction.
export const hdrMipShader = mipShader(
  '',
  'let size=vec2i(textureDimensions(source))',
  'let v=textureLoad(source,min(vec2i(p.xy)*2+vec2i(x,y),size-1),0)',
)

/** Orient each full-resolution fetch before the first ordinary mip reduction. */
export const hdrOrientedMipShader = mipShader(
  '@group(0) @binding(2) var<uniform> orientation:vec4u;\n',
  `let sourceSize=vec2i(textureDimensions(source));
  let flip=orientation.x;
  let size=select(sourceSize,sourceSize.yx,(flip&4u)!=0u)`,
  `var q=min(vec2i(p.xy)*2+vec2i(x,y),size-1);
    if((flip&4u)!=0u) { q=q.yx; }
    if((flip&1u)!=0u) { q.x=sourceSize.x-1-q.x; }
    if((flip&2u)!=0u) { q.y=sourceSize.y-1-q.y; }
    let v=textureLoad(source,q,0)`,
)
