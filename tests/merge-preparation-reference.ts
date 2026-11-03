// Frozen pre-consolidation LibRaw CPU oracle. Never imported by application code.
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { RawSource } from '../src/main/gpu/raw-source'
import { sensorBlendParameters, sensorBlendRgb } from '../src/main/gpu/sensor-blend'
import {
  cameraRegistrationWriter,
  type CameraRegistration,
} from '../src/main/merge/camera-registration'
import {
  createAreaReducer,
  createPreparationKernel,
  createSensorClippingMask,
} from '../src/main/merge/cpu-kernels'
import { expandMask, type Plane } from '../src/main/merge/math'
import { sourceCorrectionPlan } from '../src/main/merge/preparation-policy'
import { type SensorCache } from '../src/main/merge/sensor-cache'
import { cameraProfile } from '../src/main/processing/cameras'
import { rawDecoder } from '../src/main/processing/decoders'
import { radial } from '../src/main/processing/lens-correction'
import { SRGB_TO_2020, luminance } from '../src/shared/hdr'
import type { MergeMeasurements, MergePreparation } from '../src/shared/merge'
import {
  MERGE_LIMITS,
  type CameraPreparationPolicy,
  type MergeSource,
  type ReferencePreparationPolicy,
} from '../src/shared/merge'

function preparationWork(): NonNullable<MergeMeasurements['preparation'][number]['work']> {
  return {
    maskRepairMs: 0,
    cameraRegistrationMs: 0,
    hashingMs: 0,
    writingMs: 0,
    sensorCacheMs: 0,
    reductionMs: 0,
    conversionMs: 0,
    highlightBlendMs: 0,
    cpuKernel: { backend: 'scalar', heapBytes: 0, copyMs: 0, processingMs: 0 },
  }
}

function decoderWork(): NonNullable<MergeMeasurements['preparation'][number]['decoder']> {
  return { opens: 0, openingMs: 0, sensorMs: 0, linearMs: 0, saturationMaskMs: 0 }
}

