/// <reference types="@webgpu/types" />
import {
  diagnosticColors,
  diagnosticLevels,
  diagnosticTarget,
  encodeDiagnosticChannel,
  type PreviewPreference,
} from '../../shared/hdr-display'
import './hdr-diagnostic.css'

const canvas = document.querySelector<HTMLCanvasElement>('#patches')!
const mode = document.querySelector<HTMLSelectElement>('#mode')!
const gamut = document.querySelector<HTMLSelectElement>('#gamut')!
const status = document.querySelector<HTMLElement>('#status')!
const report = document.querySelector<HTMLElement>('#report')!
let generation = 0
let device: GPUDevice | undefined
let context: GPUCanvasContext | null = null
let details: ScreenDetails | undefined
let screenListeners: AbortController | undefined
let unavailable: string | null = 'WebGPU has not been probed.'
let screenError: string | null = null
let adapterInfo: Record<string, unknown> | null = null
let probing = false
let pendingProbe = false
let stopped = false
let last: Record<string, unknown> = {}

function publish(extra: Record<string, unknown>): void {
  last = { ...last, ...extra, timestamp: new Date().toISOString() }
  report.textContent = JSON.stringify(last, null, 2)
  console.info('IRODORI_HDR_REPORT ' + JSON.stringify(last))
}

function target() {
  return diagnosticTarget(
    mode.value as PreviewPreference,
    details?.currentScreen.hdrHeadroom,
    unavailable,
    generation,
  )
}

function clear(): void {
  // Hide obsolete pixels immediately, including while requestAdapter is pending.
  canvas.style.visibility = 'hidden'
  context?.unconfigure()
}

async function draw(): Promise<void> {
  const current = ++generation
  clear()
  const output = target()
  const screen = details?.currentScreen
  status.textContent = `${output.mode.toUpperCase()} · ${output.reason}`
  publish({
    state: 'probing',
    target: output,
    adapter: adapterInfo,
    screen: screen
      ? {
          label: screen.label,
          left: screen.left,
          top: screen.top,
          width: screen.width,
          height: screen.height,
          hdrHeadroomStops: screen.hdrHeadroom ?? null,
        }
      : null,
    devicePixelRatio: window.devicePixelRatio,
    dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
    configured: null,
    timing: null,
    colorEncoding: 'extended-srgb-transfer-v1',
    reference: 'relative linear RGB; 1 = reference white; absolute nits unknown',
    physicalOutputVerified: false,
    error: null,
    screenError,
  })
  if (!device || !context) {
    publish({ state: 'unavailable' })
    return
  }
  const activeDevice = device
  const started = performance.now()
  activeDevice.pushErrorScope('validation')
  let scopeOpen = true
  try {
    const colorSpace = gamut.value as PredefinedColorSpace
    canvas.width = Math.min(4096, Math.round(canvas.clientWidth * window.devicePixelRatio))
    canvas.height = Math.min(2048, Math.round(canvas.clientHeight * window.devicePixelRatio))
    context.configure({
      device: activeDevice,
      format: 'rgba16float',
      colorSpace,
      alphaMode: 'opaque',
      toneMapping: { mode: output.mode === 'hdr' ? 'extended' : 'standard' },
    })
    const configuration = context.getConfiguration()
    if (
      configuration?.toneMapping?.mode !== (output.mode === 'hdr' ? 'extended' : 'standard') ||
      configuration.format !== 'rgba16float' ||
      configuration.colorSpace !== colorSpace ||
      configuration.alphaMode !== 'opaque'
    )
      throw new Error('The requested canvas format, encoding, or tone mapping was not retained.')
    const colors = diagnosticColors.flatMap(({ rgb }) =>
      diagnosticLevels.map((level) =>
        rgb.map((channel) =>
          encodeDiagnosticChannel(
            output.mode === 'sdr' ? Math.min(1, channel * level) : channel * level,
          ),
        ),
      ),
    )
    // Constant patches avoid texture uploads; no photo data or native decoder enters this process.
    const module = activeDevice.createShaderModule({
      code: `
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
          return vec4f(p[i], 0., 1.);
        }
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          let colors = array<vec3f, 24>(${colors.map((rgb) => `vec3f(${rgb.map((v) => v.toFixed(9)).join(', ')})`).join(',')});
          let column = min(5u, u32(p.x * 6. / ${canvas.width}.));
          let row = min(3u, u32(p.y * 4. / ${canvas.height}.));
          return vec4f(colors[row * 6u + column], 1.);
        }`,
    })
    const pipeline = await activeDevice.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    })
    if (generation !== current || device !== activeDevice || stopped) return
    const encoder = activeDevice.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.draw(3)
    pass.end()
    activeDevice.queue.submit([encoder.finish()])
    await activeDevice.queue.onSubmittedWorkDone()
    scopeOpen = false
    const error = await activeDevice.popErrorScope()
    if (error) throw new Error(error.message)
    if (generation !== current || stopped) return
    canvas.style.visibility = 'visible'
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    if (generation !== current || stopped) return
    publish({
      state: 'presented',
      configured: {
        format: configuration.format,
        colorSpace: configuration.colorSpace,
        toneMapping: configuration.toneMapping,
        alphaMode: configuration.alphaMode,
      },
      submittedLinearLevels: diagnosticLevels,
      timing: {
        submitAndTwoAnimationFramesMs: performance.now() - started,
        includesPipelineCreation: true,
        physicalScanoutMeasured: false,
      },
    })
  } catch (error) {
    if (generation !== current || stopped) return
    clear()
    unavailable = `Canvas presentation failed: ${String(error)}`
    status.textContent = `SDR · ${unavailable}`
    publish({ state: 'unavailable', target: target(), error: unavailable })
  } finally {
    if (scopeOpen) await activeDevice.popErrorScope().catch(() => undefined)
  }
}

