import { ACES_DATA_BYTES, packAces } from '../../shared/aces-data'
import type { AdjustmentParameters } from '../../shared/adjustments'
import { srgbTransform } from '../../shared/adjustments'
import { authoredOutputShader, type PointRenderOptions } from '../../shared/authored-output-wgsl'
import { creativeColorActive, prepareCreativeColor } from '../../shared/creative-color'
import { CREATIVE_COLOR_PARAMETER_BYTES, packCreativeColor } from '../../shared/creative-color-gpu'
import {
  HDR_CONTENT_TARGET,
  prepareDisplayRendering,
  REC2020_TO_ACES,
} from '../../shared/display-rendering'
import { displayRenderingWgsl } from '../../shared/display-rendering-wgsl'
import {
  EXPORT_GPU_LIMIT_BYTES,
  exportGpuAllocation,
  ExportResourceError,
} from '../../shared/export-resources'
import { SDR_TARGET } from '../../shared/hdr'
import { hdrAdjustmentShader } from '../../shared/hdr-adjustments-wgsl'
import { exportPrecisionData, exportPrecisionWgsl } from '../export/precision-wgsl'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { preparedToneCurves } from '../../shared/tone-curves'
import { packToneCurves, TONE_CURVE_PARAMETER_BYTES } from '../../shared/tone-curves-gpu'
import {
  hasLocalMasks,
  localMasksWgsl,
  packLocalMasks,
  maskBaseAtlasPlan,
} from '../../shared/masks-gpu'
import { maskOutputSize } from '../../shared/mask-geometry'
import { pointOnlyMaskAdjustments } from '../../shared/masked-texture'
import { createMaskBaseAtlas } from './mask-bases'
import {
  activeNativeMaskEdges,
  prepareNativeMaskEdges,
  type NativeMaskEdgeOptions,
} from '../mask-edges/native'

const inputMatrix =
  'mat3x3f(' + REC2020_TO_ACES.map((row) => 'vec3f(' + row.join(',') + ')').join(',') + ')'

/** Additional simultaneously live buffers used by paired native consumption. */
export function preparedPointAllocationBytes(
  capacity: number,
  packed: boolean,
  hdr = false,
  primary = false,
): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error('Invalid prepared point capacity.')
  const stride = packed ? (hdr ? 3 : 1) : hdr ? 6 : 3
  return (
    capacity * (20 + stride * 4 + (primary ? 20 : 0) + (hdr && packed ? 16 + stride * 4 : 0)) +
    4 +
    (hdr && packed ? 12 : 0)
  )
}

/** Exact native-word compatibility is selected before downstream resize or encoding. */
function preparedSelectionShader(
  stride: number,
  packed: boolean,
  workgroup: number,
  primary = false,
  hdr = false,
): string {
  return `
struct Params { values:array<vec4f,12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> parent:array<vec4f>;
@group(0) @binding(2) var<storage,read> prepared:array<vec4f>;
@group(0) @binding(3) var<storage,read> coverage:array<f32>;
struct Legacy { peak:u32, values:array<u32> }
@group(0) @binding(4) var<storage,read> legacy:Legacy;
struct Result { peak:atomic<u32>, values:array<u32> }
@group(0) @binding(5) var<storage,read_write> result:Result;
${primary ? '@group(0) @binding(6) var<storage,read> primaryCoverage:array<f32>;' : ''}
fn finite(value:vec4f)->bool {
 return all((bitcast<vec4u>(value)&vec4u(0x7f800000u))!=vec4u(0x7f800000u));
}
fn unitInterval(bits:u32)->bool {
 return (bits&0x7fffffffu)<=0x3f800000u&&((bits&0x80000000u)==0u||bits==0x80000000u);
}
@compute @workgroup_size(${workgroup}) fn selectPrepared(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=u32(u.values[0].x)){return;}
 let original=parent[id.x];let candidate=prepared[id.x];let amount=coverage[id.x];
 let amountBits=bitcast<u32>(amount);let alphaBits=bitcast<u32>(original.a);
 if(!finite(original)||!finite(candidate)||!unitInterval(amountBits)||!unitInterval(alphaBits)||
    alphaBits!=bitcast<u32>(candidate.a)){
  atomicMax(&result.peak,bitcast<u32>(1e30));
 }
 for(var channel=0u;channel<${stride}u;channel++){
  let slot=id.x*${stride}u+channel;
  ${primary ? `let selectedAmount=select(amount,primaryCoverage[id.x],channel<${packed ? '1' : '3'}u);let selectedBits=bitcast<u32>(selectedAmount);` : 'let selectedBits=amountBits;'}
  if(!(selectedBits>0u&&selectedBits<=0x3f800000u&&alphaBits>0u&&alphaBits<=0x3f800000u)){result.values[slot]=legacy.values[slot];}
  ${packed ? '' : 'if((result.values[slot]&0x7f800000u)==0x7f800000u){atomicMax(&result.peak,bitcast<u32>(1e30));}'}
  ${hdr && !packed ? 'if(channel>=3u){atomicMax(&result.peak,result.values[slot]);}' : ''}
 }
}`
}

