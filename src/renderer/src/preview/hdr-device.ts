/// <reference types="@webgpu/types" />
import { HDR_CACHE_MAX_TILES } from './hdr-render-cache'
let pending: Promise<GPUDevice> | undefined
export function hdrDevice(): Promise<GPUDevice> {
  return (pending ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter || adapter.info.isFallbackAdapter)
      throw new Error('A hardware WebGPU adapter is unavailable.')
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D),
        maxBufferSize: Math.min(512 * 1024 ** 2, adapter.limits.maxBufferSize),
        maxTextureArrayLayers: Math.min(HDR_CACHE_MAX_TILES, adapter.limits.maxTextureArrayLayers),
      },
    })
    void device.lost.then(() => {
      pending = undefined
    })
    return device
  })().catch((error) => {
    pending = undefined
    throw error
  }))
}

/** Each attempted color space owns its error scope, including synchronous failures. */
export async function probeHdrCanvas(device: GPUDevice, context: GPUCanvasContext) {
  let reason = 'Extended float canvas is unavailable.'
  for (const colorSpace of ['display-p3', 'srgb'] as const) {
    device.pushErrorScope('validation')
    let configuration: GPUCanvasConfiguration | null = null
    let failed = false
    try {
      context.configure({
        device,
        format: 'rgba16float',
        colorSpace,
        toneMapping: { mode: 'extended' },
        alphaMode: 'opaque',
      })
      configuration = context.getConfiguration()
    } catch (error) {
      failed = true
      reason = String(error)
    } finally {
      const error = await device.popErrorScope()
      context.unconfigure()
      if (error) {
        failed = true
        reason = error.message
      }
    }
    if (
      !failed &&
      configuration?.format === 'rgba16float' &&
      configuration.colorSpace === colorSpace &&
      configuration.toneMapping?.mode === 'extended'
    )
      return { p3: colorSpace === 'display-p3', extended: true }
  }
  throw new Error(reason)
}
