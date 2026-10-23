import type { RecoveryPatternMetadata } from './recovery-color-fixtures.helpers'

interface RecoveryColorGpuState {
  device: GPUDevice
  pipeline: GPURenderPipeline
  canvas: HTMLCanvasElement
  context: GPUCanvasContext
  adapter: Record<string, string | boolean>
  errors: string[]
  lost: boolean
  profile: 'raw-half'
}
type RecoveryColorWindow = Window & { recoveryColorGpu?: RecoveryColorGpuState }

export async function initializeRecoveryColorGpu() {
  if ('luma' in window)
    throw new Error('Synthetic recovery patterns require the catalog-free diagnostic.')
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter || adapter.info.isFallbackAdapter)
    throw new Error('Required hardware WebGPU is unavailable.')
  const device = await adapter.requestDevice(),
    canvas = document.createElement('canvas')
  canvas.hidden = true
  canvas.dataset.testid = 'synthetic-recovery-color-source'
  canvas.setAttribute('aria-label', 'Isolated synthetic recovery conversion source')
  document.body.append(canvas)
  const context = canvas.getContext('webgpu')
  if (!context) {
    device.destroy()
    canvas.remove()
    throw new Error('WebGPU canvas is unavailable.')
  }
  const module = device.createShaderModule({
    code: `
    @group(0) @binding(0) var<storage,read> pixels:array<vec4f>;
    @group(0) @binding(1) var<uniform> size:vec4u;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
      let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
    }
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
      return pixels[u32(p.y)*size.x+u32(p.x)];
    }`,
  })
  try {
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    })
    const state: RecoveryColorGpuState = {
      device,
      pipeline,
      canvas,
      context,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        fallback: adapter.info.isFallbackAdapter,
      },
      errors: [],
      lost: false,
      profile: 'raw-half',
    }
    device.addEventListener('uncapturederror', (event) => {
      if (state.errors.length < 16) state.errors.push(event.error.message)
    })
    void device.lost.then((info) => {
      state.lost = true
      if (state.errors.length < 16) state.errors.push(info.message)
    })
    ;(window as RecoveryColorWindow).recoveryColorGpu = state
    return {
      adapter: state.adapter,
      devicePixelRatio,
      sourceHidden: canvas.hidden,
      profile: state.profile,
      scope:
        'Actual hardware WebGPU RGBA16F canvas browser-copy conversion, synthetic catalog-free diagnostic; physical scanout/luminance unmeasured.',
    }
  } catch (error) {
    device.destroy()
    canvas.remove()
    throw error
  }
}

