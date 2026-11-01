import { compensatedScalarWgsl } from '../../../src/shared/compensated-scalar-wgsl'
import { NOISE_SPATIAL_WEIGHTS } from '../../../src/shared/spatial-detail'

/** Research only. Three passes share one immutable, mixed integer/float uniform. */
export const patchwiseNoiseWgsl = `
struct PatchParameters {
  image:vec4u, source:vec4u, centers:vec4u, outputRect:vec4u,
  noise:vec4f, statistics:vec4f, coefficients0:vec4f, coefficients1:vec4f,
}
@group(0) @binding(0) var<uniform> patchParams:PatchParameters;
@group(0) @binding(1) var<storage,read> inputPixels:array<vec4u>;
@group(0) @binding(2) var<storage,read_write> featurePixels:array<vec4f>;
// A vec3 array would have a 16-byte stride. The declared publication is 27 scalars.
@group(0) @binding(3) var<storage,read_write> estimates:array<u32>;
@group(0) @binding(4) var<storage,read_write> outputPixels:array<vec4u>;
const spatial:array<f32,49> = array<f32,49>(${NOISE_SPATIAL_WEIGHTS.map((v) => v.toPrecision(17)).join(',')});
${compensatedScalarWgsl('patchDs')}
fn scalar(v:vec2f)->f32 {return v.x+v.y;}
fn luminance(rgb:vec3f)->f32 {
  return scalar(patchDsAdd(patchDsAdd(
    patchDsMul(vec2f(rgb.x,0.),patchParams.coefficients0.xy),
    patchDsMul(vec2f(rgb.y,0.),patchParams.coefficients0.zw)),
    patchDsMul(vec2f(rgb.z,0.),patchParams.coefficients1.xy)));
}
fn greenDelta(a:f32,b:f32)->f32 {
  return scalar(patchDsDiv(patchDsAdd(
    patchDsMul(patchParams.coefficients0.xy,vec2f(a,0.)),
    patchDsMul(patchParams.coefficients1.xy,vec2f(b,0.))),patchParams.coefficients0.zw));
}
fn hypot2(x:f32,y:f32)->f32 {
  let m=max(abs(x),abs(y));if(m==0.) {return 0.;}
  let v=vec2f(x,y)/m;return m*sqrt(dot(v,v));
}
fn coordinateDelta(v:f32,s:f32,d:f32)->f32 {
  if(d==0.) {return 0.;}
  let h=sinh(d*.5);return v*2.*h*h+hypot2(v,s)*sinh(d);
}
fn clampImage(p:vec2i)->vec2i {return clamp(p,vec2i(0),vec2i(patchParams.image.xy)-vec2i(1));}
fn sourceIndex(p:vec2i)->u32 {
  // Only unused cache-padding slots may fall outside the admitted source window.
  let local=clamp(clampImage(p)-vec2i(patchParams.source.xy),vec2i(0),vec2i(patchParams.source.zw)-vec2i(1));
  return u32(local.y)*patchParams.source.z+u32(local.x);
}
fn canonicalStageZero(v:f32)->f32 {
  let bits=bitcast<u32>(v);return bitcast<f32>(select(bits,0u,(bits&0x7fffffffu)==0u));
}
fn finiteFeatures(v:vec3f)->bool {
  return all((bitcast<vec3u>(v)&vec3u(0x7f800000u))!=vec3u(0x7f800000u));
}
fn invalidateCenter(base:u32) {
  // Propagate unsupported internal arithmetic to checked output, never a silent bypass.
  for(var i=0u;i<27u;i++) {estimates[base+i]=0x7fc00000u;}
}
@compute @workgroup_size(64) fn preparePatchwiseFeatures(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=patchParams.source.z*patchParams.source.w) {return;}
  let p=bitcast<vec4f>(inputPixels[id.x]);
  if(p.a==0.) {featurePixels[id.x]=vec4f(0.,0.,0.,p.a);return;}
  let y=luminance(p.rgb);let s=hypot2(y,.18);
  featurePixels[id.x]=vec4f(asinh(y/.18),asinh((p.r-y)/s),asinh((p.b-y)/s),p.a);
}
var<workgroup> cache:array<vec4f,256>;
fn cached(p:vec2i)->vec4f {return cache[u32(p.y*16+p.x)];}
@compute @workgroup_size(8,8) fn estimatePatchwiseCenters(
  @builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_id) local:vec3u,
  @builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) groupId:vec3u) {
  let origin=vec2i(patchParams.centers.xy)+vec2i(groupId.xy*8u)-vec2i(4);
  for(var slot=lane;slot<256u;slot+=64u) {
    let p=origin+vec2i(i32(slot%16u),i32(slot/16u));cache[slot]=featurePixels[sourceIndex(p)];
  }
  workgroupBarrier();
  if(id.x>=patchParams.centers.z||id.y>=patchParams.centers.w) {return;}
  let c=vec2i(patchParams.centers.xy)+vec2i(id.xy);
  let base=(id.y*patchParams.centers.z+id.x)*27u;
  for(var i=0u;i<27u;i++) {estimates[base+i]=0u;}
  let center=vec2i(local.xy)+vec2i(4);
  if(cached(center).a==0.) {return;}
  var sums:array<vec3f,9>;var normalizers:array<vec2f,9>;
  for(var i=0u;i<9u;i++) {sums[i]=vec3f(0.);normalizers[i]=vec2f(0.);}
  for(var dy=-3;dy<=3;dy++) {for(var dx=-3;dx<=3;dx++) {
    let d=vec2i(dx,dy);let neighbor=cached(center+d);
    if(neighbor.a==0.) {continue;}
    var distances=vec2f(0.);var coverage=0.;var distinctCoverage=0.;
    for(var ry=-1;ry<=1;ry++) {for(var rx=-1;rx<=1;rx++) {
      let r=vec2i(rx,ry);let a=cached(center+r);let b=cached(center+d+r);
      let alpha=a.a*b.a;if(alpha==0.) {continue;}
      if(!finiteFeatures(a.xyz)||!finiteFeatures(b.xyz)) {invalidateCenter(base);return;}
      let delta=a.xyz-b.xyz;
      distances+=alpha*vec2f(delta.x*delta.x,delta.y*delta.y+delta.z*delta.z);
      coverage+=alpha;
      if(any(clampImage(c+r)!=clampImage(c+d+r))) {distinctCoverage+=alpha;}
    }}
    let corrected=max(distances/coverage-2.*patchParams.statistics.xy*(distinctCoverage/coverage),vec2f(0.));
    let baseWeight=spatial[u32((dy+3)*7+dx+3)]*neighbor.a;
    var weights=vec2f(0.);
    if(patchParams.noise.x==1.) {weights.x=baseWeight*exp(-corrected.x*patchParams.noise.z-corrected.y/(.12*.12));}
    if(patchParams.noise.y==1.) {weights.y=baseWeight*exp(-corrected.x/(.08*.08)-corrected.y*patchParams.noise.w);}
    for(var ry=-1;ry<=1;ry++) {for(var rx=-1;rx<=1;rx++) {
      let r=vec2i(rx,ry);let t=c+r;
      if(any(t<vec2i(0))||any(t>=vec2i(patchParams.image.xy))) {continue;}
      let targetFeature=cached(center+r);let sampleFeature=cached(center+d+r);
      if(targetFeature.a==0.||sampleFeature.a==0.) {continue;}
      let i=u32((ry+1)*3+rx+1);let w=weights*sampleFeature.a;
      sums[i]+=vec3f(w.x,w.y,w.y)*(sampleFeature.xyz-targetFeature.xyz);normalizers[i]+=w;
    }}
  }}
  for(var i=0u;i<9u;i++) {
    if(patchParams.noise.x==1.&&normalizers[i].x>0.) {estimates[base+i*3u]=bitcast<u32>(canonicalStageZero(sums[i].x/normalizers[i].x));}
    if(patchParams.noise.y==1.&&normalizers[i].y>0.) {
      estimates[base+i*3u+1u]=bitcast<u32>(canonicalStageZero(sums[i].y/normalizers[i].y));
      estimates[base+i*3u+2u]=bitcast<u32>(canonicalStageZero(sums[i].z/normalizers[i].y));
    }
  }
}
@compute @workgroup_size(64) fn gatherPatchwiseOutput(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=patchParams.outputRect.z*patchParams.outputRect.w) {return;}
  let p=vec2i(patchParams.outputRect.xy)+vec2i(i32(id.x%patchParams.outputRect.z),i32(id.x/patchParams.outputRect.z));
  let raw=inputPixels[sourceIndex(p)];let rgba=bitcast<vec4f>(raw);
  if(rgba.a==0.||(patchParams.noise.x==0.&&patchParams.noise.y==0.)) {outputPixels[id.x]=raw;return;}
  var sums=vec3f(0.);var normalizer=0.;
  for(var ry=-1;ry<=1;ry++) {for(var rx=-1;rx<=1;rx++) {
    let c=p-vec2i(rx,ry);
    if(any(c<vec2i(0))||any(c>=vec2i(patchParams.image.xy))) {continue;}
    let alpha=featurePixels[sourceIndex(c)].a;if(alpha==0.) {continue;}
    let local=c-vec2i(patchParams.centers.xy);let center=u32(local.y)*patchParams.centers.z+u32(local.x);
    let base=center*27u+u32((ry+1)*3+rx+1)*3u;
    let proposal=bitcast<vec3f>(vec3u(estimates[base],estimates[base+1u],estimates[base+2u]));
    if(!finiteFeatures(proposal)) {
      outputPixels[id.x]=vec4u(vec3u(0x7fc00000u),raw.a);return;
    }
    sums+=alpha*proposal;normalizer+=alpha;
  }}
  let delta=sums/normalizer*vec3f(patchParams.statistics.z,patchParams.statistics.w,patchParams.statistics.w);
  let y=luminance(rgba.rgb);let scale=hypot2(y,.18);
  var dl=0.;var da=0.;var db=0.;
  if(patchParams.noise.x==1.) {dl=coordinateDelta(y,.18,delta.x);}
  if(patchParams.noise.y==1.) {da=coordinateDelta(rgba.r-y,scale,delta.y);db=coordinateDelta(rgba.b-y,scale,delta.z);}
  if(dl==0.&&da==0.&&db==0.) {outputPixels[id.x]=raw;return;}
  let rgb=vec3f(rgba.r+dl+da,rgba.g+dl-greenDelta(da,db),rgba.b+dl+db);
  outputPixels[id.x]=vec4u(bitcast<vec3u>(rgb),raw.a);
}
`

/** A source-frozen research variant; the Gaussian export above remains unchanged. */
export type ResearchChromaSpatialPolicy = 'gaussian-search-v1' | 'uniform-search-v1'

export function patchwiseNoiseWgslForChromaSpatialPolicy(
  policy: ResearchChromaSpatialPolicy = 'gaussian-search-v1',
): string {
  if (policy === 'gaussian-search-v1') return patchwiseNoiseWgsl
  if (policy !== 'uniform-search-v1') throw new Error('Unknown research chroma spatial policy.')
  const gaussian =
      'if(patchParams.noise.y==1.) {weights.y=baseWeight*exp(-corrected.x/(.08*.08)-corrected.y*patchParams.noise.w);}',
    uniform =
      'if(patchParams.noise.y==1.) {weights.y=neighbor.a*exp(-corrected.x/(.08*.08)-corrected.y*patchParams.noise.w);}'
  if (patchwiseNoiseWgsl.split(gaussian).length !== 2)
    throw new Error('Research shader no longer has exactly one declared chroma spatial term.')
  return patchwiseNoiseWgsl.replace(gaussian, uniform)
}
