import type { AdjustmentParameters } from './adjustments'
import { contrastModule } from './contrast'
import { highlightsModule } from './highlights'
import { shadowsModule } from './shadows'
import { whitesModule } from './whites'
import { blacksModule } from './blacks'
import { colorIntensityGlslFor, colorIntensityWgsl } from './color-intensity'
import { maskColorBalanceGain, maskColorBalanceMatrices, MASK_COLOR_VERSION } from './mask-color'
import { identityMatrix } from './white-balance'
import { identityMaskGeometry, validateMaskGeometry } from './mask-geometry'
import {
  maskCapabilities,
  maskBaseReference,
  validateMaskBaseContent,
  validateMaskLight,
  hasMaskAdjustments,
  validateMaskStroke,
  type ResolvedMask,
  type MaskBaseContent,
  maskHasEdges,
  validatePreparedMaskCoverage,
} from './masks'

export const MASK_RENDERING_VERSION =
  'ordered-light-color-brush-generated-edge-green-native-v4-' + MASK_COLOR_VERSION
export const MASK_DESCRIPTOR_VEC4S = 9
export const MASK_GPU_TEXTURE_WIDTH = 256
export const MAX_MASK_BASE_ATLAS_BYTES = maskCapabilities.maxBaseAtlasBytes
const TILE_EDGE = 256
export const MAX_MASK_GPU_BYTES = maskCapabilities.maxRetainedBytes

/** An empty or erase-only uninverted mask cannot affect any photograph pixel. */
export function maskHasCoverage(
  mask: Pick<ResolvedMask, 'inverted' | 'strokes' | 'base'>,
): boolean {
  return Boolean(mask.base) || mask.inverted || mask.strokes.some((stroke) => stroke.mode === 'add')
}

/** One native R8 atlas shares a binding across every distinct generated base. */
function renderMask(mask: ResolvedMask, coverageOnly = false): ResolvedMask {
  if (!maskHasEdges(mask)) return mask
  if (!mask.preparedCoverage) {
    if (coverageOnly || (mask.enabled && hasMaskAdjustments(mask)))
      throw new Error('Mask edge coverage is not ready. Retry GPU after preparation completes.')
    return { ...mask, base: undefined, strokes: [], inverted: false }
  }
  validatePreparedMaskCoverage(mask.preparedCoverage)
  const base = {
    version: 1 as const,
    hash: mask.preparedCoverage.hash,
    width: mask.preparedCoverage.width,
    height: mask.preparedCoverage.height,
    pngBase64: mask.preparedCoverage.pngBase64,
  }
  return { ...mask, base, strokes: [], inverted: false }
}
export function maskBaseAtlasPlan(
  parameters: Pick<AdjustmentParameters, 'localMasks'>,
  coverageOnly = false,
) {
  const unique = new Map<string, MaskBaseContent>()
  for (const original of parameters.localMasks ?? []) {
    const mask = renderMask(original, coverageOnly)
    if (!mask.base) continue
    validateMaskBaseContent(mask.base)
    unique.set(mask.base.hash, mask.base)
  }
  const bases = [...unique.values()],
    width = bases[0]?.width ?? 1,
    height = bases[0]?.height ?? 1
  if (bases.some((base) => base.width !== width || base.height !== height))
    throw new Error('Generated masks must share the photograph native source grid.')
  const layers = Math.max(1, bases.length),
    bytes = width * height * layers
  if (bytes > MAX_MASK_BASE_ATLAS_BYTES)
    throw new Error(
      'Generated masks exceed the 256 MiB native coverage atlas limit. Remove a generated mask before trying again.',
    )
  const transferRows = Math.min(height, Math.max(1, Math.floor((4 * 1024 * 1024) / (width * 4))))
  return {
    bases,
    width,
    height,
    layers,
    bytes,
    transferRows,
    uploadBytes: bases.length ? width * transferRows * 4 : 0,
    decodeBytes: bases.length ? width * height * 4 : 0,
    key: bases.map((base) => base.hash).join(':'),
  }
}

