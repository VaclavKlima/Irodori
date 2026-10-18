/// <reference types="@webgpu/types" />

export const CAMERA_STUDY_GPU_LIMIT = 1024 ** 3
const STRIP_ROWS = 64
const TRANSFER_BYTES = 8 * 1024 ** 2
const align = (bytes: number) => Math.ceil(bytes / 256) * 256

export interface CameraStudyInput {
  width: number
  height: number
  reducedWidth: number
  reducedHeight: number
  rgba: Float32Array<ArrayBuffer>
  /** Canonical, oriented lens/CA-aware validity, one three-bit value per native pixel. */
  valid: Uint8Array<ArrayBuffer>
  inverse: number[]
  minimumSignal: number
}

/** Independently authored research kernels. No external HDR+ or Burst Photo code is used. */
export const cameraStudyWgsl = `
struct Params {
  size:vec4u,
  red:vec4f,
  green:vec4f,
  blue:vec4f,
  limits:vec4f,
}
const LAYER_ROWS:u32 = ${STRIP_ROWS}u;
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var working:texture_2d_array<f32>;
@group(0) @binding(2) var canonical:texture_2d_array<u32>;
@group(0) @binding(3) var nativeOut:texture_storage_2d_array<rgba32float,write>;
@group(0) @binding(4) var nativeIn:texture_2d_array<f32>;
@group(0) @binding(5) var reducedOut:texture_storage_2d<rgba32float,write>;

@compute @workgroup_size(8,8) fn project(@builtin(global_invocation_id) p:vec3u) {
  if(any(p.xy>=u.size.xy)) { return; }
  let at=vec2i(i32(p.x),i32(p.y%LAYER_ROWS));
  let layer=i32(p.y/LAYER_ROWS);
  let rgb=textureLoad(working,at,layer,0).rgb;
  let camera=vec3f(
    u.red.x*rgb.r+u.red.y*rgb.g+u.red.z*rgb.b,
    u.green.x*rgb.r+u.green.y*rgb.g+u.green.z*rgb.b,
    u.blue.x*rgb.r+u.blue.y*rgb.g+u.blue.z*rgb.b);
  textureStore(nativeOut,at,layer,vec4f(camera,f32(textureLoad(canonical,at,layer,0).r)));
}

@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) p:vec3u) {
  if(any(p.xy>=u.size.zw)) { return; }
  // Integer pixel-edge numerators preserve positive area footprints at exact boundaries.
  let firstNumerator=p.xy*u.size.xy;
  let lastNumerator=(p.xy+1u)*u.size.xy;
  let first=firstNumerator/u.size.zw;
  let last=(lastNumerator+u.size.zw-1u)/u.size.zw;
  var sum=vec3f(0.);
  var total=0.;
  var valid=7u;
  for(var y=first.y;y<last.y;y++) {
    let wy=f32(min((y+1u)*u.size.w,lastNumerator.y)-max(y*u.size.w,firstNumerator.y))/f32(u.size.w);
    for(var x=first.x;x<last.x;x++) {
      let wx=f32(min((x+1u)*u.size.z,lastNumerator.x)-max(x*u.size.z,firstNumerator.x))/f32(u.size.z);
      let weight=wx*wy;
      let sample=textureLoad(nativeIn,vec2i(i32(x),i32(y%LAYER_ROWS)),i32(y/LAYER_ROWS),0);
      var usable=u32(sample.a);
      if(sample.r<=u.limits.x) {usable=usable&6u;}
      if(sample.g<=u.limits.x) {usable=usable&5u;}
      if(sample.b<=u.limits.x) {usable=usable&3u;}
      valid=valid&usable;
      sum=sum+sample.rgb*weight;
      total=total+weight;
    }
  }
  let average=sum/total;
  textureStore(reducedOut,vec2i(p.xy),vec4f(
    select(0.,average.r,(valid&1u)!=0u),
    select(0.,average.g,(valid&2u)!=0u),
    select(0.,average.b,(valid&4u)!=0u),f32(valid)));
}
`

