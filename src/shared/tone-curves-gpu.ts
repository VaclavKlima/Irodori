import { compensatedScalarWgsl } from './compensated-scalar-wgsl'
import { D65_XYZ } from './color-intensity'
import { RGB_TO_XYZ, XYZ_TO_RGB, type ColorPrimaries, type ColorTriple } from './color-model'
import { curveChannels, type CompiledToneCurves } from './tone-curves'

/** Five header vec4s and three vec4s per segment, each scalar stored as high/low. */
export const CURVE_PARAMETER_VECTORS = 50
export const TONE_CURVE_PARAMETER_FLOATS = 4 * CURVE_PARAMETER_VECTORS * 4
export const TONE_CURVE_PARAMETER_BYTES = TONE_CURVE_PARAMETER_FLOATS * 4

export function packToneCurves(
  curves: CompiledToneCurves,
  target = new Float32Array(TONE_CURVE_PARAMETER_FLOATS),
): Float32Array {
  if (target.length !== TONE_CURVE_PARAMETER_FLOATS)
    throw new Error('Invalid tone-curve parameter allocation.')
  target.fill(0)
  const pair = (at: number, value: number) => {
    target[at] = Math.fround(value)
    target[at + 1] = Math.fround(value - target[at])
  }
  for (const [index, name] of curveChannels.entries()) {
    const curve = curves[name],
      base = index * CURVE_PARAMETER_VECTORS * 4,
      first = curve.segments[0],
      last = curve.segments.at(-1)!
    target[base] = curve.segments.length
    target[base + 1] = Number(curve.identity)
    for (const [i, value] of [
      curve.first.input,
      curve.last.input,
      curve.first.output,
      curve.last.output,
      curve.startSlope,
      curve.endSlope,
      first.end - first.input,
      last.end - last.input,
    ].entries())
      pair(base + 2 + i * 2, value)
    for (const [i, segment] of curve.segments.entries())
      for (const [j, value] of [
        segment.input,
        segment.inverseSpan,
        ...segment.coefficients,
      ].entries())
        pair(base + 20 + i * 12 + j * 2, value)
  }
  return target
}

function literal(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}
function constant(value: number): string {
  const hi = Math.fround(value)
  return `vec2f(${literal(hi)},${literal(Math.fround(value - hi))})`
}
function matrixFunction(name: string, rows: readonly ColorTriple[]): string {
  return `fn ${name}(v:array<vec2f,3>)->array<vec2f,3> {
  return array<vec2f,3>(${rows
    .map((row) =>
      row.reduce(
        (sum, value, i) => `curveAdd(${sum},curveMul(v[${i}],${constant(value)}))`,
        'vec2f(0.)',
      ),
    )
    .join(',')});
}`
}

/** Evaluates in the existing point pass; binding owns only 3,200 bytes per photograph. */
export function toneCurvesWgsl(primaries: ColorPrimaries, binding = 7): string {
  if (!Number.isInteger(binding) || binding < 0 || binding > 15)
    throw new Error('Invalid tone-curve binding.')
  return `
@group(0) @binding(${binding}) var<storage,read> toneCurveData:array<vec4f>;
${compensatedScalarWgsl('curve')}
fn curveLess(a:vec2f,b:vec2f)->bool {return a.x<b.x || (a.x==b.x && a.y<b.y);}
fn curveValue(a:vec2f)->f32 {return a.x+a.y;}
fn curveEvaluate(value:vec2f,base:u32)->vec2f {
  let header=toneCurveData[base];
  if(header.y==1.) {return value;}
  let count=u32(header.x);
  let first=header.zw;let last=toneCurveData[base+1u].xy;
  let left=curveLess(value,first);let right=curveLess(last,value);
  if(left || right) {
    var x=first;var y=toneCurveData[base+1u].zw;
    var slope=toneCurveData[base+2u].zw;var span=toneCurveData[base+3u].zw;
    if(right) {x=last;y=toneCurveData[base+2u].xy;slope=toneCurveData[base+3u].xy;span=toneCurveData[base+4u].xy;}
    var distance=curveSub(x,value);if(right) {distance=curveSub(value,x);}
    let extension=curveAdd(distance,curveMul(curveMul(curveSub(slope,vec2f(1.,0.)),span),curveDiv(distance,curveAdd(span,distance))));
    if(right) {return curveAdd(y,extension);}return curveSub(y,extension);
  }
  var index=0u;
  for(var i=0u;i<14u;i++) {
    if(index+1u>=count) {break;}
    let next=toneCurveData[base+5u+(index+1u)*3u].xy;
    if(!curveLess(next,value)) {break;}index++;
  }
  let at=base+5u+index*3u;
  let position=toneCurveData[at];let ab=toneCurveData[at+1u];let cd=toneCurveData[at+2u];
  let t=curveMul(curveSub(value,position.xy),position.zw);
  return curveAdd(curveMul(curveAdd(curveMul(curveAdd(curveMul(ab.xy,t),ab.zw),t),cd.xy),t),cd.zw);
}
fn curveLabF(v:vec2f)->vec2f {
  if(!curveLess(${constant(216 / 24389)},v)) {
    return curveDiv(curveAdd(curveMul(${constant(24389 / 27)},v),vec2f(16.,0.)),vec2f(116.,0.));
  }
  var root=vec2f(pow(v.x,1./3.),0.);
  // Newton refinement removes the implementation-dependent pow error.
  for(var i=0;i<2;i++) {
    let square=curveMul(root,root);
    root=curveAdd(root,curveDiv(curveSub(v,curveMul(square,root)),curveMul(vec2f(3.,0.),square)));
  }
  return root;
}
fn curveLabInverse(v:vec2f)->vec2f {
  if(curveLess(${constant(6 / 29)},v)) {return curveMul(curveMul(v,v),v);}
  return curveMul(curveSub(curveMul(vec2f(116.,0.),v),vec2f(16.,0.)),${constant(27 / 24389)});
}
${matrixFunction('curveToXyz', RGB_TO_XYZ[primaries])}
${matrixFunction('curveFromXyz', XYZ_TO_RGB[primaries])}
fn curveApplyAt(rgb:vec3f,base:u32)->vec3f {
  // Avoid every color conversion when Master is identity.
  var next=array<vec2f,3>(vec2f(rgb.x,0.),vec2f(rgb.y,0.),vec2f(rgb.z,0.));
  if(toneCurveData[base].y!=1.) {
    let xyz=curveToXyz(next);let y=curveEvaluate(xyz[1],base);
    if(any(y!=xyz[1])) {
      let delta=curveSub(curveLabF(y),curveLabF(xyz[1]));
      let x=curveMul(${constant(D65_XYZ[0])},curveLabInverse(curveAdd(curveLabF(curveDiv(xyz[0],${constant(D65_XYZ[0])})),delta)));
      let z=curveMul(${constant(D65_XYZ[2])},curveLabInverse(curveAdd(curveLabF(curveDiv(xyz[2],${constant(D65_XYZ[2])})),delta)));
      next=curveFromXyz(array<vec2f,3>(x,y,z));
    }
  }
  return vec3f(curveValue(curveEvaluate(next[0],base+50u)),curveValue(curveEvaluate(next[1],base+100u)),curveValue(curveEvaluate(next[2],base+150u)));
}
fn applyToneCurves(rgb:vec3f)->vec3f {return curveApplyAt(rgb,0u);}
`
}