export function hasLocalMasks(parameters: Pick<AdjustmentParameters, 'localMasks'>): boolean {
  return Boolean(
    parameters.localMasks?.some(
      (mask) => mask.enabled && maskHasCoverage(mask) && hasMaskAdjustments(mask),
    ),
  )
}

/** Admission precedes GPU preparation. Geometry is an upper bound for complete
 * prepared coverage; layer identities need no pixel filtering or PNG encoding. */
export function localMaskAllocationBytes(
  parameters: Pick<AdjustmentParameters, 'localMasks' | 'maskGeometry'>,
  image: { width: number; height: number },
) {
  const masks = parameters.localMasks ?? []
  const unfiltered = masks.map((mask) => ({
    ...mask,
    edge: { featherPx: 0, shiftPx: 0 },
    preparedCoverage: undefined,
  }))
  const geometryBytes = packLocalMasks({ ...parameters, localMasks: unfiltered }, image).byteLength
  const layers = new Set(
    masks.flatMap((mask) => {
      if (maskHasEdges(mask))
        return mask.enabled && hasMaskAdjustments(mask)
          ? [JSON.stringify([mask.base?.hash, mask.head, mask.strokes, mask.inverted, mask.edge])]
          : []
      return mask.base ? [mask.base.hash] : []
    }),
  ).size
  const width = parameters.maskGeometry?.canonicalWidth ?? image.width,
    height = parameters.maskGeometry?.canonicalHeight ?? image.height
  const coverageBytes = width * height * layers
  if (coverageBytes > MAX_MASK_BASE_ATLAS_BYTES)
    throw new Error('Mask coverage exceeds the native GPU atlas limit.')
  return geometryBytes + coverageBytes
}

/** Labels, selection IDs and durable-chain hashes do not change photo pixels. */
export function localMaskPixelData(parameters: Pick<AdjustmentParameters, 'localMasks'>) {
  return (
    parameters.localMasks
      ?.filter((mask) => mask.enabled && maskHasCoverage(mask) && hasMaskAdjustments(mask))
      .map((mask) => ({
        inverted: mask.inverted,
        light: mask.light,
        color: mask.color,
        strokes: mask.strokes,
        edge: mask.edge,
        ...(mask.base ? { base: maskBaseReference(mask.base) } : {}),
      })) ?? []
  )
}

/** Retain the unit-input Light/matrix range guard; nonlinear color also checks GPU output. */
export function validateLocalMaskGain(parameters: Pick<AdjustmentParameters, 'localMasks'>): void {
  let bound = 1
  for (const mask of [...(parameters.localMasks ?? [])].reverse()) {
    if (!mask.enabled || !maskHasCoverage(mask)) continue
    bound *= maskColorBalanceGain(mask.color)
    const light = mask.light
    bound *= 2 ** Math.max(0, light.exposureEv)
    if (light.contrast) bound = Math.max(bound, 20)
    bound *=
      (1 + Math.max(0, light.highlights) / 100) *
      2 ** ((2 * Math.max(0, light.shadows)) / 100 + Math.max(0, light.whites) / 100)
    bound += (0.04 * Math.max(0, light.blacks)) / 100
    if (!Number.isFinite(bound) || bound > 3.4028234663852886e38)
      throw new Error(
        'The combined local adjustment stack exceeds the Float32 numerical range. Reduce its adjustments.',
      )
  }
}

