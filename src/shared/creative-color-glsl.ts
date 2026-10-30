import { colorIntensityGlslFor } from './color-intensity'
import type { ColorPrimaries } from './color-model'
import { CREATIVE_COLOR_PARAMETER_VECTORS } from './creative-color-gpu'
import { creativeColorPrecisionBody } from './creative-color-precision-wgsl'

// GLSL ES 3.00 lacks frexp/ldexp. Normalize the logarithm input with bit operations.
// A reserved positive-zero uniform word forces rounding before bitwise arithmetic;
// it avoids repeating the significand decomposition at every compensated operation.
const arithmetic = `
struct CcSplit {float fract;int exp;};
CcSplit ccSplit(float v) {
  if(v==0.) {return CcSplit(v,0);}
  uint bits=floatBitsToUint(v);int exponent=int((bits>>23u)&255u);int correction=0;
  if(exponent==0) {v*=16777216.;bits=floatBitsToUint(v);exponent=int((bits>>23u)&255u);correction=-24;}
  return CcSplit(uintBitsToFloat((bits&0x807fffffu)|0x3f000000u),exponent-126+correction);
}
float ccLdexp(float v,int exponent) {
  int first=clamp(exponent,-126,127);
  return (v*exp2(float(first)))*exp2(float(exponent-first));
}
float ccRound(float v) {return uintBitsToFloat(floatBitsToUint(v)^floatBitsToUint(creativeColorData[2].z));}
vec2 ccSum(float a,float b) {
  float s=ccRound(a+b);float z=ccRound(s-a);
  return vec2(s,ccRound(a-ccRound(s-z))+ccRound(b-z));
}
vec2 ccAdd(vec2 a,vec2 b) {vec2 s=ccSum(a.x,b.x);return ccSum(s.x,ccRound(s.y+a.y+b.y));}
vec2 ccSub(vec2 a,vec2 b) {return ccAdd(a,-b);}
vec2 ccMul(vec2 a,vec2 b) {
  float ah=uintBitsToFloat(floatBitsToUint(a.x)&0xfffff000u);
  float bh=uintBitsToFloat(floatBitsToUint(b.x)&0xfffff000u);
  float al=ccRound(a.x-ah);float bl=ccRound(b.x-bh);float p=ccRound(a.x*b.x);
  float e=ccRound(ccRound(ccRound(ah*bh-p)+ccRound(ah*bl))+ccRound(al*bh));
  return ccSum(p,ccRound(ccRound(e+ccRound(al*bl))+a.x*b.y+a.y*b.x+a.y*b.y));
}
vec2 ccDiv(vec2 a,vec2 b) {
  float q=ccRound(a.x/b.x);vec2 r=ccSub(a,ccMul(vec2(q,0.),b));
  return ccSum(q,ccRound((r.x+r.y)/b.x));
}
`

/** Translate only this module's explicitly typed pure color functions, never user shaders. */
export function creativeColorGlsl(primaries: ColorPrimaries = 'srgb'): string {
  let body = creativeColorPrecisionBody(primaries)
    .replace('struct CcSplit {fract:f32,exp:i32}', '')
    .replace('fn ccSplit(v:f32)->CcSplit {let p=frexp(v);return CcSplit(p.fract,p.exp);}', '')
    .replace(/array<(\w+),\s*(\d+)>/g, '$1[$2]')
    .replace(
      /struct (\w+) \{([^}]+)\}/g,
      (_, name: string, fields: string) =>
        `struct ${name} {${fields
          .split(',')
          .map((field) => {
            const [id, type] = field.split(':')
            return `${type} ${id};`
          })
          .join('')}};`,
    )
    .replace(
      /fn (\w+)\(([^)]*)\)->(\w+(?:\[\d+\])?)\s*\{/g,
      (_, name: string, args: string, result: string) =>
        `${result} ${name}(${args
          .split(',')
          .filter(Boolean)
          .map((arg) => {
            const [id, type] = arg.split(':')
            return `${type} ${id};`.slice(0, -1)
          })
          .join(',')}) {`,
    )
    .replace(
      /\b(let|var|const) (\w+):(\w+(?:\[\d+\])?)/g,
      (_, keyword: string, name: string, type: string) =>
        `${keyword === 'const' ? 'const ' : ''}${type} ${name}`,
    )
    .replaceAll('all(a==b)', 'all(equal(a,b))')
    .replaceAll('ldexp(', 'ccLdexp(')
  const types: Record<string, string> = {
    vec2f: 'vec2',
    vec3f: 'vec3',
    vec4f: 'vec4',
    f32: 'float',
    u32: 'uint',
    i32: 'int',
  }
  body = body.replace(/\b(vec[234]f|f32|u32|i32)\b/g, (v) => types[v])
  if (/\b(fn|let|var)\b|->|array<|\b\w+:\w+/.test(body))
    throw new Error('Unsupported creative-color shader syntax.')
  return `${colorIntensityGlslFor(primaries)}
uniform vec4 creativeColorData[${CREATIVE_COLOR_PARAMETER_VECTORS}];
${arithmetic}
${body}`
}
