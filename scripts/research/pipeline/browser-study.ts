import { createTileStudy, type TileRequest } from './gpu-study.ts'
import {
  FrameInputSchedule,
  meetsSamplingFrequency,
  SAMPLING_FREQUENCY_FRACTION,
  interaction,
  distribution,
  type InputEvent,
  type PresentedEvent,
} from './metrics.ts'
import { readHdrUploadBytes, validateHdrStrip } from '../../../src/renderer/src/preview/hdr-stream'

interface PresentationOptions {
  photoId: string
  parameters: number[][]
  inputFrames: number
  repetitions: number
  frequency: 60 | 120
}
export async function runPresentationStudy(options: PresentationOptions) {
  if (options.inputFrames < 240 || options.repetitions < 3)
    throw new Error('Sustained evidence requires three runs of at least 240 inputs.')
  const token = crypto.randomUUID(),
    started = performance.now()
  let cleanup = () => window.irodori.releaseFullPreview(token)
  try {
    const preview = await window.irodori.requestHdrPreview(options.photoId, token)
    if (!preview) throw new Error('A real managed HDR fixture is required.')
    const asset = { ...preview.linear.hdr, url: preview.linear.url }
    const data = new Float32Array(asset.byteLength / 4),
      readAt = performance.now()
    for await (const chunk of readHdrUploadBytes(asset)) {
      const strip = await validateHdrStrip(asset, chunk.index, chunk.bytes, chunk.readMs)
      data.set(strip.data, strip.row * asset.width * 4)
    }
    const validatedSourceReadMs = performance.now() - readAt
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter || adapter.info.isFallbackAdapter)
      throw new Error('A hardware Electron WebGPU adapter is required.')
    // Match the production HDR device limits. Dawn can require a full-image
    // initialization staging buffer even when queue uploads use bounded strips.
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: Math.min(512 * 1024 ** 2, adapter.limits.maxBufferSize),
        maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D),
        maxTextureArrayLayers: Math.min(256, adapter.limits.maxTextureArrayLayers),
      },
    })
    cleanup = async () => {
      device.destroy()
      await window.irodori.releaseFullPreview(token)
    }
    const errors: string[] = []
    device.addEventListener('uncapturederror', (event) => {
      if (errors.length < 8) errors.push(event.error.message)
    })
    const original = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
    const bounds = original.getBoundingClientRect(),
      canvas = document.createElement('canvas')
    Object.assign(canvas.style, {
      position: 'fixed',
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      zIndex: '10',
      pointerEvents: 'none',
      background: '#101010',
    })
    canvas.setAttribute('aria-label', 'Isolated image pipeline research canvas')
    document.body.append(canvas)
    cleanup = async () => {
      device.destroy()
      canvas.remove()
      await window.irodori.releaseFullPreview(token)
    }
    const study = await createTileStudy(
      device,
      { width: asset.width, height: asset.height, data },
      canvas,
    )
    const studyReadyMs = performance.now() - started
    cleanup = async () => {
      study.destroy()
      device.destroy()
      canvas.remove()
      await window.irodori.releaseFullPreview(token)
    }
    if (errors.length) throw new Error(errors[0])
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
    const intervals: number[] = []
    let previous = await frame()
    for (let i = 0; i < 30; i++) {
      const next = await frame()
      intervals.push(next - previous)
      previous = next
    }
    const displayInterval = distribution(intervals)
    const measuredDisplayFrequencyHz =
      (1000 * intervals.length) / intervals.reduce((sum, interval) => sum + interval, 0)
    const displayFrequencyAvailable = meetsSamplingFrequency(
      measuredDisplayFrequencyHz,
      options.frequency,
    )
    const cases: unknown[] = []
    let allInputSamplingRequirementsMet = true
    const base: TileRequest = {
      viewport: { width: bounds.width, height: bounds.height },
      view: {
        fit: true,
        scale: Math.min(1, bounds.width / asset.width, bounds.height / asset.height),
        x: 0,
        y: 0,
      },
      dpr: devicePixelRatio,
      parameters: options.parameters[0],
      identity: 'neutral',
      quality: 'normal',
      batchSize: 32,
      waitAfterBatch: false,
      histogram: true,
    }
    let activeSerial = 0
    for (const zoom of displayFrequencyAvailable ? ['fit', '100%', '800%'] : [])
      for (const quality of ['draft', 'normal'] as const)
        for (let repetition = 0; repetition < options.repetitions; repetition++) {
          const view = {
            ...base.view,
            fit: zoom === 'fit',
            scale: zoom === 'fit' ? base.view.scale : zoom === '100%' ? 1 : 8,
          }
          const inputs: InputEvent[] = [],
            presentations: PresentedEvent[] = [],
            completed: unknown[] = []
          let pending: { serial: number; parameters: number[] } | undefined,
            working: Promise<void> | undefined,
            failure: unknown
          const pump = async () => {
            while (pending) {
              const request = pending
              pending = undefined
              const result = await study.render(
                {
                  ...base,
                  view,
                  parameters: request.parameters,
                  identity: JSON.stringify(request.parameters),
                  quality,
                  batchSize: quality === 'draft' ? 8 : 32,
                  waitAfterBatch: quality === 'draft',
                },
                () => request.serial === activeSerial,
              )
              if (errors.length) throw new Error(errors[0])
              completed.push({ serial: request.serial, ...result })
              if (!result.cancelled) {
                // Completed queue work followed by an actual visible animation frame.
                // This is compositor cadence evidence, not physical scanout.
                await frame()
                presentations.push({ serial: request.serial, at: performance.now() })
              }
            }
          }
          const inputSchedule = new FrameInputSchedule(options.frequency)
          for (let i = 0; i < options.inputFrames; i++) {
            let timing = inputSchedule.takeFrame(await frame())
            while (!timing) timing = inputSchedule.takeFrame(await frame())
            const serial = ++activeSerial
            inputs.push({ serial, at: performance.now(), ...timing })
            pending = { serial, parameters: options.parameters[i % options.parameters.length] }
            if (!working)
              working = pump()
                .catch((error) => {
                  failure = error
                })
                .finally(() => {
                  working = undefined
                })
          }
          while (working || pending) {
            if (!working && pending)
              working = pump()
                .catch((error) => {
                  failure = error
                })
                .finally(() => {
                  working = undefined
                })
            if (working) await working
          }
          if (failure) throw failure
          if (!presentations.length)
            throw new Error('No completed research frame reached presentation.')
          const refinementAt = performance.now()
          const refinement = await study.render({
            ...base,
            view,
            parameters: options.parameters[(options.inputFrames - 1) % options.parameters.length],
            identity: JSON.stringify(
              options.parameters[(options.inputFrames - 1) % options.parameters.length],
            ),
            quality: 'normal',
          })
          await frame()
          const measuredInteraction = interaction(inputs, presentations)
          const inputSamplingRequirementMet = meetsSamplingFrequency(
            measuredInteraction.inputCadence.frequencyHz,
            options.frequency,
          )
          allInputSamplingRequirementsMet &&= inputSamplingRequirementMet
          cases.push({
            zoom,
            quality,
            repetition,
            requestedFrequency: options.frequency,
            measuredDisplayIntervalMs: displayInterval,
            measuredDisplayFrequencyHz,
            displayFrequencyAvailable,
            inputSamplingRequirementMet,
            frequencyAvailable: displayFrequencyAvailable && inputSamplingRequirementMet,
            minimumSamplingFrequencyFraction: SAMPLING_FREQUENCY_FRACTION,
            inputPolicy: 'latest pending; cancel at completed tile batches',
            inputTimingPolicy:
              'absolute deadlines accumulated from first native rAF; at most one input per native frame; actual dispatch and frame timestamps retained',
            inputFrameToleranceMs: inputSchedule.frameToleranceMs,
            inputOperators: [
              'Exposure',
              'Contrast',
              'Highlights',
              'Shadows',
              'Whites',
              'Blacks',
              'Temperature',
              'Tint',
            ],
            ...measuredInteraction,
            inputs,
            presentations,
            completed,
            refinementMs: performance.now() - refinementAt,
            refinement,
          })
        }
    const navigation: unknown[] = []
    for (const cold of displayFrequencyAvailable ? [true, false] : []) {
      for (let repetition = 0; repetition < 3; repetition++) {
        const samples: number[] = [],
          frames = []
        for (let i = 0; i < 30; i++) {
          const at = performance.now()
          const result = await study.render({
            ...base,
            view: { ...base.view, fit: false, scale: 1, x: i % 2 ? 4 : -4 },
            parameters: options.parameters[0],
            identity: 'sharp-navigation-fixed-edit',
            histogram: false,
            cold,
          })
          await frame()
          samples.push(performance.now() - at)
          frames.push(result)
        }
        navigation.push({
          cold,
          repetition,
          latencyMs: distribution(samples),
          frames,
          identityPolicy:
            'same source/rendering/edit identity only; all batches complete before publication',
        })
      }
    }
    return {
      source: {
        width: asset.width,
        height: asset.height,
        sha256: asset.sha256,
        descriptor: asset.source,
      },
      requestPreparedAssetThroughStudyReadyMs: studyReadyMs,
      validatedSourceReadMs,
      uploadAndMipsMs: study.uploadAndMipsMs,
      allocatedGpuBytes: study.allocatedGpuBytes,
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      deviceLimits: {
        maxBufferSize: device.limits.maxBufferSize,
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        maxTextureArrayLayers: device.limits.maxTextureArrayLayers,
      },
      viewport: base.viewport,
      dpr: base.dpr,
      displayInterval,
      cases,
      navigation,
      errors,
      measurementBoundary:
        'Research canvas using production operators/shaders and managed RAW; bypasses React input/history and transport. Actual slider benchmark remains separate.',
      measuredDisplayFrequencyHz,
      displayFrequencyAvailable,
      inputSamplingRequirementMet: cases.length > 0 && allInputSamplingRequirementsMet,
      minimumSamplingFrequencyFraction: SAMPLING_FREQUENCY_FRACTION,
      frequencyAvailable:
        displayFrequencyAvailable && cases.length > 0 && allInputSamplingRequirementsMet,
    }
  } finally {
    await cleanup()
  }
}