function preparedPeakShader(inside: boolean): string {
  return `
struct Params { values:array<vec4f,12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> parent:array<vec4f>;
@group(0) @binding(2) var<storage,read> prepared:array<vec4f>;
@group(0) @binding(3) var<storage,read> coverage:array<f32>;
@group(0) @binding(4) var<storage,read_write> masked:array<vec4f>;
@compute @workgroup_size(64) fn preparePeak(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=u32(u.values[0].x)){return;}
 let amount=bitcast<u32>(coverage[id.x]);let alpha=bitcast<u32>(parent[id.x].a);
 let selected=amount>0u&&amount<=0x3f800000u&&alpha>0u&&alpha<=0x3f800000u;
 let pixel=${inside ? 'prepared' : 'parent'}[id.x];
 masked[id.x]=vec4f(pixel.rgb,select(0.,pixel.a,${inside ? 'selected' : '!selected'}));
}`
}

const preparedHeadroomShader = `
struct Legacy{peak:f32,values:array<u32>}
struct Result{peak:atomic<u32>,values:array<u32>}
@group(0) @binding(0) var<storage,read> legacy:Legacy;
@group(0) @binding(1) var<storage,read> peaks:array<f32>;
@group(0) @binding(2) var<storage,read_write> result:Result;
@compute @workgroup_size(1) fn headroom(){
 let candidate=bitcast<f32>(atomicLoad(&result.peak));
 let peak=max(1.01,max(peaks[0],peaks[1]));
 atomicStore(&result.peak,bitcast<u32>(select(peak,1e30,legacy.peak>65504.||candidate>65504.)));
}`

const preparedPrimaryValidationShader = `
struct Params {values:array<vec4f,12>}
struct Result {peak:atomic<u32>,values:array<u32>}
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> parent:array<vec4f>;
@group(0) @binding(2) var<storage,read> prepared:array<vec4f>;
@group(0) @binding(3) var<storage,read> coverage:array<f32>;
@group(0) @binding(4) var<storage,read_write> result:Result;
@compute @workgroup_size(64) fn validatePrimary(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=u32(u.values[0].x)){return;}
 let a=parent[id.x];let b=prepared[id.x];let bits=bitcast<u32>(coverage[id.x]);
 if(any((bitcast<vec4u>(a)&vec4u(0x7f800000u))==vec4u(0x7f800000u))||
    any((bitcast<vec4u>(b)&vec4u(0x7f800000u))==vec4u(0x7f800000u))||
    bitcast<u32>(a.a)!=bitcast<u32>(b.a)||a.a<0.||a.a>1.||
    (bits&0x7fffffffu)>0x3f800000u||((bits&0x80000000u)!=0u&&bits!=0x80000000u)){
  atomicMax(&result.peak,bitcast<u32>(1e30));
 }
}`

/** Two fixed renditions use the same reference shader, with per-invocation table selection. */
export function exportShader(
  hdr: boolean,
  packed: boolean,
  workgroup = 64,
  deferred = false,
  creative = false,
  preserveAlpha = false,
  curves = false,
  masks = false,
  bases = false,
  preparedPoint = false,
) {
  const precision = /fn acesMath\(index:u32\)->vec2f\s*\{[^}]+\}/
  if (!precision.test(displayRenderingWgsl))
    throw new Error('Reference ACES precision lookup is unavailable.')
  const tableWords = ACES_DATA_BYTES / 16
  const rendering = displayRenderingWgsl
    .replace(precision, exportPrecisionWgsl)
    .replace(`array<vec4f,${tableWords}>`, `array<vec4f,${tableWords * 2}>`)
    .replaceAll('acesData.values[', 'acesData.values[acesOffset+')
  const channels = hdr ? 6 : 3
  const reduction = `workgroupBarrier();
 for(var step=${workgroup / 2}u;step>0u;step/=2u) {
  if(local<step) {peaks[local]=max(peaks[local],peaks[local+step]);}
  workgroupBarrier();
 }
 if(local==0u) {atomicMax(&result.peak,bitcast<u32>(peaks[0]));}`
  return `
var<private> acesOffset:i32;
${rendering}
struct Params { values:array<vec4f,12> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> input:array<vec4f>;
struct Result { peak:atomic<u32>, values:array<u32> }
@group(0) @binding(2) var<storage,read_write> result:Result;
${deferred ? '@group(0) @binding(5) var<storage,read_write> working:array<f32>;' : ''}
${hdrAdjustmentShader(creative, 12, 'acesPow', curves)}
${masks ? localMasksWgsl(16, bases ? 18 : undefined, 'acesPow') : ''}
${hdr && packed ? `var<workgroup> peaks:array<f32,${workgroup}>;` : ''}
${
  preserveAlpha && packed
    ? `
