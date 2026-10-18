import { GPU_REFERENCE_PREPARATION, MERGE_LIMITS } from '../../shared/merge'
import { REC2020_LUMA, SRGB_TO_2020 } from '../../shared/hdr'
import type { LinearFrame } from '../processing/contracts'
import { radial, type CorrectionPlan } from '../processing/lens-correction'
import type { CpuKernelMeasurement } from './cpu-kernels'
import {
  createFallbackGeometryProvider,
  FALLBACK_GEOMETRY_PIXEL_WORDS,
  type FallbackGeometryProvider,
  type FallbackGeometryStrip,
} from './fallback-geometry'

const STRIP_ROWS = 64
const UNIFORM_BYTES = 304
const LUT_BYTES = 4096 * 16
const MAX_UPLOAD_BYTES = 8 * 1024 ** 2
const MAX_GPU_BYTES = 1024 ** 3
const FLOAT32_UNIT = 2 ** -24
const FLOAT32_MIN_NORMAL = 2 ** -126

function layout(rawWidth: number, rawHeight: number, width: number, height: number) {
  if (
    ![rawWidth, rawHeight, width, height].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    rawWidth * rawHeight > 24_000_000 ||
    width * height > 24_000_000
  )
    throw new Error('Unsupported GPU reference fallback dimensions.')
  const rowBytes = Math.ceil((rawWidth * 16) / 256) * 256,
    layerRows = Math.min(STRIP_ROWS, rawHeight, Math.floor(MAX_UPLOAD_BYTES / rowBytes)),
    layers = Math.ceil(rawHeight / layerRows),
    uploadBytes = rowBytes * layerRows,
    sourceBytes = rawWidth * layerRows * layers * 16,
    capacity = width * Math.min(STRIP_ROWS, height),
    geometryBytes = capacity * FALLBACK_GEOMETRY_PIXEL_WORDS * 4,
    resultBytes = capacity * 32,
    allocatedGpuBytes =
      UNIFORM_BYTES + LUT_BYTES + uploadBytes + sourceBytes + geometryBytes + resultBytes * 2
  if (
    ![
      layerRows,
      layers,
      uploadBytes,
      sourceBytes,
      capacity,
      geometryBytes,
      resultBytes,
      allocatedGpuBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new Error('Unsupported GPU reference fallback allocation.')
  return {
    rowBytes,
    layerRows,
    layers,
    uploadBytes,
    sourceBytes,
    capacity,
    geometryBytes,
    resultBytes,
    allocatedGpuBytes,
  }
}

/** Logical ownership includes source padding, bounded upload staging and readback. */
export function gpuReferenceFallbackBytes(
  rawWidth: number,
  rawHeight: number,
  outputWidth: number,
  outputHeight: number,
): number {
  return layout(rawWidth, rawHeight, outputWidth, outputHeight).allocatedGpuBytes
}

export interface GpuReferenceFallbackCheckpoint {
  phase: 'allocated' | 'uploaded-source' | 'uploaded-geometry' | 'submitted' | 'readback'
  top?: number
  rows?: number
}

export interface GpuReferenceFallbackOptions {
  signal?: AbortSignal
  /** Caller-owned live resources must be subtracted before supplying this budget. */
  availableBytes?: number
  /** Internal live ownership diagnostics, including failed constructor cleanup. */
  observeMetrics?: (metrics: GpuReferenceFallbackMetrics) => void
  /** Internal lifecycle/corruption probes; never exposed through the app bridge. */
  hooks?: {
    checkpoint?: (event: GpuReferenceFallbackCheckpoint) => void | Promise<void>
    /** Eight floats per pixel: RGB high, repair flag, RGB low, luma error bound. */
    readback?: (top: number, values: Float32Array<ArrayBuffer>) => void
  }
}

export interface GpuReferenceFallbackMetrics {
  backend: 'gpu'
  policy: typeof GPU_REFERENCE_PREPARATION
  allocatedGpuBytes: number
  setupMs: number
  uploadMs: number
  geometryMs: number
  conversionMs: number
  readbackMs: number
  verificationMs: number
  closingMs: number
  runtimeMs: number
  batches: number
  prefetchedStrips: number
  discardedPrefetches: number
  inputBytes: number
  geometryBytes: number
  outputBytes: number
  scalarRepairs: number
  thresholdRepairs: number
  conditionRepairs: number
}

const shader = `
struct Params {
  size:vec4u, lens:vec4f, tuning:vec4f,
  wbHi:array<vec4f,2>, wbLo:array<vec4f,2>,
  cameraHi:array<vec4f,3>, cameraLo:array<vec4f,3>,
  workingHi:array<vec4f,3>, workingLo:array<vec4f,3>
}
struct Output { high:vec4f, low:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var source:texture_2d_array<f32>;
@group(0) @binding(2) var<storage,read> geometry:array<u32>;
@group(0) @binding(3) var<storage,read> lut:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> output:array<Output>;

// Explicit rounding barriers follow the maintained ACES compensated primitives.
// Native agreement is still required: WGSL's inherited FMA accuracy does not
// establish portable error-free multiplication or a backend-independent proof.
fn rounded(v:f32)->f32 {let p=frexp(v);return ldexp(p.fract,p.exp);}
fn twoSum(a:f32,b:f32)->vec2f {
  let s=rounded(a+b);let z=rounded(s-a);
  return vec2f(s,rounded(rounded(a-rounded(s-z))+rounded(b-z)));
}
fn add(a:vec2f,b:vec2f)->vec2f {
  let s=twoSum(a.x,b.x);
  return twoSum(s.x,rounded(rounded(s.y+a.y)+b.y));
}
fn multiply(a:vec2f,b:vec2f)->vec2f {
  let p=rounded(a.x*b.x);
  let e=rounded(fma(a.x,b.x,-p));
  let cross=rounded(rounded(a.x*b.y)+rounded(a.y*b.x));
  return twoSum(p,rounded(rounded(e+cross)+rounded(a.y*b.y)));
}
fn divide(a:vec2f,b:vec2f)->vec2f {
  let q=rounded(a.x/b.x);
  let remainder=add(a,-multiply(b,vec2f(q,0.)));
  return twoSum(q,rounded(rounded(remainder.x+remainder.y)/b.x));
}
fn finite(v:f32)->bool {return (bitcast<u32>(v)&0x7f800000u)!=0x7f800000u;}
fn value(v:vec2f)->f32 {return rounded(v.x+v.y);}
fn wb(index:u32)->vec2f {return vec2f(u.wbHi[index>>2u][index&3u],u.wbLo[index>>2u][index&3u]);}
fn tapLength(delta:vec2f)->vec2f {
  if(all(delta==vec2f(0.))) {return vec2f(0.);}
  let squared=add(multiply(vec2f(delta.x,0.),vec2f(delta.x,0.)),
    multiply(vec2f(delta.y,0.),vec2f(delta.y,0.)));
  let root=rounded(sqrt(squared.x));
  let remainder=add(squared,-multiply(vec2f(root,0.),vec2f(root,0.)));
  // A compensated Newton correction makes the initial normal sqrt error
  // second order, retaining the low component through radius division.
  return add(vec2f(root,0.),divide(remainder,vec2f(rounded(2.*root),0.)));
}
fn gainAt(position:vec2i)->vec2f {
  if(u.tuning.x>=0.) {return vec2f(u.tuning.x,0.);}
  let delta=vec2f(position)-u.lens.xy;
  let radius=divide(tapLength(delta),vec2f(u.lens.z,u.tuning.z));
  var p=multiply(radius,vec2f(4095.,0.));
  if(p.x<0. || (p.x==0. && p.y<0.)) {p=vec2f(0.);}
  if(p.x>4095. || (p.x==4095. && p.y>0.)) {p=vec2f(4095.,0.);}
  var base=i32(floor(p.x));
  // An integral high component with negative low lies in the preceding cell.
  if(p.x==f32(base) && p.y<0.) {base-=1;}
  let i=u32(clamp(base,0,4094));
  let f=add(p,-vec2f(f32(i),0.));
  // Preserve the original two weighted products and addition, rather than
  // combining the LUT slope or discarding the low fraction at a segment edge.
  return add(multiply(vec2f(lut[i].w,0.),add(vec2f(1.,0.),-f)),
    multiply(vec2f(lut[i+1u].w,0.),f));
}
struct Sample { pair:vec2f, error:f32, invalid:bool }
fn sampleChannel(pixel:u32,channel:u32)->Sample {
  let at=pixel*18u+channel*6u;
  let base=vec2i(bitcast<i32>(geometry[at]),bitcast<i32>(geometry[at+1u]));
  let dx=vec2f(bitcast<f32>(geometry[at+2u]),bitcast<f32>(geometry[at+3u]));
  let dy=vec2f(bitcast<f32>(geometry[at+4u]),bitcast<f32>(geometry[at+5u]));
  let layerRows=i32(textureDimensions(source).y);
  var sum=vec2f(0.);var magnitude=0.;var error=0.;var invalid=false;
  for(var yy=0;yy<2;yy++) {
    for(var xx=0;xx<2;xx++) {
      let xw=select(add(vec2f(1.,0.),-dx),dx,xx==1);
      let yw=select(add(vec2f(1.,0.),-dy),dy,yy==1);
      let weight=multiply(xw,yw);
      let p=clamp(base+vec2i(xx,yy),vec2i(0),vec2i(u.size.xy)-vec2i(1));
      let input=textureLoad(source,vec2i(p.x,p.y%layerRows),p.y/layerRows,0)[channel];
      let gain=gainAt(p);
      invalid=invalid || !finite(input) || !finite(gain.x) || !finite(gain.y) || !finite(dx.x) || !finite(dx.y) || !finite(dy.x) || !finite(dy.y);
      let weighted=multiply(multiply(vec2f(input,0.),weight),gain);
      sum=add(sum,weighted);
      let scale=abs(input)*max(0.,value(weight));
      error+=scale*u.lens.w;
      magnitude+=scale*abs(value(gain));
    }
  }
  let normalized=divide(multiply(divide(multiply(sum,wb(0u)),wb(2u+channel)),wb(5u+channel)),wb(1u));
  let scale=abs((value(wb(0u))/value(wb(2u+channel)))*value(wb(5u+channel))/value(wb(1u)));
  // Covers split fraction/coefficient residuals, ordered Float64 reference
  // rounding, compensated arithmetic and conservative underflow allowance.
  error=2.*scale*(error+u.tuning.y*magnitude+1e-30)+u.tuning.y*abs(value(normalized))+1e-30;
  return Sample(normalized,error,invalid || !finite(error));
}
struct Color { pairs:array<vec2f,3>, errors:vec3f }
fn transform(input:Color,hi:array<vec4f,3>,lo:array<vec4f,3>)->Color {
  var result:Color;
  for(var row=0u;row<3u;row++) {
    let a=multiply(vec2f(hi[row].x,lo[row].x),input.pairs[0]);
    let b=multiply(vec2f(hi[row].y,lo[row].y),input.pairs[1]);
    let c=multiply(vec2f(hi[row].z,lo[row].z),input.pairs[2]);
    result.pairs[row]=add(add(a,b),c);
    let magnitude=abs(value(a))+abs(value(b))+abs(value(c));
    result.errors[row]=2.*dot(abs(hi[row].xyz)+abs(lo[row].xyz),input.errors)+u.tuning.y*magnitude+1e-30;
  }
  return result;
}
@compute @workgroup_size(128) fn convert(@builtin(global_invocation_id) invocation:vec3u) {
  let pixel=invocation.x;if(pixel>=u.size.w) {return;}
  let red=sampleChannel(pixel,0u);let green=sampleChannel(pixel,1u);let blue=sampleChannel(pixel,2u);
  var camera:Color;
  camera.pairs[0]=red.pair;camera.pairs[1]=green.pair;camera.pairs[2]=blue.pair;
  camera.errors=vec3f(red.error,green.error,blue.error);
  // These remain two separate, left-associated matrices, matching the CPU.
  let linear=transform(camera,u.cameraHi,u.cameraLo);
  let working=transform(linear,u.workingHi,u.workingLo);
  var high=vec3f(0.);var low=vec3f(0.);var repair=false;
  var invalid=red.invalid || green.invalid || blue.invalid;
  for(var c=0u;c<3u;c++) {
    high[c]=working.pairs[c].x;low[c]=working.pairs[c].y;
    let result=value(working.pairs[c]);
    let bound=working.errors[c]+1.1920928955078125e-7*abs(result)+1e-30;
    invalid=invalid || !finite(high[c]) || !finite(low[c]) || !finite(bound);
    repair=repair || bound>2e-6+2e-5*max(0.,abs(result)-bound);
  }
  let lumaError=2.*dot(working.errors,vec3f(${REC2020_LUMA.join(',')}))+u.tuning.y*(abs(value(working.pairs[0]))+abs(value(working.pairs[1]))+abs(value(working.pairs[2])))+1e-30;
  invalid=invalid || !finite(lumaError);
  output[pixel]=Output(vec4f(high,select(select(0.,1.,repair),2.,invalid)),vec4f(low,lumaError));
}
`

/** Pop synchronously before any await or nested renderer operation. */
function scoped<T>(device: GPUDevice, operation: () => T) {
  let opened = 0,
    value!: T,
    failure: { error: unknown } | undefined
  try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
      device.pushErrorScope(filter)
      opened++
    }
    value = operation()
  } catch (error) {
    failure = { error }
  }
  const checks: Promise<GPUError | null>[] = []
  while (opened) {
    opened--
    try {
      checks.push(device.popErrorScope())
    } catch (error) {
      failure ??= { error }
    }
  }
  const checked = Promise.all(checks).then((errors) => {
    const error = errors.find((entry) => entry !== null)
    if (error) throw new Error(`${error.constructor.name}: ${error.message}`)
  })
  void checked.catch(() => undefined)
  if (failure) throw failure.error
  return { value, checked }
}