export async function compareRecoveryColor({
  input,
  metadata,
  mode,
  colorSpace,
}: {
  input: Float32Array
  metadata: RecoveryPatternMetadata
  mode: 'sdr' | 'hdr'
  colorSpace: PredefinedColorSpace
}) {
  const state = (window as RecoveryColorWindow).recoveryColorGpu
  if (!state || state.lost || state.errors.length)
    throw new Error(`Recovery GPU is unavailable: ${state?.errors.join('; ')}`)
  const { device, pipeline, canvas, context } = state,
    width = metadata.width,
    height = metadata.height,
    scale = Math.min(1, 1024 / Math.max(width, height)),
    outputWidth = Math.max(1, Math.round(width * scale)),
    outputHeight = Math.max(1, Math.round(height * scale)),
    digest = async (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('')
  if (width <= 1024 && height <= 1024)
    throw new Error('The source must require actual downsampling.')
  const inputBuffer = input.buffer
  if (!(inputBuffer instanceof ArrayBuffer))
    throw new Error('Recovery input must own non-shared ArrayBuffer storage.')
  if (
    input.length !== width * height * 4 ||
    input.byteLength > 32 * 1024 ** 2 ||
    !input.every(Number.isFinite)
  )
    throw new Error('Invalid bounded recovery fixture.')
  for (let i = 3; i < input.length; i += 4)
    if (input[i] !== 1) throw new Error('The presented fixture must be opaque.')
  const reference = document.createElement('canvas'),
    candidate = document.createElement('canvas')
  reference.width = candidate.width = outputWidth
  reference.height = candidate.height = outputHeight
  const cpu = reference.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }),
    candidateCpu = candidate.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true })
  if (!cpu || !candidateCpu) throw new Error('Required bounded Canvas2D contexts are unavailable.')
  const inputHash = await digest(inputBuffer),
    source = device.createBuffer({
      size: input.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  let scopeOpen = false,
    readback: GPUBuffer | undefined,
    reconstructed: HTMLCanvasElement | undefined
  try {
    canvas.width = width
    canvas.height = height
    context.configure({
      device,
      format: 'rgba16float',
      colorSpace,
      alphaMode: 'opaque',
      toneMapping: { mode: mode === 'hdr' ? 'extended' : 'standard' },
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const configuration = context.getConfiguration()
    if (
      configuration?.format !== 'rgba16float' ||
      configuration.colorSpace !== colorSpace ||
      configuration.alphaMode !== 'opaque' ||
      configuration.toneMapping?.mode !== (mode === 'hdr' ? 'extended' : 'standard')
    )
      throw new Error('The real source canvas did not retain the requested configuration.')
    device.pushErrorScope('validation')
    scopeOpen = true
    device.queue.writeBuffer(source, 0, inputBuffer, input.byteOffset, input.byteLength)
    device.queue.writeBuffer(uniform, 0, new Uint32Array([width, height, 0, 0]))
    const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: uniform } },
        ],
      }),
      encoder = device.createCommandEncoder(),
      sourceTexture = context.getCurrentTexture(),
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: sourceTexture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
      })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    const copying = performance.now()
    // The oracle and candidate capture this submitted drawing buffer in one task.
    // The unchanged CPU oracle is deliberately first and warms the source.
    cpu.drawImage(canvas, 0, 0, outputWidth, outputHeight)
    const expected = cpu.getImageData(0, 0, outputWidth, outputHeight),
      referenceMs = performance.now() - copying
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256,
      paddedGpuBytes = bytesPerRow * height,
      snapshotStarted = performance.now()
    readback = device.createBuffer({
      size: paddedGpuBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const copy = device.createCommandEncoder()
    copy.copyTextureToBuffer(
      { texture: sourceTexture },
      { buffer: readback, bytesPerRow, rowsPerImage: height },
      [width, height],
    )
    device.queue.submit([copy.finish()])
    const snapshotCopyEncodeAndSubmitMs = performance.now() - snapshotStarted,
      fencing = performance.now(),
      completion = device.queue.onSubmittedWorkDone(),
      mappedAt = performance.now()
    // Observe both owners even when device loss rejects one first.
    const settled = await Promise.allSettled([completion, readback.mapAsync(GPUMapMode.READ)])
    const fenceMs = performance.now() - fencing
    const snapshotMapMs = performance.now() - mappedAt,
      failure = settled.find((item) => item.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const owning = performance.now(),
      mapped = readback.getMappedRange(),
      owned = new Uint16Array(width * height * 4)
    for (let y = 0; y < height; y++)
      owned.set(new Uint16Array(mapped, y * bytesPerRow, width * 4), y * width * 4)
    readback.unmap()
    readback.destroy()
    readback = undefined
    context.unconfigure()
    const snapshotCpuOwnershipMs = performance.now() - owning
    for (let i = 3; i < owned.length; i += 4)
      if (owned[i] !== 0x3c00)
        throw new Error('Raw snapshot did not retain opaque half-float alpha.')
    const Float16 = (
      globalThis as unknown as {
        Float16Array?: new (buffer: ArrayBuffer) => ArrayBufferView<ArrayBuffer>
      }
    ).Float16Array
    if (!Float16)
      throw new Error('Float16Array is unavailable; raw-half reconstruction is unsupported.')
    const converting = performance.now(),
      reconstructedPixels = Reflect.construct(ImageData, [
        new Float16(owned.buffer),
        width,
        height,
        { colorSpace, pixelFormat: 'rgba-float16' },
      ]) as ImageData & { pixelFormat?: string }
    if (
      reconstructedPixels.pixelFormat !== 'rgba-float16' ||
      reconstructedPixels.colorSpace !== colorSpace ||
      reconstructedPixels.data.constructor.name !== 'Float16Array' ||
      reconstructedPixels.data.buffer !== owned.buffer
    )
      throw new Error('ImageData did not retain raw half-float storage and source gamut.')
    reconstructed = document.createElement('canvas')
    reconstructed.width = width
    reconstructed.height = height
    const requested = { colorSpace, colorType: 'float16', willReadFrequently: true },
      reconstructedContext = reconstructed.getContext(
        '2d',
        requested,
      ) as CanvasRenderingContext2D | null
    if (!reconstructedContext)
      throw new Error('Source-gamut CPU float16 reconstruction is unavailable.')
    const attributes =
      reconstructedContext.getContextAttributes() as CanvasRenderingContext2DSettings & {
        colorType?: string
      }
    if (
      attributes.colorSpace !== colorSpace ||
      attributes.colorType !== 'float16' ||
      attributes.willReadFrequently !== true
    )
      throw new Error(
        'The reconstructed CPU canvas did not retain the requested float16 source gamut.',
      )
    reconstructedContext.putImageData(reconstructedPixels, 0, 0)
    candidateCpu.drawImage(reconstructed, 0, 0, outputWidth, outputHeight)
    const rareConversionMs = performance.now() - converting
    const candidateDrawMs = rareConversionMs
    const rawHalfSnapshot = {
      bytesPerRow,
      paddedGpuBytes,
      ownedCpuBytes: owned.byteLength,
      sha256: await digest(owned.buffer),
      snapshotCopyEncodeAndSubmitMs,
      snapshotMapMs,
      snapshotCpuOwnershipMs,
      rareConversionMs,
      rareConversionAndReadbackMs: 0,
      reconstructedContext: attributes,
      reconstructedImageData: {
        pixelFormat: reconstructedPixels.pixelFormat ?? null,
        colorSpace: reconstructedPixels.colorSpace,
        constructor: reconstructedPixels.data.constructor.name,
      },
      sourceUnconfiguredBeforeConversion: true,
      readbackDestroyedBeforeConversion: true,
    }
    const reading = performance.now(),
      actual = candidateCpu.getImageData(0, 0, outputWidth, outputHeight),
      candidateReadMs = performance.now() - reading
    rawHalfSnapshot.rareConversionAndReadbackMs = rawHalfSnapshot.rareConversionMs + candidateReadMs
    if (
      expected.data.length !== outputWidth * outputHeight * 4 ||
      actual.data.length !== expected.data.length ||
      expected.data.constructor.name !== 'Uint8ClampedArray' ||
      actual.data.constructor.name !== 'Uint8ClampedArray'
    )
      throw new Error('Recovery readback did not retain the complete bounded RGBA8 plane.')
    if (cpu.isContextLost() || candidateCpu.isContextLost() || state.lost)
      throw new Error('A recovery conversion context was lost.')
    const validation = await device.popErrorScope()
    scopeOpen = false
    if (validation || state.errors.length)
      throw new Error(validation?.message ?? state.errors.join('; '))
    const changedRGBA = [0, 0, 0, 0],
      negativeRGBA = [0, 0, 0, 0],
      positiveRGBA = [0, 0, 0, 0],
      signedRGBA = [0, 0, 0, 0],
      squaredRGBA = [0, 0, 0, 0],
      distribution: Record<string, number> = {},
      firstDifferences: Array<{
        x: number
        y: number
        channel: number
        reference: number
        actual: number
      }> = []
    let maxRgbCodeDifference = 0,
      maxAlphaCodeDifference = 0,
      changedPixels = 0,
      referenceMinimumRgbCode = 255,
      referenceMaximumRgbCode = 0,
      referenceMinimumAlphaCode = 255,
      referenceMaximumAlphaCode = 0,
      referencePixelsDifferentFromFirst = 0
    for (let i = 0; i < actual.data.length; i += 4) {
      let changed = false
      referencePixelsDifferentFromFirst += Number(
        expected.data[i] !== expected.data[0] ||
          expected.data[i + 1] !== expected.data[1] ||
          expected.data[i + 2] !== expected.data[2],
      )
      for (let channel = 0; channel < 4; channel++) {
        const delta = actual.data[i + channel] - expected.data[i + channel]
        if (channel < 3) {
          referenceMinimumRgbCode = Math.min(referenceMinimumRgbCode, expected.data[i + channel])
          referenceMaximumRgbCode = Math.max(referenceMaximumRgbCode, expected.data[i + channel])
        } else {
          referenceMinimumAlphaCode = Math.min(
            referenceMinimumAlphaCode,
            expected.data[i + channel],
          )
          referenceMaximumAlphaCode = Math.max(
            referenceMaximumAlphaCode,
            expected.data[i + channel],
          )
        }
        if (channel < 3) maxRgbCodeDifference = Math.max(maxRgbCodeDifference, Math.abs(delta))
        else maxAlphaCodeDifference = Math.max(maxAlphaCodeDifference, Math.abs(delta))
        signedRGBA[channel] += delta
        squaredRGBA[channel] += delta * delta
        if (!delta) continue
        changed = true
        changedRGBA[channel]++
        if (delta < 0) negativeRGBA[channel]++
        else positiveRGBA[channel]++
        if (channel < 3) distribution[String(delta)] = (distribution[String(delta)] ?? 0) + 1
        if (firstDifferences.length < 32)
          firstDifferences.push({
            x: (i / 4) % outputWidth,
            y: Math.floor(i / 4 / outputWidth),
            channel,
            reference: expected.data[i + channel],
            actual: actual.data[i + channel],
          })
      }
      changedPixels += Number(changed)
    }
    const monotonicity = {
      applicable: !!metadata.monotone,
      referenceViolations: [0, 0, 0],
      candidateViolations: [0, 0, 0],
      referenceMaximumDecrease: [0, 0, 0],
      candidateMaximumDecrease: [0, 0, 0],
    }
    if (metadata.monotone)
      for (let y = 0; y < outputHeight; y++)
        for (let x = 1; x < outputWidth; x++)
          for (let c = 0; c < 3; c++) {
            const at = (y * outputWidth + x) * 4 + c,
              referenceDecrease = expected.data[at - 4] - expected.data[at],
              candidateDecrease = actual.data[at - 4] - actual.data[at]
            monotonicity.referenceViolations[c] += Number(referenceDecrease > 0)
            monotonicity.candidateViolations[c] += Number(candidateDecrease > 0)
            monotonicity.referenceMaximumDecrease[c] = Math.max(
              monotonicity.referenceMaximumDecrease[c],
              referenceDecrease,
            )
            monotonicity.candidateMaximumDecrease[c] = Math.max(
              monotonicity.candidateMaximumDecrease[c],
              candidateDecrease,
            )
          }
    const pixels = outputWidth * outputHeight,
      rgbChanged = changedRGBA[0] + changedRGBA[1] + changedRGBA[2],
      attrs = (value: CanvasRenderingContext2D) =>
        value.getContextAttributes() as CanvasRenderingContext2DSettings & { colorType?: string }
    return {
      metadata,
      profile: state.profile,
      rawHalfSnapshot,
      inputSha256: inputHash,
      sourceConfiguration: {
        format: configuration.format,
        colorSpace: configuration.colorSpace,
        alphaMode: configuration.alphaMode,
        toneMapping: configuration.toneMapping,
        usage: configuration.usage,
      },
      referenceContext: attrs(cpu),
      candidateContext: attrs(candidateCpu),
      acceleration:
        'Explicit GPU texture-to-buffer copy; owned CPU half-float bits; source-gamut CPU float16 canvas and CPU sRGB8 downsample. No retained GPU resource is used for rare conversion.',
      referenceReadback: {
        colorSpace: expected.colorSpace,
        constructor: expected.data.constructor.name,
      },
      candidateReadback: {
        colorSpace: actual.colorSpace,
        constructor: actual.data.constructor.name,
      },
      outputWidth,
      outputHeight,
      actualDownscale: Math.max(width, height) > Math.max(outputWidth, outputHeight),
      referenceSha256: await digest(expected.data.buffer as ArrayBuffer),
      candidateSha256: await digest(actual.data.buffer as ArrayBuffer),
      referencePixelsDifferentFromFirst,
      referenceRgbCodeRange: { minimum: referenceMinimumRgbCode, maximum: referenceMaximumRgbCode },
      referenceAlphaCodeRange: {
        minimum: referenceMinimumAlphaCode,
        maximum: referenceMaximumAlphaCode,
      },
      ownership: {
        source:
          'Same submitted RGBA16F drawing buffer; oracle draw and raw GPU copy precede first await; conversion uses only depadded owned CPU bits after readback destruction and source unconfiguration.',
        serialConversions: true,
        sourceClearedAfterFence: true,
      },
      maxRgbCodeDifference,
      maxAlphaCodeDifference,
      changedRGBA,
      negativeRGBA,
      positiveRGBA,
      changedPixels,
      changedRgbFraction: rgbChanged / (pixels * 3),
      changedPixelFraction: changedPixels / pixels,
      meanSignedRGBA: signedRGBA.map((value) => value / pixels),
      rmsRGBA: squaredRGBA.map((value) => Math.sqrt(value / pixels)),
      distribution,
      monotonicity,
      firstDifferences,
      acceptedRecoveryBound: {
        policy: 'float16-cpu-snapshot-v1',
        maxRgbCodeDifference: 1,
        maxAlphaCodeDifference: 0,
        passed: maxRgbCodeDifference <= 1 && maxAlphaCodeDifference === 0,
      },
      strictZeroComparison: {
        role: 'measurement-only',
        referenceCriterion: { maxRgbCodeDifference: 0, maxAlphaCodeDifference: 0 },
        observedMaximumRgbCodeDifference: maxRgbCodeDifference,
        observedMaximumAlphaCodeDifference: maxAlphaCodeDifference,
        changedRGBA,
        identical: maxRgbCodeDifference === 0 && maxAlphaCodeDifference === 0,
      },
      timings: {
        referenceMs,
        candidateDrawMs,
        fenceMs,
        candidateReadMs,
        boundary:
          'Diagnostic software elapsed stages only; CPU oracle warms the source. No cadence or physical GPU timing acceptance.',
      },
    }
  } finally {
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    if (readback?.mapState === 'mapped') readback.unmap()
    readback?.destroy()
    if (reconstructed) reconstructed.width = reconstructed.height = 0
    if (scopeOpen) await device.popErrorScope().catch(() => undefined)
    context.unconfigure()
    source.destroy()
    uniform.destroy()
    reference.width = candidate.width = 0
    reference.height = candidate.height = 0
    canvas.width = canvas.height = 0
  }
}

export async function disposeRecoveryColorGpu() {
  const host = window as RecoveryColorWindow,
    state = host.recoveryColorGpu
  if (!state) return
  await state.device.queue.onSubmittedWorkDone().catch(() => undefined)
  state.context.unconfigure()
  state.canvas.remove()
  state.device.destroy()
  delete host.recoveryColorGpu
}

/** Isolated strict-await bandwidth experiment; no CPU oracle reads or browser canvas copies. */
export async function measureRawHalfSnapshotThroughput({
  width,
  height,
  trials,
}: {
  width: number
  height: number
  trials: number
}) {
  const state = (window as RecoveryColorWindow).recoveryColorGpu
  if (!state || state.lost || state.errors.length)
    throw new Error(`Recovery GPU is unavailable: ${state?.errors.join('; ')}`)
  if (
    width !== 2866 ||
    height !== 1189 ||
    !Number.isSafeInteger(trials) ||
    trials < 60 ||
    trials > 120
  )
    throw new Error(
      'Throughput profile requires the retained 2866×1189 native editor viewport and 60–120 trials.',
    )
  const { device } = state,
    rowBytes = width * 8,
    bytesPerRow = Math.ceil(rowBytes / 256) * 256,
    paddedGpuBytes = bytesPerRow * height,
    ownedCpuBytes = rowBytes * height,
    owned = [new Uint16Array(width * height * 4), new Uint16Array(width * height * 4)],
    source = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING,
    }),
    readback = device.createBuffer({
      size: paddedGpuBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    code = `
      @group(0) @binding(0) var<uniform> serial:vec4u;
      fn noise(input:u32)->f32 {
        var x=input; x=x^(x<<13u); x=x^(x>>17u); x=x^(x<<5u);
        return f32(x&65535u)/65535.;
      }
      @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
        let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.)); return vec4f(p[i],0.,1.);
      }
      @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
        if(p.x<1. && p.y<1.) { return vec4f(f32(serial.x)/128.,.5,.25,1.); }
        let seed=u32(p.x)+u32(p.y)*${width}u+serial.x*747796405u;
        return vec4f(noise(seed)*2.5-.1,noise(seed^2891336453u)*2.5,noise(seed^277803737u)*2.5,1.);
      }`,
    observations: Array<{
      serial: number
      slot: number
      sourceRenderFenceMs: number
      copyEncodeAndSubmitMs: number
      copyFenceMs: number
      mapMs: number
      mapAndFenceMs: number
      cpuOwnershipMs: number
      verificationMs: number
      snapshotCriticalPathMs: number
      trialMs: number
      marker: number[]
      expectedMarker: number[]
      matchingSerial: boolean
    }> = []
  const progress: {
    stage: string
    width: number
    height: number
    plannedTrials: number
    observations: typeof observations
    error?: string
  } = {
    stage: 'preparing',
    width,
    height,
    plannedTrials: trials,
    observations,
  }
  ;(window as Window & { rawHalfThroughputProgress?: typeof progress }).rawHalfThroughputProgress =
    progress
  let scopeOpen = false,
    sourceDestroyed = false,
    readbackDestroyed = false,
    publishedSerial = 0,
    mappedCount = 0,
    unmappedCount = 0
  try {
    const module = device.createShaderModule({ code }),
      pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }],
      })
    const Float16 = (
      globalThis as unknown as {
        Float16Array?: new (length: number) => { [index: number]: number; buffer: ArrayBuffer }
      }
    ).Float16Array
    if (!Float16) throw new Error('Float16Array is required for the independent serial witness.')
    const markerValues = new Float16(4),
      expectedMarker = new Uint16Array(markerValues.buffer),
      loopStarted = performance.now()
    device.pushErrorScope('validation')
    scopeOpen = true
    progress.stage = 'measuring'
    for (let serial = 1; serial <= trials; serial++) {
      if (state.lost || state.errors.length)
        throw new Error(`Recovery GPU failed: ${state.errors.join('; ')}`)
      const trialStarted = performance.now(),
        slot = (serial - 1) % owned.length,
        destination = owned[slot]
      device.queue.writeBuffer(uniform, 0, new Uint32Array([serial, 0, 0, 0]))
      const rendering = device.createCommandEncoder(),
        pass = rendering.beginRenderPass({
          colorAttachments: [
            {
              view: source.createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1],
            },
          ],
        })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
      device.queue.submit([rendering.finish()])
      const renderingFence = performance.now()
      await device.queue.onSubmittedWorkDone()
      const sourceRenderFenceMs = performance.now() - renderingFence,
        snapshotStarted = performance.now(),
        copying = device.createCommandEncoder()
      copying.copyTextureToBuffer(
        { texture: source },
        { buffer: readback, bytesPerRow, rowsPerImage: height },
        [width, height],
      )
      device.queue.submit([copying.finish()])
      const copyEncodeAndSubmitMs = performance.now() - snapshotStarted,
        waiting = performance.now()
      let copyFenceMs = 0,
        mapMs = 0
      const completion = device.queue.onSubmittedWorkDone().then(() => {
          copyFenceMs = performance.now() - waiting
        }),
        mapping = readback.mapAsync(GPUMapMode.READ).then(() => {
          mapMs = performance.now() - waiting
          mappedCount++
        }),
        settled = await Promise.allSettled([completion, mapping]),
        mapAndFenceMs = performance.now() - waiting,
        failure = settled.find((item) => item.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const owning = performance.now(),
        mapped = readback.getMappedRange()
      for (let y = 0; y < height; y++)
        destination.set(new Uint16Array(mapped, y * bytesPerRow, width * 4), y * width * 4)
      readback.unmap()
      unmappedCount++
      const cpuOwnershipMs = performance.now() - owning,
        snapshotCriticalPathMs = performance.now() - snapshotStarted,
        verifying = performance.now()
      markerValues[0] = serial / 128
      markerValues[1] = 0.5
      markerValues[2] = 0.25
      markerValues[3] = 1
      const marker = Array.from(destination.subarray(0, 4)),
        expected = Array.from(expectedMarker),
        matchingSerial =
          marker.every((value, index) => value === expected[index]) && serial > publishedSerial
      for (let i = 0; i < 64; i++) {
        const pixel = Math.min(width * height - 1, Math.floor((i * (width * height - 1)) / 63))
        if (destination[pixel * 4 + 3] !== 0x3c00)
          throw new Error(`Raw snapshot alpha witness failed at serial ${serial}.`)
      }
      if (!matchingSerial) throw new Error(`Raw snapshot serial witness failed: ${serial}.`)
      publishedSerial = serial
      observations.push({
        serial,
        slot,
        sourceRenderFenceMs,
        copyEncodeAndSubmitMs,
        copyFenceMs,
        mapMs,
        mapAndFenceMs,
        cpuOwnershipMs,
        verificationMs: performance.now() - verifying,
        snapshotCriticalPathMs,
        trialMs: performance.now() - trialStarted,
        marker,
        expectedMarker: expected,
        matchingSerial,
      })
    }
    const loopMs = performance.now() - loopStarted,
      validation = await device.popErrorScope()
    scopeOpen = false
    if (validation || state.lost || state.errors.length)
      throw new Error(validation?.message ?? state.errors.join('; '))
    source.destroy()
    sourceDestroyed = true
    readback.destroy()
    readbackDestroyed = true
    const finalOwned = owned[(publishedSerial - 1) % owned.length],
      finalOwnedSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', finalOwned.buffer)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join(''),
      shaderSha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))),
        (n) => n.toString(16).padStart(2, '0'),
      ).join(''),
      quantiles = (key: keyof (typeof observations)[number]) => {
        const values = observations
            .map((row) => row[key])
            .filter((value): value is number => typeof value === 'number')
            .sort((a, b) => a - b),
          at = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)]
        return {
          minimum: values[0],
          p50: at(0.5),
          p95: at(0.95),
          p99: at(0.99),
          maximum: values[values.length - 1],
          mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        }
      }
    progress.stage = 'complete'
    return {
      profile: 'raw-half-throughput',
      mode: 'strict-await',
      width,
      height,
      format: 'rgba16float',
      plannedTrials: trials,
      completedTrials: observations.length,
      publishedSerial,
      mappedCount,
      unmappedCount,
      maximumInFlightSnapshots: 1,
      cpuOwnershipSlots: owned.length,
      rowBytes,
      bytesPerRow,
      paddedGpuBytes,
      ownedCpuBytes,
      requestedWorkingBytes: {
        sourceTexture: ownedCpuBytes,
        mapReadBuffer: paddedGpuBytes,
        cpuPlanes: ownedCpuBytes * owned.length,
        uniform: 16,
      },
      source: {
        kind: 'Persistent real GPU offscreen texture matching retained native editor viewport geometry.',
        shaderSha256,
        encoding:
          'Procedural nonuniform extended encoded RGB with an exact half-float serial witness; no photographs or CPU source upload.',
        renderedBeforeEveryCopy: true,
        cpuOracleRead: false,
        browserCanvasCopy: false,
      },
      ownership: {
        readbackUnmappedBeforeEveryWitness: true,
        sourceDestroyedBeforeFinalCpuHash: sourceDestroyed,
        readbackDestroyedBeforeFinalCpuHash: readbackDestroyed,
        finalOwnedSha256,
      },
      timings: {
        loopMs,
        snapshotCriticalPathMs: quantiles('snapshotCriticalPathMs'),
        sourceRenderFenceMs: quantiles('sourceRenderFenceMs'),
        copyEncodeAndSubmitMs: quantiles('copyEncodeAndSubmitMs'),
        copyFenceMs: quantiles('copyFenceMs'),
        mapMs: quantiles('mapMs'),
        mapAndFenceMs: quantiles('mapAndFenceMs'),
        cpuOwnershipMs: quantiles('cpuOwnershipMs'),
        verificationMs: quantiles('verificationMs'),
        trialMs: quantiles('trialMs'),
        snapshotsOver60HzInterval: observations.filter(
          (row) => row.snapshotCriticalPathMs > 1000 / 60,
        ).length,
        snapshotsOver120HzInterval: observations.filter(
          (row) => row.snapshotCriticalPathMs > 1000 / 120,
        ).length,
        boundary:
          'Sequential diagnostic elapsed stages without pacing or visible publication. Texture/buffers/CPU slots reused, render fenced before copy. Includes first trial; no CPU-oracle warming. These are not editor cadence or adoption gates.',
      },
      observations,
    }
  } catch (error) {
    progress.stage = 'failed'
    progress.error = String(error)
    throw error
  } finally {
    await device.queue.onSubmittedWorkDone().catch(() => undefined)
    if (readback.mapState === 'mapped') {
      readback.unmap()
    }
    if (!readbackDestroyed) readback.destroy()
    if (!sourceDestroyed) source.destroy()
    uniform.destroy()
    if (scopeOpen) await device.popErrorScope().catch(() => undefined)
  }
}
