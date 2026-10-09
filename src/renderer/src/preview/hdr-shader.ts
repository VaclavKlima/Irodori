import { hdrRangesWgsl } from './hdr-ranges'
import { displayRenderingWgsl, displayEncodingWgsl } from '../../../shared/display-rendering-wgsl'
import { REC2020_TO_P3, REC2020_TO_SRGB } from '../../../shared/hdr'
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

export const hdrRenderingWgsl = `
struct Params { values: array<vec4f, 11> }
@group(0) @binding(0) var<uniform> u: Params;
@group(0) @binding(1) var pixels: texture_2d<f32>;
${displayRenderingWgsl}
const luma = vec3f(.2627002120112671, .6779980715188708, .059301716469862);
fn adjusted(input: vec3f) -> vec3f {
  var rgb = input;
  if (u.values[4].w > 0.) { rgb = vec3f(dot(u.values[5].xyz,rgb), dot(u.values[6].xyz,rgb), dot(u.values[7].xyz,rgb)); }
  rgb *= exp2(u.values[2].x);
  var y = dot(rgb,luma);
  let contrast = u.values[2].y;
  if (contrast != 0. && y > 0. && y < 1.) {
    var next = .18 * pow(y/.18,exp2(contrast/100.));
    if (y > .18) { next = 1. - .82 * pow((1.-y)/.82,exp2(contrast/100.)); }
    rgb *= next/y;
  }
  y = dot(rgb,luma);
  let h = u.values[2].z/100.;
  if (h != 0. && y > .18) { rgb *= ((1.+h)*y-h*(.18+.82*(y-.18)/(.82+y-.18)))/y; }
  y = dot(rgb,luma);
  if (u.values[2].w != 0. && y > 0. && y < .18) { rgb *= exp2(2.*u.values[2].w/100.*pow(1.-y/.18,2.)); }
  y = dot(rgb,luma);
  if (u.values[3].x != 0. && y > 0.) { let t = clamp((y-.18)/.82,0.,1.); rgb *= exp2(u.values[3].x/100.*t*t*(3.-2.*t)); }
  y = dot(rgb,luma);
  let b = u.values[3].y/100.;
  if (b != 0. && y >= 0.) {
    let d = .04*b*pow(max(1.-y/.18,0.),3.);
    if (b > 0.) { rgb += vec3f(d); } else if (y > 0.) { rgb *= max(0.,y+d)/y; }
  }
  return rgb;
}
fn outputRgb(rgb: vec3f) -> vec3f {return renderDisplayRgb(rgb,u.values[3].z);}
fn encoded(v:vec3f)->vec3f {return encodeDisplayRgb(v);}
`

export const hdrCacheShader = `
${hdrRenderingWgsl}
@group(0) @binding(3) var cached: texture_storage_2d_array<rgba32float,write>;
@group(0) @binding(5) var<storage,read> jobs:array<vec4u>;
@compute @workgroup_size(8,8) fn renderTile(@builtin(global_invocation_id) p:vec3u) {
  let size=vec2i(textureDimensions(cached));
  if(any(vec2i(p.xy)>=size)) { return; }
  let job=jobs[p.z];
  let point=vec2i(job.xy)*(size-2)+vec2i(p.xy)-1;
  let pixel=textureLoad(pixels,clamp(point,vec2i(0),vec2i(textureDimensions(pixels))-1),0);
  var rgb=pixel.rgb;
  if(job.w==0u) { rgb=adjusted(rgb); }
  textureStore(cached,vec2i(p.xy),i32(job.z),vec4f(outputRgb(rgb),pixel.a));
}`

// Pan/zoom presentation deliberately contains no ACES evaluation.
export const hdrShader = `
struct Params { values: array<vec4f, 11> }
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

export const hdrMipShader = `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var destination: texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) p:vec3u) {
  if(any(p.xy>=textureDimensions(destination))) { return; }
  let size=vec2i(textureDimensions(source)); var sum=vec4f(0.);
  for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
    let v=textureLoad(source,min(vec2i(p.xy)*2+vec2i(x,y),size-1),0);
    sum+=vec4f(v.rgb*v.a,v.a);
  }}
  textureStore(destination,p.xy,vec4f(select(vec3f(0.),sum.rgb/max(sum.a,1e-20),sum.a>0.),sum.a*.25));
}`