/** Geometry-only preparation: image samples and mask coverage are evaluated on the GPU. */
export function packLocalMasks(
  parameters: Pick<AdjustmentParameters, 'localMasks' | 'maskGeometry'>,
  image: { width: number; height: number },
  coverageOnly = false,
) {
  const masks = (parameters.localMasks ?? []).map((mask) => renderMask(mask, coverageOnly))
  const atlas = maskBaseAtlasPlan(parameters, coverageOnly)
  validateLocalMaskGain(parameters)
  if (masks.length > maskCapabilities.maxMasks) throw new Error('Too many local masks.')
  const geometry = parameters.maskGeometry ?? identityMaskGeometry(image.width, image.height)
  validateMaskGeometry(geometry)
  if (
    atlas.bases.length &&
    (atlas.width !== geometry.canonicalWidth || atlas.height !== geometry.canonicalHeight)
  )
    throw new Error('Generated mask dimensions do not match the immutable oriented source grid.')
  const { canonicalWidth: width, canonicalHeight: height } = geometry,
    short = Math.min(width, height),
    cols = Math.ceil(width / TILE_EDGE),
    rows = Math.ceil(height / TILE_EDGE),
    cells = cols * rows,
    c = geometry.correction,
    values: number[] = new Array((6 + masks.length * MASK_DESCRIPTOR_VEC4S) * 4).fill(0)
  const add = (...items: number[]) => {
    if ((values.length + items.length) * 4 > MAX_MASK_GPU_BYTES)
      throw new Error('Local mask GPU geometry exceeds its bounded allocation.')
    const at = values.length / 4
    values.push(...items)
    return at
  }
  values.splice(
    0,
    24,
    masks.length,
    width,
    height,
    short,
    geometry.sourceWidth,
    geometry.sourceHeight,
    geometry.flip,
    Number(Boolean(c)),
    c?.width ?? geometry.sourceWidth,
    c?.height ?? geometry.sourceHeight,
    c?.left ?? 0,
    c?.top ?? 0,
    ...(geometry.crop?.outputToSource.slice(0, 4) ?? [1, 0, 0, 1]),
    geometry.crop?.outputToSource[4] ?? 0,
    geometry.crop?.outputToSource[5] ?? 0,
    cols,
    rows,
    0,
    image.width,
    image.height,
    TILE_EDGE,
  )
  let pointCount = 0,
    referenceCount = 0
  for (let ordinal = 0; ordinal < masks.length; ordinal++) {
    const mask = masks[ordinal]
    validateMaskLight(mask.light)
    const balance = maskColorBalanceMatrices(mask.color)
    const packedBalance = [
      balance?.srgb ?? identityMatrix,
      balance?.rec2020 ?? identityMatrix,
    ].flatMap((matrix) => [0, 1, 2].flatMap((row) => [...matrix.slice(row * 3, row * 3 + 3), 0]))
    const bins: Array<Array<[number, number]>> = Array.from({ length: cells }, () => [])
    for (const stroke of mask.strokes) {
      validateMaskStroke(stroke)
      pointCount += stroke.points.length
      if (pointCount > maskCapabilities.maxLivePoints)
        throw new Error('The live brush geometry limit was exceeded.')
      const metadata = add(stroke.radius, stroke.feather, Number(stroke.mode === 'subtract'), 0)
      for (let i = 0; i < Math.max(1, stroke.points.length - 1); i++) {
        const a = stroke.points[i],
          b = stroke.points[Math.min(i + 1, stroke.points.length - 1)],
          segment = add(
            (a.x * width) / short,
            (a.y * height) / short,
            (b.x * width) / short,
            (b.y * height) / short,
          ),
          radiusX = (stroke.radius * short) / width,
          radiusY = (stroke.radius * short) / height,
          x0 = Math.max(0, Math.floor(((Math.min(a.x, b.x) - radiusX) * width) / TILE_EDGE)),
          x1 = Math.min(cols - 1, Math.floor(((Math.max(a.x, b.x) + radiusX) * width) / TILE_EDGE)),
          y0 = Math.max(0, Math.floor(((Math.min(a.y, b.y) - radiusY) * height) / TILE_EDGE)),
          y1 = Math.min(rows - 1, Math.floor(((Math.max(a.y, b.y) + radiusY) * height) / TILE_EDGE))
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            if (++referenceCount > MAX_MASK_GPU_BYTES / 16)
              throw new Error('Local mask spatial indexing exceeds its bounded allocation.')
            bins[y * cols + x].push([segment, metadata])
            if (bins[y * cols + x].length > maskCapabilities.maxLivePoints)
              throw new Error('Local mask tile complexity exceeds its bounded allocation.')
          }
      }
    }
    const table = values.length / 4
    for (let i = 0; i < cells; i++) add(0, 0, 0, 0)
    for (let i = 0; i < cells; i++) {
      values[(table + i) * 4] = values.length / 4
      values[(table + i) * 4 + 1] = bins[i].length
      for (const [segment, metadata] of bins[i]) add(segment, metadata, 0, 0)
    }
    values.splice(
      (6 + ordinal * MASK_DESCRIPTOR_VEC4S) * 4,
      MASK_DESCRIPTOR_VEC4S * 4,
      table,
      Number(mask.inverted),
      Number(mask.enabled),
      mask.base ? atlas.bases.findIndex((base) => base.hash === mask.base!.hash) + 1 : 0,
      mask.light.exposureEv,
      mask.light.contrast,
      mask.light.highlights,
      mask.light.shadows,
      mask.light.whites,
      mask.light.blacks,
      mask.color.saturation,
      Number(balance !== null),
      ...packedBalance,
    )
  }
  if (c) {
    values[20] = values.length / 4
    for (let i = 0; i < 4096; i++) add(c.distortion[i], 0, 0, 0)
  }
  return new Float32Array(values)
}

