import type { ColorPrimaries, ColorTriple } from './color-model'
import { RGB_TO_XYZ, XYZ_TO_RGB } from './color-model'
import { D65_XYZ } from './color-intensity'
import { TONE_CURVE_PARAMETER_FLOATS } from './tone-curves-gpu'

const literal = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v))
const pair = (v: number) =>
  `vec2(${literal(Math.fround(v))},${literal(Math.fround(v - Math.fround(v)))})`
const matrix = (name: string, rows: readonly ColorTriple[]) =>
  `vec2[3] ${name}(vec2 v[3]) {return vec2[3](${rows.map((row) => row.reduce((sum, v, i) => `curveAdd(${sum},curveMul(v[${i}],${pair(v)}))`, 'vec2(0.)')).join(',')});}`

/** GLSL ES frontend of the same compensated PCHIP operator; no LUT or image pass. */
export function toneCurvesGlsl(primaries: ColorPrimaries = 'srgb'): string {
  return `
uniform vec4 toneCurveData[${TONE_CURVE_PARAMETER_FLOATS / 4}];
float curveRound(float v) {return uintBitsToFloat(floatBitsToUint(v)^floatBitsToUint(toneCurveData[4].z));}
vec2 curveSum(float a,float b) {float s=curveRound(a+b);float z=curveRound(s-a);return vec2(s,curveRound(a-curveRound(s-z))+curveRound(b-z));}
vec2 curveAdd(vec2 a,vec2 b) {vec2 s=curveSum(a.x,b.x);return curveSum(s.x,curveRound(s.y+a.y+b.y));}
vec2 curveSub(vec2 a,vec2 b) {return curveAdd(a,-b);}
vec2 curveMul(vec2 a,vec2 b) {
  float ah=uintBitsToFloat(floatBitsToUint(a.x)&0xfffff000u),bh=uintBitsToFloat(floatBitsToUint(b.x)&0xfffff000u);
  float al=curveRound(a.x-ah),bl=curveRound(b.x-bh),p=curveRound(a.x*b.x);
  float e=curveRound(curveRound(curveRound(ah*bh-p)+curveRound(ah*bl))+curveRound(al*bh));
  return curveSum(p,curveRound(curveRound(e+curveRound(al*bl))+a.x*b.y+a.y*b.x+a.y*b.y));
}
vec2 curveDiv(vec2 a,vec2 b) {float q=curveRound(a.x/b.x);vec2 r=curveSub(a,curveMul(vec2(q,0.),b));return curveSum(q,curveRound((r.x+r.y)/b.x));}
bool curveLess(vec2 a,vec2 b) {return a.x<b.x||(a.x==b.x&&a.y<b.y);}
float curveValue(vec2 a) {if(a.y==0.) return a.x;return a.x+a.y;}
vec2 curveEvaluate(vec2 value,int base) {
  vec4 header=toneCurveData[base];if(header.y==1.) return value;
  int count=int(header.x);vec2 first=header.zw,last=toneCurveData[base+1].xy;
  bool left=curveLess(value,first),right=curveLess(last,value);
  if(left||right) {
    vec2 x=first,y=toneCurveData[base+1].zw,slope=toneCurveData[base+2].zw,span=toneCurveData[base+3].zw;
    if(right) {x=last;y=toneCurveData[base+2].xy;slope=toneCurveData[base+3].xy;span=toneCurveData[base+4].xy;}
    vec2 distance=right?curveSub(value,x):curveSub(x,value);
    vec2 extension=curveAdd(distance,curveMul(curveMul(curveSub(slope,vec2(1.,0.)),span),curveDiv(distance,curveAdd(span,distance))));
    return right?curveAdd(y,extension):curveSub(y,extension);
  }
  int index=0;
  for(int i=0;i<14;i++) {if(index+1>=count) break;vec2 next=toneCurveData[base+5+(index+1)*3].xy;if(!curveLess(next,value)) break;index++;}
  int at=base+5+index*3;vec4 position=toneCurveData[at],ab=toneCurveData[at+1],cd=toneCurveData[at+2];
  vec2 t=curveMul(curveSub(value,position.xy),position.zw);
  return curveAdd(curveMul(curveAdd(curveMul(curveAdd(curveMul(ab.xy,t),ab.zw),t),cd.xy),t),cd.zw);
}
vec2 curveLabF(vec2 v) {
  if(!curveLess(${pair(216 / 24389)},v)) return curveDiv(curveAdd(curveMul(${pair(24389 / 27)},v),vec2(16.,0.)),vec2(116.,0.));
  vec2 root=vec2(pow(v.x,1./3.),0.);
  for(int i=0;i<2;i++) {vec2 square=curveMul(root,root);root=curveAdd(root,curveDiv(curveSub(v,curveMul(square,root)),curveMul(vec2(3.,0.),square)));}
  return root;
}
vec2 curveLabInverse(vec2 v) {if(curveLess(${pair(6 / 29)},v)) return curveMul(curveMul(v,v),v);return curveMul(curveSub(curveMul(vec2(116.,0.),v),vec2(16.,0.)),${pair(27 / 24389)});}
${matrix('curveToXyz', RGB_TO_XYZ[primaries])}
${matrix('curveFromXyz', XYZ_TO_RGB[primaries])}
vec3 curveApplyAt(vec3 rgb,int base) {
  vec2 next[3]=vec2[3](vec2(rgb.x,0.),vec2(rgb.y,0.),vec2(rgb.z,0.));
  if(toneCurveData[base].y!=1.) {
    vec2 xyz[3]=curveToXyz(next);vec2 y=curveEvaluate(xyz[1],base);
    if(any(notEqual(y,xyz[1]))) {
      vec2 delta=curveSub(curveLabF(y),curveLabF(xyz[1]));
      vec2 x=curveMul(${pair(D65_XYZ[0])},curveLabInverse(curveAdd(curveLabF(curveDiv(xyz[0],${pair(D65_XYZ[0])})),delta)));
      vec2 z=curveMul(${pair(D65_XYZ[2])},curveLabInverse(curveAdd(curveLabF(curveDiv(xyz[2],${pair(D65_XYZ[2])})),delta)));
      next=curveFromXyz(vec2[3](x,y,z));
    }
  }
  return vec3(curveValue(curveEvaluate(next[0],base+50)),curveValue(curveEvaluate(next[1],base+100)),curveValue(curveEvaluate(next[2],base+150)));
}
vec3 applyToneCurves(vec3 rgb) {return curveApplyAt(rgb,0);}
`
}