export interface PreparedSource {
  path: string
  strips: string[]
  width: number
  height: number
  plane: Plane
  decoder: string
  cameraProfile: string
  normalization: import('../src/shared/hdr').HdrNormalization
  measurement?: MergeMeasurements['preparation'][number]
  gpuBytes?: number
  sensor?: SensorCache
  identity?: string
  cameraRegistration?: CameraRegistration
  cameraPreparation?: CameraPreparationPolicy
  referenceFallbackPreparation?: ReferencePreparationPolicy
  /** Alignment-only proxies select a camera channel; fusion sources never set this. */
  registrationChannel?: number
}
export async function prepareSourceReference(
  path: string,
  directory: string,
  index: number,
  source: MergeSource,
  reference: MergeSource,
  checkpoint: () => Promise<void>,
  preparation?: MergePreparation,
  highlightSafe = false,
  decoding = decoderWork(),
): Promise<PreparedSource> {
  const start = performance.now(),
    work = preparationWork()
  const decoder = rawDecoder(path)
  if (!decoder) throw new Error('Merge requires RAW sources.')
  const opening = performance.now(),
    session = await decoder.open(path)
  decoding.opens++
  decoding.openingMs += performance.now() - opening
  let frame: ReturnType<typeof session.linear>, saturated: Uint8Array, raw: RawSource
  try {
    if (!session.metadata.hdrEligible || session.metadata.model !== source.metadata.model)
      throw new Error('Unverified Sony RAW recording mode.')
    const sensorStart = performance.now(),
      sourceRaw = session.gpuSource(true)
    decoding.sensorMs += performance.now() - sensorStart
    if (!sourceRaw?.normalization?.sourceSaturation)
      throw new Error('Source saturation metadata is unavailable.')
    const thresholds = sourceRaw.normalization.sourceSaturation.thresholds
    raw = sourceRaw
    const saturationStart = performance.now()
    const nativeMask = await createSensorClippingMask(raw, work.cpuKernel!)
    if (nativeMask) saturated = nativeMask
    else {
      saturated = new Uint8Array(raw.width * raw.height)
      for (let y = 0; y < raw.height; y++)
        for (let x = 0; x < raw.width; x++) {
          const c = raw.cfa[(y % 2) * 2 + (x % 2)]
          saturated[y * raw.width + x] = Number(
            raw.pixels[(y + raw.top) * raw.rawWidth + x + raw.left] >= thresholds[c],
          )
        }
      saturated = expandMask(saturated, raw.width, raw.height, 2)
    }
    decoding.saturationMaskMs += performance.now() - saturationStart
    const linearStart = performance.now()
    frame = session.linear(true)
    decoding.linearMs += performance.now() - linearStart
  } finally {
    session.close()
  }
  const decodingMs = performance.now() - start
  const normal = frame.normalization!,
    gains = reference.metadata.whiteBalance!.asShotGains
  if (highlightSafe) {
    const blending = performance.now()
    const blend = sensorBlendParameters(normal)
    if (!blend) throw new Error('Verified camera highlight parameters are unavailable.')
    for (let top = 0; top < frame.height; top += 64) {
      await checkpoint()
      const last = Math.min(frame.height, top + 64) * frame.width * 4
      for (let i = top * frame.width * 4; i < last; i += 4)
        if (
          frame.data[i] > blend.saturation[0] ||
          frame.data[i + 1] > blend.saturation[1] ||
          frame.data[i + 2] > blend.saturation[2]
        )
          frame.data.set(
            sensorBlendRgb([frame.data[i], frame.data[i + 1], frame.data[i + 2]], blend),
            i,
          )
    }
    work.highlightBlendMs = performance.now() - blending
  }
  const plan = sourceCorrectionPlan(
    frame.width,
    frame.height,
    frame.flip,
    source,
    reference,
    preparation,
  )
  const width = frame.flip & 4 ? plan.height : plan.width,
    height = frame.flip & 4 ? plan.width : plan.height
  if (width * height > MERGE_LIMITS.maxPixels)
    throw new Error('Merge exceeds the pixel allocation limit.')
  const ratio = Math.min(1, MERGE_LIMITS.previewEdge / Math.max(width, height))
  const plane: Plane = {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    data: new Float32Array(0),
  }
  const strips: string[] = []
  const target = join(directory, `source-${index}.f32`),
    file = await open(target, 'wx')
  let camera: Awaited<ReturnType<typeof cameraRegistrationWriter>> | undefined
  const cx = (frame.width - 1) / 2,
    cy = (frame.height - 1) / 2,
    radius = Math.hypot(cx, cy),
    staging = new Float32Array(width * Math.min(64, height) * 4),
    stagingLuminance = new Float64Array(width * Math.min(64, height)),
    maximumGain = Math.max(...normal.gains),
    minimumGain = Math.min(...gains),
    cameraRgb = [0, 0, 0],
    rgb: [number, number, number] = [0, 0, 0],
    gainKeys = new Int32Array(2048).fill(-1),
    gainValues = new Float64Array(gainKeys.length),
    cacheableGainCoordinates = frame.width * frame.height <= 0x7fffffff
  // Integer sensor coordinates identify exact Float64 gains. Collisions only
  // recompute values; this local cache owns a fixed 24 KiB for one preparation.
  const gainAt = (x: number, y: number) => {
    if (!cacheableGainCoordinates) return radial(plan.lut, Math.hypot(x - cx, y - cy) / radius, 3)
    const key = y * frame.width + x,
      slot = key & (gainKeys.length - 1)
    if (gainKeys[slot] !== key) {
      gainValues[slot] = radial(plan.lut, Math.hypot(x - cx, y - cy) / radius, 3)
      gainKeys[slot] = key
    }
    return gainValues[slot]
  }
  const kernel = await createPreparationKernel(
      frame,
      plan,
      saturated,
      gains,
      work.cpuKernel!,
      undefined,
      { width: plane.width, height: plane.height },
    ),
    reduction =
      kernel?.reduction ??
      createAreaReducer(width, height, { width: plane.width, height: plane.height }, 'luminance')
  let accelerated = kernel
  try {
    if (preparation && !highlightSafe) {
      const cameraStart = performance.now()
      camera = await cameraRegistrationWriter(
        directory,
        index,
        raw,
        plan,
        plane.width,
        plane.height,
        work.cpuKernel,
      )
      work.cameraRegistrationMs += performance.now() - cameraStart
    }
    for (let top = 0; top < height; top += 64) {
      await checkpoint()
      const rows = Math.min(64, height - top),
        conversion = performance.now()
      let out = staging.subarray(0, width * rows * 4),
        native: ReturnType<NonNullable<typeof kernel>['convert']> | undefined
      if (accelerated) {
        try {
          native = accelerated.convert(top, rows)
          out = native.pixels
        } catch {
          accelerated = undefined
          work.cpuKernel!.backend = 'scalar'
        }
      }
      if (!native) {
        for (let y = top; y < top + rows; y++)
          for (let x = 0; x < width; x++) {
            let sx = frame.flip & 4 ? y : x,
              sy = frame.flip & 4 ? x : y
            if (frame.flip & 1) sx = plan.width - 1 - sx
            if (frame.flip & 2) sy = plan.height - 1 - sy
            const qx = sx + plan.left - cx,
              qy = sy + plan.top - cy,
              r = Math.hypot(qx, qy) / radius
            let clipped = false
            for (let c = 0; c < 3; c++) {
              const scale = radial(plan.lut, r, c),
                px = cx + qx * scale,
                py = cy + qy * scale
              const ix = Math.floor(px),
                iy = Math.floor(py),
                dx = px - ix,
                dy = py - iy
              let value = 0
              for (let yy = 0; yy < 2; yy++)
                for (let xx = 0; xx < 2; xx++) {
                  const tx = Math.max(0, Math.min(frame.width - 1, ix + xx)),
                    ty = Math.max(0, Math.min(frame.height - 1, iy + yy))
                  const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy)
                  value += frame.data[(ty * frame.width + tx) * 4 + c] * weight * gainAt(tx, ty)
                  if (weight > 0 && saturated[ty * frame.width + tx]) clipped = true
                }
              cameraRgb[c] = (((value * maximumGain) / normal.gains[c]) * gains[c]) / minimumGain
            }
            const cameraRed =
                frame.matrix[0] * cameraRgb[0] +
                frame.matrix[1] * cameraRgb[1] +
                frame.matrix[2] * cameraRgb[2],
              cameraGreen =
                frame.matrix[4] * cameraRgb[0] +
                frame.matrix[5] * cameraRgb[1] +
                frame.matrix[6] * cameraRgb[2],
              cameraBlue =
                frame.matrix[8] * cameraRgb[0] +
                frame.matrix[9] * cameraRgb[1] +
                frame.matrix[10] * cameraRgb[2]
            for (let c = 0; c < 3; c++)
              rgb[c] =
                SRGB_TO_2020[c * 3] * cameraRed +
                SRGB_TO_2020[c * 3 + 1] * cameraGreen +
                SRGB_TO_2020[c * 3 + 2] * cameraBlue
            const i = ((y - top) * width + x) * 4
            out[i] = rgb[0]
            out[i + 1] = rgb[1]
            out[i + 2] = rgb[2]
            out[i + 3] = Number(!clipped)
            stagingLuminance[i / 4] = Math.max(0, luminance(rgb))
          }
      }
      reduction.add(top, out, native?.luminance ?? stagingLuminance.subarray(0, width * rows))
      work.conversionMs += performance.now() - conversion
      const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength),
        hashing = performance.now()
      strips.push(createHash('sha256').update(bytes).digest('hex'))
      work.hashingMs += performance.now() - hashing
      const cameraStart = performance.now()
      await camera?.write(top, bytes)
      work.cameraRegistrationMs += performance.now() - cameraStart
      const writing = performance.now()
      await file.writeFile(bytes)
      work.writingMs += performance.now() - writing
    }
  } finally {
    try {
      try {
        await camera?.close()
      } finally {
        await file.close()
      }
    } finally {
      kernel?.close()
    }
  }
  const cameraStart = performance.now(),
    cameraRegistration = await camera?.finish()
  work.cameraRegistrationMs += performance.now() - cameraStart
  const reducing = performance.now()
  const reduced = reduction.finish()[0]
  plane.data = reduced.data
  plane.mask = reduced.mask
  work.reductionMs += performance.now() - reducing
  return {
    path: target,
    strips,
    width,
    height,
    plane,
    normalization: { ...normal, referenceWhite: 1 },
    decoder: `${decoder.id}-${decoder.version}`,
    cameraProfile: `${cameraProfile(source.metadata.make!, source.metadata.model!)!.id}-${cameraProfile(source.metadata.make!, source.metadata.model!)!.version}`,
    measurement: {
      backend: 'cpu',
      reused: false,
      decodingMs,
      preparationMs: performance.now() - start - decodingMs,
      work,
      decoder: decoding,
    },
    cameraRegistration,
  }
}