/** A settled converter must not remain retained by the caller's long-lived device. */
function observeLoss(device: GPUDevice, observer: { lost?: (info: GPUDeviceLostInfo) => void }) {
  void device.lost.then((info) => observer.lost?.(info))
}

/** Bounded candidate conversion of the unchanged, already highlight-blended
 * LibRaw linear frame. CPU geometry and validity stay canonical. On failure the
 * caller closes this converter and replays that same frame through the CPU path.
 */
export async function createGpuReferenceFallback(
  device: GPUDevice,
  frame: LinearFrame,
  plan: CorrectionPlan,
  saturated: Uint8Array,
  gains: number[],
  reduced: { width: number; height: number },
  checkpoint: () => Promise<void>,
  measurement?: CpuKernelMeasurement,
  options: GpuReferenceFallbackOptions = {},
) {
  const started = performance.now(),
    width = frame.flip & 4 ? plan.height : plan.width,
    height = frame.flip & 4 ? plan.width : plan.height,
    allocation = layout(frame.width, frame.height, width, height),
    normal = frame.normalization,
    availableBytes = options.availableBytes ?? MAX_GPU_BYTES,
    {
      allocatedGpuBytes,
      capacity,
      rowBytes,
      layerRows,
      layers,
      uploadBytes,
      geometryBytes,
      resultBytes,
    } = allocation
  if (
    !Number.isSafeInteger(availableBytes) ||
    allocatedGpuBytes > Math.min(availableBytes, MAX_GPU_BYTES)
  )
    throw new Error('GPU reference fallback exceeds its available memory budget.')
  if (
    !(frame.data.buffer instanceof ArrayBuffer) ||
    frame.data.length !== frame.width * frame.height * 4 ||
    frame.matrix.length !== 12 ||
    !frame.matrix.every(Number.isFinite) ||
    !normal ||
    normal.gains.length < 3 ||
    normal.gains.length > 4 ||
    !normal.gains.every((value) => Number.isFinite(value) && value > 0) ||
    gains.length < 3 ||
    gains.length > 4 ||
    !gains.every((value) => Number.isFinite(value) && value > 0) ||
    plan.lut.length !== LUT_BYTES / 4 ||
    !plan.lut.every(Number.isFinite)
  )
    throw new Error('Unsupported GPU reference fallback source.')
  if (
    Math.max(frame.width, layerRows) > device.limits.maxTextureDimension2D ||
    layers > device.limits.maxTextureArrayLayers ||
    Math.max(geometryBytes, resultBytes, LUT_BYTES) > device.limits.maxStorageBufferBindingSize ||
    Math.max(geometryBytes, resultBytes, uploadBytes, LUT_BYTES, UNIFORM_BYTES) >
      device.limits.maxBufferSize ||
    UNIFORM_BYTES > device.limits.maxUniformBufferBindingSize ||
    Math.ceil(capacity / 128) > device.limits.maxComputeWorkgroupsPerDimension ||
    device.limits.maxComputeInvocationsPerWorkgroup < 128 ||
    device.limits.maxComputeWorkgroupSizeX < 128
  )
    throw new Error('GPU reference fallback exceeds the device limits.')
  options.signal?.throwIfAborted()
  const metrics: GpuReferenceFallbackMetrics = {
    backend: 'gpu',
    policy: GPU_REFERENCE_PREPARATION,
    allocatedGpuBytes,
    setupMs: 0,
    uploadMs: 0,
    geometryMs: 0,
    conversionMs: 0,
    readbackMs: 0,
    verificationMs: 0,
    closingMs: 0,
    runtimeMs: 0,
    batches: 0,
    prefetchedStrips: 0,
    discardedPrefetches: 0,
    inputBytes: 0,
    geometryBytes: 0,
    outputBytes: 0,
    scalarRepairs: 0,
    thresholdRepairs: 0,
    conditionRepairs: 0,
  }
  const observeMetrics = () => {
    try {
      options.observeMetrics?.(metrics)
    } catch {
      // Diagnostic observers cannot change conversion or prevent resource cleanup.
    }
  }
  const resources: GPUBuffer[] = [],
    lossObserver: { lost?: (info: GPUDeviceLostInfo) => void } = {}
  let geometry: FallbackGeometryProvider | undefined,
    prefetched: FallbackGeometryStrip | undefined,
    source: GPUTexture | undefined,
    staging: GPUBuffer | undefined,
    pendingMap: Promise<void> | undefined,
    pendingChecks: Promise<void> | undefined,
    mapping = false,
    active:
      Promise<{ rgba: Float32Array<ArrayBuffer>; luma: Float64Array<ArrayBuffer> }> | undefined,
    closing: Promise<void> | undefined,
    closed = false,
    failure: { error: unknown } | undefined
  const unmap = () => {
    if (!mapping) return
    mapping = false
    staging!.unmap()
  }
  const stop = (error: unknown) => {
    failure ??= { error }
    prefetched = undefined
    unmap()
    return failure.error
  }
  const check = () => {
    options.signal?.throwIfAborted()
    if (failure) throw failure.error
    if (closing || closed) throw new Error('GPU reference fallback converter is closed.')
  }
  const probe = async (event: GpuReferenceFallbackCheckpoint) => {
    await options.hooks?.checkpoint?.(event)
    check()
  }
  const drain = async () => {
    await Promise.allSettled([pendingMap, pendingChecks])
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
  }
  const abort = () => void stop(options.signal!.reason)
  const close = (): Promise<void> => {
    if (closing) return closing
    options.signal?.removeEventListener('abort', abort)
    closing = (async () => {
      const closingAt = performance.now()
      await active?.catch(() => undefined)
      unmap()
      await drain()
      try {
        for (const resource of resources) resource.destroy()
        source?.destroy()
      } finally {
        try {
          prefetched = undefined
          geometry?.close()
        } finally {
          closed = true
          lossObserver.lost = undefined
          metrics.closingMs += performance.now() - closingAt
          metrics.runtimeMs = performance.now() - started
          observeMetrics()
        }
      }
    })()
    return closing
  }
  lossObserver.lost = (info) => {
    if (!closed) stop(new Error(`GPU reference fallback device lost: ${info.message}`))
  }
  observeLoss(device, lossObserver)
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage })
    resources.push(result)
    return result
  }
  try {
    observeMetrics()
    await checkpoint()
    check()
    geometry = await createFallbackGeometryProvider(
      frame,
      plan,
      saturated,
      measurement,
      undefined,
      reduced,
    )
    check()
    if (geometry.width !== width || geometry.height !== height)
      throw new Error('GPU reference fallback geometry changed.')
    const values = new Float32Array(UNIFORM_BYTES / 4),
      counts = new Uint32Array(values.buffer),
      maximumGain = Math.max(...normal.gains),
      minimumGain = Math.min(...gains),
      balance = [maximumGain, minimumGain, ...normal.gains.slice(0, 3), ...gains.slice(0, 3)],
      cx = (frame.width - 1) / 2,
      cy = (frame.height - 1) / 2,
      radius = Math.hypot(cx, cy),
      raw = new Float32Array(capacity * 8),
      rgba = new Float32Array(capacity * 4),
      luma = new Float64Array(capacity),
      currentAlpha = new Uint8Array(capacity),
      upload = new Uint8Array(uploadBytes),
      uploadFloats = new Float32Array(upload.buffer)
    const pair = (value: number, hi: number, lo: number) => {
      const high = Math.fround(value),
        low = Math.fround(value - high)
      const subnormal = (part: number) => part !== 0 && Math.abs(part) < FLOAT32_MIN_NORMAL
      if (
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        (high === 0 && value !== 0) ||
        subnormal(high) ||
        subnormal(low)
      )
        throw new Error('Unsupported GPU reference fallback coefficient.')
      values[hi] = high
      values[lo] = low
    }
    counts.set([frame.width, frame.height, width, 0])
    let maximumVignette = 0,
      maximumDelta = 0,
      constantVignette = true
    for (let i = 0; i < 4096; i++) {
      const gain = plan.lut[i * 4 + 3]
      if (!(gain >= 2 ** -100)) throw new Error('Unsupported GPU reference fallback vignette gain.')
      maximumVignette = Math.max(maximumVignette, gain)
      if (i) maximumDelta = Math.max(maximumDelta, Math.abs(gain - plan.lut[(i - 1) * 4 + 3]))
      constantVignette &&= gain === plan.lut[3]
    }
    // With exact integer tap deltas, a normal sqrt starting estimate followed by
    // compensated Newton refinement, split CPU radius division and paired LUT
    // interpolation have second-order Float32 error under genuine fused FMA and
    // retained rounding barriers. The slope term also encloses segment-edge
    // uncertainty; the Float64 term includes the unchanged CPU hypot/reference
    // operations. This generous factor still needs independent full native
    // validation on each backend; WGSL alone is not a portable proof of the bound.
    const gainError = constantVignette
      ? 8 * Number.EPSILON * maximumVignette
      : (4095 * maximumDelta + maximumVignette) * (4096 * FLOAT32_UNIT ** 2 + 32 * Number.EPSILON)
    values.set([cx, cy, radius, gainError], 4)
    values.set([constantVignette ? plan.lut[3] : -1, 1024 * FLOAT32_UNIT ** 2, 0, 0], 8)
    pair(radius, 6, 10)
    balance.forEach((value, at) => {
      if (Math.fround(value) < 2 ** -100)
        throw new Error('Unsupported GPU reference fallback normalization.')
      pair(value, 12 + at, 20 + at)
    })
    for (let row = 0; row < 3; row++)
      for (let channel = 0; channel < 3; channel++) {
        pair(frame.matrix[row * 4 + channel], 28 + row * 4 + channel, 40 + row * 4 + channel)
        pair(SRGB_TO_2020[row * 3 + channel], 52 + row * 4 + channel, 64 + row * 4 + channel)
      }
    const setup = scoped(device, () => {
      source = device.createTexture({
        size: [frame.width, layerRows, layers],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      return {
        uniform: buffer(UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
        upload: buffer(uploadBytes, GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST),
        geometry: buffer(geometryBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        lut: buffer(LUT_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        result: buffer(resultBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        staging: buffer(resultBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
        module: device.createShaderModule({ code: shader, label: 'Luma GPU reference fallback' }),
      }
    })
    await setup.checked
    staging = setup.value.staging
    check()
    const compilation = await setup.value.module.getCompilationInfo(),
      errors = compilation.messages.filter((message) => message.type === 'error')
    if (errors.length) throw new Error(errors.map((message) => message.message).join('\n'))
    const grouping = scoped(device, () => {
      const group = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
          },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
      })
      return device.createPipelineLayout({ bindGroupLayouts: [group] })
    })
    await grouping.checked
    check()
    const building = scoped(device, () =>
      device.createComputePipelineAsync({
        layout: grouping.value,
        compute: { module: setup.value.module, entryPoint: 'convert' },
      }),
    )
    void building.value.catch(() => undefined)
    const [pipeline] = await Promise.all([building.value, building.checked])
    check()
    const binding = scoped(device, () =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: setup.value.uniform } },
          { binding: 1, resource: source!.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: { buffer: setup.value.geometry } },
          { binding: 3, resource: { buffer: setup.value.lut } },
          { binding: 4, resource: { buffer: setup.value.result } },
        ],
      }),
    )
    await binding.checked
    check()
    options.signal?.addEventListener('abort', abort, { once: true })
    await probe({ phase: 'allocated' })
    metrics.setupMs = performance.now() - started
    const uploadStarted = performance.now(),
      initial = scoped(device, () => {
        device.queue.writeBuffer(setup.value.uniform, 0, values)
        device.queue.writeBuffer(setup.value.lut, 0, plan.lut)
      })
    await initial.checked
    for (let top = 0; top < frame.height; top += layerRows) {
      await checkpoint()
      check()
      const rows = Math.min(layerRows, frame.height - top)
      upload.fill(0)
      for (let row = 0; row < rows; row++)
        uploadFloats.set(
          frame.data.subarray((top + row) * frame.width * 4, (top + row + 1) * frame.width * 4),
          (row * rowBytes) / 4,
        )
      const copied = scoped(device, () => {
        device.queue.writeBuffer(setup.value.upload, 0, upload)
        const encoder = device.createCommandEncoder()
        encoder.copyBufferToTexture(
          { buffer: setup.value.upload, bytesPerRow: rowBytes, rowsPerImage: layerRows },
          { texture: source!, origin: [0, 0, top / layerRows] },
          [frame.width, layerRows, 1],
        )
        device.queue.submit([encoder.finish()])
      })
      pendingChecks = copied.checked
      await Promise.all([copied.checked, device.queue.onSubmittedWorkDone()])
      check()
      metrics.inputBytes += rows * frame.width * 16
      await probe({ phase: 'uploaded-source', top, rows })
    }
    metrics.uploadMs += performance.now() - uploadStarted
    metrics.runtimeMs = performance.now() - started

    // Fixed-size exact recovery cache; arbitrary LUTs retain canonical Float64
    // hypot/radial evaluation, including constant-gain rounding in the CPU recipe.
    const gainKeys = new Int32Array(4096).fill(-1),
      gainValues = new Float64Array(4096)
    const gainAt = (x: number, y: number) => {
      const key = y * frame.width + x,
        slot = key & (gainKeys.length - 1)
      if (gainKeys[slot] !== key) {
        gainValues[slot] = radial(plan.lut, Math.hypot(x - cx, y - cy) / radius, 3)
        gainKeys[slot] = key
      }
      return gainValues[slot]
    }
    const camera = new Float64Array(3),
      linear = new Float64Array(3),
      repaired = new Float64Array(3)
    const repairPoint = (x: number, y: number) => {
      for (let channel = 0; channel < 3; channel++) {
        const { ix, iy, dx, dy } = geometry!.coordinate(x, y, channel)
        let value = 0
        for (let yy = 0; yy < 2; yy++)
          for (let xx = 0; xx < 2; xx++) {
            const tx = Math.max(0, Math.min(frame.width - 1, ix + xx)),
              ty = Math.max(0, Math.min(frame.height - 1, iy + yy)),
              weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy)
            value += frame.data[(ty * frame.width + tx) * 4 + channel] * weight * gainAt(tx, ty)
          }
        camera[channel] =
          (((value * maximumGain) / normal.gains[channel]) * gains[channel]) / minimumGain
      }
      for (let row = 0; row < 3; row++)
        linear[row] =
          frame.matrix[row * 4] * camera[0] +
          frame.matrix[row * 4 + 1] * camera[1] +
          frame.matrix[row * 4 + 2] * camera[2]
      for (let row = 0; row < 3; row++)
        repaired[row] =
          SRGB_TO_2020[row * 3] * linear[0] +
          SRGB_TO_2020[row * 3 + 1] * linear[1] +
          SRGB_TO_2020[row * 3 + 2] * linear[2]
      return repaired
    }
    const readGeometry = (top: number, rows: number) => {
      const geometryAt = performance.now()
      try {
        const strip = geometry!.read(top, rows, options.signal),
          count = width * rows
        if (
          strip.top !== top ||
          strip.rows !== rows ||
          strip.geometry.length !== count * FALLBACK_GEOMETRY_PIXEL_WORDS ||
          strip.alpha.length !== count ||
          strip.alpha.some((value) => value > 1)
        )
          throw new Error('Invalid canonical GPU reference fallback strip.')
        return strip
      } finally {
        metrics.geometryMs += performance.now() - geometryAt
      }
    }
    const perform = async (top: number, rows: number) => {
      await checkpoint()
      check()
      const count = width * rows,
        previous = prefetched
      prefetched = undefined
      let canonical: FallbackGeometryStrip
      if (previous?.top === top && previous.rows === rows) canonical = previous
      else {
        if (previous) metrics.discardedPrefetches++
        canonical = readGeometry(top, rows)
      }
      // The provider owns one geometry/alpha strip. Preserve current validity
      // before planning the next strip into that same borrowed CPU storage.
      currentAlpha.set(canonical.alpha)
      counts[3] = count
      const uploading = performance.now(),
        uploaded = scoped(device, () => {
          device.queue.writeBuffer(setup.value.uniform, 0, values)
          const bytes = new Uint8Array(
            canonical.geometry.buffer,
            canonical.geometry.byteOffset,
            canonical.geometry.byteLength,
          )
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_UPLOAD_BYTES)
            device.queue.writeBuffer(
              setup.value.geometry,
              offset,
              bytes.subarray(offset, Math.min(bytes.byteLength, offset + MAX_UPLOAD_BYTES)),
            )
        })
      await uploaded.checked
      metrics.uploadMs += performance.now() - uploading
      metrics.geometryBytes += canonical.geometry.byteLength
      await probe({ phase: 'uploaded-geometry', top, rows })
      const dispatching = performance.now(),
        submitted = scoped(device, () => {
          const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass()
          pass.setPipeline(pipeline)
          pass.setBindGroup(0, binding.value)
          pass.dispatchWorkgroups(Math.ceil(count / 128))
          pass.end()
          encoder.copyBufferToBuffer(setup.value.result, 0, staging!, 0, count * 32)
          device.queue.submit([encoder.finish()])
          mapping = true
          pendingMap = staging!.mapAsync(GPUMapMode.READ, 0, count * 32)
          void pendingMap.catch(() => undefined)
          return pendingMap
        })
      pendingChecks = submitted.checked
      metrics.conversionMs += performance.now() - dispatching
      await probe({ phase: 'submitted', top, rows })
      if (rows === STRIP_ROWS && top % STRIP_ROWS === 0 && top + STRIP_ROWS * 2 <= height) {
        await checkpoint()
        check()
        // writeBuffer has already snapshotted current geometry and all GPU
        // scopes are popped. Only the provider's disjoint geometry/alpha output
        // is reused; its ordered reducer input/state remains untouched.
        prefetched = readGeometry(top + STRIP_ROWS, STRIP_ROWS)
        metrics.prefetchedStrips++
        check()
      }
      // Geometry runs while the submitted GPU/map work is pending. Attribute
      // only the exposed remaining wait and readback copy to this category.
      const reading = performance.now()
      await Promise.all([submitted.value, pendingChecks])
      check()
      const pixels = raw.subarray(0, count * 8)
      try {
        const mapped = staging!.getMappedRange(0, count * 32)
        if (mapped.byteLength !== count * 32)
          throw new Error('Incomplete GPU reference fallback readback.')
        pixels.set(new Float32Array(mapped))
      } finally {
        unmap()
      }
      metrics.readbackMs += performance.now() - reading
      options.hooks?.readback?.(top, pixels)
      await probe({ phase: 'readback', top, rows })
      const verifying = performance.now()
      for (let pixel = 0; pixel < count; pixel++) {
        const at = pixel * 8,
          out = pixel * 4,
          flag = pixels[at + 3],
          error = pixels[at + 7]
        if ((flag !== 0 && flag !== 1) || !Number.isFinite(error) || error < 0)
          throw new Error('Invalid GPU reference fallback error enclosure.')
        for (let channel = 0; channel < 3; channel++) {
          const high = pixels[at + channel],
            low = pixels[at + 4 + channel]
          if (
            !Number.isFinite(high) ||
            !Number.isFinite(low) ||
            Math.abs(low) > Math.abs(high) * FLOAT32_UNIT * 2 + FLOAT32_MIN_NORMAL
          )
            throw new Error('Invalid GPU reference fallback compensated sample.')
        }
        let red = pixels[at] + pixels[at + 4],
          green = pixels[at + 1] + pixels[at + 5],
          blue = pixels[at + 2] + pixels[at + 6],
          light = Math.max(
            0,
            red * REC2020_LUMA[0] + green * REC2020_LUMA[1] + blue * REC2020_LUMA[2],
          )
        const threshold =
            currentAlpha[pixel] === 1 && Math.abs(light - MERGE_LIMITS.readNoise * 3) <= error,
          condition = flag === 1 || error > 2e-6 + 2e-5 * Math.max(0, light - error)
        if (threshold || condition) {
          const exact = repairPoint(pixel % width, top + Math.floor(pixel / width))
          red = exact[0]
          green = exact[1]
          blue = exact[2]
          light = Math.max(
            0,
            red * REC2020_LUMA[0] + green * REC2020_LUMA[1] + blue * REC2020_LUMA[2],
          )
          metrics.scalarRepairs++
          metrics.thresholdRepairs += Number(threshold)
          metrics.conditionRepairs += Number(condition)
        }
        rgba[out] = red
        rgba[out + 1] = green
        rgba[out + 2] = blue
        rgba[out + 3] = currentAlpha[pixel]
        luma[pixel] = light
        if (
          !Number.isFinite(rgba[out]) ||
          !Number.isFinite(rgba[out + 1]) ||
          !Number.isFinite(rgba[out + 2]) ||
          !Number.isFinite(light)
        )
          throw new Error('Non-finite GPU reference fallback sample.')
      }
      metrics.verificationMs += performance.now() - verifying
      metrics.batches++
      metrics.outputBytes += count * 32
      metrics.runtimeMs = performance.now() - started
      check()
      return { rgba: rgba.subarray(0, count * 4), luma: luma.subarray(0, count) }
    }
    return {
      width,
      height,
      metrics,
      reduction: geometry.reduction,
      convert(
        top: number,
        rows: number,
      ): Promise<{ rgba: Float32Array<ArrayBuffer>; luma: Float64Array<ArrayBuffer> }> {
        try {
          check()
          if (
            active ||
            !Number.isSafeInteger(top) ||
            !Number.isSafeInteger(rows) ||
            top < 0 ||
            rows < 1 ||
            rows > STRIP_ROWS ||
            top + rows > height
          )
            throw new Error('Invalid or concurrent GPU reference fallback strip.')
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = perform(top, rows).catch(async (error) => {
          const reason = stop(options.signal?.aborted ? options.signal.reason : error)
          await drain()
          throw reason
        })
        active = operation
        return operation.finally(() => {
          if (active === operation) active = undefined
        })
      },
      close,
    }
  } catch (error) {
    stop(options.signal?.aborted ? options.signal.reason : error)
    await close()
    throw options.signal?.aborted ? options.signal.reason : error
  }
}
