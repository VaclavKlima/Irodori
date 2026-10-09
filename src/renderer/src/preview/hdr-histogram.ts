import { hdrRenderingWgsl, hdrPresentationWgsl } from './hdr-shader'
import { hdrStatistics, type HdrStatistics } from '../../../shared/hdr-statistics'
import type { DisplayTarget, HdrWorkingAsset } from '../../../shared/hdr'

export const HDR_HISTOGRAM_WORDS = 256 + 512 * 3 + 9
export const hdrHistogramShader = `${hdrRenderingWgsl}
${hdrPresentationWgsl}
@group(0) @binding(6) var<storage,read_write> histogram:array<atomic<u32>>;
@compute @workgroup_size(64) fn sampleHistogram(@builtin(global_invocation_id) p:vec3u) {
  let count=u32(u.values[9].x);
  if(p.x>=count) { return; }
  let size=textureDimensions(pixels);
  // Exact floor((i + .5) * pixels / count), without Float32 indexing drift at RAW sizes.
  let total=size.x*size.y;
  let quotient=total/count;
  let remainder=total%count;
  let index=min(total-1u,p.x*quotient+quotient/2u+
    (p.x*remainder+remainder/2u+(quotient%2u)*(count/2u))/count);
  let pixel=textureLoad(pixels,vec2i(i32(index%size.x),i32(index/size.x)),0);
  if(pixel.a==0.) { return; }
  var working=pixel.rgb;
  if(u.values[4].x!=1.) { working=adjusted(working); }
  let rgb=outputRgb(working);
  let y=dot(rgb,luma);
  let base=1792u;
  atomicAdd(&histogram[base],1u);
  if(y==0.) { atomicAdd(&histogram[base+1u],1u); }
  else if(y<0.) { atomicAdd(&histogram[base+2u],1u); }
  else {
    let stop=log2(y);
    if(stop< -16.) { atomicAdd(&histogram[base+3u],1u); }
    else if(stop>=16.) { atomicAdd(&histogram[base+4u],1u); }
    else { atomicAdd(&histogram[u32(floor((stop+16.)*8.))],1u); }
  }
  if(y>1.) { atomicAdd(&histogram[base+5u],1u); }
  if(u.values[10].z>0. && y>u.values[10].w) { atomicAdd(&histogram[base+6u],1u); }
  let converted=canvasRgb(rgb);
  if(any(converted<vec3f(-.000002))) { atomicAdd(&histogram[base+8u],1u); }
  if(any(converted<vec3f(-.000002)) || any(converted>vec3f(u.values[9].y+.000002))) {
    atomicAdd(&histogram[base+7u],1u);
  }
  for(var c=0u;c<3u;c++) {
    var bin=u32(round(clamp(encoded(rgb)[c],0.,1.)*255.));
    if(rgb[c]>1.) { bin=256u+min(255u,u32(floor(log2(rgb[c])*64.))); }
    atomicAdd(&histogram[256u+c*512u+bin],1u);
  }
}`
export function readHdrHistogram(
  data: Uint32Array,
  target: DisplayTarget,
  asset: HdrWorkingAsset,
  editSerial: number,
): HdrStatistics {
  const result = hdrStatistics('content-hdr', target, asset, false)
  result.editSerial = editSerial
  result.bins = Array.from(data.subarray(0, 256))
  result.rgbHistogram!.rgb = [0, 1, 2].map((c) =>
    Array.from(data.subarray(256 + c * 512, 256 + (c + 1) * 512)),
  ) as [number[], number[], number[]]
  const counters = data.subarray(1792)
  result.visiblePixels = result.rgbHistogram!.visiblePixels = counters[0]
  ;[result.zero, result.negative, result.underflow, result.overflow, result.aboveWhite] =
    Array.from(counters.subarray(1, 6))
  result.exceedingHeadroom = target.headroom === null ? null : counters[6]
  result.outputClipped = counters[7]
  // The following counter is added separately to retain luminance/channel diagnostics.
  result.gamutLimited = data[HDR_HISTOGRAM_WORDS - 1] ?? 0
  result.gamutCompressed = null
  return result
}
