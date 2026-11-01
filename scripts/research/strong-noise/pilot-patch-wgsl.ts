import { compensatedScalarWgsl } from '../../../src/shared/compensated-scalar-wgsl'
import { NOISE_SPATIAL_WEIGHTS } from '../../../src/shared/spatial-detail'

/**
 * Disabled C16 GPU prototype. Whole-image coordinates only. Intermediate stage
 * publication is f32; compensated arithmetic reduces accumulation cancellation,
 * but WGSL transcendental results are not the host-F64 research proof.
 */
export const pilotPatchWgsl = `
struct Parameters {
  image:vec4u, noise:vec4f, statistics:vec4f, coefficients0:vec4f,
  coefficients1:vec4f, reserved0:vec4f, reserved1:vec4f, reserved2:vec4f,
}
@group(0) @binding(0) var<uniform> params:Parameters;
@group(0) @binding(1) var<storage,read> inputPixels:array<vec4u>;
@group(0) @binding(2) var<storage,read_write> features:array<vec4f>;
// The physical publications are scalar arrays, without vec3 stride padding.
@group(0) @binding(3) var<storage,read_write> pilot:array<f32>;
@group(0) @binding(4) var<storage,read_write> userL:array<f32>;
@group(0) @binding(5) var<storage,read_write> guide:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> finalC:array<vec2f>;
@group(0) @binding(7) var<storage,read_write> outputPixels:array<vec4u>;
const spatial:array<f32,49> = array<f32,49>(${NOISE_SPATIAL_WEIGHTS.map((v) => v.toPrecision(17)).join(',')});
${compensatedScalarWgsl('ds')}
fn value(v:vec2f)->f32 {return dsRound(v.x+v.y);}
fn pair(v:f32)->vec2f {return vec2f(v,0.);}
fn addProduct(s:vec2f,a:f32,b:f32)->vec2f {return dsAdd(s,dsMul(pair(a),pair(b)));}
fn square(v:f32)->vec2f {return dsMul(pair(v),pair(v));}
fn ratio(n:vec2f,d:vec2f)->f32 {return value(dsDiv(n,d));}
fn published(v:f32)->f32 {if(v==0.) {return 0.;}return v;}
fn index(p:vec2i)->u32 {
  let v=clamp(p,vec2i(0),vec2i(params.image.xy)-vec2i(1));
  return u32(v.y)*params.image.x+u32(v.x);
}
fn inside(p:vec2i)->bool {return all(p>=vec2i(0))&&all(p<vec2i(params.image.xy));}
fn point(i:u32)->vec2i {return vec2i(i32(i%params.image.x),i32(i/params.image.x));}
fn bandIndex(i:u32)->u32 {return params.image.z*params.image.x+i;}
fn bandOutside(i:u32)->bool {return i>=params.image.x*params.image.w;}
fn luminance(rgb:vec3f)->f32 {
  return value(dsAdd(dsAdd(dsMul(pair(rgb.r),params.coefficients0.xy),
    dsMul(pair(rgb.g),params.coefficients0.zw)),dsMul(pair(rgb.b),params.coefficients1.xy)));
}
fn hypot2(x:f32,y:f32)->f32 {
  let m=max(abs(x),abs(y));if(m==0.) {return 0.;}
  let v=vec2f(x,y)/m;return m*sqrt(dot(v,v));
}
fn change(v:f32,s:f32,d:f32)->f32 {
  if(d==0.) {return 0.;}let h=sinh(d*.5);
  return value(dsAdd(dsMul(pair(v),pair(2.*h*h)),dsMul(pair(hypot2(v,s)),pair(sinh(d)))));
}
fn green(a:f32,b:f32)->vec2f {
  return dsDiv(dsAdd(dsMul(params.coefficients0.xy,pair(a)),
    dsMul(params.coefficients1.xy,pair(b))),params.coefficients0.zw);
}
// Original/pilot matching offsets are applied BEFORE the global clamp. The
// final guide matcher below deliberately uses center-first clamping instead.
fn originalDistance(c:vec2i,d:vec2i,radius:i32)->vec2f {
  var q=vec2f(0.);var dl=vec2f(0.);var dc=vec2f(0.);var distinct=vec2f(0.);
  for(var y=-radius;y<=radius;y++) {for(var x=-radius;x<=radius;x++) {
    let u=vec2i(x,y);let ai=index(c+u);let bi=index(c+d+u);
    let a=features[ai];let b=features[bi];let alpha=a.a*b.a;
    if(alpha==0.) {continue;}
    let diff=a.xyz-b.xyz;
    q=dsAdd(q,pair(alpha));
    dl=dsAdd(dl,dsMul(pair(alpha),square(diff.x)));
    dc=dsAdd(dc,dsMul(pair(alpha),dsAdd(square(diff.y),square(diff.z))));
    if(ai!=bi) {distinct=dsAdd(distinct,pair(alpha));}
  }}
  if(value(q)<=0.) {return vec2f(0.);}
  let bias=ratio(distinct,q);
  return max(vec2f(ratio(dl,q),ratio(dc,q))-2.*params.statistics.xy*bias,vec2f(0.));
}
@compute @workgroup_size(64) fn prepareFeatures(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let rgba=bitcast<vec4f>(inputPixels[i]);
  if(rgba.a==0.) {features[i]=vec4f(0.);return;}
  let y=luminance(rgba.rgb);let scale=hypot2(y,.18);
  features[i]=vec4f(asinh(y/.18),asinh((rgba.r-y)/scale),asinh((rgba.b-y)/scale),rgba.a);
}
@compute @workgroup_size(64) fn estimateLuminance(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let c=point(i);
  for(var r=0u;r<9u;r++) {pilot[i*59u+r]=0.;userL[i*9u+r]=0.;}
  if(features[i].a==0.) {return;}
  var ps:array<vec2f,9>;var pz:array<vec2f,9>;
  var us:array<vec2f,9>;var uz:array<vec2f,9>;
  for(var r=0u;r<9u;r++) {ps[r]=vec2f(0.);pz[r]=vec2f(0.);us[r]=vec2f(0.);uz[r]=vec2f(0.);}
  for(var dy=-3;dy<=3;dy++) {for(var dx=-3;dx<=3;dx++) {
    let d=vec2i(dx,dy);let n=features[index(c+d)];if(n.a==0.) {continue;}
    let dist=originalDistance(c,d,1);let base=spatial[u32((dy+3)*7+dx+3)]*n.a;
    var wp=0.;var wu=0.;
    if(params.noise.y>0.) {wp=base*exp(-dist.x/(.024*.024)-dist.y/(.12*.12));}
    if(params.noise.x>0.) {wu=base*exp(-dist.x*params.noise.z-dist.y/(.12*.12));}
    for(var y=-1;y<=1;y++) {for(var x=-1;x<=1;x++) {
      let t=c+vec2i(x,y);if(!inside(t)) {continue;}
      let a=features[index(t)];let b=features[index(t+d)];
      if(a.a==0.||b.a==0.) {continue;}
      let r=u32((y+1)*3+x+1);let delta=b.x-a.x;
      let pw=wp*b.a;ps[r]=addProduct(ps[r],pw,delta);pz[r]=dsAdd(pz[r],pair(pw));
      let uw=wu*b.a;us[r]=addProduct(us[r],uw,delta);uz[r]=dsAdd(uz[r],pair(uw));
    }}
  }}
  for(var r=0u;r<9u;r++) {
    if(value(pz[r])>0.) {pilot[i*59u+r]=published(ratio(ps[r],pz[r]));}
    if(value(uz[r])>0.) {userL[i*9u+r]=published(ratio(us[r],uz[r]));}
  }
}
@compute @workgroup_size(64) fn estimatePilotChroma(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let c=point(i);
  for(var r=9u;r<59u;r++) {pilot[i*59u+r]=0.;}
  if(features[i].a==0.) {return;}
  var sa:array<vec2f,25>;var sb:array<vec2f,25>;var sz:array<vec2f,25>;
  for(var r=0u;r<25u;r++) {sa[r]=vec2f(0.);sb[r]=vec2f(0.);sz[r]=vec2f(0.);}
  for(var dy=-10;dy<=10;dy++) {for(var dx=-10;dx<=10;dx++) {
    let d=vec2i(dx,dy);let n=features[index(c+d)];if(n.a==0.) {continue;}
    let dist=originalDistance(c,d,2);
    let w=n.a*exp(-dist.x/(.08*.08)-dist.y*params.coefficients1.z);
    for(var y=-2;y<=2;y++) {for(var x=-2;x<=2;x++) {
      let t=c+vec2i(x,y);if(!inside(t)) {continue;}
      let a=features[index(t)];let b=features[index(t+d)];
      if(a.a==0.||b.a==0.) {continue;}
      let r=u32((y+2)*5+x+2);let tw=w*b.a;
      sa[r]=addProduct(sa[r],tw,b.y-a.y);sb[r]=addProduct(sb[r],tw,b.z-a.z);
      sz[r]=dsAdd(sz[r],pair(tw));
    }}
  }}
  for(var r=0u;r<25u;r++) {if(value(sz[r])>0.) {
    pilot[i*59u+9u+r*2u]=published(ratio(sa[r],sz[r]));
    pilot[i*59u+10u+r*2u]=published(ratio(sb[r],sz[r]));
  }}
}
fn gatherL(p:vec2i,fromPilot:bool)->f32 {
  var s=vec2f(0.);var z=vec2f(0.);
  for(var y=-1;y<=1;y++) {for(var x=-1;x<=1;x++) {
    let c=p-vec2i(x,y);if(!inside(c)) {continue;}
    let i=index(c);let a=features[i].a;if(a==0.) {continue;}
    let r=u32((y+1)*3+x+1);var v=userL[i*9u+r];if(fromPilot) {v=pilot[i*59u+r];}
    z=dsAdd(z,pair(a));s=addProduct(s,a,v);
  }}
  return ratio(s,z);
}
@compute @workgroup_size(64) fn publishGuide(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let p=point(i);let f=features[i];
  if(f.a==0.) {guide[i]=vec4f(0.);return;}
  var sa=vec2f(0.);var sb=vec2f(0.);var z=vec2f(0.);
  for(var y=-2;y<=2;y++) {for(var x=-2;x<=2;x++) {
    let c=p-vec2i(x,y);if(!inside(c)) {continue;}
    let ci=index(c);let a=features[ci].a;if(a==0.) {continue;}
    let at=ci*59u+9u+u32((y+2)*5+x+2)*2u;
    z=dsAdd(z,pair(a));sa=addProduct(sa,a,pilot[at]);sb=addProduct(sb,a,pilot[at+1u]);
  }}
  guide[i]=vec4f(value(dsAdd(pair(f.x),pair(gatherL(p,true)))),
    value(dsAdd(pair(f.y),dsDiv(sa,z))),value(dsAdd(pair(f.z),dsDiv(sb,z))),f.a);
}
@compute @workgroup_size(64) fn estimateFinalChroma(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let p=point(i);finalC[i]=vec2f(0.);
  if(features[i].a==0.) {return;}
  var sa=vec2f(0.);var sb=vec2f(0.);var z=vec2f(0.);
  for(var dy=-10;dy<=10;dy++) {for(var dx=-10;dx<=10;dx++) {
    // Clamp the neighbor CENTER first. Duplicates and physical self stay present.
    let v=clamp(p+vec2i(dx,dy),vec2i(0),vec2i(params.image.xy)-vec2i(1));
    let vi=index(v);let alpha=features[vi].a;if(alpha==0.) {continue;}
    var q=vec2f(0.);var dl=vec2f(0.);var dc=vec2f(0.);
    for(var y=-2;y<=2;y++) {for(var x=-2;x<=2;x++) {
      let a=index(p+vec2i(x,y));let b=index(v+vec2i(x,y));
      let aq=features[a].a*features[b].a;if(aq==0.) {continue;}
      let delta=guide[a].xyz-guide[b].xyz;
      q=dsAdd(q,pair(aq));dl=dsAdd(dl,dsMul(pair(aq),square(delta.x)));
      dc=dsAdd(dc,dsMul(pair(aq),dsAdd(square(delta.y),square(delta.z))));
    }}
    if(value(q)<=0.) {continue;}
    let w=alpha*alpha*exp(-ratio(dl,q)/(.08*.08)-ratio(dc,q)*params.noise.w);
    z=dsAdd(z,pair(w));sa=addProduct(sa,w,features[vi].y-features[i].y);
    sb=addProduct(sb,w,features[vi].z-features[i].z);
  }}
  if(value(z)<=0.) {finalC[i]=vec2f(bitcast<f32>(0x7fc00000u|params.image.z));return;}
  finalC[i]=vec2f(published(ratio(sa,z)),published(ratio(sb,z)));
}
@compute @workgroup_size(64) fn composeOutput(@builtin(global_invocation_id) id:vec3u) {
  if(bandOutside(id.x)) {return;}let i=bandIndex(id.x);let raw=inputPixels[i];let rgba=bitcast<vec4f>(raw);
  if(rgba.a==0.) {outputPixels[i]=raw;return;}
  if(any((bitcast<vec3u>(features[i].xyz)&vec3u(0x7f800000u))==vec3u(0x7f800000u))) {
    outputPixels[i]=vec4u(vec3u(0x7fc00000u),raw.a);return;
  }
  var l=0.;if(params.noise.x>0.) {l=gatherL(point(i),false)*params.statistics.z;}
  var c=vec2f(0.);if(params.noise.y>0.) {c=finalC[i]*params.statistics.w;}
  let y=luminance(rgba.rgb);let scale=hypot2(y,.18);
  let dl=change(y,.18,l);let da=change(rgba.r-y,scale,c.x);let db=change(rgba.b-y,scale,c.y);
  if(dl==0.&&da==0.&&db==0.) {outputPixels[i]=raw;return;}
  let r=value(dsAdd(dsAdd(pair(rgba.r),pair(dl)),pair(da)));
  let g=value(dsSub(dsAdd(pair(rgba.g),pair(dl)),green(da,db)));
  let b=value(dsAdd(dsAdd(pair(rgba.b),pair(dl)),pair(db)));
  outputPixels[i]=vec4u(bitcast<vec3u>(vec3f(r,g,b)),raw.a);
}
`
