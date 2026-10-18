import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { MERGE_LIMITS, GPU_CAMERA_PREPARATION } from '../../shared/merge'
import type { RawSource } from '../gpu/raw-source'
import type { CorrectionPlan } from '../processing/lens-correction'
import {
  CAMERA_REGISTRATION_POLICY,
  cameraRegistrationInverse,
  createCameraValidityProvider,
  type CameraRegistration,
  type CameraValidityProvider,
} from './camera-registration'
import { createAreaReducer, type CpuKernelMeasurement } from './cpu-kernels'
import type { Plane } from './math'

export const GPU_CAMERA_PIXEL_POLICY = GPU_CAMERA_PREPARATION
const STRIP_ROWS = 64
const UNIFORM_BYTES = 160
const MAX_GPU_BYTES = 1024 ** 3
const FLOAT32_UNIT = 2 ** -24
const FLOAT32_MIN_NORMAL = 2 ** -126
const maskBytes = (pixels: number) => Math.ceil(pixels / 4) * 4

/** Additional live GPU ownership; the caller reserves this beside the RAW renderer. */
export function gpuCameraRegistrationBytes(width: number, height: number): number {
  const capacity = width * Math.min(STRIP_ROWS, height),
    bytes = UNIFORM_BYTES + capacity * 48 + maskBytes(capacity)
  if (![width, height, capacity, bytes].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid GPU camera evidence dimensions.')
  return bytes
}

export interface GpuCameraCheckpoint {
  phase: 'allocated' | 'uploaded' | 'submitted' | 'readback' | 'before-write'
  top?: number
  rows?: number
}

export interface GpuCameraRegistrationOptions {
  device: GPUDevice
  /** Bytes remaining after all concurrently live RAW/preparation allocations. */
  availableBytes: number
  checkpoint: () => Promise<void>
  signal?: AbortSignal
  measurement?: CpuKernelMeasurement
  /** Internal live ownership diagnostics, including failed constructor cleanup. */
  observeMetrics?: (metrics: GpuCameraRegistrationMetrics) => void
  /** Internal fault injection only; not exposed through the application bridge or MCP. */
  hooks?: {
    checkpoint?: (event: GpuCameraCheckpoint) => void | Promise<void>
    readback?: (top: number, pixels: Float32Array<ArrayBuffer>) => void
  }
}

export interface GpuCameraRegistrationMetrics {
  policy: typeof GPU_CAMERA_PIXEL_POLICY
  backend: 'gpu'
  allocatedGpuBytes: number
  runtimeMs: number
  setupMs: number
  uploadMs: number
  dispatchReadbackMs: number
  verificationMs: number
  reductionMs: number
  hashingMs: number
  writingMs: number
  closingMs: number
  batches: number
  inputBytes: number
  outputBytes: number
  scalarRepairs: number
  thresholdRepairs: number
  conditionRepairs: number
  roundingRepairs: number
}

const shader = `
struct Params { size:vec4u, hi:array<vec4f,3>, lo:array<vec4f,3>, bounds:array<vec4f,3> }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var<storage,read> working:array<vec4f>;
@group(0) @binding(2) var<storage,read> validity:array<u32>;
@group(0) @binding(3) var<storage,read_write> camera:array<vec4f>;

// These compensated primitives follow the maintained ACES scalar helpers.
// The frexp/ldexp boundaries retain explicit Float32 rounding on Metal.
// FMA error behavior still needs independent native proof on every backend;
// WGSL alone does not establish portable error-free multiplication.
fn cameraRound(v:f32)->f32 {let p=frexp(v);return ldexp(p.fract,p.exp);}
fn cameraSum(a:f32,b:f32)->vec2f {
  let s=cameraRound(a+b);
  let z=cameraRound(s-a);
  return vec2f(s,cameraRound(cameraRound(a-cameraRound(s-z))+cameraRound(b-z)));
}
fn cameraAdd(a:vec2f,b:vec2f)->vec2f {
  let s=cameraSum(a.x,b.x);
  return cameraSum(s.x,cameraRound(cameraRound(s.y+a.y)+b.y));
}
fn cameraProduct(a:vec2f,b:f32)->vec2f {
  let p=cameraRound(a.x*b);
  let residual=cameraRound(fma(a.x,b,-p));
  return cameraSum(p,cameraRound(residual+cameraRound(a.y*b)));
}
fn cameraFinite(v:f32)->bool {
  return (bitcast<u32>(v)&0x7f800000u)!=0x7f800000u;
}
fn cameraNext(v:f32,up:bool)->f32 {
  let bits=bitcast<u32>(v);
  return bitcast<f32>(select(bits-1u,bits+1u,up==(v>0.)));
}
struct Projection { value:f32, reasons:u32 }
fn cameraProjection(rgb:vec3f,channel:u32)->Projection {
  let hi=u.hi[channel].xyz;
  let lo=u.lo[channel].xyz;
  let first=cameraProduct(vec2f(hi.x,lo.x),rgb.x);
  let second=cameraProduct(vec2f(hi.y,lo.y),rgb.y);
  let third=cameraProduct(vec2f(hi.z,lo.z),rgb.z);
  // Retain the CPU's left-associated three-term order. The enclosure also
  // includes the CPU Float64 products/additions before its final Float32 store.
  let sum=cameraAdd(cameraAdd(first,second),third);
  let rounded=cameraRound(sum.x+sum.y);
  let magnitude=max(abs(rgb.x),max(abs(rgb.y),abs(rgb.z)));
  let limits=u.bounds[channel];
  let bound=2.*cameraRound(cameraRound(magnitude*limits.x)+limits.y);
  var uncertain=!cameraFinite(rounded) || !cameraFinite(sum.x) ||
    !cameraFinite(sum.y) || !cameraFinite(bound) ||
    (u.size.y&(1u<<channel))!=0u ||
    abs(rounded)<7.888609052210118e-31 || abs(rounded)>=3.4028234663852886e38;
  if(!uncertain) {
    let lowerStep=cameraRound(cameraRound(rounded-cameraNext(rounded,false))*.5);
    let upperStep=cameraRound(cameraRound(cameraNext(rounded,true)-rounded)*.5);
    // A midpoint needs two floats: rounding it to one Float32 would erase the
    // tie we must detect. Strict containment certifies just one rounding bin.
    let lower=cameraAdd(sum,-vec2f(rounded,-lowerStep));
    let upper=cameraAdd(vec2f(rounded,upperStep),-sum);
    let fromLower=cameraRound(lower.x+lower.y);
    let fromUpper=cameraRound(upper.x+upper.y);
    uncertain=!(fromLower>bound && fromUpper>bound);
  }
  let legacyBound=cameraRound(cameraRound(magnitude*limits.z)+limits.w);
  let value=select(0.,rounded,cameraFinite(rounded));
  let threshold=abs(value-${MERGE_LIMITS.readNoise * 3})<=legacyBound;
  let condition=legacyBound>2e-6+2e-5*max(0.,abs(value)-legacyBound);
  return Projection(value,select(0u,1u,uncertain) |
    select(0u,2u,threshold) | select(0u,4u,condition));
}
@compute @workgroup_size(256) fn project(@builtin(global_invocation_id) p:vec3u) {
  let at=p.x;
  if(at>=u.size.x) { return; }
  let rgb=working[at].rgb;
  let bits=(validity[at>>2u]>>((at&3u)*8u))&255u;
  let red=cameraProjection(rgb,0u);
  let green=cameraProjection(rgb,1u);
  let blue=cameraProjection(rgb,2u);
  let repairs=select(0u,1u,red.reasons!=0u) | select(0u,2u,green.reasons!=0u) |
    select(0u,4u,blue.reasons!=0u);
  let thresholds=((red.reasons&2u)>>1u) | (green.reasons&2u) | ((blue.reasons&2u)<<1u);
  let conditions=((red.reasons&4u)>>2u) | ((green.reasons&4u)>>1u) | (blue.reasons&4u);
  let rounding=(red.reasons&1u) | ((green.reasons&1u)<<1u) | ((blue.reasons&1u)<<2u);
  // Extra exact-integer transport bits never enter stored native validity.
  let transport=bits | (repairs<<3u) | (thresholds<<6u) | (conditions<<9u) | (rounding<<12u);
  camera[at]=vec4f(red.value,green.value,blue.value,f32(transport));
}
`

/** Pop synchronously: a RAW renderer may already own enclosing error scopes. */
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

/** A closed writer must not remain retained by the caller's long-lived device. */
function observeLoss(device: GPUDevice, observer: { lost?: (info: GPUDeviceLostInfo) => void }) {
  void device.lost.then((info) => observer.lost?.(info))
}

/** Streaming native evidence, with canonical CPU geometry and ordered area reduction.
 * Any failure rejects the complete writer; the caller replays the saved working
 * pixels through the CPU writer after close() has drained this device's work.
 */
export async function gpuCameraRegistrationWriter(
  directory: string,
  index: number,
  raw: RawSource,
  plan: CorrectionPlan,
  previewWidth: number,
  previewHeight: number,
  options: GpuCameraRegistrationOptions,
) {
  const started = performance.now(),
    { device } = options,
    width = raw.flip & 4 ? plan.height : plan.width,
    height = raw.flip & 4 ? plan.width : plan.height,
    capacity = width * Math.min(STRIP_ROWS, height),
    allocatedGpuBytes = gpuCameraRegistrationBytes(width, height),
    inverse = cameraRegistrationInverse(raw),
    rounded = inverse.map(Math.fround),
    residuals = inverse.map((value, at) => Math.fround(value - rounded[at])),
    path = join(directory, `source-${index}.camera.f32`)
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(options.availableBytes) ||
    options.availableBytes < allocatedGpuBytes ||
    allocatedGpuBytes > MAX_GPU_BYTES
  )
    throw new Error('GPU camera evidence exceeds its available memory budget.')
  if (
    !rounded.every(Number.isFinite) ||
    capacity * 16 > device.limits.maxStorageBufferBindingSize ||
    Math.max(capacity * 16, maskBytes(capacity), UNIFORM_BYTES) > device.limits.maxBufferSize ||
    UNIFORM_BYTES > device.limits.maxUniformBufferBindingSize ||
    Math.ceil(capacity / 256) > device.limits.maxComputeWorkgroupsPerDimension ||
    device.limits.maxComputeInvocationsPerWorkgroup < 256 ||
    device.limits.maxComputeWorkgroupSizeX < 256
  )
    throw new Error('GPU camera evidence exceeds the device limits.')
  options.signal?.throwIfAborted()
  const metrics: GpuCameraRegistrationMetrics = {
    policy: GPU_CAMERA_PIXEL_POLICY,
    backend: 'gpu',
    allocatedGpuBytes,
    runtimeMs: 0,
    setupMs: 0,
    uploadMs: 0,
    dispatchReadbackMs: 0,
    verificationMs: 0,
    reductionMs: 0,
    hashingMs: 0,
    writingMs: 0,
    closingMs: 0,
    batches: 0,
    inputBytes: 0,
    outputBytes: 0,
    scalarRepairs: 0,
    thresholdRepairs: 0,
    conditionRepairs: 0,
    roundingRepairs: 0,
  }
  const observeMetrics = () => {
    try {
      options.observeMetrics?.(metrics)
    } catch {
      // Diagnostic observers cannot change projection or prevent resource cleanup.
    }
  }
  const resources: GPUBuffer[] = [],
    strips: string[] = [],
    lossObserver: { lost?: (info: GPUDeviceLostInfo) => void } = {}
  let validity: CameraValidityProvider | undefined,
    file: FileHandle | undefined,
    staging: GPUBuffer | undefined,
    pendingMap: Promise<void> | undefined,
    pendingChecks: Promise<void> | undefined,
    mapping = false,
    active: Promise<void> | undefined,
    closing: Promise<void> | undefined,
    closed = false,
    finished = false,
    ownedFile = false,
    next = 0,
    failure: { error: unknown } | undefined
  const unmap = () => {
    if (!mapping) return
    mapping = false
    staging!.unmap()
  }
  const stop = (error: unknown) => {
    failure ??= { error }
    unmap()
    return failure.error
  }
  const check = () => {
    options.signal?.throwIfAborted()
    if (failure) throw failure.error
    if (closing || closed) throw new Error('GPU camera evidence writer is closed.')
  }
  const probe = async (event: GpuCameraCheckpoint) => {
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
      try {
        await active?.catch(() => undefined)
        unmap()
        await drain()
        let cleanupFailure: { error: unknown } | undefined
        try {
          await file?.close()
        } catch (error) {
          cleanupFailure = { error }
          failure ??= { error }
        } finally {
          for (const resource of resources) resource.destroy()
          validity?.close()
          closed = true
        }
        if (ownedFile && (!finished || failure)) await rm(path, { force: true })
        if (cleanupFailure) throw cleanupFailure.error
      } finally {
        lossObserver.lost = undefined
        metrics.closingMs += performance.now() - closingAt
        metrics.runtimeMs = performance.now() - started
        observeMetrics()
      }
    })()
    return closing
  }
  lossObserver.lost = (info) => {
    if (!closed) stop(new Error(`GPU camera evidence device lost: ${info.message}`))
  }
  observeLoss(device, lossObserver)
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const result = device.createBuffer({ size, usage })
    resources.push(result)
    return result
  }
  try {
    observeMetrics()
    check()
    validity = await createCameraValidityProvider(raw, plan, options.measurement, {
      width: previewWidth,
      height: previewHeight,
    })
    check()
    if (validity.width !== width || validity.height !== height)
      throw new Error('GPU camera validity geometry changed.')
    const reduction =
        validity.reduction ??
        createAreaReducer(width, height, { width: previewWidth, height: previewHeight }, 'camera'),
      values = new Float32Array(UNIFORM_BYTES / 4),
      counts = new Uint32Array(values.buffer),
      maskUpload = new Uint8Array(maskBytes(capacity)),
      output = new Float32Array(capacity * 4),
      errorRows = [0, 1, 2].map((channel) => {
        let error = 0,
          residual = 0,
          magnitude = 0
        for (let k = 0; k < 3; k++) {
          const at = channel * 3 + k
          error += Math.abs(inverse[at] - rounded[at])
          if (Math.abs(rounded[at]) < FLOAT32_MIN_NORMAL) error += Math.abs(rounded[at])
          residual += Math.abs(inverse[at] - rounded[at] - residuals[at])
          if (Math.abs(rounded[at]) < FLOAT32_MIN_NORMAL) residual += Math.abs(rounded[at])
          if (Math.abs(residuals[at]) < FLOAT32_MIN_NORMAL) residual += Math.abs(residuals[at])
          magnitude += Math.abs(inverse[at])
        }
        return {
          rounding: error + 16 * FLOAT32_UNIT * magnitude,
          underflow: 16 * FLOAT32_MIN_NORMAL * (1 + magnitude),
          interval: residual + (256 * FLOAT32_UNIT ** 2 + 8 * Number.EPSILON) * magnitude,
        }
      })
    for (let row = 0; row < 3; row++) {
      values.set(rounded.slice(row * 3, row * 3 + 3), 4 + row * 4)
      values.set(residuals.slice(row * 3, row * 3 + 3), 16 + row * 4)
      const bound = errorRows[row]
      values.set([bound.interval, bound.underflow, bound.rounding, bound.underflow], 28 + row * 4)
      const subnormal = (value: number) => value !== 0 && Math.abs(value) < FLOAT32_MIN_NORMAL
      if (
        rounded.slice(row * 3, row * 3 + 3).some(subnormal) ||
        residuals.slice(row * 3, row * 3 + 3).some(subnormal) ||
        (bound.interval > 0 &&
          (Math.fround(bound.interval) === 0 || subnormal(Math.fround(bound.interval))))
      )
        counts[1] |= 1 << row
    }
    const setup = scoped(device, () => ({
      uniform: buffer(UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      input: buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      masks: buffer(maskBytes(capacity), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
      result: buffer(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      staging: buffer(capacity * 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      module: device.createShaderModule({ code: shader, label: 'Luma GPU camera evidence' }),
    }))
    await setup.checked
    staging = setup.value.staging
    check()
    const compilation = await setup.value.module.getCompilationInfo(),
      errors = compilation.messages.filter((message) => message.type === 'error')
    if (errors.length) throw new Error(errors.map((message) => message.message).join('\n'))
    const building = scoped(device, () =>
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: setup.value.module, entryPoint: 'project' },
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
          { binding: 1, resource: { buffer: setup.value.input } },
          { binding: 2, resource: { buffer: setup.value.masks } },
          { binding: 3, resource: { buffer: setup.value.result } },
        ],
      }),
    )
    await binding.checked
    check()
    file = await open(path, 'wx')
    ownedFile = true
    options.signal?.addEventListener('abort', abort, { once: true })
    await probe({ phase: 'allocated' })
    metrics.setupMs = performance.now() - started

    const perform = async (top: number, bytes: Uint8Array<ArrayBuffer>) => {
      const inputRows = bytes.byteLength / width / 16
      for (let offset = 0; offset < inputRows; offset += STRIP_ROWS) {
        await options.checkpoint()
        check()
        const rows = Math.min(STRIP_ROWS, inputRows - offset),
          stripTop = top + offset,
          count = width * rows,
          rgbBytes = bytes.subarray(offset * width * 16, (offset + rows) * width * 16),
          rgb = new Float32Array(rgbBytes.buffer, rgbBytes.byteOffset, rgbBytes.byteLength / 4),
          canonical = validity!.read(stripTop, rows)
        if (canonical.length !== count || canonical.some((bits) => bits > 7))
          throw new Error('Invalid canonical GPU camera validity strip.')
        maskUpload.set(canonical)
        counts[0] = count
        const uploading = performance.now(),
          uploaded = scoped(device, () => {
            device.queue.writeBuffer(setup.value.uniform, 0, values)
            device.queue.writeBuffer(setup.value.input, 0, rgbBytes)
            device.queue.writeBuffer(setup.value.masks, 0, maskUpload.subarray(0, maskBytes(count)))
          })
        await uploaded.checked
        metrics.uploadMs += performance.now() - uploading
        await probe({ phase: 'uploaded', top: stripTop, rows })
        const dispatching = performance.now(),
          submitted = scoped(device, () => {
            const encoder = device.createCommandEncoder(),
              pass = encoder.beginComputePass()
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, binding.value)
            pass.dispatchWorkgroups(Math.ceil(count / 256))
            pass.end()
            encoder.copyBufferToBuffer(setup.value.result, 0, staging!, 0, count * 16)
            device.queue.submit([encoder.finish()])
            mapping = true
            pendingMap = staging!.mapAsync(GPUMapMode.READ, 0, count * 16)
            void pendingMap.catch(() => undefined)
            return pendingMap
          })
        pendingChecks = submitted.checked
        await probe({ phase: 'submitted', top: stripTop, rows })
        await Promise.all([submitted.value, pendingChecks])
        check()
        const pixels = output.subarray(0, count * 4)
        try {
          const mapped = staging!.getMappedRange(0, count * 16)
          if (mapped.byteLength !== count * 16)
            throw new Error('Incomplete GPU camera evidence readback.')
          pixels.set(new Float32Array(mapped))
        } finally {
          unmap()
        }
        metrics.dispatchReadbackMs += performance.now() - dispatching
        options.hooks?.readback?.(stripTop, pixels)
        await probe({ phase: 'readback', top: stripTop, rows })
        const verifying = performance.now()
        for (let i = 0; i < count; i++) {
          const at = i * 4,
            transport = pixels[at + 3],
            repairs = (transport >>> 3) & 7,
            thresholds = (transport >>> 6) & 7,
            conditions = (transport >>> 9) & 7,
            rounding = (transport >>> 12) & 7
          if (
            !Number.isInteger(transport) ||
            transport < 0 ||
            transport > 32767 ||
            (transport & 7) !== canonical[i] ||
            (thresholds | conditions | rounding) !== repairs
          )
            throw new Error('Invalid GPU camera evidence or validity sample.')
          pixels[at + 3] = canonical[i]
          for (let c = 0; c < 3; c++) {
            const value = pixels[at + c]
            if (!Number.isFinite(value)) throw new Error('Non-finite GPU camera evidence sample.')
            if (repairs & (1 << c)) {
              const repaired = Math.fround(
                inverse[c * 3] * rgb[at] +
                  inverse[c * 3 + 1] * rgb[at + 1] +
                  inverse[c * 3 + 2] * rgb[at + 2],
              )
              if (!Number.isFinite(repaired))
                throw new Error('Non-finite scalar GPU camera repair sample.')
              pixels[at + c] = repaired
              metrics.scalarRepairs++
              metrics.thresholdRepairs += Number(!!(thresholds & (1 << c)))
              metrics.conditionRepairs += Number(!!(conditions & (1 << c)))
              metrics.roundingRepairs += Number(!!(rounding & (1 << c)))
            }
          }
        }
        metrics.verificationMs += performance.now() - verifying
        const reducing = performance.now()
        reduction.add(stripTop, pixels)
        metrics.reductionMs += performance.now() - reducing
        const native = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          hashing = performance.now(),
          digest = createHash('sha256').update(native).digest('hex')
        metrics.hashingMs += performance.now() - hashing
        await probe({ phase: 'before-write', top: stripTop, rows })
        const writing = performance.now()
        await file!.writeFile(native)
        metrics.writingMs += performance.now() - writing
        check()
        strips.push(digest)
        next += rows
        metrics.batches++
        metrics.inputBytes += rgbBytes.byteLength
        metrics.outputBytes += native.byteLength
      }
    }
    return {
      metrics,
      write(top: number, bytes: Buffer): Promise<void> {
        let borrowed: Uint8Array<ArrayBuffer>
        try {
          check()
          const rows = bytes.byteLength / width / 16
          if (
            active ||
            top !== next ||
            top % STRIP_ROWS ||
            !(bytes.buffer instanceof ArrayBuffer) ||
            bytes.byteOffset % 4 ||
            !Number.isSafeInteger(rows) ||
            rows < 1 ||
            top + rows > height ||
            (rows % STRIP_ROWS && top + rows !== height)
          )
            throw new Error('Invalid or concurrent GPU camera evidence strip.')
          borrowed = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = perform(top, borrowed).catch(async (error) => {
          const reason = stop(options.signal?.aborted ? options.signal.reason : error)
          await drain()
          throw reason
        })
        active = operation
        return operation.finally(() => {
          if (active === operation) active = undefined
        })
      },
      async finish(): Promise<CameraRegistration> {
        check()
        if (active || next !== height || strips.length !== Math.ceil(height / STRIP_ROWS))
          throw new Error('Incomplete GPU camera registration evidence.')
        const planes = reduction.finish() as [Plane, Plane, Plane]
        finished = true
        await close()
        options.signal?.throwIfAborted()
        if (failure) throw failure.error
        return { version: CAMERA_REGISTRATION_POLICY, path, strips, planes }
      },
      close,
    }
  } catch (error) {
    stop(error)
    await close()
    throw error
  }
}
