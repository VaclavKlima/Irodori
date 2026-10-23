// Recover a binary32 product residual without requiring WGSL fma to be fused.
// Integer significands multiply modulo 2^32; the high bits cancel against the
// actual rounded product, leaving an exact signed residual smaller than 2^24.
fn acesProductError(a:f32,b:f32,product:f32)->f32 {
  let ab=bitcast<u32>(a);let bb=bitcast<u32>(b);let pb=bitcast<u32>(product);
  let ax=(ab>>23u)&255u;let bx=(bb>>23u)&255u;let px=(pb>>23u)&255u;
  // A nonzero rounding residual of a subnormal product is generally too small
  // for an error-free binary32 representation.
  // WGSL can flush subnormal inputs/results independently of this calculation.
  if(ax==255u || bx==255u || px==0u || px==255u) {return 0.;}
  let am=(ab&0x7fffffu)|select(0x800000u,0u,ax==0u);
  let bm=(bb&0x7fffffu)|select(0x800000u,0u,bx==0u);
  if(am==0u || bm==0u) {return 0.;}
  let exponent=select(i32(ax)-150,-149,ax==0u)+select(i32(bx)-150,-149,bx==0u);
  let shift=i32(px)-150-exponent;
  if(shift<0 || shift>24) {return 0.;}
  let pm=(pb&0x7fffffu)|0x800000u;
  let residual=bitcast<i32>(am*bm-(pm<<u32(shift)));
  if(residual==0) {return 0.;}
  let magnitude=select(u32(residual),u32(-residual),residual<0);
  let leading=firstLeadingBit(magnitude);
  let power=exponent+i32(leading);
  let sign=((ab^bb)&0x80000000u)^select(0u,0x80000000u,residual<0);
  if(power>=-126) {
    let mantissa=(magnitude<<(23u-leading))&0x7fffffu;
    return bitcast<f32>(sign|(u32(power+127)<<23u)|mantissa);
  }
  // Pack subnormal residuals with round-to-nearest-even rather than relying on
  // ldexp with a tiny scaling exponent, which WGSL may flush prematurely.
  let right=-149-exponent;
  if(right<=0) {return bitcast<f32>(sign|(magnitude<<u32(-right)));}
  if(right>24) {return bitcast<f32>(sign);}
  let whole=magnitude>>u32(right);
  let remainder=magnitude&((1u<<u32(right))-1u);
  let halfway=1u<<u32(right-1);
  let increment=u32(remainder>halfway || (remainder==halfway && (whole&1u)!=0u));
  return bitcast<f32>(sign|(whole+increment));
}
// Two-component arithmetic retains the CTL equations at cone-response cancellations.
// This changes evaluation precision, not the reference transform or its parameters.
fn ds(a:f32)->vec2f {return vec2f(a,0.);}
fn dsAdd(a:vec2f,b:vec2f)->vec2f {
  let s=acesSum(a.x,b.x);return acesSum(s.x,s.y+a.y+b.y);
}
fn dsNeg(a:vec2f)->vec2f {return -a;}
fn dsSub(a:vec2f,b:vec2f)->vec2f {return dsAdd(a,-b);}
fn dsMul(a:vec2f,b:vec2f)->vec2f {
  let p=acesRound(a.x*b.x);return acesSum(p,acesProductError(a.x,b.x,p)+a.x*b.y+a.y*b.x+a.y*b.y);
}
fn dsDiv(a:vec2f,b:vec2f)->vec2f {
  let q=a.x/b.x;let r=dsSub(a,dsMul(ds(q),b));return acesSum(q,(r.x+r.y)/b.x);
}
fn dsValue(a:vec2f)->f32 {return a.x+a.y;}
fn dsSqrt(v:vec2f)->vec2f {
  if(v.x==0.) {return ds(0.);}
  let x=sqrt(v.x);let r=dsSub(v,dsMul(ds(x),ds(x)));
  return acesSum(x,(r.x+r.y)/(2.*x));
}
${acesPrecisionWgsl}
fn dsPow(a:vec2f,b:vec2f)->vec2f {
  if(a.x==0.) {return ds(0.);}
  return dsExp(dsMul(dsLog(a),b));
}
fn dsCone(v:vec2f)->vec2f {
  let power=dsPow(v*sign(v.x),vec2f(.42,1.3113021835042815e-8));
  return dsDiv(power,dsAdd(vec2f(27.13,8.392333992190082e-7),power))*sign(v.x);
}
fn dsConeInverse(v:vec2f)->vec2f {
  let a=select(v*sign(v.x),ds(.99),abs(v.x)>.99);
  let base=dsDiv(dsMul(vec2f(27.13,8.392333992190082e-7),a),dsSub(ds(1.),a));
  return dsPow(base,vec2f(2.380952380952381,2.2706531321858847e-8))*sign(v.x);
}
fn dsMatrix(v:array<vec2f,3>,hi:mat3x3f,lo:mat3x3f)->array<vec2f,3> {
  var result:array<vec2f,3>;
  for(var c=0;c<3;c++) {
    result[c]=dsAdd(dsAdd(dsMul(v[0],vec2f(hi[0][c],lo[0][c])),dsMul(v[1],vec2f(hi[1][c],lo[1][c]))),dsMul(v[2],vec2f(hi[2][c],lo[2][c])));
  }
  return result;
}
fn RGB_to_Aab(RGB:vec3f,p:JMhParams)->vec3f {
  let cone=dsMatrix(array<vec2f,3>(ds(RGB.x),ds(RGB.y),ds(RGB.z)),p.MATRIX_RGB_to_CAM16_c,p.MATRIX_RGB_to_CAM16_c_lo);
  let response=dsMatrix(array<vec2f,3>(dsCone(cone[0]),dsCone(cone[1]),dsCone(cone[2])),p.MATRIX_cone_response_to_Aab,p.MATRIX_cone_response_to_Aab_lo);
  return vec3f(dsValue(response[0]),dsValue(response[1]),dsValue(response[2]));
}
fn Aab_to_RGB(Aab:vec3f,p:JMhParams)->vec3f {
  let cone=dsMatrix(array<vec2f,3>(ds(Aab.x),ds(Aab.y),ds(Aab.z)),p.MATRIX_Aab_to_cone_response,p.MATRIX_Aab_to_cone_response_lo);
  let response=dsMatrix(array<vec2f,3>(dsConeInverse(cone[0]),dsConeInverse(cone[1]),dsConeInverse(cone[2])),p.MATRIX_CAM16_c_to_RGB,p.MATRIX_CAM16_c_to_RGB_lo);
  return vec3f(dsValue(response[0]),dsValue(response[1]),dsValue(response[2]));
}

