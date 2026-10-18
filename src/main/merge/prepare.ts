import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { rawDecoder } from '../processing/decoders'
import { cameraProfile } from '../processing/cameras'
import { correctionPlan, radial } from '../processing/lens-correction'
import { SRGB_TO_2020, luminance } from '../../shared/hdr'
import { MERGE_LIMITS, mergeFailure, type MergeSource } from '../../shared/merge'
import { expandMask, type Plane } from './math'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import type { MergeMeasurements } from '../../shared/merge'
import type { RawSource } from '../gpu/raw-source'
import { saveSensorCache, type SensorCache } from './sensor-cache'
import { sourceCorrectionPlan } from './preparation-policy'
import type { MergePreparation } from '../../shared/merge'
import { cameraRegistrationWriter, type CameraRegistration } from './camera-registration'
import { sensorBlendParameters, sensorBlendRgb } from '../gpu/sensor-blend'
import {
  createAreaReducer,
  createMaskRepairKernel,
  createPreparationKernel,
  createSensorClippingMask,
} from './cpu-kernels'

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

function sensorMask(raw: RawSource) {
  const mask = new Uint8Array(raw.width * raw.height)
  for (let y = 0; y < raw.height; y++) {
    let first = -1
    for (let x = 0; x <= raw.width; x++) {
      const c = raw.cfa[(y % 2) * 2 + (x % 2)],
        clipped =
          x < raw.width &&
          raw.pixels[(y + raw.top) * raw.rawWidth + x + raw.left] >=
            raw.normalization!.sourceSaturation!.thresholds[c]
      if (clipped && first < 0) first = x
      if (!clipped && first >= 0) {
        // Dilate contiguous sensor runs directly, avoiding full-image intermediate masks.
        for (let yy = Math.max(0, y - 2); yy < Math.min(raw.height, y + 3); yy++)
          mask.fill(
            1,
            yy * raw.width + Math.max(0, first - 2),
            yy * raw.width + Math.min(raw.width, x + 2),
          )
        first = -1
      }
    }
  }
  return mask
}

/** Float32 lens coordinates can cross a sensor stencil boundary. Canonical
 * double-precision geometry repairs only boundary pixels, without changing RGB. */
function repairMask(
  bytes: Buffer,
  top: number,
  width: number,
  raw: RawSource,
  plan: ReturnType<typeof correctionPlan>,
  saturated: Uint8Array,
  alpha: Uint32Array,
) {
  const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    rows = pixels.length / 4 / width,
    cx = (raw.width - 1) / 2,
    cy = (raw.height - 1) / 2,
    radius = Math.hypot(cx, cy),
    changed: number[] = []
  // Read the original mask so repairs do not change boundary selection.
  const mask = new Uint8Array(rows * width)
  const first = top * width
  let bits = alpha[first >>> 5]
  for (let k = 0; k < mask.length; k++) {
    const i = first + k,
      a = pixels[k * 4 + 3]
    mask[k] = a
    bits |= a << (i & 31)
    if ((i & 31) === 31) {
      alpha[i >>> 5] = bits
      bits = 0
    }
  }
  if ((first + mask.length) & 31) alpha[(first + mask.length) >>> 5] = bits
  for (let row = 0; row < rows; row++)
    for (let x = 0; x < width; x++) {
      const k = row * width + x,
        a = mask[k]
      if (
        row > 0 &&
        row < rows - 1 &&
        a === mask[k - width] &&
        a === mask[k + width] &&
        (x === 0 || a === mask[k - 1]) &&
        (x === width - 1 || a === mask[k + 1])
      )
        continue
      const y = top + row
      let sx = raw.flip & 4 ? y : x,
        sy = raw.flip & 4 ? x : y
      if (raw.flip & 1) sx = plan.width - 1 - sx
      if (raw.flip & 2) sy = plan.height - 1 - sy
      const qx = sx + plan.left - cx,
        qy = sy + plan.top - cy,
        r = Math.hypot(qx, qy) / radius
      let clipped = false
      for (let c = 0; c < 3 && !clipped; c++) {
        const scale = radial(plan.lut, r, c),
          px = cx + qx * scale,
          py = cy + qy * scale,
          ix = Math.floor(px),
          iy = Math.floor(py),
          dx = px - ix,
          dy = py - iy
        for (let yy = 0; yy < 2; yy++)
          for (let xx = 0; xx < 2; xx++)
            if (
              (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy) > 0 &&
              saturated[
                Math.max(0, Math.min(raw.height - 1, iy + yy)) * raw.width +
                  Math.max(0, Math.min(raw.width - 1, ix + xx))
              ]
            )
              clipped = true
      }
      pixels[k * 4 + 3] = Number(!clipped)
      const i = first + k
      if (clipped) alpha[i >>> 5] &= ~(1 << (i & 31))
      else alpha[i >>> 5] |= 1 << (i & 31)
      if (clipped && a) changed.push((top + row) * width + x)
    }
  return changed
}

