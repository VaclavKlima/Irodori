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