fn acesPow(a:f32,b:f32)->f32 {return pow(a,b);}
fn J_to_Y(J:f32,p:JMhParams)->f32 {
  let a=dsPow(dsDiv(ds(abs(J)),ds(100.)),vec2f(p.inv_cz,p.inv_cz_lo));
  return dsValue(dsDiv(dsConeInverse(dsMul(a,vec2f(p.A_w_J,p.A_w_J_lo))),vec2f(p.F_L_n,p.F_L_n_lo)));
}
fn Y_to_J(Y:f32,p:JMhParams)->f32 {
  let cone=dsCone(dsMul(ds(abs(Y)),vec2f(p.F_L_n,p.F_L_n_lo)));
  let a=dsMul(cone,vec2f(p.inv_A_w_J,p.inv_A_w_J_lo));
  return sign(Y)*dsValue(dsMul(ds(100.),dsPow(a,vec2f(p.cz,p.cz_lo))));
}
// Retain the quadratic discriminant and denominator at the gamut intersection.
fn solve_J_intersect(J:f32,M:f32,focusJ:f32,maxJ:f32,slope_gain:f32)->f32 {
  let scaled=dsDiv(ds(M),ds(slope_gain));let a=dsDiv(scaled,ds(focusJ));
  var b:vec2f;var c:vec2f;
  if(J<focusJ) {b=dsSub(ds(1.),scaled);c=ds(-J);}
  else {b=dsNeg(dsAdd(dsAdd(ds(1.),scaled),dsMul(ds(maxJ),a)));c=dsAdd(dsMul(ds(maxJ),scaled),ds(J));}
  let root=dsSqrt(dsSub(dsMul(b,b),dsMul(ds(4.),dsMul(a,c))));
  let denominator=select(dsSub(b,root),dsAdd(b,root),J<focusJ);
  return dsValue(dsDiv(dsMul(ds(-2.),c),denominator));
}
// NIST DLMF 4.24.3 and 4.24.15: alternating atan series and pi/4 reduction.
// https://dlmf.nist.gov/4.24.E3 and https://dlmf.nist.gov/4.24.E15
// Coefficients are the binary32 high/low split of (-1)^i/(2*i+1), i=0..15;
// pi constants and 180/pi use the same split, with no fitted coefficients.
// |t| <= 0.415 bounds the omitted real series by 0.415^33/33 < 1e-14
// radians. This tail bound excludes GPU arithmetic and final binary32 rounding.
fn acesAtanUnit(z:vec2f)->vec2f {
  // atan(z)-z is bounded by z^3/3 here; avoid squaring tiny normal ratios.
  if(z.x<.0000152587890625) {return z;}
  var t=z;
  var offset=ds(0.);
  if(dsValue(z)>.4142135623730951) {
    t=dsDiv(dsSub(z,ds(1.)),dsAdd(z,ds(1.)));
    offset=vec2f(.7853981852531433,-2.1855695031547384e-8);
  }
  let square=dsMul(t,t);
  var series=vec2f(-.032258063554763794,-9.613652374174109e-10);
  series=dsAdd(vec2f(.03448275849223137,1.284582856753147e-10),dsMul(square,series));
  series=dsAdd(vec2f(-.03703703731298447,2.759474315716659e-10),dsMul(square,series));
  series=dsAdd(vec2f(.03999999910593033,8.940696724635266e-10),dsMul(square,series));
  series=dsAdd(vec2f(-.043478261679410934,8.09845718263702e-10),dsMul(square,series));
  series=dsAdd(vec2f(.0476190485060215,-8.869738832295582e-10),dsMul(square,series));
  series=dsAdd(vec2f(-.05263157933950424,3.9213582381236733e-10),dsMul(square,series));
  series=dsAdd(vec2f(.05882352963089943,-2.1913472425527658e-10),dsMul(square,series));
  series=dsAdd(vec2f(-.06666667014360428,3.4769376128229723e-9),dsMul(square,series));
  series=dsAdd(vec2f(.07692307978868484,-2.8656079176236915e-9),dsMul(square,series));
  series=dsAdd(vec2f(-.09090909361839294,2.7093020327217943e-9),dsMul(square,series));
  series=dsAdd(vec2f(.1111111119389534,-8.278422947149977e-10),dsMul(square,series));
  series=dsAdd(vec2f(-.1428571492433548,6.3862119481505886e-9),dsMul(square,series));
  series=dsAdd(vec2f(.20000000298023224,-2.980232227667301e-9),dsMul(square,series));
  series=dsAdd(vec2f(-.3333333432674408,9.934107481068821e-9),dsMul(square,series));
  series=dsAdd(ds(1.),dsMul(square,series));
  return dsAdd(offset,dsMul(t,series));
}
struct AcesAngleParts {mantissa:f32,exponent:i32}
fn acesAngleParts(bits:u32)->AcesAngleParts {
  let exponent=(bits>>23u)&255u;
  if(exponent!=0u) {
    return AcesAngleParts(bitcast<f32>((bits&0x7fffffu)|0x3f800000u),i32(exponent)-127);
  }
  // The caller excludes zero. Normalize retained subnormal bits in integers;
  // WGSL may still flush subnormal float inputs before their bits are observed.
  let leading=firstLeadingBit(bits);
  return AcesAngleParts(bitcast<f32>(((bits<<(23u-leading))&0x7fffffu)|0x3f800000u),i32(leading)-149);
}
fn acesAtanRatio(smaller:u32,larger:u32)->vec2f {
  let a=acesAngleParts(smaller);let b=acesAngleParts(larger);
  let exponent=a.exponent-b.exponent;
  // The omitted angular correction is below 2^-126 radians. Avoid relying on
  // subnormal division or an out-of-range scaling exponent for extreme ratios.
  if(exponent< -126) {return ds(0.);}
  let ratio=dsDiv(ds(a.mantissa),ds(b.mantissa));
  return vec2f(ldexp(ratio.x,exponent),ldexp(ratio.y,exponent));
}
fn acesAtan2(y:f32,x:f32)->vec2f {
  let xb=bitcast<u32>(x);let yb=bitcast<u32>(y);
  let ax=xb&0x7fffffffu;let ay=yb&0x7fffffffu;
  var angle:vec2f;
  if(ay==0u) {angle=ds(0.);}
  else if(ax==0u) {angle=vec2f(1.5707963705062866,-4.371139006309477e-8);}
  else if(ay>ax) {
    angle=dsSub(vec2f(1.5707963705062866,-4.371139006309477e-8),acesAtanUnit(acesAtanRatio(ax,ay)));
  } else {angle=acesAtanUnit(acesAtanRatio(ay,ax));}
  // Preserve signed-zero quadrants when the implementation retains their bits.
  if((xb&0x80000000u)!=0u) {angle=dsSub(vec2f(3.1415927410125732,-8.742278012618954e-8),angle);}
  if((yb&0x80000000u)!=0u) {angle=dsNeg(angle);}
  return angle;
}
fn acesAtan2Degrees(y:f32,x:f32)->f32 {
  return dsValue(dsMul(acesAtan2(y,x),vec2f(57.295780181884766,-6.688024427603523e-7)));
}
fn Aab_to_JMh(Aab:vec3f,p:JMhParams)->vec3f {
  if(Aab.x<=0.) {return vec3f(0.);}
  let J=dsValue(dsMul(ds(100.),dsPow(ds(Aab.x),vec2f(p.cz,p.cz_lo))));
  return vec3f(J,length(Aab.yz),wrap_to_360(acesAtan2Degrees(Aab.z,Aab.y)));
}
fn JMh_to_Aab(JMh:vec3f,p:JMhParams)->vec3f {
  let a=dsValue(dsPow(dsDiv(ds(JMh.x),ds(100.)),vec2f(p.inv_cz,p.inv_cz_lo)));
  // Retain the degrees-to-radians residual before trigonometry near gamut boundaries.
  let h=dsMul(ds(JMh.z),vec2f(.017453292519943295,1.3519960498364902e-10));
  let co=fma(-sin(h.x),h.y,cos(h.x));
  let si=fma(cos(h.x),h.y,sin(h.x));
  return vec3f(a,JMh.y*co,JMh.y*si);
}