export interface CameraStudyObservation {
  completedWallMs: number
  submissionMs: number
  completionFenceMs: number
  projectionGpuMs: number | null
  reductionGpuMs: number | null
  timestampReadbackMs: number
}

export interface CameraStudyCheckpoint {
  phase: 'uploaded-layer' | 'submitted' | 'completed' | 'native-readback' | 'reduced-readback'
  top?: number
}

export interface CameraStudyOptions {
  signal?: AbortSignal
  /** Research-only deterministic lifecycle probes, outside the production API. */
  checkpoint?: (event: CameraStudyCheckpoint) => void | Promise<void>
}

/** Native Dawn research only; production keeps its current CPU camera evidence writer. */
export async function createCameraStudy(
  device: GPUDevice,
  input: CameraStudyInput,
  options: CameraStudyOptions = {},
) {
  options.signal?.throwIfAborted()
  const { width, height, reducedWidth, reducedHeight } = input
  if (
    ![width, height, reducedWidth, reducedHeight].every((v) => Number.isSafeInteger(v) && v > 0) ||
    reducedWidth > width ||
    reducedHeight > height ||
    input.rgba.length !== width * height * 4 ||
    input.valid.length !== width * height ||
    input.inverse.length !== 9 ||
    !input.inverse.every(Number.isFinite) ||
    !Number.isFinite(input.minimumSignal) ||
    input.minimumSignal < 0 ||
    input.valid.some((value) => value > 7)
  )
    throw new Error('Invalid research camera preparation input.')
  if (Math.max(width, height) > device.limits.maxTextureDimension2D)
    throw new Error('Research camera dimensions exceed the adapter limit.')
  const layerRows = Math.min(STRIP_ROWS, height),
    layerCount = Math.ceil(height / STRIP_ROWS),
    nativeTextureRows = layerRows * layerCount,
    maximumUploadBytes = width * layerRows * 16,
    timestamped = device.features.has('timestamp-query')
  if (layerCount > device.limits.maxTextureArrayLayers || maximumUploadBytes > TRANSFER_BYTES)
    throw new Error('Research camera layers exceed the adapter or bounded transfer limit.')
  const stagingBytes = align(width * 16) * Math.min(STRIP_ROWS, height)
  const allocatedGpuBytes =
    width * nativeTextureRows * 36 +
    reducedWidth * reducedHeight * 16 +
    stagingBytes +
    80 +
    (timestamped ? 96 : 0)
  if (allocatedGpuBytes > CAMERA_STUDY_GPU_LIMIT || stagingBytes > device.limits.maxBufferSize)
    throw new Error('Research camera preparation exceeds its fixed 1 GiB logical GPU limit.')

  const textures: GPUTexture[] = [],
    buffers: GPUBuffer[] = []
  let queries: GPUQuerySet | undefined
  let disposed = false,
    active = false,
    closing = false,
    lost: GPUDeviceLostInfo | undefined,
    settle: (() => void) | undefined,
    idle = Promise.resolve()
  void device.lost.then((info) => {
    lost = info
  })
  const check = (signal = options.signal) => {
    signal?.throwIfAborted()
    if (disposed) throw new Error('Research camera study is disposed.')
    if (lost) throw new Error(`Research camera study device lost: ${lost.reason}.`)
  }
  const fence = async () => {
    try {
      await device.queue.onSubmittedWorkDone()
    } catch (error) {
      if (lost)
        throw new Error(`Research camera study device lost: ${lost.reason}.`, { cause: error })
      throw error
    }
  }
  const checkpoint = async (event: CameraStudyCheckpoint, signal = options.signal) => {
    await options.checkpoint?.(event)
    check(signal)
  }
  const begin = (signal?: AbortSignal) => {
    check(signal)
    if (closing || active) throw new Error('Research camera study is closing or already active.')
    active = true
    idle = new Promise<void>((resolve) => {
      settle = resolve
    })
  }
  const end = () => {
    active = false
    settle?.()
    settle = undefined
  }
  const destroy = () => {
    if (disposed) return
    if (active) throw new Error('Research camera study must drain before resource destruction.')
    closing = true
    disposed = true
    queries?.destroy()
    for (const texture of textures) texture.destroy()
    for (const buffer of buffers) buffer.destroy()
  }
  const close = async () => {
    closing = true
    await idle
    try {
      await fence()
    } catch {
      // A lost device still needs all research-owned resources released.
    } finally {
      destroy()
    }
  }
  const texture = (w: number, h: number, format: GPUTextureFormat, layers = 1) => {
    const value = device.createTexture({
      size: [w, h, layers],
      format,
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING,
    })
    textures.push(value)
    return value
  }
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    buffers.push(value)
    return value
  }
  const started = performance.now()
  try {
    // Bound each texture subresource as well as the source view: Dawn may clear an
    // entire uninitialized subresource with an internal upload before a partial copy.
    const working = texture(width, layerRows, 'rgba32float', layerCount),
      canonical = texture(width, layerRows, 'r32uint', layerCount),
      native = texture(width, layerRows, 'rgba32float', layerCount),
      reduced = texture(reducedWidth, reducedHeight, 'rgba32float'),
      uniform = buffer(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      staging = buffer(stagingBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
    const allocationMs = performance.now() - started
    let resolve: GPUBuffer | undefined, queryReadback: GPUBuffer | undefined
    if (timestamped) {
      queries = device.createQuerySet({ type: 'timestamp', count: 4 })
      resolve = buffer(32, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC)
      queryReadback = buffer(32, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
    }
    const values = new Float32Array(20)
    new Uint32Array(values.buffer).set([width, height, reducedWidth, reducedHeight])
    for (let row = 0; row < 3; row++)
      values.set(input.inverse.slice(row * 3, row * 3 + 3), 4 + row * 4)
    values[16] = input.minimumSignal
    // For Float32 samples, comparison to the greatest Float32 <= the CPU threshold
    // exactly preserves the original Float64 strict-greater-than classification.
    if (values[16] > input.minimumSignal) new Uint32Array(values.buffer)[16]--
    device.queue.writeBuffer(uniform, 0, values)
    const uploading = performance.now()
    for (let top = 0; top < height; top += STRIP_ROWS) {
      const rows = Math.min(STRIP_ROWS, height - top),
        layer = top / STRIP_ROWS,
        pixels = new Float32Array(width * layerRows * 4),
        masks = new Uint32Array(width * layerRows)
      pixels.set(input.rgba.subarray(top * width * 4, (top + rows) * width * 4))
      for (let i = 0; i < width * rows; i++) masks[i] = input.valid[top * width + i]
      device.queue.writeTexture(
        { texture: working, origin: [0, 0, layer] },
        pixels,
        { bytesPerRow: width * 16 },
        [width, layerRows],
      )
      device.queue.writeTexture(
        { texture: canonical, origin: [0, 0, layer] },
        masks,
        { bytesPerRow: width * 4 },
        [width, layerRows],
      )
      await fence()
      await checkpoint({ phase: 'uploaded-layer', top })
    }
    const uploadMs = performance.now() - uploading
    const compiling = performance.now()
    const module = device.createShaderModule({
      code: cameraStudyWgsl,
      label: 'Research camera evidence',
    })
    const projectLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'uint', viewDimension: '2d-array' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba32float',
            viewDimension: '2d-array',
          },
        },
      ],
    })
    const reduceLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
      ],
    })
    const project = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [projectLayout] }),
      compute: { module, entryPoint: 'project' },
    })
    const reduction = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [reduceLayout] }),
      compute: { module, entryPoint: 'reduce' },
    })
    check()
    const projectGroup = device.createBindGroup({
      layout: projectLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: working.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: canonical.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: native.createView({ dimension: '2d-array' }) },
      ],
    })
    const reduceGroup = device.createBindGroup({
      layout: reduceLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 4, resource: native.createView({ dimension: '2d-array' }) },
        { binding: 5, resource: reduced.createView() },
      ],
    })
    const compileMs = performance.now() - compiling
    async function run(signal = options.signal): Promise<CameraStudyObservation> {
      begin(signal)
      const at = performance.now()
      try {
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginComputePass({
          timestampWrites: queries
            ? { querySet: queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
            : undefined,
        })
        pass.setPipeline(project)
        pass.setBindGroup(0, projectGroup)
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8))
        pass.end()
        const reducedPass = encoder.beginComputePass({
          timestampWrites: queries
            ? { querySet: queries, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 }
            : undefined,
        })
        reducedPass.setPipeline(reduction)
        reducedPass.setBindGroup(0, reduceGroup)
        reducedPass.dispatchWorkgroups(Math.ceil(reducedWidth / 8), Math.ceil(reducedHeight / 8))
        reducedPass.end()
        if (queries) {
          encoder.resolveQuerySet(queries, 0, 4, resolve!, 0)
          encoder.copyBufferToBuffer(resolve!, 0, queryReadback!, 0, 32)
        }
        device.queue.submit([encoder.finish()])
        const submissionMs = performance.now() - at,
          fencing = performance.now()
        // Cancellation after submission waits for the owned work before rejecting.
        try {
          await options.checkpoint?.({ phase: 'submitted' })
        } finally {
          await fence()
        }
        const completedWallMs = performance.now() - at,
          completionFenceMs = performance.now() - fencing
        await checkpoint({ phase: 'completed' }, signal)
        let projectionGpuMs: number | null = null,
          reductionGpuMs: number | null = null
        const reading = performance.now()
        if (queryReadback) {
          await queryReadback.mapAsync(GPUMapMode.READ)
          try {
            const times = new BigUint64Array(queryReadback.getMappedRange())
            projectionGpuMs = Number(times[1] - times[0]) / 1e6
            reductionGpuMs = Number(times[3] - times[2]) / 1e6
          } finally {
            queryReadback.unmap()
          }
        }
        check(signal)
        return {
          completedWallMs,
          submissionMs,
          completionFenceMs,
          projectionGpuMs,
          reductionGpuMs,
          timestampReadbackMs: performance.now() - reading,
        }
      } finally {
        end()
      }
    }
    async function* strips(
      source: GPUTexture,
      w: number,
      h: number,
      layered = false,
      signal = options.signal,
    ) {
      begin(signal)
      try {
        for (let top = 0; top < h; top += STRIP_ROWS) {
          check(signal)
          const rows = Math.min(STRIP_ROWS, h - top),
            bytesPerRow = align(w * 16),
            encoder = device.createCommandEncoder()
          encoder.copyTextureToBuffer(
            { texture: source, origin: layered ? [0, 0, top / STRIP_ROWS] : [0, top] },
            { buffer: staging, bytesPerRow, rowsPerImage: rows },
            [w, rows],
          )
          device.queue.submit([encoder.finish()])
          await staging.mapAsync(GPUMapMode.READ, 0, bytesPerRow * rows)
          let data: Float32Array<ArrayBuffer>
          try {
            const mapped = new Float32Array(staging.getMappedRange(0, bytesPerRow * rows))
            data = new Float32Array(w * rows * 4)
            for (let row = 0; row < rows; row++)
              data.set(
                mapped.subarray((row * bytesPerRow) / 4, (row * bytesPerRow) / 4 + w * 4),
                row * w * 4,
              )
          } finally {
            staging.unmap()
          }
          await checkpoint({ phase: layered ? 'native-readback' : 'reduced-readback', top }, signal)
          yield { top, rows, data }
        }
      } finally {
        end()
      }
    }
    return {
      run,
      nativeStrips: (signal?: AbortSignal) => strips(native, width, height, true, signal),
      reducedStrips: (signal?: AbortSignal) =>
        strips(reduced, reducedWidth, reducedHeight, false, signal),
      allocatedGpuBytes,
      layerRows,
      layerCount,
      paddedNativeRows: nativeTextureRows - height,
      maximumUploadBytes,
      allocationMs,
      uploadMs,
      compileMs,
      timestamped,
      destroy,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export type CameraStudy = Awaited<ReturnType<typeof createCameraStudy>>
