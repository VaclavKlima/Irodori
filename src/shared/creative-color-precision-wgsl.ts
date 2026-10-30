import { colorIntensityWgsl, D65_XYZ } from './color-intensity'
import { RGB_TO_XYZ, XYZ_TO_RGB, type ColorPrimaries, type ColorTriple } from './color-model'
import { colorRangeDefinitions } from './color-mixer'
import { compensatedScalarWgsl } from './compensated-scalar-wgsl'

const literal = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v))
const constant = (v: number) => {
  const hi = Math.fround(v)
  return `vec2f(${literal(hi)},${literal(Math.fround(v - hi))})`
}
const matrix = (name: string, rows: readonly ColorTriple[]) =>
  `fn ${name}(rgb:array<vec2f,3>)->array<vec2f,3> {return array<vec2f,3>(${rows.map((row) => row.reduce((sum, v, i) => `ccAdd(${sum},ccMul(rgb[${i}],${constant(v)}))`, 'vec2f(0.)')).join(',')});}`
const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))

/** Compensated color math is restricted to active creative controls in the point kernel. */
export function creativeColorPrecisionWgsl(
  primaries: ColorPrimaries,
  binding: number,
  power: string,
): string {
  return `
${colorIntensityWgsl(primaries, power)}
@group(0) @binding(${binding}) var<storage,read> creativeColorData:array<vec4f>;
${compensatedScalarWgsl('cc', 'creativeColorData[2].z')}
${creativeColorPrecisionBody(primaries, power)}
`
}

