import { hdrRenderingWgsl } from '../../../src/renderer/src/preview/hdr-shader'

/** Historical reference mapping for differential GPU controls, never an application selector. */
export const grid8ReferenceKernel = {
  kind: 'grid8' as const,
  shader: `
${hdrRenderingWgsl}
@group(0) @binding(3) var cached: texture_storage_2d_array<rgba32float,write>;
@group(0) @binding(5) var<storage,read> jobs:array<vec4u>;
@compute @workgroup_size(8,8) fn renderTile(@builtin(global_invocation_id) p:vec3u) {
  let size=vec2i(textureDimensions(cached));
  if(any(vec2i(p.xy)>=size)) { return; }
  let job=jobs[p.z];
  let point=vec2i(job.xy)*(size-2)+vec2i(p.xy)-1;
  let pixel=textureLoad(pixels,clamp(point,vec2i(0),vec2i(textureDimensions(pixels))-1),0);
  var rgb=pixel.rgb;
  if(job.w==0u) { rgb=adjusted(rgb); }
  textureStore(cached,vec2i(p.xy),i32(job.z),vec4f(outputRgb(rgb),pixel.a));
}`,
  dispatch(extent: number, jobs: number): [number, number, number] {
    return [Math.ceil(extent / 8), Math.ceil(extent / 8), jobs]
  },
}
