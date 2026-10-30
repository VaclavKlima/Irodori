#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/features2d.hpp>
#include <opencv2/calib3d.hpp>
#include <opencv2/video/tracking.hpp>
#include <algorithm>
#include <cmath>
#include <vector>
#include <wasm_simd128.h>
#include <emscripten/emscripten.h>

static double patchStats[4]={0,0,0,0};

static v128_t mask4(const unsigned char* p) {
  return wasm_u32x4_extend_low_u16x8(wasm_u16x8_extend_low_u8x16(wasm_v128_load32_zero(p)));
}
static double horizontal(v128_t v) {
  return double(wasm_f32x4_extract_lane(v,0))+wasm_f32x4_extract_lane(v,1)+
    wasm_f32x4_extract_lane(v,2)+wasm_f32x4_extract_lane(v,3);
}

// Translation-only inverse compositional optimization. Coarse levels use L2;
// the native level uses bounded robust weights. Masks remain independent.
static double translation(const cv::Mat& a, const cv::Mat& b, const cv::Mat& am,
                          const cv::Mat& bm, float& dx, float& dy, bool robust, bool optimize=true) {
  cv::Mat ar,br,gx,gy;
  auto maskedBlur=[](const cv::Mat& pixels,const cv::Mat& mask,cv::Mat& result) {
    cv::Mat weights,filtered;
    mask.convertTo(weights,CV_32F,1./255);
    cv::GaussianBlur(pixels.mul(weights),filtered,cv::Size(5,5),0);
    cv::GaussianBlur(weights,weights,cv::Size(5,5),0);
    cv::max(weights,1e-6,weights);
    cv::divide(filtered,weights,result);
  };
  // Invalid pixels are absent observations, not black photographic detail.
  maskedBlur(a,am,ar);
  maskedBlur(b,bm,br);
  if(optimize) {
    cv::Sobel(ar,gx,CV_32F,1,0,1,.5);
    cv::Sobel(ar,gy,CV_32F,0,1,1,.5);
  }
  auto sampled=[&](int x,int y,float& v)->bool {
    float px=x+dx,py=y+dy;
    if(px<0 || py<0 || px>=br.cols-1 || py>=br.rows-1) return false;
    int ix=int(px),iy=int(py);float fx=px-ix,fy=py-iy;
    if(!bm.at<unsigned char>(iy,ix) || !bm.at<unsigned char>(iy,ix+1) ||
       !bm.at<unsigned char>(iy+1,ix) || !bm.at<unsigned char>(iy+1,ix+1)) return false;
    v=(br.at<float>(iy,ix)*(1-fx)+br.at<float>(iy,ix+1)*fx)*(1-fy)+
      (br.at<float>(iy+1,ix)*(1-fx)+br.at<float>(iy+1,ix+1)*fx)*fy;
    return true;
  };
  for(int iteration=0;optimize && iteration<12;iteration++) {
    double n=0,sx=0,sy=0,se=0,xx=0,xy=0,yy=0,xe=0,ye=0,
      si=0,ii=0,xi=0,yi=0,ie=0;
    const int ix=int(std::floor(dx)),iy=int(std::floor(dy));
    const float fx=dx-ix,fy=dy-iy;
    for(int y=std::max(2,-iy);y<std::min(a.rows-2,br.rows-1-iy);y++) {
      v128_t ns=wasm_f32x4_splat(0),xs=ns,ys=ns,es=ns,xxs=ns,xys=ns,yys=ns,xes=ns,yes=ns,
        is=ns,iis=ns,xis=ns,yis=ns,ies=ns;
      const float *pa=ar.ptr<float>(y),*px=gx.ptr<float>(y),*py=gy.ptr<float>(y),
        *b0=br.ptr<float>(y+iy),*b1=br.ptr<float>(y+iy+1);
      const unsigned char *ma=am.ptr<unsigned char>(y),*mb0=bm.ptr<unsigned char>(y+iy),*mb1=bm.ptr<unsigned char>(y+iy+1);
      int x=std::max(2,-ix),last=std::min(a.cols-2,br.cols-1-ix);
      for(;x+4<=last;x+=4) {
        const int q=x+ix;
        v128_t valid=wasm_v128_and(mask4(ma+x),wasm_v128_and(wasm_v128_and(mask4(mb0+q),mask4(mb0+q+1)),wasm_v128_and(mask4(mb1+q),mask4(mb1+q+1))));
        valid=wasm_i32x4_gt(valid,wasm_i32x4_splat(0));
        auto blend=[&](const float* p){return wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(p+q),wasm_f32x4_splat(1-fx)),wasm_f32x4_mul(wasm_v128_load(p+q+1),wasm_f32x4_splat(fx)));};
        v128_t value=wasm_f32x4_add(wasm_f32x4_mul(blend(b0),wasm_f32x4_splat(1-fy)),wasm_f32x4_mul(blend(b1),wasm_f32x4_splat(fy))),
          ex=wasm_f32x4_sub(value,wasm_v128_load(pa+x)),vx=wasm_v128_load(px+x),vy=wasm_v128_load(py+x),vi=wasm_f32x4_sub(wasm_v128_load(pa+x),wasm_f32x4_splat(1)),weight=wasm_f32x4_splat(1);
        if(robust) weight=wasm_f32x4_min(weight,wasm_f32x4_div(wasm_f32x4_splat(.05f),wasm_f32x4_max(wasm_f32x4_splat(1e-12f),wasm_f32x4_abs(ex))));
        weight=wasm_v128_and(weight,valid);
        const v128_t wx=wasm_f32x4_mul(vx,weight),wy=wasm_f32x4_mul(vy,weight),we=wasm_f32x4_mul(ex,weight);
        ns=wasm_f32x4_add(ns,weight);xs=wasm_f32x4_add(xs,wx);ys=wasm_f32x4_add(ys,wy);es=wasm_f32x4_add(es,we);
        xxs=wasm_f32x4_add(xxs,wasm_f32x4_mul(vx,wx));xys=wasm_f32x4_add(xys,wasm_f32x4_mul(vx,wy));yys=wasm_f32x4_add(yys,wasm_f32x4_mul(vy,wy));
        xes=wasm_f32x4_add(xes,wasm_f32x4_mul(vx,we));yes=wasm_f32x4_add(yes,wasm_f32x4_mul(vy,we));
        const v128_t wi=wasm_f32x4_mul(vi,weight);
        is=wasm_f32x4_add(is,wi);iis=wasm_f32x4_add(iis,wasm_f32x4_mul(vi,wi));
        xis=wasm_f32x4_add(xis,wasm_f32x4_mul(vx,wi));yis=wasm_f32x4_add(yis,wasm_f32x4_mul(vy,wi));ies=wasm_f32x4_add(ies,wasm_f32x4_mul(vi,we));
      }
      // Reduce each row to doubles so SIMD accumulation does not grow with patch area.
      n+=horizontal(ns);sx+=horizontal(xs);sy+=horizontal(ys);se+=horizontal(es);xx+=horizontal(xxs);xy+=horizontal(xys);yy+=horizontal(yys);xe+=horizontal(xes);ye+=horizontal(yes);
      si+=horizontal(is);ii+=horizontal(iis);xi+=horizontal(xis);yi+=horizontal(yis);ie+=horizontal(ies);
      for(;x<last;x++) {
        if(!ma[x]) continue;float value;if(!sampled(x,y,value)) continue;
        double ex=value-pa[x],vx=px[x],vy=py[x],vi=pa[x]-1,weight=robust?std::min(1.,.05/std::max(1e-12,std::abs(ex))):1.;
        n+=weight;sx+=vx*weight;sy+=vy*weight;se+=ex*weight;xx+=vx*vx*weight;xy+=vx*vy*weight;yy+=vy*vy*weight;xe+=vx*ex*weight;ye+=vy*ex*weight;
        si+=vi*weight;ii+=vi*vi*weight;xi+=vx*vi*weight;yi+=vy*vi*weight;ie+=vi*ex*weight;
      }
    }
    if(n<64) return -1;
    xx-=sx*sx/n;xy-=sx*sy/n;yy-=sy*sy/n;xe-=sx*se/n;ye-=sy*se/n;
    // Project gain and offset out of the joint normal equations. Independent
    // masks change patch means; photometric error must not become displacement.
    ii-=si*si/n;xi-=sx*si/n;yi-=sy*si/n;ie-=si*se/n;
    if(ii<=1e-12) return -1;
    xx-=xi*xi/ii;xy-=xi*yi/ii;yy-=yi*yi/ii;xe-=xi*ie/ii;ye-=yi*ie/ii;
    double det=xx*yy-xy*xy;if(det<=1e-12) return -1;
    double stepX=(xy*ye-yy*xe)/det,stepY=(xy*xe-xx*ye)/det,
      length=std::hypot(stepX,stepY), scale=std::min(1.,2./std::max(length,1e-12));
    dx+=stepX*scale;dy+=stepY*scale;
    if(length<.001) break;
  }
  double n=0,sa=0,sb=0,saa=0,sbb=0,sab=0;
  const int ix=int(std::floor(dx)),iy=int(std::floor(dy));
  const float fx=dx-ix,fy=dy-iy;
  for(int y=std::max(2,-iy);y<std::min(a.rows-2,br.rows-1-iy);y++) {
    v128_t ns=wasm_f32x4_splat(0),as=ns,bs=ns,aas=ns,bbs=ns,abs=ns;
    const float *pa=ar.ptr<float>(y),*b0=br.ptr<float>(y+iy),*b1=br.ptr<float>(y+iy+1);
    const unsigned char *ma=am.ptr<unsigned char>(y),*mb0=bm.ptr<unsigned char>(y+iy),*mb1=bm.ptr<unsigned char>(y+iy+1);
    int x=std::max(2,-ix),last=std::min(a.cols-2,br.cols-1-ix);
    for(;x+4<=last;x+=4) {
      int q=x+ix;
      v128_t valid=wasm_v128_and(mask4(ma+x),wasm_v128_and(wasm_v128_and(mask4(mb0+q),mask4(mb0+q+1)),wasm_v128_and(mask4(mb1+q),mask4(mb1+q+1))));
      valid=wasm_i32x4_gt(valid,wasm_i32x4_splat(0));
      auto blend=[&](const float* p){return wasm_f32x4_add(wasm_f32x4_mul(wasm_v128_load(p+q),wasm_f32x4_splat(1-fx)),wasm_f32x4_mul(wasm_v128_load(p+q+1),wasm_f32x4_splat(fx)));};
      // Correlation is invariant to offsets. Center normalized patches near
      // zero before SIMD moments, avoiding cancellation on low-contrast texture.
      v128_t av=wasm_v128_and(wasm_f32x4_sub(wasm_v128_load(pa+x),wasm_f32x4_splat(1)),valid),bv=wasm_v128_and(wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_mul(blend(b0),wasm_f32x4_splat(1-fy)),wasm_f32x4_mul(blend(b1),wasm_f32x4_splat(fy))),wasm_f32x4_splat(1)),valid);
      ns=wasm_f32x4_add(ns,wasm_v128_and(wasm_f32x4_splat(1),valid));as=wasm_f32x4_add(as,av);bs=wasm_f32x4_add(bs,bv);
      aas=wasm_f32x4_add(aas,wasm_f32x4_mul(av,av));bbs=wasm_f32x4_add(bbs,wasm_f32x4_mul(bv,bv));abs=wasm_f32x4_add(abs,wasm_f32x4_mul(av,bv));
    }
    n+=horizontal(ns);sa+=horizontal(as);sb+=horizontal(bs);saa+=horizontal(aas);sbb+=horizontal(bbs);sab+=horizontal(abs);
    for(;x<last;x++) {
      if(!ma[x]) continue;float value;if(!sampled(x,y,value)) continue;
      double v=double(pa[x])-1,centered=double(value)-1;n++;sa+=v;sb+=centered;saa+=v*v;sbb+=centered*centered;sab+=v*centered;
    }
  }
  if(n<64) return -1;
  return (sab-sa*sb/n)/std::sqrt(std::max(1e-20,(saa-sa*sa/n)*(sbb-sb*sb/n)));
}

