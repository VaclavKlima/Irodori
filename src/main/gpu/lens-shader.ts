export const lensShader = /* wgsl */ `
struct Params { size: vec4u, crop: vec4u, camera: array<vec4f, 3> }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var correctedOutput: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<storage, read> lut: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> histogram: array<atomic<u32>>;
fn radial(r: f32) -> vec4f {
  let pos = clamp(r * 4095.0, 0.0, 4095.0); let i = min(4094u, u32(pos));
  return mix(lut[i], lut[i+1u], vec4f(pos-f32(i)));
}
fn cubic(v: f32) -> f32 {
  let x=abs(v);
  if(x<1.0) { return (1.5*x-2.5)*x*x+1.0; }
  if(x<2.0) { return ((-0.5*x+2.5)*x-4.0)*x+2.0; }
  return 0.0;
}
@compute @workgroup_size(16,16) fn correct(@builtin(global_invocation_id) id:vec3u) {
  if(any(id.xy>=p.size.zw)) { return; }
  let center=(vec2f(p.size.xy)-1.0)*0.5; let radius=length(center);
  let q=vec2f(id.xy+p.crop.xy)-center; let factors=radial(length(q)/radius);
  var rgb=vec3f(0);
  for(var c=0u;c<3u;c++) {
    let position=center+q*factors[c]; let base=vec2i(floor(position));
    for(var y=-1;y<=2;y++) { for(var x=-1;x<=2;x++) {
      let tap=clamp(base+vec2i(x,y),vec2i(0),vec2i(p.size.xy)-1);
      let gain=radial(length(vec2f(tap)-center)/radius).w;
      rgb[c]+=textureLoad(source,tap,0)[c]*gain*cubic(position.x-f32(base.x+x))*cubic(position.y-f32(base.y+y));
    } }
  }
  var converted:vec3f;
  for(var c=0u;c<3u;c++) { converted[c]=dot(p.camera[c].xyz,rgb)*65535.0; }
  let clipped=vec3u(clamp(converted,vec3f(0),vec3f(65535)));
  textureStore(correctedOutput,vec2i(id.xy),vec4f(converted/65535.0,1));
  if(p.crop.z==0u) { for(var c=0u;c<3u;c++) { atomicAdd(&histogram[c*8192u+(clipped[c] >> 3u)],1u); } }
}
`
