/** Native source warping directly from the AHD camera texture and canonical clipping bits. */
export const mergeSensorShader = /* wgsl */ `
struct Preparation { size:vec4u, crop:vec4u, sensor:vec4u, cfa:vec4u, thresholds:vec4f, camera:array<vec4f,3>, review:vec4u }
struct Params { prep:Preparation, size:vec4u, band:vec4u, matrix:array<vec4f,3>, values:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var camera:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> lut:array<vec4f>;
@group(0) @binding(3) var<storage,read> alpha:array<u32>;
@group(0) @binding(4) var<storage,read_write> referenceY:array<f32>;
@group(0) @binding(5) var<storage,read_write> sums:array<vec4f>;
// Bits: common coverage, residual motion, valid reference sensor sample.
@group(0) @binding(6) var<storage,read_write> flags:array<u32>;
@group(0) @binding(7) var<storage,read> offsets:array<vec2f>;
@group(0) @binding(8) var<storage,read> excluded:array<u32>;
@group(0) @binding(9) var<storage,read> referenceBand:array<vec4f>;
@group(0) @binding(10) var<storage,read_write> outputBand:array<vec4f>;
fn radial(r:f32)->vec4f { let pos=clamp(r*4095.,0.,4095.); let i=min(4094u,u32(pos)); return mix(lut[i],lut[i+1u],vec4f(pos-f32(i))); }
fn nativePixel(id:vec2u)->vec3f {
  var q=select(id,id.yx,(p.prep.sensor.w & 4u)!=0u);
  if((p.prep.sensor.w & 1u)!=0u) { q.x=p.prep.size.z-1u-q.x; }
  if((p.prep.sensor.w & 2u)!=0u) { q.y=p.prep.size.w-1u-q.y; }
  let center=(vec2f(p.prep.size.xy)-1.)*.5; let radius=length(center);
  let delta=vec2f(q+p.prep.crop.xy)-center; let factors=radial(length(delta)/radius);
  var rgb=vec3f(0);
  for(var c=0u;c<3u;c++) {
    let position=center+delta*factors[c]; let base=vec2i(floor(position)); let fraction=fract(position);
    for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
      let tap=clamp(base+vec2i(x,y),vec2i(0),vec2i(p.prep.size.xy)-1);
      let weight=select(1.-fraction.x,fraction.x,x==1)*select(1.-fraction.y,fraction.y,y==1);
      rgb[c]+=textureLoad(camera,tap,0)[c]*radial(length(vec2f(tap)-center)/radius).w*weight;
    } }
  }
  var converted:vec3f;
  for(var c=0u;c<3u;c++) { converted[c]=dot(p.prep.camera[c].xyz,rgb); }
  return converted;
}
fn localOffset(xy:vec2f)->vec2f {
  if(p.band.w==0u) {return vec2f(0);}
  let grid=p.band.w; let q=clamp((xy+.5)*f32(grid)/vec2f(p.size.xy)-.5,vec2f(0),vec2f(f32(grid-1u)));let base=vec2u(floor(q));let f=fract(q);var delta=vec2f(0);
  for(var y=0u;y<2u;y++) {for(var x=0u;x<2u;x++) {let k=min(base+vec2u(x,y),vec2u(grid-1u));let weight=select(1.-f.x,f.x,x==1u)*select(1.-f.y,f.y,y==1u);delta+=offsets[k.y*grid+k.x]*weight;}}
  return delta;
}
fn luminance(rgb:vec3f)->f32 { return dot(rgb,vec3f(.2627,.678,.0593)); }
fn variance(v:f32,scale:f32,iso:f32)->f32 { return (.0015*.0015*max(1.,iso/100.)+.0001*max(0.,v))/(scale*scale); }
fn valid(q:vec2f)->bool {
  let base=vec2u(floor(q)); let f=fract(q);
  for(var y=0u;y<2u;y++) { for(var x=0u;x<2u;x++) {
    let weight=select(1.-f.x,f.x,x==1u)*select(1.-f.y,f.y,y==1u);
    let tap=min(base+vec2u(x,y),p.size.xy-1u); let i=tap.y*p.size.x+tap.x;
    if(weight>0. && ((alpha[i/32u] >> (i%32u)) & 1u)==0u) { return false; }
  } }
  return true;
}
fn sample(q:vec2f)->vec3f {
  let base=vec2u(floor(q)); let f=fract(q); var rgb=vec3f(0);
  for(var y=0u;y<2u;y++) { for(var x=0u;x<2u;x++) {
    let weight=select(1.-f.x,f.x,x==1u)*select(1.-f.y,f.y,y==1u);
    if(weight>0.) { rgb+=nativePixel(min(base+vec2u(x,y),p.size.xy-1u))*weight; }
  } }
  return rgb;
}
@compute @workgroup_size(16,16) fn initializeReference(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=p.size.xy)) { return; }
  let i=id.y*p.size.x+id.x;
  referenceY[i]=luminance(nativePixel(id.xy));
  if(((alpha[i/32u] >> (i%32u)) & 1u)!=0u) { flags[i] |= 4u; }
}
@compute @workgroup_size(16,16) fn accumulateSensor(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=p.size.xy)) { return; }
  let i=id.y*p.size.x+id.x;
  if((flags[i] & 1u)==0u) { return; }
  var confidence=1.-f32((excluded[i/32u] >> (i%32u)) & 1u);
  if(p.matrix[0].w>0.) { confidence=1.-f32((excluded[i/4u] >> ((i%4u)*8u)) & 255u)/255.; }
  if(confidence<=0.) { return; }
  let xy=vec3f(vec2f(id.xy),1.);
  let denominator=dot(p.matrix[2].xyz,xy); let q=vec2f(dot(p.matrix[0].xyz,xy),dot(p.matrix[1].xyz,xy))/denominator+localOffset(xy.xy);
  if(any(q<vec2f(0)) || any(q>vec2f(p.size.xy)-1.) || !valid(q)) { return; }
  let value=sample(q); let rawY=luminance(value); let refY=referenceY[i];
  let v=variance(rawY,p.values.x,p.values.y);
  if(p.band.z==1u && (flags[i] & 4u)!=0u && p.values.w>0. && abs(rawY/p.values.x-refY)>(8.-p.values.w*.04)*sqrt(v+variance(refY,1.,p.values.z))) { flags[i] |= 2u; }
  let weight=confidence/max(1e-12,v); sums[i]+=vec4f(value/p.values.x*weight,weight);
}
@compute @workgroup_size(256) fn finishSensor(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if(i>=p.size.x*p.size.w) { return; }
  let global=p.size.z*p.size.x+i; let sum=sums[global]; var rgb=referenceBand[i].rgb;
  if(sum.a>0.) { rgb=sum.rgb/sum.a; }
  outputBand[i]=vec4f(rgb,f32((flags[global] & 1u)!=0u && sum.a>0.));
}
`