// Round the exact Float32 value to R8. Float32 multiplication can move a value
// just below a half-byte boundary onto it (for example Float32(0.7) * 255).
fn alphaByte(value:f32)->u32 {
 if(!(value>0.)){return 0u;}
 if(value>=1.){return 255u;}
 let bits=bitcast<u32>(value);
 let exponent=(bits>>23u)&255u;
 if(exponent<118u){return 0u;}
 let numerator=((bits&0x7fffffu)|0x800000u)*255u;
 let shift=150u-exponent;
 if(shift==32u){return select(0u,1u,numerator>=0x80000000u);}
 let remainder=numerator&((1u<<shift)-1u);
 return (numerator>>shift)+select(0u,1u,remainder>=(1u<<(shift-1u)));
}
`
    : ''
}
fn exportTarget(jmh:vec3f,linear:f32)->vec3f {
 let toned=Y_to_J(tonescale_fwd(linear,aces_ts()),aces_input_params());
 return JMh_to_RGB(gamut_compress_fwd(chroma_compress_fwd(jmh,toned)),aces_limit_params());
}
@compute @workgroup_size(${workgroup}) fn render(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32) {
 ${hdr && packed && !deferred ? 'peaks[local]=0.;' : ''}
 if(id.x<u32(u.values[0].x)) {
 let pixel=input[id.x];
 ${masks ? 'let absolute=u32(u.values[0].y)+id.x;let maskPoint=vec2f(f32(absolute%u32(maskData[5].y))+.5,f32(absolute/u32(maskData[5].y))+.5);' : ''}
 ${preparedPoint ? 'var consumedRgb=pixel.rgb;if(u.values[11].w<.5){' : ''}${masks ? 'var localEdited=applyLocalMasks(adjusted(pixel.rgb),maskPoint,1.,true);if(!localMaskFinite(localEdited)){atomicMax(&result.peak,bitcast<u32>(1e30));localEdited=vec3f(0.);}' : ''}${preparedPoint ? `consumedRgb=${masks ? 'localEdited' : 'adjusted(pixel.rgb)'};}` : ''}
 let aces=${inputMatrix}*${preparedPoint ? 'consumedRgb' : masks ? 'localEdited' : 'adjusted(pixel.rgb)'};
 acesOffset=0;
 let sdrInput=clamp_AP0_to_AP1(aces,0.,aces_ts().forward_limit);
 let jmh=RGB_to_JMh(sdrInput,aces_input_params());
 let linear=J_to_Y(jmh.x,aces_input_params())/ref_luminance;
 let sdr=clamp(exportTarget(jmh,linear),vec3f(0.),vec3f(1.))${preserveAlpha ? '' : '*pixel.a+vec3f(1.-pixel.a)'};
 ${
   hdr
     ? `acesOffset=${tableWords};
 let hdrInput=clamp_AP0_to_AP1(aces,0.,aces_ts().forward_limit);
 var hdrJmh=jmh;
 var hdrLinear=linear;
 if(any(hdrInput!=sdrInput)) {
  hdrJmh=RGB_to_JMh(hdrInput,aces_input_params());
  hdrLinear=J_to_Y(hdrJmh.x,aces_input_params())/ref_luminance;
 }
 ${
   deferred
     ? `let slot=(u32(u.values[0].y)+id.x)*5u;
 working[slot]=hdrJmh.x; working[slot+1u]=hdrJmh.y; working[slot+2u]=hdrJmh.z;
 working[slot+3u]=pixel.a; working[slot+4u]=hdrLinear;`
     : 'let hdr=clamp(exportTarget(hdrJmh,hdrLinear),vec3f(0.),vec3f(10.))*pixel.a+vec3f(1.-pixel.a);'
 }`
     : ''
 }
 ${
   packed
     ? `let rgb=vec3u(floor(clamp(encodeDisplayRgb(sdr),vec3f(0.),vec3f(1.))*255.+.5));
 result.values[id.x*${hdr && !deferred ? 3 : 1}u]=rgb.r | (rgb.g<<8u) | (rgb.b<<16u)${preserveAlpha ? ' | (alphaByte(pixel.a)<<24u)' : ''};
 ${hdr && !deferred ? 'result.values[id.x*3u+1u]=pack2x16float(hdr.rg); result.values[id.x*3u+2u]=pack2x16float(vec2f(hdr.b,1.)); peaks[local]=max(hdr.r,max(hdr.g,hdr.b));' : ''}`
     : `result.values[id.x*${channels}u]=bitcast<u32>(sdr.r);
 result.values[id.x*${channels}u+1u]=bitcast<u32>(sdr.g);
 result.values[id.x*${channels}u+2u]=bitcast<u32>(sdr.b);
 ${hdr ? 'result.values[id.x*6u+3u]=bitcast<u32>(hdr.r); result.values[id.x*6u+4u]=bitcast<u32>(hdr.g); result.values[id.x*6u+5u]=bitcast<u32>(hdr.b);' : ''}`
 }
 }
 ${hdr && packed && !deferred ? reduction : ''}
}
${
  deferred
    ? `@compute @workgroup_size(${workgroup}) fn renderHdr(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) local:u32) {
 peaks[local]=0.;
 if(id.x<u32(u.values[0].x)) {
  let slot=(u32(u.values[0].y)+id.x)*5u;
  acesOffset=${tableWords};
  let jmh=vec3f(working[slot],working[slot+1u],working[slot+2u]);
  let alpha=working[slot+3u];
  let hdr=clamp(exportTarget(jmh,working[slot+4u]),vec3f(0.),vec3f(10.))*alpha+vec3f(1.-alpha);
  result.values[id.x*3u+1u]=pack2x16float(hdr.rg);
  result.values[id.x*3u+2u]=pack2x16float(vec2f(hdr.b,1.));
  peaks[local]=max(hdr.r,max(hdr.g,hdr.b));
 }
 ${reduction}
}`
    : ''
}
`
}