const modules = [contrastModule, highlightsModule, shadowsModule, whitesModule, blacksModule]
const lightShader = (language: 'wgsl' | 'glsl') =>
  modules.map((module) => module[language].replaceAll('apply', 'maskApply')).join('\n')

const colorShader = (language: 'wgsl' | 'glsl', primaries: 'srgb' | 'rec2020', power: string) => {
  let shader =
    language === 'wgsl' ? colorIntensityWgsl(primaries, power) : colorIntensityGlslFor(primaries)
  const prefix = primaries === 'srgb' ? 'maskSrgb_' : 'maskRec2020_'
  for (const name of ['colorLabF', 'colorLabInverse', 'colorLabDelta', 'applyColorIntensity'])
    shader = shader.replaceAll(new RegExp('\\b' + name + '\\b', 'g'), prefix + name)
  return shader
}

export function localMasksWgsl(binding = 16, baseBinding?: number, power = 'pow') {
  return `
@group(0) @binding(${binding}) var<storage,read> maskData:array<vec4f>;
${
  baseBinding === undefined
    ? ''
    : `@group(0) @binding(${baseBinding}) var maskBaseAtlas:texture_2d_array<f32>;
fn maskBaseCoverage(layer:i32,point:vec2f)->f32 {
 if(any(point<vec2f(0.))||any(point>=vec2f(1.))){return 0.;}
 let size=vec2i(textureDimensions(maskBaseAtlas));let position=point*vec2f(size)-.5;
 let low=vec2i(floor(position));let fraction=fract(position);let high=clamp(low+1,vec2i(0),size-1);let at=clamp(low,vec2i(0),size-1);
 return mix(mix(textureLoad(maskBaseAtlas,at,layer,0).r,textureLoad(maskBaseAtlas,vec2i(high.x,at.y),layer,0).r,fraction.x),mix(textureLoad(maskBaseAtlas,vec2i(at.x,high.y),layer,0).r,textureLoad(maskBaseAtlas,high,layer,0).r,fraction.x),fraction.y);
}`
}
${lightShader('wgsl')}
${colorShader('wgsl', 'srgb', power)}
${colorShader('wgsl', 'rec2020', power)}
fn localMaskFinite(rgb:vec3f)->bool {
 return all((bitcast<vec3u>(rgb)&vec3u(0x7f800000u))!=vec3u(0x7f800000u));
}
fn maskCanonical(pixel:vec2f)->vec2f {
 let base=maskData[1]; let crop=maskData[3]; let tail=maskData[4]; let corrected=maskData[2];
 var p=vec2f(dot(crop.xy,pixel),dot(crop.zw,pixel))+tail.xy;
 let flip=u32(base.z);
 if((flip&4u)!=0u){p=p.yx;}
 if((flip&1u)!=0u){p.x=corrected.x-p.x;}
 if((flip&2u)!=0u){p.y=corrected.y-p.y;}
 if(base.w!=0.){
  let center=(base.xy-1.)*.5; let q=p-.5+corrected.zw-center;
  let radius=length(center); var position=0.;
  if(radius>0.){position=clamp(length(q)/radius*4095.,0.,4095.);}
  let index=min(4094u,u32(position)); let offset=u32(maskData[5].x);
  let factor=mix(maskData[offset+index].x,maskData[offset+index+1u].x,position-f32(index));
  p=center+q*factor+.5;
 }
 if((flip&1u)!=0u){p.x=base.x-p.x;}
 if((flip&2u)!=0u){p.y=base.y-p.y;}
 if((flip&4u)!=0u){p=p.yx;}
 return p/maskData[0].yz;
}
fn maskCoverage(index:u32,canonical:vec2f)->f32 {
 let mask=maskData[6u+index*${MASK_DESCRIPTOR_VEC4S}u]; let size=maskData[0].yz; let short=maskData[0].w;
 let dimensions=vec2u(maskData[4].zw);
 let tile=clamp(vec2i(floor(canonical*size/maskData[5].w)),vec2i(0),vec2i(dimensions)-1);
 let bin=maskData[u32(mask.x)+u32(tile.y)*dimensions.x+u32(tile.x)];
 let point=canonical*size/short;
 var coverage=${baseBinding === undefined ? '0.' : 'select(0.,maskBaseCoverage(i32(mask.w)-1,canonical),mask.w>0.)'}; var brush=0.; var last=-1; var subtract=false;
 for(var i=0u;i<u32(bin.y);i++){
  let entry=maskData[u32(bin.x)+i]; let stroke=i32(entry.y);
  if(stroke!=last){
   if(last>=0){if(subtract){coverage*=1.-brush;}else{coverage=max(coverage,brush);}}
   brush=0.; last=stroke; subtract=maskData[u32(stroke)].z!=0.;
  }
  let segment=maskData[u32(entry.x)]; let style=maskData[u32(entry.y)];
  let delta=segment.zw-segment.xy; let lengthSquared=dot(delta,delta); var t=0.;
  if(lengthSquared>0.){t=clamp(dot(point-segment.xy,delta)/lengthSquared,0.,1.);}
  let distance=length(point-(segment.xy+t*delta));
  var amount=select(0.,1.,distance<=style.x);
  if(style.y>0.){amount=1.-smoothstep(style.x*(1.-style.y),style.x,distance);}
  brush=max(brush,amount);
 }
 if(last>=0){if(subtract){coverage*=1.-brush;}else{coverage=max(coverage,brush);}}
 return select(coverage,1.-coverage,mask.y!=0.);
}
fn maskLight(input:vec3f,light:vec4f,endpoints:vec2f,white:f32,scene:bool)->vec3f {
 if(all(light==vec4f(0.)) && all(endpoints==vec2f(0.))){return input;}
 var rgb=input*exp2(light.x);
 if(!scene){
  rgb=max(rgb,vec3f(0.)); rgb=maskApplyContrast(rgb,light.y,white);
  rgb=maskApplyHighlights(rgb,light.z,white); rgb=maskApplyShadows(rgb,light.w,white);
  rgb=maskApplyWhites(rgb,endpoints.x,white); return maskApplyBlacks(rgb,endpoints.y,white);
 }
 let weights=vec3f(.2627002120112671,.6779980715188708,.059301716469862);
 var y=dot(rgb,weights);
 if(light.y!=0. && y>0. && y<1.){
  var next=.18*pow(y/.18,exp2(light.y/100.));
  if(y>.18){next=1.-.82*pow((1.-y)/.82,exp2(light.y/100.));} rgb*=next/y;
 }
 y=dot(rgb,weights); let h=light.z/100.;
 if(h!=0. && y>.18){rgb*=((1.+h)*y-h*(.18+.82*(y-.18)/(.82+y-.18)))/y;}
 y=dot(rgb,weights);
 if(light.w!=0. && y>0. && y<.18){rgb*=exp2(2.*light.w/100.*pow(1.-y/.18,2.));}
 y=dot(rgb,weights);
 if(endpoints.x!=0. && y>0.){let t=clamp((y-.18)/.82,0.,1.);rgb*=exp2(endpoints.x/100.*t*t*(3.-2.*t));}
 y=dot(rgb,weights); let b=endpoints.y/100.;
 if(b!=0. && y>=0.){let d=.04*b*pow(max(1.-y/.18,0.),3.);if(b>0.){rgb+=vec3f(d);}else if(y>0.){rgb*=max(0.,y+d)/y;}}
 return rgb;
}
fn maskBalance(input:vec3f,offset:u32,scene:bool)->vec3f {
 let start=offset+select(3u,6u,scene);
 return vec3f(dot(maskData[start].xyz,input),dot(maskData[start+1u].xyz,input),dot(maskData[start+2u].xyz,input));
}
fn maskSaturation(input:vec3f,saturation:f32,scene:bool)->vec3f {
 if(scene){return maskRec2020_applyColorIntensity(input,vec2f(saturation,0.));}
 return maskSrgb_applyColorIntensity(input,vec2f(saturation,0.));
}
fn applyLocalMasks(input:vec3f,pixel:vec2f,white:f32,scene:bool)->vec3f {
 let point=maskCanonical(pixel); var rgb=input;
 // Descriptors are stored top first. The top mask consumes every lower result.
 for(var remaining=u32(maskData[0].x);remaining>0u;remaining--){
  let index=remaining-1u;let offset=6u+index*${MASK_DESCRIPTOR_VEC4S}u;let descriptor=maskData[offset];
  let light=maskData[offset+1u];let config=maskData[offset+2u];let endpoints=config.xy;let color=config.zw;
  if(descriptor.z==0. || (all(light==vec4f(0.)) && all(config==vec4f(0.)))){continue;}
  let coverage=maskCoverage(index,point);
  if(coverage>0.){
   var changed=rgb;
   if(color.y!=0.){changed=maskBalance(changed,offset,scene);}
   changed=maskLight(changed,light,endpoints,white,scene);
   if(color.x!=0.){changed=maskSaturation(changed/white,color.x,scene)*white;}
   if(!localMaskFinite(changed)){return changed;}
   rgb=mix(rgb,changed,coverage);
  }
  if(!localMaskFinite(rgb)){return rgb;}
 }
 return rgb;
}
`
}

