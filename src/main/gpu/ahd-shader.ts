import {
  exposureModule,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
} from '../../shared/adjustments'
import { sensorBlendWgsl } from './sensor-blend'
// AHD stages adapted from LibRaw 0.22.1 (CDDL-1.0).
// Copyright 2019-2025 LibRaw LLC; dcraw portions Copyright 1997-2018 Dave Coffin.
// See third_party/libraw/ for license, attribution, and the upstream source reference.
export const ahdShader = /* wgsl */ `
${exposureModule.wgsl}
${contrastModule.wgsl}
${highlightsModule.wgsl}
${shadowsModule.wgsl}
${whitesModule.wgsl}
${blacksModule.wgsl}
${sensorBlendWgsl}
struct Params {
  size: vec4u, // active width, height, stored width, flip
  crop: vec4u, // left, top, stripe start, stripe rows
  black: vec4f,
  scale: vec4f,
  camera: array<vec4f, 3>,
  xyz: array<vec4f, 3>,
  adjustments: vec4f, // exposure, contrast, neutral display white, highlights
  tonalEndpoints: vec4f, // shadows, whites, blacks, custom white balance
  wb0: vec4f, wb1: vec4f, wb2: vec4f,
  blendSaturation: vec4f, blendWhite: vec4f,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
@group(0) @binding(2) var<storage, read_write> green: array<vec2i>;
@group(0) @binding(3) var<storage, read_write> candidates: array<vec4i>;
@group(0) @binding(4) var<storage, read_write> labs: array<vec4i>;
@group(0) @binding(5) var<storage, read_write> homogeneity: array<vec2u>;
@group(0) @binding(6) var linear: texture_storage_2d<rgba32float, write>;
@group(0) @binding(7) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> output: array<u32>;
@group(0) @binding(9) var<storage, read> curve: array<u32>;
@group(0) @binding(10) var<storage, read> labCurve: array<f32>;
@group(0) @binding(11) var linearInput: texture_2d<f32>;

fn channel(q: vec2i) -> u32 {
  let x = u32(q.x) & 1u; let y = u32(q.y) & 1u;
  return select(select(0u, 1u, x == 1u), select(3u, 2u, x == 1u), y == 1u);
}
fn mosaic(q0: vec2i) -> i32 {
  let q = clamp(q0, vec2i(0), vec2i(p.size.xy) - 1);
  let index = (u32(q.y) + p.crop.y) * p.size.z + p.crop.x + u32(q.x);
  let sample = (raw[index / 2u] >> ((index & 1u) * 16u)) & 65535u;
  let c = channel(q);
  return clamp(i32(max(0.0, f32(sample) - p.black[c]) * p.scale[c]), 0, 65535);
}
fn localIndex(q: vec2i) -> u32 { return u32(q.y - i32(p.crop.z) + 6) * p.size.x + u32(q.x); }
fn position(id: vec3u) -> vec2i { return vec2i(i32(id.x), i32(id.y) + i32(p.crop.z) - 6); }
fn valid(id: vec3u) -> bool { return id.x < p.size.x && id.y < p.crop.w + 12u; }
fn greenAt(q: vec2i, d: u32) -> i32 {
  let z = clamp(q, vec2i(0, i32(p.crop.z) - 6), vec2i(i32(p.size.x) - 1, i32(p.crop.z + p.crop.w) + 5));
  return green[localIndex(z)][d];
}
fn rgbAt(q: vec2i, d: u32) -> vec3i {
  let g = greenAt(q, d); let c = channel(q);
  var rgb = vec3i(0, g, 0);
  if (c == 1u || c == 3u) {
    let horizontal = 2u - channel(q + vec2i(0, 1));
    let vertical = 2u - horizontal;
    rgb[horizontal] = clamp(g + ((mosaic(q-vec2i(1,0)) + mosaic(q+vec2i(1,0)) - greenAt(q-vec2i(1,0),d) - greenAt(q+vec2i(1,0),d)) >> 1u), 0, 65535);
    rgb[vertical] = clamp(g + ((mosaic(q-vec2i(0,1)) + mosaic(q+vec2i(0,1)) - greenAt(q-vec2i(0,1),d) - greenAt(q+vec2i(0,1),d)) >> 1u), 0, 65535);
  } else {
    rgb[c] = mosaic(q);
    let a=q+vec2i(-1,-1); let b=q+vec2i(1,-1); let e=q+vec2i(-1,1); let f=q+vec2i(1,1);
    rgb[2u-c] = clamp(g + ((mosaic(a)+mosaic(b)+mosaic(e)+mosaic(f)-greenAt(a,d)-greenAt(b,d)-greenAt(e,d)-greenAt(f,d)+1) >> 2u), 0, 65535);
  }
  return rgb;
}
fn lab(rgb: vec3i) -> vec3i {
  var xyz = vec3f(0.5);
  for(var c=0u;c<3u;c++) {
    xyz.x += p.xyz[0][c]*f32(rgb[c]); xyz.y += p.xyz[1][c]*f32(rgb[c]); xyz.z += p.xyz[2][c]*f32(rgb[c]);
  }
  let indices = vec3u(clamp(xyz,vec3f(0),vec3f(65535)));
  xyz = vec3f(labCurve[indices.x], labCurve[indices.y], labCurve[indices.z]);
  // Preserve signed 16-bit Lab quantization used by AHD's homogeneity decisions.
  let v = vec3i(vec3f(64.0*(116.0*xyz.y-16.0), 32000.0*(xyz.x-xyz.y), 12800.0*(xyz.y-xyz.z)));
  return (v << vec3u(16u)) >> vec3u(16u);
}
@compute @workgroup_size(16, 16) fn interpolateGreen(@builtin(global_invocation_id) id: vec3u) {
  if (!valid(id)) { return; }
  let q=position(id); let center=mosaic(q); var v=vec2i(center);
  if ((channel(q)&1u)==0u) {
    let a=mosaic(q-vec2i(1,0)); let b=mosaic(q+vec2i(1,0));
    let c=mosaic(q-vec2i(0,1)); let d=mosaic(q+vec2i(0,1));
    v.x=clamp(((a+center+b)*2-mosaic(q-vec2i(2,0))-mosaic(q+vec2i(2,0))) >> 2u,min(a,b),max(a,b));
    v.y=clamp(((c+center+d)*2-mosaic(q-vec2i(0,2))-mosaic(q+vec2i(0,2))) >> 2u,min(c,d),max(c,d));
  }
  green[localIndex(q)]=v;
}
@compute @workgroup_size(16, 16) fn interpolateColor(@builtin(global_invocation_id) id: vec3u) {
  if (!valid(id)) { return; }
  let q=position(id); let i=localIndex(q)*2u;
  for(var d=0u;d<2u;d++) { let rgb=rgbAt(q,d); candidates[i+d]=vec4i(rgb,0); labs[i+d]=vec4i(lab(rgb),0); }
}
@compute @workgroup_size(16, 16) fn buildHomogeneity(@builtin(global_invocation_id) id: vec3u) {
  if (!valid(id) || id.x == 0u || id.x+1u>=p.size.x || id.y==0u || id.y+1u>=p.crop.w+12u) { return; }
  let i=localIndex(position(id)); let offsets=array<i32,4>(-1,1,-i32(p.size.x),i32(p.size.x));
  var ld: array<vec4u,2>; var ab: array<vec4u,2>;
  for(var d=0u;d<2u;d++) { for(var n=0u;n<4u;n++) {
    let delta=labs[i*2u+d].xyz-labs[u32(i32(i)+offsets[n])*2u+d].xyz;
    ld[d][n]=u32(abs(delta.x)); ab[d][n]=u32(delta.y*delta.y+delta.z*delta.z);
  } }
  let le=min(max(ld[0].x,ld[0].y),max(ld[1].z,ld[1].w));
  let ae=min(max(ab[0].x,ab[0].y),max(ab[1].z,ab[1].w));
  var h=vec2u(0);
  for(var d=0u;d<2u;d++) { for(var n=0u;n<4u;n++) { h[d]+=select(0u,1u,ld[d][n]<=le && ab[d][n]<=ae); } }
  homogeneity[i]=h;
}
fn border(q:vec2i) -> vec3i {
  var sum=vec3i(0); var count=vec3i(0);
  for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) {
    let z=q+vec2i(x,y);
    if (all(z>=vec2i(0)) && all(z<vec2i(p.size.xy))) {
      let c=channel(z); let rgbc=select(c,1u,c==3u); sum[rgbc]+=mosaic(z); count[rgbc]++;
    }
  } }
  var rgb=sum/max(count,vec3i(1)); let c=channel(q); rgb[select(c,1u,c==3u)]=mosaic(q); return rgb;
}
@compute @workgroup_size(16, 16) fn combine(@builtin(global_invocation_id) id: vec3u) {
  if (id.x>=p.size.x || id.y>=p.crop.w) { return; }
  let q=vec2i(id.xy+vec2u(0,p.crop.z)); let i=localIndex(q); var rgb:vec3i;
  if (q.x<5 || q.y<5 || q.x>=i32(p.size.x)-5 || q.y>=i32(p.size.y)-5) { rgb=border(q); }
  else {
    var h=vec2u(0);
    for(var y=-1;y<=1;y++) { for(var x=-1;x<=1;x++) { h+=homogeneity[u32(i32(i)+y*i32(p.size.x)+x)]; } }
    if(h.x==h.y) { rgb=(candidates[i*2u].xyz+candidates[i*2u+1u].xyz) >> vec3u(1u); }
    else { rgb=candidates[i*2u+select(0u,1u,h.y>h.x)].xyz; }
  }
  var converted:vec3f;
  for(var c=0u;c<3u;c++) { converted[c]=p.camera[c].x*f32(rgb.x)+p.camera[c].y*f32(rgb.y)+p.camera[c].z*f32(rgb.z); }
  if (p.xyz[0].w > 0.0) {
    var camera=vec3f(rgb)/65535.0;
    if(p.blendWhite.w>0.) { camera=sensorBlendRgb(camera,p.blendSaturation.xyz,p.blendWhite.xyz,p.blendSaturation.w); }
    textureStore(linear,q,vec4f(camera,1.0));
  }
  else { textureStore(linear,q,vec4f(converted/65535.0,1.0)); }
  let clipped=vec3u(clamp(converted*p.xyz[1].w,vec3f(0),vec3f(65535)));
  if(p.xyz[2].w==0.) { for(var c=0u;c<3u;c++) { atomicAdd(&histogram[c*8192u+(clipped[c] >> 3u)],1u); } }
}
@compute @workgroup_size(16, 16) fn display(@builtin(global_invocation_id) id: vec3u) {
  if(any(id.xy>=p.size.xy)) { return; }
  var input=textureLoad(linearInput,vec2i(id.xy),0).xyz;
  if(p.tonalEndpoints.w != 0.0) { input=vec3f(dot(p.wb0.xyz,input),dot(p.wb1.xyz,input),dot(p.wb2.xyz,input)); }
  let rgb=vec3u(clamp(applyBlacks(applyWhites(applyShadows(applyHighlights(applyContrast(applyExposure(input,p.adjustments.x),p.adjustments.y,p.adjustments.z),p.adjustments.w,p.adjustments.z),p.tonalEndpoints.x,p.adjustments.z),p.tonalEndpoints.y,p.adjustments.z),p.tonalEndpoints.z,p.adjustments.z)*65535.0,vec3f(0),vec3f(65535)));
  var q=id.xy; var width=p.size.x;
  if ((p.size.w & 1u)!=0u) { q.x=p.size.x-1u-q.x; }
  if ((p.size.w & 2u)!=0u) { q.y=p.size.y-1u-q.y; }
  if ((p.size.w & 4u)!=0u) { q=q.yx; width=p.size.y; }
  output[q.y*width+q.x]=curve[rgb.x] | (curve[rgb.y]<<8u) | (curve[rgb.z]<<16u) | 4278190080u;
}
`
