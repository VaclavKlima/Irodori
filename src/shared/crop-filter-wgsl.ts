import { compensatedScalarWgsl } from './compensated-scalar-wgsl'
import { validateCropWindow, type CropRectangle, type CropSourceWindow } from './crop-filter'
import type { CropGeometry } from './crop'
import { CROP_PARAMETERS_BYTES } from './crop-resources'

export const CROP_GPU_PARAMETER_BYTES = CROP_PARAMETERS_BYTES
export function packCropTile(
  geometry: CropGeometry,
  tile: CropRectangle,
  source: CropSourceWindow,
): Float32Array<ArrayBuffer> {
  validateCropWindow(geometry, tile, source)
  const result = new Float32Array(CROP_GPU_PARAMETER_BYTES / 4)
  result.set([
    geometry.source.width,
    geometry.source.height,
    source.left,
    source.top,
    source.width,
    source.height,
    tile.left,
    tile.top,
    tile.width,
    tile.height,
    Number(geometry.pixelAligned),
    0,
  ])
  for (const [i, value] of geometry.outputToSource.entries()) {
    result[12 + i * 2] = Math.fround(value)
    result[13 + i * 2] = Math.fround(value - result[12 + i * 2])
  }
  return result
}

export const cropFilteringWgsl = `
struct CropParams { values:array<vec4f,6> }
@group(0) @binding(0) var<uniform> crop:CropParams;
// Integer storage preserves exact-copy payloads, including signed zero.
@group(0) @binding(1) var<storage,read> cropInput:array<vec4u>;
@group(0) @binding(2) var<storage,read_write> cropOutput:array<vec4u>;
${compensatedScalarWgsl('warp')}
fn warpValue(v:vec2f)->f32 {return v.x+v.y;}
struct WarpPhase { index:i32, fraction:vec2f }
fn warpPhase(v:vec2f)->WarpPhase {
  var index=i32(floor(v.x));
  let r=warpSub(v,vec2f(f32(index),0.));
  if(r.x<0. || (r.x==0. && r.y<0.)) {index--;}
  return WarpPhase(index,warpSub(v,vec2f(f32(index),0.)));
}
fn warpWeights(t:vec2f)->array<vec2f,4> {
  let one=vec2f(1.,0.);let half=vec2f(.5,0.);
  let complement=warpSub(one,t);let square=warpMul(t,t);
  return array<vec2f,4>(
    -warpMul(half,warpMul(t,warpMul(complement,complement))),
    warpAdd(one,warpMul(square,warpSub(warpMul(vec2f(1.5,0.),t),vec2f(2.5,0.)))),
    warpMul(t,warpAdd(half,warpMul(t,warpSub(vec2f(2.,0.),warpMul(vec2f(1.5,0.),t))))),
    -warpMul(half,warpMul(square,complement)));
}
fn warpIndex(x:i32,y:i32,base:u32)->u32 {
  let xx=clamp(x,0,i32(crop.values[0].x)-1)-i32(crop.values[0].z);
  let yy=clamp(y,0,i32(crop.values[0].y)-1)-i32(crop.values[0].w);
  return base+u32(yy)*u32(crop.values[1].x)+u32(xx);
}
fn warpReconstruct(x:vec2f,y:vec2f,base:u32,exact:bool)->vec4u {
  let px=warpPhase(x);let py=warpPhase(y);
  if(exact) {return cropInput[warpIndex(px.index,py.index,base)];}
  let wx=warpWeights(px.fraction);let wy=warpWeights(py.fraction);
  var opaque=true;
  var rgb=array<vec2f,3>(vec2f(0.),vec2f(0.),vec2f(0.));
  for(var row=0;row<4;row++) {
    for(var column=0;column<4;column++) {
      let pixel=bitcast<vec4f>(cropInput[warpIndex(px.index+column-1,py.index+row-1,base)]);
      if(pixel.a!=1.) {opaque=false;}
      let weight=warpMul(wx[column],wy[row]);
      for(var c=0;c<3;c++) {rgb[c]=warpAdd(rgb[c],warpMul(vec2f(pixel[c],0.),weight));}
    }
  }
  var alpha=vec2f(1.,0.);
  if(!opaque) {
    rgb=array<vec2f,3>(vec2f(0.),vec2f(0.),vec2f(0.));alpha=vec2f(0.);
    let bx=array<vec2f,2>(warpSub(vec2f(1.,0.),px.fraction),px.fraction);
    let by=array<vec2f,2>(warpSub(vec2f(1.,0.),py.fraction),py.fraction);
    for(var row=0;row<2;row++) {
      for(var column=0;column<2;column++) {
        let pixel=bitcast<vec4f>(cropInput[warpIndex(px.index+column,py.index+row,base)]);
        let weight=warpMul(warpMul(bx[column],by[row]),vec2f(pixel.a,0.));
        alpha=warpAdd(alpha,weight);
        for(var c=0;c<3;c++) {rgb[c]=warpAdd(rgb[c],warpMul(vec2f(pixel[c],0.),weight));}
      }
    }
    if(warpValue(alpha)<=1./1048576.) {return vec4u(0u);}
    for(var c=0;c<3;c++) {rgb[c]=warpDiv(rgb[c],alpha);}
  }
  return bitcast<vec4u>(vec4f(warpValue(rgb[0]),warpValue(rgb[1]),warpValue(rgb[2]),clamp(warpValue(alpha),0.,1.)));
}
@compute @workgroup_size(64) fn warpCrop(@builtin(global_invocation_id) id:vec3u) {
  let count=u32(crop.values[2].x*crop.values[2].y);
  if(id.x>=count) {return;}
  let width=u32(crop.values[2].x);
  let x=vec2f(crop.values[1].z+f32(id.x%width)+.5,0.);
  let y=vec2f(crop.values[1].w+f32(id.x/width)+.5,0.);
  let sx=warpSub(warpAdd(warpAdd(warpMul(crop.values[3].xy,x),warpMul(crop.values[3].zw,y)),crop.values[5].xy),vec2f(.5,0.));
  let sy=warpSub(warpAdd(warpAdd(warpMul(crop.values[4].xy,x),warpMul(crop.values[4].zw,y)),crop.values[5].zw),vec2f(.5,0.));
  cropOutput[id.x]=warpReconstruct(sx,sy,0u,crop.values[2].z==1.);
}
`