export function creativeColorPrecisionBody(primaries: ColorPrimaries, power = 'pow'): string {
  return `
struct CcSplit {fract:f32,exp:i32}
fn ccSplit(v:f32)->CcSplit {let p=frexp(v);return CcSplit(p.fract,p.exp);}
fn ccValue(v:vec2f)->f32 {return v.x+v.y;}
fn ccLess(a:vec2f,b:vec2f)->bool {return a.x<b.x || (a.x==b.x && a.y<b.y);}
fn ccPairEqual(a:vec2f,b:vec2f)->bool {return all(a==b);}
fn ccRgbEqual(a:vec3f,b:vec3f)->bool {return all(a==b);}
fn ccZero(a:vec2f)->bool {return ccPairEqual(a,vec2f(0.));}
fn ccEqual(a:array<vec2f,3>,b:array<vec2f,3>)->bool {return ccPairEqual(a[0],b[0]) && ccPairEqual(a[1],b[1]) && ccPairEqual(a[2],b[2]);}
fn ccParameter(base:u32,index:u32,channel:u32)->vec2f {return vec2f(creativeColorData[base+2u*index][channel],creativeColorData[base+2u*index+1u][channel]);}
${matrix('ccToXyz', RGB_TO_XYZ[primaries])}
${matrix('ccFromXyz', XYZ_TO_RGB[primaries])}
fn ccSmooth(x:vec2f)->vec2f {
  if(!ccLess(vec2f(0.),x)) {return vec2f(0.);}
  if(!ccLess(x,vec2f(1.,0.))) {return vec2f(1.,0.);}
  return ccMul(ccMul(x,x),ccSub(vec2f(3.,0.),ccMul(vec2f(2.,0.),x)));
}
fn ccSqrt(v:vec2f)->vec2f {
  var root:vec2f=vec2f(sqrt(v.x),0.);
  for(var i:i32=0;i<2;i++) {root=ccAdd(root,ccDiv(ccSub(v,ccMul(root,root)),ccMul(vec2f(2.,0.),root)));}
  return root;
}
// All operator exponents lie in [-1,1]; the degree-14 series is bounded there.
fn ccExp2(v:vec2f)->vec2f {
  let x:vec2f=ccMul(v,${constant(Math.LN2)});
  var sum:vec2f=${constant(1 / factorial(14))};
  ${Array.from({ length: 14 }, (_, i) => 13 - i)
    .map((n) => `sum=ccAdd(${constant(1 / factorial(n))},ccMul(x,sum));`)
    .join('\n')}
  return sum;
}
fn ccLog2(v:vec2f)->vec2f {
  let split:CcSplit=ccSplit(v.x);
  let m:vec2f=vec2f(ldexp(v.x,-split.exp),ldexp(v.y,-split.exp));
  let t:vec2f=ccDiv(ccSub(m,vec2f(1.,0.)),ccAdd(m,vec2f(1.,0.)));let square:vec2f=ccMul(t,t);
  var term:vec2f=t;var sum:vec2f=t;
  // |t| <= 1/3, so the omitted logarithm tail is below 2e-15.
  for(var i:i32=1;i<14;i++) {term=ccMul(term,square);sum=ccAdd(sum,ccDiv(term,vec2f(f32(2*i+1),0.)));}
  return ccAdd(vec2f(f32(split.exp),0.),ccMul(sum,${constant(2 / Math.LN2)}));
}
const ccEpsilon:vec2f=${constant(216 / 24389)};
const ccDelta:vec2f=${constant(6 / 29)};
const ccWhiteX:vec2f=${constant(D65_XYZ[0])};
const ccWhiteZ:vec2f=${constant(D65_XYZ[2])};
fn ccF(v:vec2f)->vec2f {
  if(!ccLess(ccEpsilon,v)) {return ccDiv(ccAdd(ccMul(${constant(24389 / 27)},v),vec2f(16.,0.)),vec2f(116.,0.));}
  var root:vec2f=vec2f(${power}(v.x,1./3.),0.);
  for(var i:i32=0;i<2;i++) {
    let square:vec2f=ccMul(root,root);
    root=ccAdd(root,ccDiv(ccSub(v,ccMul(square,root)),ccMul(vec2f(3.,0.),square)));
  }
  return root;
}
fn ccInverse(v:vec2f)->vec2f {
  if(ccLess(ccDelta,v)) {return ccMul(ccMul(v,v),v);}
  return ccMul(ccSub(ccMul(vec2f(116.,0.),v),vec2f(16.,0.)),${constant(27 / 24389)});
}
fn ccLightness(y:vec2f)->vec2f {
  if(!ccLess(ccEpsilon,y)) {return ccMul(${constant(24389 / 27)},y);}
  return ccSub(ccMul(vec2f(116.,0.),ccF(y)),vec2f(16.,0.));
}
fn ccRatio(y:vec2f,next:vec2f,gain:vec2f)->vec2f {
  if(ccPairEqual(gain,vec2f(1.,0.))) {return gain;}
  if(!ccLess(ccEpsilon,y) && !ccLess(ccEpsilon,next)) {return gain;}
  return ccDiv(ccLightness(next),ccLightness(y));
}
fn ccLab(rgb:array<vec2f,3>)->array<vec2f,3> {
  if(ccPairEqual(rgb[0],rgb[1]) && ccPairEqual(rgb[1],rgb[2])) {return array<vec2f,3>(rgb[0],vec2f(0.),vec2f(0.));}
  let xyz:array<vec2f,3>=ccToXyz(rgb);let fy:vec2f=ccF(xyz[1]);
  return array<vec2f,3>(xyz[1],ccMul(vec2f(500.,0.),ccSub(ccF(ccDiv(xyz[0],ccWhiteX)),fy)),ccMul(vec2f(200.,0.),ccSub(fy,ccF(ccDiv(xyz[2],ccWhiteZ)))));
}
struct CcSelection {first:u32,second:u32,blend:vec2f,protection:vec2f}
const ccDirections:array<vec4f,8>=array<vec4f,8>(${colorRangeDefinitions.map((v) => `vec4f(${constant(v.direction[0])},${constant(v.direction[1])})`).join(',')});
fn ccCross(direction:vec4f,a:vec2f,b:vec2f)->vec2f {return ccSub(ccMul(direction.xy,b),ccMul(direction.zw,a));}
fn ccSelect(rgb:vec3f)->CcSelection {
  let empty:CcSelection=CcSelection(0u,1u,vec2f(0.),vec2f(0.));
  if(ccRgbEqual(rgb,vec3f(rgb.x))) {return empty;}
  let peak:f32=max(max(abs(rgb.x),abs(rgb.y)),abs(rgb.z));if(peak==0.) {return empty;}
  let divisor:vec2f=vec2f(peak,0.);
  let lab:array<vec2f,3>=ccLab(array<vec2f,3>(ccDiv(vec2f(rgb.x,0.),divisor),ccDiv(vec2f(rgb.y,0.),divisor),ccDiv(vec2f(rgb.z,0.),divisor)));
  let chroma2:vec2f=ccAdd(ccMul(lab[1],lab[1]),ccMul(lab[2],lab[2]));let l:vec2f=ccLightness(lab[0]);
  let denominator:vec2f=ccAdd(ccMul(l,l),ccMul(vec2f(4.,0.),chroma2));if(ccZero(denominator)) {return empty;}
  let protection:vec2f=ccSmooth(ccDiv(ccSub(ccDiv(chroma2,denominator),${constant(0.0004)}),${constant(0.006)}));
  if(ccZero(protection)) {return empty;}
  let firstCross:vec2f=ccCross(ccDirections[0],lab[1],lab[2]);var left:vec2f=firstCross;
  for(var i:u32=0u;i<8u;i++) {
    let next:u32=(i+1u)%8u;var nextCross:vec2f=firstCross;
    if(next!=0u) {nextCross=ccCross(ccDirections[next],lab[1],lab[2]);}
    let right:vec2f=-nextCross;let sum:vec2f=ccAdd(left,right);
    if(!ccLess(left,vec2f(0.)) && !ccLess(right,vec2f(0.)) && ccLess(vec2f(0.),sum)) {
      return CcSelection(i,next,ccSmooth(ccDiv(left,sum)),protection);
    }
    left=nextCross;
  }
  return empty;
}
fn ccSelection(rgb:vec3f)->vec4f {let v:CcSelection=ccSelect(rgb);return vec4f(f32(v.first),f32(v.second),ccValue(v.blend),ccValue(v.protection));}
fn ccMixer(value:array<vec2f,3>,selected:CcSelection,base:u32)->array<vec2f,3> {
  if(ccZero(selected.protection)) {return value;}
  let left:vec2f=ccSub(vec2f(1.,0.),selected.blend);var amounts:array<vec2f,4>;
  for(var i:u32=0u;i<4u;i++) {
    amounts[i]=ccMul(selected.protection,ccAdd(ccMul(left,ccParameter(base,2u+selected.first,i)),ccMul(selected.blend,ccParameter(base,2u+selected.second,i))));
  }
  if(ccZero(amounts[0]) && ccZero(amounts[1]) && ccZero(amounts[2]) && ccZero(amounts[3])) {return value;}
  let real:vec2f=ccAdd(vec2f(1.,0.),amounts[0]);let imaginary:vec2f=amounts[1];
  let length:vec2f=ccSqrt(ccAdd(ccMul(real,real),ccMul(imaginary,imaginary)));
  let cosineDelta:vec2f=-ccDiv(ccMul(imaginary,imaginary),ccMul(length,ccAdd(real,length)));let sine:vec2f=ccDiv(imaginary,length);
  var gain:vec2f=vec2f(1.,0.);if(!ccZero(amounts[3])) {gain=ccExp2(amounts[3]);}
  let y:vec2f=ccMul(value[0],gain);let scale:vec2f=ccMul(ccAdd(vec2f(1.,0.),amounts[2]),ccRatio(value[0],y,gain));
  let a:vec2f=ccMul(ccSub(ccAdd(value[1],ccMul(cosineDelta,value[1])),ccMul(sine,value[2])),scale);
  let b:vec2f=ccMul(ccAdd(ccAdd(value[2],ccMul(sine,value[1])),ccMul(cosineDelta,value[2])),scale);
  return array<vec2f,3>(y,a,b);
}
fn ccGradeAmounts(y:vec2f,base:u32)->array<vec2f,3> {
  let empty:array<vec2f,3>=array<vec2f,3>(vec2f(0.),vec2f(0.),vec2f(0.));
  if(creativeColorData[base].w==0.) {return empty;}
  var weights:array<vec2f,3>=array<vec2f,3>(vec2f(1.,0.),vec2f(0.),vec2f(0.));
  let positive:bool=ccLess(vec2f(0.),y);
  if(positive) {
    let width:vec2f=ccParameter(base,1u,0u);let z:vec2f=ccAdd(ccLog2(ccDiv(y,${constant(0.18)})),ccParameter(base,1u,1u));
    let denominator:vec2f=ccMul(vec2f(2.,0.),width);
    let left:vec2f=ccSmooth(ccDiv(ccAdd(ccAdd(z,vec2f(2.,0.)),width),denominator));
    let right:vec2f=ccSmooth(ccDiv(ccAdd(ccSub(z,vec2f(2.,0.)),width),denominator));
    weights=array<vec2f,3>(ccSub(vec2f(1.,0.),left),ccSub(left,right),right);
  }
  var amounts:array<vec2f,3>=empty;
  for(var tone:u32=0u;tone<3u;tone++) {for(var c:u32=0u;c<3u;c++) {amounts[c]=ccAdd(amounts[c],ccMul(weights[tone],ccParameter(base,10u+tone,c)));}}
  if(!positive) {amounts[0]=vec2f(0.);amounts[1]=vec2f(0.);}return amounts;
}
fn ccIntensity(value:array<vec2f,3>,color:vec2f)->array<vec2f,3> {
  if(ccPairEqual(color,vec2f(0.))) {return value;}
  if(color.x == -100.) {return array<vec2f,3>(value[0],vec2f(0.),vec2f(0.));}
  let l:vec2f=ccLightness(value[0]);let l2:vec2f=ccMul(l,l);
  let denominator:vec2f=ccAdd(l2,ccMul(vec2f(4.,0.),ccAdd(ccMul(value[1],value[1]),ccMul(value[2],value[2]))));
  var weight:vec2f=vec2f(0.);if(ccLess(vec2f(0.),denominator)) {weight=ccDiv(l2,denominator);}
  let gain:vec2f=ccMul(ccAdd(vec2f(1.,0.),ccDiv(vec2f(color.x,0.),vec2f(100.,0.))),ccExp2(ccMul(ccDiv(vec2f(color.y,0.),vec2f(100.,0.)),weight)));
  return array<vec2f,3>(value[0],ccMul(value[1],gain),ccMul(value[2],gain));
}
fn ccGrade(value:array<vec2f,3>,amounts:array<vec2f,3>)->array<vec2f,3> {
  if(ccZero(amounts[0]) && ccZero(amounts[1]) && ccZero(amounts[2])) {return value;}
  var gain:vec2f=vec2f(1.,0.);if(!ccZero(amounts[2])) {gain=ccExp2(amounts[2]);}
  let y:vec2f=ccMul(value[0],gain);let ratio:vec2f=ccRatio(value[0],y,gain);
  var strength:vec2f=ccLightness(y);if(ccLess(strength,vec2f(0.))) {strength=vec2f(0.);}
  return array<vec2f,3>(y,ccAdd(ccMul(value[1],ratio),ccMul(strength,amounts[0])),ccAdd(ccMul(value[2],ratio),ccMul(strength,amounts[1])));
}
fn ccResult(rgb:vec3f,original:array<vec2f,3>,value:array<vec2f,3>)->vec3f {
  if(ccEqual(original,value)) {return rgb;}
  if(ccZero(value[1]) && ccZero(value[2])) {return vec3f(ccValue(value[0]));}
  let fy:vec2f=ccF(value[0]);
  let xyz:array<vec2f,3>=array<vec2f,3>(ccMul(ccWhiteX,ccInverse(ccAdd(fy,ccDiv(value[1],vec2f(500.,0.))))),value[0],ccMul(ccWhiteZ,ccInverse(ccSub(fy,ccDiv(value[2],vec2f(200.,0.))))));
  let result:array<vec2f,3>=ccFromXyz(xyz);return vec3f(ccValue(result[0]),ccValue(result[1]),ccValue(result[2]));
}
fn creativeColorApplyAt(rgb:vec3f,base:u32)->vec3f {
  let header:vec4f=creativeColorData[base];
  if(ccPairEqual(header.zw,vec2f(0.))) {return applyColorIntensity(rgb,header.xy);}
  let original:array<vec2f,3>=ccLab(array<vec2f,3>(vec2f(rgb.x,0.),vec2f(rgb.y,0.),vec2f(rgb.z,0.)));var mixed:array<vec2f,3>=original;
  if(header.z!=0.) {mixed=ccMixer(mixed,ccSelect(rgb),base);}
  let grade:array<vec2f,3>=ccGradeAmounts(mixed[0],base);
  if(ccEqual(mixed,original) && ccZero(grade[0]) && ccZero(grade[1]) && ccZero(grade[2])) {return applyColorIntensity(rgb,header.xy);}
  return ccResult(rgb,original,ccGrade(ccIntensity(mixed,header.xy),grade));
}
fn applyCreativeColor(rgb:vec3f)->vec3f {return creativeColorApplyAt(rgb,0u);}
`
}