export interface PreparedSource {
  path: string
  strips: string[]
  width: number
  height: number
  plane: Plane
  decoder: string
  cameraProfile: string
  normalization: import('../../shared/hdr').HdrNormalization
  measurement?: MergeMeasurements['preparation'][number]
  gpuBytes?: number
  sensor?: SensorCache
  identity?: string
  cameraRegistration?: CameraRegistration
  /** Alignment-only proxies select a camera channel; fusion sources never set this. */
  registrationChannel?: number
}
/** Sequential decoding; saturation is captured in sensor coordinates before demosaicing. */
export async function prepareSource(
  path: string,
  directory: string,
  index: number,
  source: MergeSource,
  reference: MergeSource,
  gpu?: RawGpuRenderer,
  checkpoint: () => Promise<void> = async () => {},
  preparation?: MergePreparation,
): Promise<PreparedSource> {
  const start = performance.now(),
    work = preparationWork(),
    decoding = decoderWork()
  let fallback: string | undefined
  if (gpu && process.env.LUMA_MERGE_BACKEND !== 'cpu') {
    const decoder = rawDecoder(path)
    if (!decoder) throw new Error('Merge requires RAW sources.')
    const opening = performance.now(),
      session = await decoder.open(path)
    decoding.opens++
    decoding.openingMs += performance.now() - opening
    try {
      if (!session.metadata.hdrEligible || session.metadata.model !== source.metadata.model)
        throw new Error('Unverified Sony RAW recording mode.')
      const sensorStart = performance.now(),
        raw = session.gpuSource(true)
      decoding.sensorMs += performance.now() - sensorStart
      if (!raw?.normalization?.sourceSaturation)
        throw new Error('Source saturation metadata is unavailable.')
      const decodingMs = performance.now() - start
      const plan = sourceCorrectionPlan(
          raw.width,
          raw.height,
          raw.flip,
          source,
          reference,
          preparation,
        ),
        width = raw.flip & 4 ? plan.height : plan.width,
        height = raw.flip & 4 ? plan.width : plan.height,
        ratio = Math.min(1, MERGE_LIMITS.previewEdge / Math.max(width, height)),
        pw = Math.max(1, Math.floor(width * ratio)),
        ph = Math.max(1, Math.floor(height * ratio)),
        target = join(directory, `source-${index}.f32`),
        file = await open(target, 'wx'),
        strips: string[] = [],
        maskStart = performance.now(),
        saturated = (await createSensorClippingMask(raw, work.cpuKernel!)) ?? sensorMask(raw),
        alpha = new Uint32Array(Math.ceil((width * height) / 32)),
        invalidated: number[] = []
      work.maskRepairMs += performance.now() - maskStart
      let camera: Awaited<ReturnType<typeof cameraRegistrationWriter>> | undefined,
        maskKernel: Awaited<ReturnType<typeof createMaskRepairKernel>> | undefined
      try {
        if (preparation) {
          const cameraStart = performance.now()
          camera = await cameraRegistrationWriter(
            directory,
            index,
            raw,
            plan,
            pw,
            ph,
            work.cpuKernel,
          )
          work.cameraRegistrationMs += performance.now() - cameraStart
        }
        maskKernel = await createMaskRepairKernel(raw, plan, saturated, work.cpuKernel!)
        let acceleratedMask = maskKernel
        const frame = await gpu.render(raw, plan, undefined, false, false, {
          gains: reference.metadata.whiteBalance!.asShotGains,
          reviewWidth: pw,
          reviewHeight: ph,
          checkpoint,
          strip: async (top, bytes) => {
            const maskStart = performance.now()
            let changed: number[] | undefined
            if (acceleratedMask)
              try {
                changed = acceleratedMask.repair(
                  top,
                  new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
                  alpha,
                )
              } catch {
                acceleratedMask = undefined
              }
            invalidated.push(
              ...(changed ?? repairMask(bytes, top, width, raw, plan, saturated, alpha)),
            )
            work.maskRepairMs += performance.now() - maskStart
            const cameraStart = performance.now()
            await camera?.write(top, bytes)
            work.cameraRegistrationMs += performance.now() - cameraStart
            const hashing = performance.now()
            for (let offset = 0; offset < bytes.length; offset += width * 64 * 16)
              strips.push(
                createHash('sha256')
                  .update(bytes.subarray(offset, Math.min(bytes.length, offset + width * 64 * 16)))
                  .digest('hex'),
              )
            work.hashingMs += performance.now() - hashing
            const writing = performance.now()
            await file.writeFile(bytes)
            work.writingMs += performance.now() - writing
          },
        })
        const reduction = performance.now(),
          data = new Float32Array(pw * ph),
          mask = new Uint8Array(pw * ph)
        for (let i = 0; i < data.length; i++) {
          const reduced = frame.mergeReduced!,
            from = i * 8
          data[i] = reduced[from + 4]
          mask[i] = reduced[from + 5] ? 255 : 0
        }
        // A reduction remains conservative when canonical native validation adds clipping.
        for (const k of invalidated) {
          const x = k % width,
            y = Math.floor(k / width)
          for (
            let py = Math.floor((y * ph) / height);
            py < Math.ceil(((y + 1) * ph) / height);
            py++
          )
            for (
              let px = Math.floor((x * pw) / width);
              px < Math.ceil(((x + 1) * pw) / width);
              px++
            ) {
              const i = py * pw + px
              mask[i] = 0
              data[i] = 0
            }
        }
        work.reductionMs += performance.now() - reduction
        const sensorStart = performance.now()
        const sensor = await saveSensorCache(
          directory,
          index,
          raw,
          reference.metadata.whiteBalance!.asShotGains,
          plan,
          alpha,
        )
        work.sensorCacheMs += performance.now() - sensorStart
        const cameraStart = performance.now()
        const cameraRegistration = await camera?.finish()
        work.cameraRegistrationMs += performance.now() - cameraStart
        return {
          path: target,
          strips,
          width,
          height,
          plane: { width: pw, height: ph, data, mask },
          normalization: { ...raw.normalization, referenceWhite: 1 },
          decoder: `${decoder.id}-${decoder.version}`,
          cameraProfile: `${cameraProfile(source.metadata.make!, source.metadata.model!)!.id}-${cameraProfile(source.metadata.make!, source.metadata.model!)!.version}`,
          measurement: {
            backend: 'gpu',
            adapter: frame.adapter,
            reused: false,
            decodingMs,
            preparationMs: performance.now() - start - decodingMs,
            work,
            decoder: decoding,
            gpu: frame.timings,
          },
          gpuBytes: frame.gpuBytes,
          sensor,
          cameraRegistration,
        }
      } finally {
        try {
          await camera?.close()
        } finally {
          try {
            maskKernel?.close()
          } finally {
            await file.close()
          }
        }
      }
    } catch (error) {
      fallback = mergeFailure(error).message
    } finally {
      session.close()
    }
    const { rm } = await import('node:fs/promises')
    await rm(join(directory, `source-${index}.f32`), { force: true })
    await rm(join(directory, `source-${index}.camera.f32`), { force: true })
  }
  const result = await prepareCpu(
    path,
    directory,
    index,
    source,
    reference,
    checkpoint,
    preparation,
    false,
    decoding,
  )
  result.measurement = {
    backend: 'cpu',
    fallback,
    reused: false,
    decodingMs: result.measurement!.decodingMs,
    preparationMs: performance.now() - start - result.measurement!.decodingMs,
    work: result.measurement!.work,
    decoder: result.measurement!.decoder,
  }
  return result
}

/** Preserve the reference's geometry while using the same camera-stage
 * highlight policy as ordinary Sony HDR for irrecoverably clipped fallback.
 * This separate preparation never supplies alignment or fusion evidence.
 */
export function prepareReferenceFallback(
  path: string,
  directory: string,
  index: number,
  source: MergeSource,
  reference: MergeSource,
  checkpoint: () => Promise<void>,
  preparation: MergePreparation,
) {
  return prepareCpu(path, directory, index, source, reference, checkpoint, preparation, true)
}

async function prepareCpu(
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
    stagingLuma = new Float64Array(width * Math.min(64, height)),
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
      createAreaReducer(width, height, { width: plane.width, height: plane.height }, 'luma')
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
            stagingLuma[i / 4] = Math.max(0, luminance(rgb))
          }
      }
      reduction.add(top, out, native?.luma ?? stagingLuma.subarray(0, width * rows))
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
