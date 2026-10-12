export const mergeAccumulationShader = /* wgsl */ `
struct Params { size:vec4u, band:vec4u, matrix:array<vec4f,3>, values:vec4f }
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var<storage,read> source:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> reference:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> sums:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> motion:array<u32>;
@group(0) @binding(5) var<storage,read> coverage:array<u32>;
@group(0) @binding(6) var<storage,read_write> output:array<vec4f>;
@group(0) @binding(7) var<storage,read> offsets:array<vec2f>;
@group(0) @binding(8) var<storage,read> excluded:array<u32>;
fn localOffset(xy:vec2f)->vec2f {
  if(p.band.w==0u) {return vec2f(0);}
  let grid=p.band.w; let q=clamp((xy+.5)*f32(grid)/vec2f(p.size.xy)-.5,vec2f(0),vec2f(f32(grid-1u)));let base=vec2u(floor(q));let f=fract(q);var delta=vec2f(0);
  for(var y=0u;y<2u;y++) {for(var x=0u;x<2u;x++) {let k=min(base+vec2u(x,y),vec2u(grid-1u));let weight=select(1.-f.x,f.x,x==1u)*select(1.-f.y,f.y,y==1u);delta+=offsets[k.y*grid+k.x]*weight;}}
  return delta;
}
fn luminance(rgb:vec3f)->f32 { return dot(rgb,vec3f(.2627,.678,.0593)); }
fn variance(v:f32,scale:f32,iso:f32)->f32 { return (.0015*.0015*max(1.,iso/100.)+.0001*max(0.,v))/(scale*scale); }
fn sample(q:vec2f)->vec4f {
  let base=vec2i(floor(q)); let fraction=fract(q); var rgb=vec3f(0); var valid=1.;
  for(var y=0;y<2;y++) { for(var x=0;x<2;x++) {
    let tap=min(base+vec2i(x,y),vec2i(p.size.xy)-1);
    let weight=select(1.-fraction.x,fraction.x,x==1)*select(1.-fraction.y,fraction.y,y==1);
    if(weight<=0.) { continue; }
    let value=source[(u32(tap.y)-p.band.x)*p.size.x+u32(tap.x)]; rgb+=value.rgb*weight;
    if(value.a<1.) { valid=0.; }
  } }
  return vec4f(rgb,valid);
}
@compute @workgroup_size(256) fn referencePixels(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if(i>=p.size.x*p.size.w) { return; }
  reference[i]=sample(vec2f(f32(i%p.size.x),f32(p.size.z+i/p.size.x)));
}
@compute @workgroup_size(256) fn accumulate(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if(i>=p.size.x*p.size.w || coverage[i]==0u) { return; }
  let confidence=1.-f32(excluded[i])/select(1.,255.,p.matrix[0].w>0.);
  if(confidence<=0.) { return; }
  let xy=vec3f(f32(i%p.size.x),f32(p.size.z+i/p.size.x),1.);
  let denominator=dot(p.matrix[2].xyz,xy); let q=vec2f(dot(p.matrix[0].xyz,xy),dot(p.matrix[1].xyz,xy))/denominator+localOffset(xy.xy);
  if(any(q<vec2f(0)) || any(q>vec2f(p.size.xy)-1.)) { return; }
  let value=sample(q); let referenceValue=reference[i]; let rawY=luminance(value.rgb); let refY=luminance(referenceValue.rgb);
  let v=variance(rawY,p.values.x,p.values.y);
  if(p.band.z==1u && value.a>0. && referenceValue.a>0. && p.values.w>0. && abs(rawY/p.values.x-refY)>(8.-p.values.w*.04)*sqrt(v+variance(refY,1.,p.values.z))) { motion[i]=1u; }
  if(value.a==0.) { return; }
  let weight=confidence/max(1e-12,v); sums[i]+=vec4f(value.rgb/p.values.x*weight,weight);
}
@compute @workgroup_size(256) fn finish(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x; if(i>=p.size.x*p.size.w) { return; }
  let sum=sums[i]; var rgb=reference[i].rgb;
  if(sum.a>0.) { rgb=sum.rgb/sum.a; }
  output[i]=vec4f(rgb,f32(coverage[i]>0u && sum.a>0.));
}
`
