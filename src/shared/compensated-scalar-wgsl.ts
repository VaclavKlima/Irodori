/** Two-component arithmetic shared by bounded GPU operators with cancellation-sensitive math. */
const arithmetic = `
// Explicit rounding keeps error-free transforms intact on fast-math backends.
fn scalarRound(v:f32)->f32 {let p=frexp(v);return ldexp(p.fract,p.exp);}
fn scalarSum(a:f32,b:f32)->vec2f {
  let s=scalarRound(a+b);let z=scalarRound(s-a);
  return vec2f(s,scalarRound(a-scalarRound(s-z))+scalarRound(b-z));
}
fn scalarAdd(a:vec2f,b:vec2f)->vec2f {
  let s=scalarSum(a.x,b.x);return scalarSum(s.x,scalarRound(s.y+a.y+b.y));
}
fn scalarSub(a:vec2f,b:vec2f)->vec2f {return scalarAdd(a,-b);}
fn scalarMul(a:vec2f,b:vec2f)->vec2f {
  // Splitting mantissas rather than multiplying by 4097 avoids split overflow.
  let ah=bitcast<f32>(bitcast<u32>(a.x)&0xfffff000u);
  let bh=bitcast<f32>(bitcast<u32>(b.x)&0xfffff000u);
  let al=scalarRound(a.x-ah);let bl=scalarRound(b.x-bh);
  let p=scalarRound(a.x*b.x);
  let e=scalarRound(scalarRound(scalarRound(ah*bh-p)+scalarRound(ah*bl))+scalarRound(al*bh));
  return scalarSum(p,scalarRound(scalarRound(e+scalarRound(al*bl))+a.x*b.y+a.y*b.x+a.y*b.y));
}
fn scalarDiv(a:vec2f,b:vec2f)->vec2f {
  let q=scalarRound(a.x/b.x);let r=scalarSub(a,scalarMul(vec2f(q,0.),b));
  return scalarSum(q,scalarRound((r.x+r.y)/b.x));
}
`

export function compensatedScalarWgsl(prefix: string, positiveZeroWord?: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) throw new Error('Invalid GPU arithmetic prefix.')
  let source = arithmetic
  if (positiveZeroWord !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\[\d+\])?(?:\.[xyzw])?$/.test(positiveZeroWord))
      throw new Error('Invalid GPU rounding word.')
    // The caller owns a canonical positive-zero word. A runtime bitwise dependency
    // forces rounding without decomposing every intermediate's significand.
    source = source.replace(
      'fn scalarRound(v:f32)->f32 {let p=frexp(v);return ldexp(p.fract,p.exp);}',
      `fn scalarRound(v:f32)->f32 {return bitcast<f32>(bitcast<u32>(v)^bitcast<u32>(${positiveZeroWord}));}`,
    )
  }
  return source.replaceAll('scalar', prefix)
}