async function screenDetails(): Promise<void> {
  screenListeners?.abort()
  screenListeners = new AbortController()
  const signal = screenListeners.signal
  screenError = null
  try {
    details = await window.getScreenDetails?.()
    details?.addEventListener('currentscreenchange', scheduleProbe, { signal })
    details?.addEventListener('screenschange', scheduleProbe, { signal })
    for (const screen of details?.screens ?? []) {
      screen.addEventListener('hdrheadroomchange', scheduleProbe, { signal })
      screen.addEventListener('change', scheduleProbe, { signal })
    }
  } catch (error) {
    details = undefined
    screenError = String(error)
  }
}

async function probe(): Promise<void> {
  if (stopped) return
  if (probing) {
    pendingProbe = true
    return
  }
  probing = true
  ++generation
  clear()
  const previous = device
  device = undefined
  previous?.destroy()
  adapterInfo = null
  try {
    await screenDetails()
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this runtime.')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter is available.')
    const info = adapter.info
    adapterInfo = {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
    }
    if (info.isFallbackAdapter) throw new Error('WebGPU selected a software adapter.')
    const next = await adapter.requestDevice()
    if (stopped) {
      next.destroy()
      return
    }
    device = next
    next.addEventListener('uncapturederror', (event) => {
      if (device !== next || stopped) return
      ++generation
      device = undefined
      clear()
      unavailable = `WebGPU failed: ${event.error.message}`
      next.destroy()
      void draw()
    })
    void next.lost.then((loss) => {
      if (device !== next || stopped) return
      ++generation
      device = undefined
      clear()
      unavailable = `WebGPU device lost: ${loss.message || loss.reason}`
      void draw()
    })
    context = canvas.getContext('webgpu')
    if (!context) throw new Error('A WebGPU canvas could not be created.')
    unavailable = null
  } catch (error) {
    unavailable = String(error)
  } finally {
    try {
      if (!stopped && !pendingProbe) await draw()
    } finally {
      probing = false
    }
    if (pendingProbe && !stopped) {
      pendingProbe = false
      void probe()
    }
  }
}

function scheduleProbe(): void {
  ++generation
  clear()
  void probe()
}
mode.addEventListener('change', scheduleProbe)
gamut.addEventListener('change', scheduleProbe)
document.querySelector('#retry')!.addEventListener('click', scheduleProbe)
document.querySelector('#lose')!.addEventListener('click', () => device?.destroy())
window.addEventListener('resize', scheduleProbe)
window.addEventListener('focus', scheduleProbe)
document.addEventListener('visibilitychange', scheduleProbe)
matchMedia('(dynamic-range: high)').addEventListener('change', scheduleProbe)
const removeResume = window.hdrDiagnostic.onResume(scheduleProbe)
window.addEventListener('pagehide', () => {
  stopped = true
  ++generation
  screenListeners?.abort()
  removeResume()
  clear()
  device?.destroy()
})
void probe()
