import { compensatedScalarWgsl } from './compensated-scalar-wgsl'
import type { ColorPrimaries } from './color-model'
import { DETAIL_PARAMETER_BYTES } from './detail-resources'
import {
  detailLuminance,
  validateDetailWindow,
  validateDetailLayout,
  NOISE_HALO,
  NOISE_SPATIAL_WEIGHTS,
  type DetailSize,
  type DetailRectangle,
  type DetailSourceWindow,
  type CompiledNoiseReduction,
  type CompiledDetailSharpening,
} from './spatial-detail'

export const DETAIL_GPU_PARAMETER_BYTES = DETAIL_PARAMETER_BYTES
export function packDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailSourceWindow,
  noise: CompiledNoiseReduction,
  sharp: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  operation: 'noise' | 'sharpen',
): Float32Array<ArrayBuffer> {
  validateDetailWindow(
    image,
    tile,
    source,
    operation === 'noise' ? (noise.active ? NOISE_HALO : 0) : sharp.active ? sharp.support : 0,
  )
  return packResidentDetailTile(image, tile, source, noise, sharp, primaries, operation)
}
/** Layout validation for an intermediate produced and retained on the GPU. */
export function packResidentDetailTile(
  image: DetailSize,
  tile: DetailRectangle,
  source: DetailRectangle,
  noise: CompiledNoiseReduction,
  sharp: CompiledDetailSharpening,
  primaries: ColorPrimaries,
  operation: 'noise' | 'sharpen',
): Float32Array<ArrayBuffer> {
  validateDetailLayout(
    image,
    tile,
    source,
    operation === 'noise' ? (noise.active ? NOISE_HALO : 0) : sharp.active ? sharp.support : 0,
  )
  const result = new Float32Array(DETAIL_GPU_PARAMETER_BYTES / 4),
    luminance = detailLuminance(primaries)
  result.set([
    image.width,
    image.height,
    source.left,
    source.top,
    source.width,
    source.height,
    tile.left,
    tile.top,
    tile.width,
    tile.height,
    Number(noise.luminance),
    Number(noise.chroma),
    noise.inverseLuminanceBandwidth2,
    noise.inverseChromaBandwidth2,
    sharp.gain,
    sharp.threshold2,
    sharp.support,
    Number(operation === 'sharpen'),
    0,
    0,
    0,
    0,
    0,
    0,
  ])
  for (let c = 0; c < 3; c++) {
    result[24 + c * 2] = Math.fround(luminance[c])
    result[25 + c * 2] = Math.fround(luminance[c] - result[24 + c * 2])
  }
  result.set(sharp.gaussian, 32)
  return result
}