// Narrow C ABI. Every allocation is owned by the caller or an RAII OpenCV object.
static void features(const cv::Mat& image, const cv::Mat& mask,
                     std::vector<cv::KeyPoint>& keys, cv::Mat& descriptors) {
  auto orb = cv::ORB::create(8000, 1.2f, 8, 16, 0, 2, cv::ORB::HARRIS_SCORE, 31, 7);
  orb->detect(image, keys, mask);
  std::sort(keys.begin(), keys.end(), [](const auto& a, const auto& b) { return a.response > b.response; });
  cv::Mat integral;
  cv::integral(mask, integral, CV_64F);
  int cells[16] = {};
  keys.erase(std::remove_if(keys.begin(), keys.end(), [&](const auto& k) {
    // Suppress keypoints on invalid-mask boundaries before descriptor extraction.
    int radius = 3;
    int x0 = int(k.pt.x)-radius, y0 = int(k.pt.y)-radius;
    int x1 = int(k.pt.x)+radius+1, y1 = int(k.pt.y)+radius+1;
    if (x0 < 0 || y0 < 0 || x1 > image.cols || y1 > image.rows) return true;
    double valid = integral.at<double>(y1,x1)-integral.at<double>(y0,x1)-integral.at<double>(y1,x0)+integral.at<double>(y0,x0);
    if (valid < double(x1-x0)*(y1-y0)*255) return true;
    int cell = std::min(3, int(k.pt.y * 4 / image.rows)) * 4 + std::min(3, int(k.pt.x * 4 / image.cols));
    return cells[cell]++ >= 250;
  }), keys.end());
  orb->compute(image, keys, descriptors);
}
extern "C" {
void irodori_patch_stats(double* output,int reset) {
  std::copy(patchStats,patchStats+4,output);
  if(reset) std::fill(patchStats,patchStats+4,0);
}
int irodori_features(unsigned char* image, unsigned char* mask, int width, int height, float* points, unsigned char* descriptors) {
  try {
    std::vector<cv::KeyPoint> keys; cv::Mat desc;
    features(cv::Mat(height,width,CV_8U,image),cv::Mat(height,width,CV_8U,mask),keys,desc);
    for(int i=0;i<desc.rows;i++) { points[i*2]=keys[i].pt.x; points[i*2+1]=keys[i].pt.y; }
    if(desc.rows) std::copy(desc.data,desc.data+desc.rows*32,descriptors);
    return desc.rows;
  } catch(const cv::Exception&) { return -1; }
}
int irodori_descriptors(float* ak, unsigned char* ad, int an, float* bk, unsigned char* bd, int bn, float* points) {
  try {
    if(an<2 || bn<2) return 0;
    cv::BFMatcher matcher(cv::NORM_HAMMING); std::vector<std::vector<cv::DMatch>> ab,ba;
    matcher.knnMatch(cv::Mat(an,32,CV_8U,ad),cv::Mat(bn,32,CV_8U,bd),ab,2);
    matcher.knnMatch(cv::Mat(bn,32,CV_8U,bd),cv::Mat(an,32,CV_8U,ad),ba,2);
    int n=0;
    for(const auto& m:ab) {
      if(m.size()!=2 || m[0].distance>=m[1].distance*.8f) continue;
      const auto& r=ba[m[0].trainIdx];
      if(r.size()!=2 || r[0].trainIdx!=m[0].queryIdx || r[0].distance>=r[1].distance*.8f) continue;
      std::copy(ak+m[0].queryIdx*2,ak+m[0].queryIdx*2+2,points+n*4);
      std::copy(bk+m[0].trainIdx*2,bk+m[0].trainIdx*2+2,points+n*4+2);
      if(++n==4000) break;
    }
    return n;
  } catch(const cv::Exception&) { return -1; }
}
int irodori_matches(unsigned char* a, unsigned char* b, unsigned char* am, unsigned char* bm,
                 int width, int height, float* points) {
  try {
    std::vector<cv::KeyPoint> ak, bk;
    cv::Mat ad, bd;
    features(cv::Mat(height, width, CV_8U, a), cv::Mat(height, width, CV_8U, am), ak, ad);
    features(cv::Mat(height, width, CV_8U, b), cv::Mat(height, width, CV_8U, bm), bk, bd);
    if (ad.rows < 2 || bd.rows < 2) return 0;
    cv::BFMatcher matcher(cv::NORM_HAMMING);
    std::vector<std::vector<cv::DMatch>> ab, ba;
    matcher.knnMatch(ad, bd, ab, 2);
    matcher.knnMatch(bd, ad, ba, 2);
    int n = 0;
    for (const auto& m : ab) {
      if (m.size() != 2 || m[0].distance >= m[1].distance * .8f) continue;
      const auto& r = ba[m[0].trainIdx];
      if (r.size() != 2 || r[0].trainIdx != m[0].queryIdx || r[0].distance >= r[1].distance * .8f) continue;
      auto p = ak[m[0].queryIdx].pt, q = bk[m[0].trainIdx].pt;
      points[n*4] = p.x; points[n*4+1] = p.y; points[n*4+2] = q.x; points[n*4+3] = q.y;
      if (++n == 4000) break;
    }
    return n;
  } catch (const cv::Exception&) { return -1; }
}
int irodori_fit(float* points, int count, int projective, double threshold, double* matrix, unsigned char* inliers) {
  try {
    cv::setRNGSeed(1739);
    std::vector<cv::Point2f> a, b;
    for (int i = 0; i < count; i++) { a.emplace_back(points[4*i], points[4*i+1]); b.emplace_back(points[4*i+2], points[4*i+3]); }
    cv::Mat mask, m;
    if (projective) m = cv::findHomography(a, b, cv::RANSAC, threshold, mask, 4000, .999);
    else m = cv::estimateAffinePartial2D(a, b, mask, cv::RANSAC, threshold, 4000, .999, 10);
    if (m.empty()) return 0;
    std::fill(matrix, matrix+9, 0); matrix[8] = 1;
    for (int y = 0; y < m.rows; y++) for (int x = 0; x < 3; x++) matrix[y*3+x] = m.at<double>(y,x);
    std::copy(mask.data, mask.data+count, inliers);
    return cv::countNonZero(mask);
  } catch (const cv::Exception&) { return -1; }
}
double irodori_ecc(float* a, float* b, unsigned char* am, unsigned char* bm,
                int width, int height, double* matrix, int motion, int iterations) {
  try {
    cv::Mat m(motion == cv::MOTION_HOMOGRAPHY ? 3 : 2, 3, CV_32F);
    for (int i = 0; i < m.rows*3; i++) m.ptr<float>()[i] = matrix[i];
    double score = cv::findTransformECCWithMask(cv::Mat(height,width,CV_32F,a), cv::Mat(height,width,CV_32F,b),
      cv::Mat(height,width,CV_8U,am), cv::Mat(height,width,CV_8U,bm), m, motion,
      cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, iterations, 1e-7), 5);
    for (int i = 0; i < m.rows*3; i++) matrix[i] = m.ptr<float>()[i];
    return score;
  } catch (const cv::Exception&) { return -1; }
}
// Batch native sampling and masked coarse-to-fine translation in SIMD WASM.
// Reference/source are bounded, checksummed native luminance bands. NaN masks
// denote sensor clipping; they are internal alignment data, never master pixels.
int irodori_patches(float* a, float* b, int width, int height, int afirst, int arows, int bfirst, int brows,
                 double* matrix, float* centers, int count, int edge, double fraction, float* output, float* tiles, int columns, int identical) {
  if(width<=0 || height<=0 || edge<=0 || edge>width || edge>height || count<0 ||
     afirst<0 || arows<0 || afirst+arows>height || bfirst<0 || brows<0 || bfirst+brows>height ||
     columns<0 || columns>32 || !std::isfinite(fraction) || fraction<0 || fraction>1) return -1;
  if(!std::all_of(matrix,matrix+9,[](double v){return std::isfinite(v);})) return -1;
  int n=0;
  auto sample=[&](float* data,int first,int rows,double x,double y,float& value)->bool {
    if(!std::isfinite(x) || !std::isfinite(y) || x<0 || y<first || x>width-1 || y>std::min(height-1,first+rows-1)) return false;
    int ix=int(x),iy=int(y); double dx=x-ix,dy=y-iy; double irodori=0; bool valid=true;
    // Interior samples use all four weights. NaN propagates the immutable
    // sensor mask without four separate branches; exact integer and border
    // coordinates retain the zero-weight handling below.
    if(dx>0 && dy>0 && ix+1<width && iy+1<first+rows && iy+1<height) {
      const float* row=data+(iy-first)*width+ix;
      irodori=double(row[0])*(1-dx)*(1-dy)+double(row[1])*dx*(1-dy)+
        double(row[width])*(1-dx)*dy+double(row[width+1])*dx*dy;
      value=std::isfinite(irodori) && irodori>.004?std::sqrt(irodori):0;
      return value>0;
    }
    for(int yy=0;yy<2;yy++) for(int xx=0;xx<2;xx++) {
      double w=(xx?dx:1-dx)*(yy?dy:1-dy); if(w==0) continue;
      int ty=std::min(height-1,iy+yy),tx=std::min(width-1,ix+xx);
      if(ty>=first+rows) return false;
      const float p=data[(ty-first)*width+tx];
      if(std::isfinite(p)) irodori+=p*w; else valid=false;
    }
    value=valid && irodori>.004?std::sqrt(irodori):0;
    return value>0;
  };
  for(int k=0;k<count;k++) {
    try {
      const double samplingStart=emscripten_get_now();
      patchStats[2]++;patchStats[3]+=edge*edge;
      if(!std::isfinite(centers[k*2]) || !std::isfinite(centers[k*2+1])) continue;
      int left=int(centers[k*2]),top=int(centers[k*2+1]);
      if(left<0 || left>width-edge || top<afirst || top>height-edge || top+edge>afirst+arows) continue;
      cv::Mat aa=cv::Mat::zeros(edge,edge,CV_32F),bb=aa.clone(),am=cv::Mat::zeros(edge,edge,CV_8U),bm=am.clone();
      CV_Assert(aa.type()==CV_32F && bb.type()==CV_32F && am.type()==CV_8U && bm.type()==CV_8U);
      double av=0,bv=0; int valid=0;
      for(int y=0;y<edge;y++) {
       float *ap=aa.ptr<float>(y),*bp=bb.ptr<float>(y);
       unsigned char *amp=am.ptr<unsigned char>(y),*bmp=bm.ptr<unsigned char>(y);
       for(int x=0;x<edge;x++) {
        double px=left+x,py=top+y,w=matrix[6]*px+matrix[7]*py+matrix[8];
        const float avalue=a[(top+y-afirst)*width+left+x];
        bool va=std::isfinite(avalue) && avalue>.004;
        ap[x]=va?std::sqrt(double(avalue)):0;
        double ox=0,oy=0;
        if(columns) {
          double gx=std::clamp((px+.5)*columns/width-.5,0.,double(columns-1)),gy=std::clamp((py+.5)*columns/height-.5,0.,double(columns-1));
          int ix=int(gx),iy=int(gy);double dx=gx-ix,dy=gy-iy;
          for(int yy=0;yy<2;yy++)for(int xx=0;xx<2;xx++){int i=(std::min(columns-1,iy+yy)*columns+std::min(columns-1,ix+xx))*2;double weight=(xx?dx:1-dx)*(yy?dy:1-dy);ox+=tiles[i]*weight;oy+=tiles[i+1]*weight;}
        }
        bool vb=sample(b,bfirst,brows,(matrix[0]*px+matrix[1]*py+matrix[2])/w+ox,(matrix[3]*px+matrix[4]*py+matrix[5])/w+oy,bp[x]);
        amp[x]=va?255:0; bmp[x]=vb?255:0;
        if(va && vb) { av+=ap[x]; bv+=bp[x]; valid++; }
       }
      }
      if(valid<edge*edge*fraction) { patchStats[0]+=emscripten_get_now()-samplingStart;continue; }
      aa/=av/valid; bb/=bv/valid;
      double xx=0,xy=0,yy=0;
      for(int y=1;y<edge-1;y++) {
       const float *ap=aa.ptr<float>(y),*above=aa.ptr<float>(y-1),*below=aa.ptr<float>(y+1);
       const unsigned char *amp=am.ptr<unsigned char>(y),*ma=am.ptr<unsigned char>(y-1),*mb=am.ptr<unsigned char>(y+1);
       for(int x=1;x<edge-1;x++) {
        if(!amp[x] || !amp[x-1] || !amp[x+1] || !ma[x] || !mb[x]) continue;
        double dx=ap[x+1]-ap[x-1],dy=below[x]-above[x];
        xx+=dx*dx; xy+=dx*dy; yy+=dy*dy;
       }
      }
      patchStats[0]+=emscripten_get_now()-samplingStart;
      if((xx+yy)/valid<1e-5 || (xx*yy-xy*xy)/((xx+yy)*(xx+yy))<.003) continue;
      // Verified whole-strip equality proves displacement independently. Retain
      // all observability/mask checks without estimating an already known zero.
      if(identical&1) {
        output[n*5]=left+(edge-1)*.5;output[n*5+1]=top+(edge-1)*.5;
        output[n*5+2]=0;output[n*5+3]=0;output[n*5+4]=1;n++;continue;
      }
      const double optimizationStart=emscripten_get_now();
      cv::Mat transform=cv::Mat::eye(2,3,CV_32F); double score=-1;
      double previous=1;
      for(double scale: {.25,.5,1.}) {
        if(edge*scale<24) continue;
        cv::Mat ar,br,ma,mb; cv::resize(aa,ar,cv::Size(),scale,scale,cv::INTER_AREA); cv::resize(bb,br,ar.size(),0,0,cv::INTER_AREA);
        cv::resize(am,ma,ar.size(),0,0,cv::INTER_AREA); cv::resize(bm,mb,ar.size(),0,0,cv::INTER_AREA);
        // A partially invalid area is excluded, rather than filled into the optimizer.
        cv::compare(ma,255,ma,cv::CMP_EQ); cv::compare(mb,255,mb,cv::CMP_EQ);
        transform.at<float>(0,2)*=scale/previous; transform.at<float>(1,2)*=scale/previous;
        score=translation(ar,br,ma,mb,transform.at<float>(0,2),transform.at<float>(1,2),scale==1.);
        if(score<0) break;
        previous=scale;
        if(identical&2) break;
      }
      if(identical&2) {
        transform.at<float>(0,2)/=previous;transform.at<float>(1,2)/=previous;
        // Coarse training uses area-reduced optimization. Retain native masks,
        // observability and native correlation before fitting scene motions.
        score=translation(aa,bb,am,bm,transform.at<float>(0,2),transform.at<float>(1,2),true,false);
      }
      patchStats[1]+=emscripten_get_now()-optimizationStart;
      if(!std::isfinite(score) || score<.9) continue;
      output[n*5]=left+(edge-1)*.5; output[n*5+1]=top+(edge-1)*.5;
      output[n*5+2]=transform.at<float>(0,2); output[n*5+3]=transform.at<float>(1,2); output[n*5+4]=score; n++;
    } catch(const cv::Exception&) { continue; }
  }
  return n;
}
}