export function localMasksGlslFor(bases = false) {
  return `
uniform highp sampler2D localMaskData;
${
  bases
    ? `
uniform highp sampler2DArray localMaskBaseAtlas;
float maskBaseCoverage(int layer,vec2 point){
 if(any(lessThan(point,vec2(0.)))||any(greaterThanEqual(point,vec2(1.))))return 0.;
 ivec2 size=textureSize(localMaskBaseAtlas,0).xy;vec2 position=point*vec2(size)-.5;
 ivec2 low=ivec2(floor(position)),high=clamp(low+1,ivec2(0),size-1),at=clamp(low,ivec2(0),size-1);vec2 fraction=fract(position);
 return mix(mix(texelFetch(localMaskBaseAtlas,ivec3(at,layer),0).r,texelFetch(localMaskBaseAtlas,ivec3(high.x,at.y,layer),0).r,fraction.x),mix(texelFetch(localMaskBaseAtlas,ivec3(at.x,high.y,layer),0).r,texelFetch(localMaskBaseAtlas,ivec3(high,layer),0).r,fraction.x),fraction.y);
}
`
    : ''
}
vec4 maskDataAt(int index){return texelFetch(localMaskData,ivec2(index%${MASK_GPU_TEXTURE_WIDTH},index/${MASK_GPU_TEXTURE_WIDTH}),0);}
bool localMaskFinite(vec3 rgb){return all(notEqual(floatBitsToUint(rgb)&uvec3(0x7f800000u),uvec3(0x7f800000u)));}
${lightShader('glsl')}
${colorShader('glsl', 'srgb', 'pow')}
vec2 maskCanonical(vec2 pixel){
 vec4 base=maskDataAt(1),crop=maskDataAt(3),tail=maskDataAt(4),corrected=maskDataAt(2);
 vec2 p=vec2(dot(crop.xy,pixel),dot(crop.zw,pixel))+tail.xy;int flip=int(base.z);
 if((flip&4)!=0)p=p.yx;if((flip&1)!=0)p.x=corrected.x-p.x;if((flip&2)!=0)p.y=corrected.y-p.y;
 if(base.w!=0.){vec2 center=(base.xy-1.)*.5,q=p-.5+corrected.zw-center;
  float radius=length(center),position=radius>0.?clamp(length(q)/radius*4095.,0.,4095.):0.;
  int index=min(4094,int(position)),offset=int(maskDataAt(5).x);
  float factor=mix(maskDataAt(offset+index).x,maskDataAt(offset+index+1).x,position-float(index));p=center+q*factor+.5;}
 if((flip&1)!=0)p.x=base.x-p.x;if((flip&2)!=0)p.y=base.y-p.y;if((flip&4)!=0)p=p.yx;
 return p/maskDataAt(0).yz;
}
float maskCoverage(int index,vec2 canonical){
 vec4 mask=maskDataAt(6+index*${MASK_DESCRIPTOR_VEC4S});vec2 size=maskDataAt(0).yz;float shortSide=maskDataAt(0).w;
 ivec2 dimensions=ivec2(maskDataAt(4).zw),tile=clamp(ivec2(floor(canonical*size/maskDataAt(5).w)),ivec2(0),dimensions-1);
 vec4 bin=maskDataAt(int(mask.x)+tile.y*dimensions.x+tile.x);vec2 point=canonical*size/shortSide;
 float coverage=${bases ? 'mask.w>0.?maskBaseCoverage(int(mask.w)-1,canonical):0.' : '0.'},brush=0.;int last=-1;bool subtract=false;
 for(int i=0;i<int(bin.y);i++){
  vec4 entry=maskDataAt(int(bin.x)+i);int stroke=int(entry.y);
  if(stroke!=last){if(last>=0){coverage=subtract?coverage*(1.-brush):max(coverage,brush);}brush=0.;last=stroke;subtract=maskDataAt(stroke).z!=0.;}
  vec4 segment=maskDataAt(int(entry.x)),style=maskDataAt(int(entry.y));vec2 delta=segment.zw-segment.xy;
  float squared=dot(delta,delta),t=squared>0.?clamp(dot(point-segment.xy,delta)/squared,0.,1.):0.;
  float distance=length(point-(segment.xy+t*delta));float amount=distance<=style.x?1.:0.;
  if(style.y>0.)amount=1.-smoothstep(style.x*(1.-style.y),style.x,distance);brush=max(brush,amount);
 }
 if(last>=0)coverage=subtract?coverage*(1.-brush):max(coverage,brush);
 return mask.y!=0.?1.-coverage:coverage;
}
vec3 applyLocalMasks(vec3 inputRgb,vec2 pixel,float white){
 vec2 point=maskCanonical(pixel);vec3 rgb=inputRgb;
 for(int remaining=int(maskDataAt(0).x);remaining>0;remaining--){
  int index=remaining-1,offset=6+index*${MASK_DESCRIPTOR_VEC4S};vec4 descriptor=maskDataAt(offset),light=maskDataAt(offset+1),config=maskDataAt(offset+2);vec2 endpoints=config.xy,color=config.zw;
  if(descriptor.z==0. || (all(equal(light,vec4(0.))) && all(equal(config,vec4(0.)))))continue;
  float coverage=maskCoverage(index,point);if(coverage<=0.)continue;
  vec3 changed=rgb;
  if(color.y!=0.){changed=vec3(dot(maskDataAt(offset+3).xyz,changed),dot(maskDataAt(offset+4).xyz,changed),dot(maskDataAt(offset+5).xyz,changed));}
  if(any(notEqual(light,vec4(0.))) || any(notEqual(endpoints,vec2(0.)))){
   changed=max(changed*exp2(light.x),vec3(0.));changed=maskApplyContrast(changed,light.y,white);
   changed=maskApplyHighlights(changed,light.z,white);changed=maskApplyShadows(changed,light.w,white);
   changed=maskApplyWhites(changed,endpoints.x,white);changed=maskApplyBlacks(changed,endpoints.y,white);
  }
  if(color.x!=0.){changed=maskSrgb_applyColorIntensity(changed/white,vec2(color.x,0.))*white;}
  if(!localMaskFinite(changed))return changed;
  rgb=mix(rgb,changed,coverage);
  if(!localMaskFinite(rgb))return rgb;
 }
 return rgb;
}
`
}
export const localMasksGlsl = localMasksGlslFor()
