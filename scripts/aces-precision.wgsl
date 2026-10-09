// Two-component arithmetic retains the CTL equations at cone-response cancellations.
// This changes evaluation precision, not the reference transform or its parameters.
fn ds(a:f32)->vec2f {return vec2f(a,0.);}
fn dsAdd(a:vec2f,b:vec2f)->vec2f {
  let s=acesSum(a.x,b.x);return acesSum(s.x,s.y+a.y+b.y);
}
fn dsNeg(a:vec2f)->vec2f {return -a;}
fn dsSub(a:vec2f,b:vec2f)->vec2f {return dsAdd(a,-b);}
fn dsMul(a:vec2f,b:vec2f)->vec2f {
  let p=acesRound(a.x*b.x);return acesSum(p,fma(a.x,b.x,-p)+a.x*b.y+a.y*b.x+a.y*b.y);
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
fn dsLog(a:vec2f)->vec2f {
  let bits=bitcast<u32>(a.x);var exponent=f32(i32((bits>>23u)&255u)-127);
  var mantissa=bitcast<f32>((bits&0x7fffffu)|0x3f800000u);
  if(mantissa>1.4142135623730951){mantissa*=.5;exponent+=1.;}
  let z=dsDiv(ds(mantissa-1.),dsAdd(ds(mantissa),ds(1.)));let z2=dsMul(z,z);
  var polynomial=vec2f(0.058823529411764705,-2.1913472425527658e-10);
  polynomial=dsAdd(vec2f(0.06666666666666667,-3.4769376128229723e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.07692307692307693,-2.8656079176236915e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.09090909090909091,-2.7093020327217943e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.1111111111111111,-8.278422947149977e-10),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.14285714285714285,-6.3862119481505886e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.2,-2.980232227667301e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(0.3333333333333333,-9.934107481068821e-9),dsMul(z2,polynomial));
  polynomial=dsAdd(vec2f(1,0),dsMul(z2,polynomial));
  let sum=dsMul(z,polynomial);
  let ln2=vec2f(.6931471805599453,-1.904654299957768e-9);
  return dsAdd(dsAdd(dsMul(ds(2.),sum),dsMul(ds(exponent),ln2)),ds(a.y/a.x));
}
fn dsExp(a:vec2f)->vec2f {
  let n=round(a.x/ .6931471805599453);
  let r=dsSub(a,dsMul(ds(n),vec2f(.6931471805599453,-1.904654299957768e-9)));
  var sum=vec2f(1.1470745597729725e-11,2.372207640763624e-19);
  sum=dsAdd(vec2f(1.6059043836821613e-10,-5.352526692508485e-18),dsMul(r,sum));
  sum=dsAdd(vec2f(2.08767569878681e-9,1.1082839478332097e-16),dsMul(r,sum));
  sum=dsAdd(vec2f(2.505210838544172e-8,4.4176231769972645e-16),dsMul(r,sum));
  sum=dsAdd(vec2f(2.755731922398589e-7,-7.575112420809432e-15),dsMul(r,sum));
  sum=dsAdd(vec2f(0.0000027557319223985893,3.7935713937038186e-14),dsMul(r,sum));
  sum=dsAdd(vec2f(0.0000248015873015873,-3.406996025904184e-13),dsMul(r,sum));
  sum=dsAdd(vec2f(0.0001984126984126984,-2.725596820723347e-12),dsMul(r,sum));
  sum=dsAdd(vec2f(0.001388888888888889,-3.3631092919220174e-11),dsMul(r,sum));
  sum=dsAdd(vec2f(0.008333333333333333,-4.3461720160287154e-10),dsMul(r,sum));
  sum=dsAdd(vec2f(0.041666666666666664,-1.2417634351336027e-9),dsMul(r,sum));
  sum=dsAdd(vec2f(0.16666666666666666,-4.967053740534411e-9),dsMul(r,sum));
  sum=dsAdd(vec2f(0.5,0),dsMul(r,sum));
  sum=dsAdd(vec2f(1,0),dsMul(r,sum));
  sum=dsAdd(vec2f(1,0),dsMul(r,sum));
  return dsMul(sum,ds(exp2(n)));
}
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
fn Aab_to_JMh(Aab:vec3f,p:JMhParams)->vec3f {
  if(Aab.x<=0.) {return vec3f(0.);}
  let J=dsValue(dsMul(ds(100.),dsPow(ds(Aab.x),vec2f(p.cz,p.cz_lo))));
  return vec3f(J,length(Aab.yz),wrap_to_360(radians_to_degrees(atan2(Aab.z,Aab.y))));
}
fn JMh_to_Aab(JMh:vec3f,p:JMhParams)->vec3f {
  let a=dsValue(dsPow(dsDiv(ds(JMh.x),ds(100.)),vec2f(p.inv_cz,p.inv_cz_lo)));
  // Retain the degrees-to-radians residual before trigonometry near gamut boundaries.
  let h=dsMul(ds(JMh.z),vec2f(.017453292519943295,1.3519960498364902e-10));
  let co=fma(-sin(h.x),h.y,cos(h.x));
  let si=fma(cos(h.x),h.y,sin(h.x));
  return vec3f(a,JMh.y*co,JMh.y*si);
}