/** Bounded native Dawn compute in the export Node worker; never creates an Electron surface. */
export async function createPointGpu(
  capacity: number,
  adjustments: AdjustmentParameters,
  whiteBalance: readonly number[] | undefined,
  hdr: boolean,
  packed: boolean,
  workgroup = 64,
  deferredPixels = 0,
  vramLimitBytes = EXPORT_GPU_LIMIT_BYTES,
  options: PointRenderOptions & NativeMaskEdgeOptions = { domain: 'scene-linear' },
  makeRenderer: () => Pick<RawGpuRenderer, 'mergeDevice' | 'close'> &
    Partial<Pick<RawGpuRenderer, 'failure'>> = () => new RawGpuRenderer(),
) {
  if (process.versions.electron) throw new Error('GPU export requires the isolated Node worker.')
  if (![32, 64, 128, 256].includes(workgroup)) throw new Error('Invalid export workgroup size.')
  if (!Number.isSafeInteger(deferredPixels) || deferredPixels < 0)
    throw new Error('Invalid retained export dimensions.')
  // AbortSignal belongs to this process; only serializable rendering settings are cloned.
  const { signal: suppliedSignal, edgeAdmission, ...renderOptions } = options
  const signal = suppliedSignal ?? new AbortController().signal
  signal.throwIfAborted()
  options = structuredClone(renderOptions)
  if (
    !['scene-linear', 'raster', 'authored-hdr'].includes(options.domain) ||
    (options.primary && options.domain !== 'authored-hdr') ||
    (hdr && options.domain === 'raster')
  )
    throw new Error('Invalid point rendering domain.')
  if (
    (options.preparedPoint !== undefined && typeof options.preparedPoint !== 'boolean') ||
    (options.preparedPoint && (deferredPixels !== 0 || (hdr && options.preserveAlpha)))
  )
    throw new Error(
      'Prepared point consumption requires independent native strips and composited HDR output.',
    )
  const authored = options.domain !== 'scene-linear',
    transform = options.transform ?? srgbTransform
  if (
    ![transform.white, transform.threshold, transform.offset].every(Number.isFinite) ||
    transform.white <= 0 ||
    transform.threshold <= 0 ||
    transform.offset < 0 ||
    typeof transform.quantize !== 'boolean'
  )
    throw new Error('Invalid authored output transform.')
  if (authored) deferredPixels = 0
  adjustments = pointOnlyMaskAdjustments(structuredClone(adjustments))
  whiteBalance = whiteBalance ? [...whiteBalance] : undefined
  const color = prepareCreativeColor(adjustments),
    creative = creativeColorActive(color),
    compiledCurves = preparedToneCurves(adjustments.curves),
    curves = !compiledCurves.identity
  const masks = hasLocalMasks(adjustments)
  const maskSize = adjustments.maskGeometry
    ? maskOutputSize(adjustments.maskGeometry)
    : options.maskSize
  if (masks && !maskSize) throw new Error('Local edits require authoritative source geometry.')
  const pointPlan = (parameters: AdjustmentParameters) => {
    const maskData = masks ? packLocalMasks(parameters, maskSize!) : undefined
    const basePlan = maskBaseAtlasPlan(masks ? parameters : { localMasks: [] }),
      bases = masks && basePlan.bases.length > 0
    const allocation = exportGpuAllocation(
      capacity,
      hdr,
      packed,
      creative,
      deferredPixels,
      vramLimitBytes,
      !!options.primary,
      curves,
      (maskData?.byteLength ?? 0) +
        (bases ? basePlan.bytes : 0) +
        (options.preparedPoint
          ? preparedPointAllocationBytes(capacity, packed, hdr, !!options.primary)
          : 0),
    )
    if (!allocation.accepted)
      throw new ExportResourceError('GPU export exceeds the frozen managed image budgets.')
    return { maskData, basePlan, bases, allocation }
  }
  // The neutral path retains refusal before acquiring a GPU owner.
  let planned =
    masks && activeNativeMaskEdges(adjustments).length ? undefined : pointPlan(adjustments)
  const gpu = makeRenderer(),
    resources: GPUBuffer[] = []
  let queue: GPUQueue | undefined,
    baseTexture: GPUTexture | undefined,
    pending: Promise<{ data: Buffer; headroom: number }> | undefined,
    closing = false,
    drained: Promise<void> | undefined
  let edgePeakBytes = 0
  const close = () =>
    (drained ??= (async () => {
      closing = true
      await pending?.catch(() => undefined)
      await queue?.onSubmittedWorkDone().catch(() => undefined)
      for (const buffer of resources) buffer.destroy()
      baseTexture?.destroy()
      gpu.close()
    })())
  try {
    const { device, adapter } = await gpu.mergeDevice()
    // A borrowed device may have been lost while its async owner resolved.
    // Never enter native Dawn again through a terminal owner's returned handle.
    if (gpu.failure) throw new Error(gpu.failure)
    queue = device.queue
    if (!planned) {
      const size = adjustments.maskGeometry
        ? {
            width: adjustments.maskGeometry.canonicalWidth,
            height: adjustments.maskGeometry.canonicalHeight,
          }
        : maskSize!
      const prepared = await prepareNativeMaskEdges(
        device,
        adjustments,
        size.width,
        size.height,
        vramLimitBytes,
        { signal, edgeAdmission },
      )
      adjustments = prepared.adjustments
      edgePeakBytes = prepared.peakBytes
      // Edge scratch is drained and destroyed before the point-render allocations below.
      planned = pointPlan(adjustments)
    }
    signal.throwIfAborted()
    const { maskData, basePlan, bases, allocation } = planned
    if (bases) baseTexture = await createMaskBaseAtlas(device, adjustments)
    const stride = packed ? (hdr ? 3 : 1) : hdr ? 6 : 3
    const buffer = (size: number, usage: number) => {
      if (size > device.limits.maxBufferSize || size > device.limits.maxStorageBufferBindingSize)
        throw new Error('Export tile exceeds the GPU allocation limit.')
      if (usage & GPUBufferUsage.UNIFORM && size > device.limits.maxUniformBufferBindingSize)
        throw new Error('Export uniforms exceed the GPU allocation limit.')
      if (resources.reduce((sum, buffer) => sum + buffer.size, size) > allocation.limitBytes)
        throw new ExportResourceError('GPU export exceeds the frozen managed image budgets.')
      const value = device.createBuffer({ size, usage })
      resources.push(value)
      return value
    }
    const uniform = buffer(192, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      input = buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      output = buffer(
        4 + capacity * stride * 4,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      ),
      staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      tables = buffer(ACES_DATA_BYTES * 2, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      math = buffer(
        exportPrecisionData.byteLength,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      )
    device.queue.writeBuffer(math, 0, exportPrecisionData)
    const primary = options.primary
      ? buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      : undefined
    const preparedInput = options.preparedPoint
        ? buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        : undefined,
      preparedUnion = options.preparedPoint
        ? buffer(capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        : undefined,
      legacyOutput = options.preparedPoint
        ? buffer(output.size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        : undefined
    const preparedPrimary =
        options.preparedPoint && primary
          ? buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
          : undefined,
      primaryUnion = preparedPrimary
        ? buffer(capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        : undefined,
      peakInput =
        options.preparedPoint && hdr && packed
          ? buffer(capacity * 16, GPUBufferUsage.STORAGE)
          : undefined,
      peakOutput = peakInput
        ? buffer(
            output.size,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          )
        : undefined,
      peakHeaders = peakInput
        ? buffer(8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
        : undefined
    const colorData = creative
      ? buffer(CREATIVE_COLOR_PARAMETER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      : undefined
    if (colorData) device.queue.writeBuffer(colorData, 0, packCreativeColor(color!))
    const curveData = curves
      ? buffer(TONE_CURVE_PARAMETER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      : undefined
    if (curveData) device.queue.writeBuffer(curveData, 0, packToneCurves(compiledCurves))
    const maskBuffer = maskData
      ? buffer(maskData.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
      : undefined
    if (maskBuffer) device.queue.writeBuffer(maskBuffer, 0, maskData!)
    const workingBytes = deferredPixels * 20
    const hdrDeferred = !!(
      hdr &&
      packed &&
      deferredPixels &&
      workingBytes <= device.limits.maxBufferSize &&
      workingBytes <= device.limits.maxStorageBufferBindingSize &&
      allocation.deferredBytes > 0
    )
    const working = hdrDeferred ? buffer(workingBytes, GPUBufferUsage.STORAGE) : undefined
    const sdrParameters = prepareDisplayRendering(SDR_TARGET),
      hdrParameters = prepareDisplayRendering(HDR_CONTENT_TARGET)
    // Only the AP0 input stage is shared. Distinct forward limits still clamp independently.
    if (JSON.stringify(sdrParameters.input_params) !== JSON.stringify(hdrParameters.input_params))
      throw new Error('Export ACES input parameters cannot be shared.')
    device.queue.writeBuffer(tables, 0, packAces(sdrParameters))
    device.queue.writeBuffer(tables, ACES_DATA_BYTES, packAces(hdrParameters))
    const values = new Float32Array(48)
    values.set(
      [transform.white, transform.threshold, transform.offset, Number(transform.quantize)],
      32,
    )
    values.set(
      [adjustments.exposureEv, adjustments.contrast, adjustments.highlights, adjustments.shadows],
      8,
    )
    values.set([adjustments.whites, adjustments.blacks], 12)
    values.set([adjustments.saturation, adjustments.vibrance], 44)
    if (whiteBalance) {
      values[19] = 1
      for (let row = 0; row < 3; row++)
        values.set(whiteBalance.slice(row * 3, row * 3 + 3), 20 + row * 4)
    }
    const module = device.createShaderModule({
      code: authored
        ? authoredOutputShader(
            hdr,
            packed,
            creative,
            { ...options, preparedPoint: false },
            workgroup,
            curves,
            masks,
            bases,
          )
        : exportShader(
            hdr,
            packed,
            workgroup,
            hdrDeferred,
            creative,
            options.preserveAlpha,
            curves,
            masks,
            bases,
          ),
    })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length)
      throw new Error(errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'render' },
    })
    const commonEntries = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 2, resource: { buffer: output } },
      ...(!authored
        ? [
            { binding: 3, resource: { buffer: math } },
            { binding: 4, resource: { buffer: tables } },
          ]
        : []),
      ...(working ? [{ binding: 5, resource: { buffer: working } }] : []),
    ]
    const pointEntries: GPUBindGroupEntry[] = [
      ...commonEntries,
      { binding: 1, resource: { buffer: input } },
      ...(primary ? [{ binding: 6, resource: { buffer: primary } }] : []),
      ...(colorData && (!authored || options.domain === 'raster' || primary)
        ? [{ binding: 12, resource: { buffer: colorData } }]
        : []),
      ...(colorData && options.domain === 'authored-hdr'
        ? [{ binding: 13, resource: { buffer: colorData } }]
        : []),
      ...(curveData && (!authored || options.domain === 'raster' || primary)
        ? [{ binding: 14, resource: { buffer: curveData } }]
        : []),
      ...(curveData && options.domain === 'authored-hdr'
        ? [{ binding: 15, resource: { buffer: curveData } }]
        : []),
      ...(maskBuffer ? [{ binding: 16, resource: { buffer: maskBuffer } }] : []),
      ...(baseTexture
        ? [{ binding: 18, resource: baseTexture.createView({ dimension: '2d-array' }) }]
        : []),
    ]
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: pointEntries,
    })
    let consumedPipeline: GPUComputePipeline | undefined,
      consumedGroup: GPUBindGroup | undefined,
      selectionPipeline: GPUComputePipeline | undefined,
      selectionGroup: GPUBindGroup | undefined,
      primaryValidation: { pipeline: GPUComputePipeline; group: GPUBindGroup } | undefined,
      peakLegacy:
        { prepare: GPUComputePipeline; group: GPUBindGroup; render: GPUBindGroup } | undefined,
      peakCandidate:
        { prepare: GPUComputePipeline; group: GPUBindGroup; render: GPUBindGroup } | undefined,
      headroomProgram: { pipeline: GPUComputePipeline; group: GPUBindGroup } | undefined
    if (preparedInput && preparedUnion && legacyOutput) {
      device.pushErrorScope('validation')
      const consumedModule = device.createShaderModule({
        code: authored
          ? authoredOutputShader(hdr, packed, creative, options, workgroup, curves, masks, bases)
          : exportShader(
              hdr,
              packed,
              workgroup,
              false,
              creative,
              options.preserveAlpha,
              curves,
              masks,
              bases,
              true,
            ),
      })
      const selectionModule = device.createShaderModule({
        code: preparedSelectionShader(stride, packed, workgroup, !!primaryUnion, hdr),
      })
      for (const module of [consumedModule, selectionModule]) {
        const errors = (await module.getCompilationInfo()).messages.filter(
          (m) => m.type === 'error',
        )
        if (errors.length)
          throw new Error(errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'))
      }
      consumedPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: consumedModule, entryPoint: 'render' },
      })
      consumedGroup = device.createBindGroup({
        layout: consumedPipeline.getBindGroupLayout(0),
        entries: pointEntries.map((entry) =>
          entry.binding === 1
            ? { binding: 1, resource: { buffer: preparedInput } }
            : entry.binding === 6 && preparedPrimary
              ? { binding: 6, resource: { buffer: preparedPrimary } }
              : entry,
        ),
      })
      selectionPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: selectionModule, entryPoint: 'selectPrepared' },
      })
      selectionGroup = device.createBindGroup({
        layout: selectionPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: input } },
          { binding: 2, resource: { buffer: preparedInput } },
          { binding: 3, resource: { buffer: preparedUnion } },
          { binding: 4, resource: { buffer: legacyOutput } },
          { binding: 5, resource: { buffer: output } },
          ...(primaryUnion ? [{ binding: 6, resource: { buffer: primaryUnion } }] : []),
        ],
      })
      const compilePrepared = async (code: string, entryPoint: string) => {
        const module = device.createShaderModule({ code })
        const errors = (await module.getCompilationInfo()).messages.filter(
          (m) => m.type === 'error',
        )
        if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'))
        return device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint },
        })
      }
      if (primary && preparedPrimary && primaryUnion) {
        const pipeline = await compilePrepared(preparedPrimaryValidationShader, 'validatePrimary')
        primaryValidation = {
          pipeline,
          group: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: primary } },
              { binding: 2, resource: { buffer: preparedPrimary } },
              { binding: 3, resource: { buffer: primaryUnion } },
              { binding: 4, resource: { buffer: output } },
            ],
          }),
        }
      }
      if (peakInput && peakOutput && peakHeaders) {
        for (const inside of [false, true]) {
          const prepare = await compilePrepared(preparedPeakShader(inside), 'preparePeak')
          const group = device.createBindGroup({
            layout: prepare.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: input } },
              ...(inside ? [{ binding: 2, resource: { buffer: preparedInput } }] : []),
              { binding: 3, resource: { buffer: preparedUnion } },
              { binding: 4, resource: { buffer: peakInput } },
            ],
          })
          const render = device.createBindGroup({
            layout: (inside ? consumedPipeline : pipeline).getBindGroupLayout(0),
            entries: pointEntries.map((entry) =>
              entry.binding === 1
                ? { binding: 1, resource: { buffer: peakInput } }
                : entry.binding === 2
                  ? { binding: 2, resource: { buffer: peakOutput } }
                  : inside && entry.binding === 6 && preparedPrimary
                    ? { binding: 6, resource: { buffer: preparedPrimary } }
                    : entry,
            ),
          })
          if (inside) peakCandidate = { prepare, group, render }
          else peakLegacy = { prepare, group, render }
        }
        const program = await compilePrepared(preparedHeadroomShader, 'headroom')
        headroomProgram = {
          pipeline: program,
          group: device.createBindGroup({
            layout: program.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: legacyOutput } },
              { binding: 1, resource: { buffer: peakHeaders } },
              { binding: 2, resource: { buffer: output } },
            ],
          }),
        }
      }
      const preparedValidation = await device.popErrorScope()
      if (preparedValidation)
        throw new Error(`Prepared point pipeline validation failed: ${preparedValidation.message}`)
    }
    const hdrPipeline = hdrDeferred
      ? await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'renderHdr' },
        })
      : undefined
    const hdrGroup = hdrPipeline
      ? device.createBindGroup({
          layout: hdrPipeline.getBindGroupLayout(0),
          entries: commonEntries,
        })
      : undefined
    const dispatch = async (
      pixels: Float32Array<ArrayBuffer> | undefined,
      offset: number,
      count: number,
      hdrPass = false,
      primaryPixels?: Float32Array<ArrayBuffer>,
    ) => {
      signal.throwIfAborted()
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > capacity ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (hdrDeferred && offset + count > deferredPixels) ||
        Math.ceil(count / workgroup) > device.limits.maxComputeWorkgroupsPerDimension
      )
        throw new Error('Invalid export tile length.')
      if (hdrPass && !hdrPipeline) throw new Error('HDR rendering was not deferred.')
      if (!hdrPass && primary && (!primaryPixels || primaryPixels.length !== count * 4))
        throw new Error('The authored SDR primary must match its HDR strip.')
      values[0] = count
      values[1] = offset
      device.queue.writeBuffer(uniform, 0, values)
      if (pixels) device.queue.writeBuffer(input, 0, pixels)
      if (primary && primaryPixels) device.queue.writeBuffer(primary, 0, primaryPixels)
      device.queue.writeBuffer(output, 0, new Float32Array([1.01]))
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass()
      pass.setPipeline(hdrPass ? hdrPipeline! : pipeline)
      pass.setBindGroup(0, hdrPass ? hdrGroup! : group)
      pass.dispatchWorkgroups(Math.ceil(count / workgroup))
      pass.end()
      const outputStride = hdrDeferred && !hdrPass ? 1 : stride
      encoder.copyBufferToBuffer(output, 0, staging, 0, 4 + count * outputStride * 4)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        signal.throwIfAborted()
        const mapped = staging.getMappedRange()
        const data = Buffer.from(new Uint8Array(mapped, 4, count * outputStride * 4))
        const headroom = new Float32Array(mapped, 0, 1)[0]
        if (!Number.isFinite(headroom) || headroom > 65504)
          throw new Error(
            masks
              ? 'Local adjustment processing produced non-finite pixels. Reduce the local adjustments.'
              : 'Invalid GPU output pixels.',
          )
        return { data, headroom }
      } finally {
        staging.unmap()
      }
    }
    const run = (
      pixels: Float32Array<ArrayBuffer> | undefined,
      offset: number,
      count: number,
      hdrPass = false,
      primaryPixels?: Float32Array<ArrayBuffer>,
    ) => {
      if (closing) return Promise.reject(new Error('The export GPU owner is closed.'))
      if (pending) return Promise.reject(new Error('The export GPU owner is busy.'))
      const work = dispatch(pixels, offset, count, hdrPass, primaryPixels)
      pending = work
      void work
        .finally(() => {
          if (pending === work) pending = undefined
        })
        .catch(() => undefined)
      return work
    }
    const dispatchPrepared = async (
      pixels: Float32Array<ArrayBuffer>,
      preparedPixels: Float32Array<ArrayBuffer>,
      union: Float32Array<ArrayBuffer>,
      offset: number,
      primaryPixels?: {
        legacy: Float32Array<ArrayBuffer>
        prepared: Float32Array<ArrayBuffer>
        union: Float32Array<ArrayBuffer>
      },
    ) => {
      signal.throwIfAborted()
      const count = pixels.length / 4
      if (
        !consumedPipeline ||
        !consumedGroup ||
        !selectionPipeline ||
        !selectionGroup ||
        !preparedInput ||
        !preparedUnion ||
        !legacyOutput
      )
        throw new Error('Prepared point consumption was not admitted for this GPU owner.')
      if (
        !(pixels instanceof Float32Array) ||
        !(preparedPixels instanceof Float32Array) ||
        !(union instanceof Float32Array) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > capacity ||
        preparedPixels.length !== pixels.length ||
        union.length !== count ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        Math.ceil(count / workgroup) > device.limits.maxComputeWorkgroupsPerDimension
      )
        throw new Error('Invalid prepared point tile.')
      if (
        primary &&
        (!primaryPixels ||
          primaryPixels.legacy.length !== pixels.length ||
          primaryPixels.prepared.length !== pixels.length ||
          primaryPixels.union.length !== count)
      )
        throw new Error('Prepared authored SDR primary must match its HDR strip.')
      values[0] = count
      values[1] = offset
      // The unchanged legacy shader does not read this previously unused lane.
      values[47] = 1
      device.queue.writeBuffer(uniform, 0, values)
      device.queue.writeBuffer(input, 0, pixels)
      device.queue.writeBuffer(preparedInput, 0, preparedPixels)
      device.queue.writeBuffer(preparedUnion, 0, union)
      if (primary && preparedPrimary && primaryUnion && primaryPixels) {
        device.queue.writeBuffer(primary, 0, primaryPixels.legacy)
        device.queue.writeBuffer(preparedPrimary, 0, primaryPixels.prepared)
        device.queue.writeBuffer(primaryUnion, 0, primaryPixels.union)
      }
      device.queue.writeBuffer(output, 0, new Float32Array([1.01]))
      const encoder = device.createCommandEncoder()
      const pass = (
        pipeline: GPUComputePipeline,
        group: GPUBindGroup,
        dispatch = Math.ceil(count / workgroup),
      ) => {
        const pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(dispatch)
        pass.end()
      }
      pass(pipeline, group)
      encoder.copyBufferToBuffer(output, 0, legacyOutput, 0, 4 + count * stride * 4)
      pass(consumedPipeline, consumedGroup)
      if (peakLegacy && peakCandidate && peakOutput && peakHeaders && headroomProgram) {
        encoder.clearBuffer(peakOutput, 0, 4)
        pass(peakLegacy.prepare, peakLegacy.group, Math.ceil(count / 64))
        pass(pipeline, peakLegacy.render)
        encoder.copyBufferToBuffer(peakOutput, 0, peakHeaders, 0, 4)
        encoder.clearBuffer(peakOutput, 0, 4)
        pass(peakCandidate.prepare, peakCandidate.group, Math.ceil(count / 64))
        pass(consumedPipeline, peakCandidate.render)
        encoder.copyBufferToBuffer(peakOutput, 0, peakHeaders, 4, 4)
        pass(headroomProgram.pipeline, headroomProgram.group, 1)
      }
      if (primaryValidation)
        pass(primaryValidation.pipeline, primaryValidation.group, Math.ceil(count / 64))
      pass(selectionPipeline, selectionGroup)
      encoder.copyBufferToBuffer(output, 0, staging, 0, 4 + count * stride * 4)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(GPUMapMode.READ)
      try {
        signal.throwIfAborted()
        const mapped = staging.getMappedRange(),
          headroom = new Float32Array(mapped, 0, 1)[0]
        if (!Number.isFinite(headroom) || headroom > 65504)
          throw new Error('Invalid prepared point pixels, coverage or alpha.')
        return {
          data: Buffer.from(new Uint8Array(mapped, 4, count * stride * 4)),
          headroom,
        }
      } finally {
        staging.unmap()
      }
    }
    const renderPrepared = (
      pixels: Float32Array<ArrayBuffer>,
      preparedPixels: Float32Array<ArrayBuffer>,
      union: Float32Array<ArrayBuffer>,
      offset = 0,
      primaryPixels?: {
        legacy: Float32Array<ArrayBuffer>
        prepared: Float32Array<ArrayBuffer>
        union: Float32Array<ArrayBuffer>
      },
    ) => {
      if (closing) return Promise.reject(new Error('The export GPU owner is closed.'))
      if (pending) return Promise.reject(new Error('The export GPU owner is busy.'))
      const work = dispatchPrepared(pixels, preparedPixels, union, offset, primaryPixels)
      pending = work
      void work
        .finally(() => {
          if (pending === work) pending = undefined
        })
        .catch(() => undefined)
      return work
    }
    return {
      adapter,
      hdrDeferred,
      peakBytes: Math.max(
        edgePeakBytes,
        resources.reduce((sum, b) => sum + b.size, 0) + (bases ? basePlan.bytes : 0),
      ),
      render(
        pixels: Float32Array<ArrayBuffer>,
        offset = 0,
        primaryPixels?: Float32Array<ArrayBuffer>,
      ) {
        if (options.preparedPoint)
          return Promise.reject(
            new Error('Prepared point owners require explicit paired consumption.'),
          )
        return run(pixels, offset, pixels.length / 4, false, primaryPixels)
      },
      ...(options.preparedPoint ? { renderPrepared } : {}),
      finishHdr(offset: number, count: number) {
        return run(undefined, offset, count, true)
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