/** Bounded native-pixel kernels; raw words preserve alpha and bypass payloads exactly. */
export const spatialDetailWgsl = `
const detailSpatial:array<f32,49> = array<f32,49>(${NOISE_SPATIAL_WEIGHTS.map((v) => v.toPrecision(17)).join(',')});
@group(0) @binding(0) var<uniform> detailParams:array<vec4f,13>;
@group(0) @binding(1) var<storage,read> detailInput:array<vec4u>;
@group(0) @binding(2) var<storage,read_write> detailFeatures:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> detailOutput:array<vec4u>;
${compensatedScalarWgsl('detailDs', 'detailParams[5].x')}
fn detailValue(v:vec2f)->f32 {return v.x+v.y;}
fn detailLuminance(rgb:vec3f)->f32 {
  return detailValue(detailDsAdd(detailDsAdd(
    detailDsMul(vec2f(rgb.x,0.),detailParams[6].xy),
    detailDsMul(vec2f(rgb.y,0.),detailParams[6].zw)),
    detailDsMul(vec2f(rgb.z,0.),detailParams[7].xy)));
}
fn detailHypot(x:f32,y:f32)->f32 {
  let m=max(abs(x),abs(y));if(m==0.) {return 0.;}
  let v=vec2f(x,y)/m;return m*sqrt(dot(v,v));
}
fn detailDelta(v:f32,s:f32,d:f32)->f32 {
  if(d==0.) {return 0.;}
  let h=sinh(d*.5);return v*2.*h*h+detailHypot(v,s)*sinh(d);
}
fn detailIndex(x:i32,y:i32)->u32 {
  let px=clamp(clamp(x,0,i32(detailParams[0].x)-1)-i32(detailParams[0].z),0,i32(detailParams[1].x)-1);
  let py=clamp(clamp(y,0,i32(detailParams[0].y)-1)-i32(detailParams[0].w),0,i32(detailParams[1].y)-1);
  return u32(py)*u32(detailParams[1].x)+u32(px);
}
fn detailGreen(da:f32,db:f32)->f32 {
  return detailValue(detailDsDiv(detailDsAdd(detailDsMul(detailParams[6].xy,vec2f(da,0.)),
    detailDsMul(detailParams[7].xy,vec2f(db,0.))),detailParams[6].zw));
}
@compute @workgroup_size(64) fn prepareDetailFeatures(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(detailParams[1].x*detailParams[1].y)) {return;}
  let source=bitcast<vec4f>(detailInput[id.x]);let y=detailLuminance(source.rgb);
  let l=asinh(y/.18);
  if(detailParams[4].y==1.) {detailFeatures[id.x]=vec4f(l,y,0.,source.a);}
  else {let s=detailHypot(y,.18);detailFeatures[id.x]=vec4f(l,asinh((source.r-y)/s),asinh((source.b-y)/s),source.a);}
}
var<workgroup> detailShared:array<vec4f,256>;
@compute @workgroup_size(8,8) fn denoiseDetail(
  @builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_id) local:vec3u,
  @builtin(local_invocation_index) localIndex:u32,@builtin(workgroup_id) groupId:vec3u) {
  let origin=vec2i(detailParams[1].zw)+vec2i(groupId.xy*8u)-vec2i(4);
  for(var slot=localIndex;slot<256u;slot+=64u) {
    let p=origin+vec2i(i32(slot%16u),i32(slot/16u));
    detailShared[slot]=detailFeatures[detailIndex(p.x,p.y)];
  }
  workgroupBarrier();
  if(id.x>=u32(detailParams[2].x)||id.y>=u32(detailParams[2].y)) {return;}
  let point=vec2i(detailParams[1].zw)+vec2i(id.xy);
  let at=detailIndex(point.x,point.y);let raw=detailInput[at];let rgba=bitcast<vec4f>(raw);
  let outputIndex=id.y*u32(detailParams[2].x)+id.x;
  if(rgba.a==0. || (detailParams[2].z==0.&&detailParams[2].w==0.)) {detailOutput[outputIndex]=raw;return;}
  let center=vec2i(local.xy)+vec2i(4);let f=detailShared[u32(center.y*16+center.x)];
  var sums=vec3f(0.);var weights=vec2f(0.);
  for(var dy=-3;dy<=3;dy++) {for(var dx=-3;dx<=3;dx++) {
    let q=center+vec2i(dx,dy);let candidate=detailShared[u32(q.y*16+q.x)];
    if(candidate.a==0.) {continue;}
    var distance=vec2f(0.);var coverage=0.;
    for(var py=-1;py<=1;py++) {for(var px=-1;px<=1;px++) {
      let p=center+vec2i(px,py);let pp=q+vec2i(px,py);
      let a=detailShared[u32(p.y*16+p.x)];let b=detailShared[u32(pp.y*16+pp.x)];
      let alpha=a.a*b.a;if(alpha==0.) {continue;}
      let d=a.xyz-b.xyz;distance+=alpha*vec2f(d.x*d.x,d.y*d.y+d.z*d.z);coverage+=alpha;
    }}
    if(coverage==0.) {continue;}
    distance/=coverage;
    let spatial=detailSpatial[u32((dy+3)*7+dx+3)]*candidate.a;
    var wl=0.;var wc=0.;
    if(detailParams[2].z==1.) {wl=spatial*exp(-distance.x*detailParams[3].x-distance.y/(.12*.12));}
    if(detailParams[2].w==1.) {wc=spatial*exp(-distance.x/(.08*.08)-distance.y*detailParams[3].y);}
    sums+=vec3f(wl,wc,wc)*(candidate.xyz-f.xyz);weights+=vec2f(wl,wc);
  }}
  let y=detailLuminance(rgba.rgb);let scale=detailHypot(y,.18);
  var dl=0.;var da=0.;var db=0.;
  if(detailParams[2].z==1.) {dl=detailDelta(y,.18,sums.x/weights.x);}
  if(detailParams[2].w==1.) {da=detailDelta(rgba.r-y,scale,sums.y/weights.y);db=detailDelta(rgba.b-y,scale,sums.z/weights.y);}
  if(dl==0.&&da==0.&&db==0.) {detailOutput[outputIndex]=raw;return;}
  let value=vec3f(rgba.r+dl+da,rgba.g+dl-detailGreen(da,db),rgba.b+dl+db);
  detailOutput[outputIndex]=vec4u(bitcast<vec3u>(value),raw.a);
}
fn detailGaussian(i:i32)->f32 {let n=u32(i);return detailParams[8u+n/4u][n%4u];}
@compute @workgroup_size(64) fn sharpenDetail(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=u32(detailParams[2].x*detailParams[2].y)) {return;}
  let gx=i32(detailParams[1].z)+i32(id.x%u32(detailParams[2].x));
  let gy=i32(detailParams[1].w)+i32(id.x/u32(detailParams[2].x));
  let at=detailIndex(gx,gy);let raw=detailInput[at];let rgba=bitcast<vec4f>(raw);
  if(rgba.a==0.||detailParams[3].z==0.) {detailOutput[id.x]=raw;return;}
  let f=detailFeatures[at];let support=i32(detailParams[4].x);
  var difference=0.;var total=0.;var lo=f.y;var hi=f.y;
  for(var y=-support;y<=support;y++) {for(var x=-support;x<=support;x++) {
    let p=detailFeatures[detailIndex(gx+x,gy+y)];if(p.a==0.) {continue;}
    let weight=detailGaussian(x+support)*detailGaussian(y+support)*p.a;
    difference+=weight*(f.x-p.x);total+=weight;lo=min(lo,p.y);hi=max(hi,p.y);
  }}
  let d=difference/total;var protection=0.;
  if(d!=0.) {protection=d*d/(d*d+detailParams[3].w);}
  let proposed=f.y+detailDelta(f.y,.18,detailParams[3].z*d*protection);
  let margin=(hi-lo)*.03;let delta=clamp(proposed,lo-margin,hi+margin)-f.y;
  if(delta==0.) {detailOutput[id.x]=raw;return;}
  detailOutput[id.x]=vec4u(bitcast<vec3u>(rgba.rgb+vec3f(delta)),raw.a);
}
`
