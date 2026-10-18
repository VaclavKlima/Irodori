import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { SRGB_TO_2020 } from '../../shared/hdr'
import { ALIGNMENT_CONSTANTS } from '../../shared/merge'
import type { RawSource } from '../gpu/raw-source'
import { radial, type CorrectionPlan } from '../processing/lens-correction'
import type { Plane } from './math'
import type { PreparedSource } from './prepare'
import { createAreaReducer, createCameraKernel, type CpuKernelMeasurement } from './cpu-kernels'

export const CAMERA_REGISTRATION_POLICY = ALIGNMENT_CONSTANTS.cameraRegistrationPolicy
export const CAMERA_CHANNELS = ['red', 'green', 'blue'] as const
export interface CameraRegistration {
  version: typeof CAMERA_REGISTRATION_POLICY
  path: string
  strips: string[]
  planes: [Plane, Plane, Plane]
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function cameraMatrix(raw: RawSource) {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3),
      column = i % 3
    return [0, 1, 2].reduce(
      (sum, k) => sum + SRGB_TO_2020[row * 3 + k] * raw.matrix[k * 4 + column],
      0,
    )
  })
}
function inverseCameraMatrix(matrix: number[]) {
  const [a, b, c, d, e, f, g, h, i] = matrix
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error('Camera registration requires an invertible color matrix.')
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant)
}

/** Separate sensor masks retain surviving camera channels. Dilation covers the
 * demosaic stencil; each lens/CA channel then samples its own canonical mask.
 */
function channelClipping(raw: RawSource, storage?: Uint8Array[]) {
  if (!raw.normalization!.sourceSaturation!.saturatedSites) return
  const masks = storage ?? Array.from({ length: 3 }, () => new Uint8Array(raw.width * raw.height)),
    thresholds = raw.normalization!.sourceSaturation!.thresholds
  for (let y = 0; y < raw.height; y++)
    for (let parity = 0; parity < 2; parity++) {
      const sensorChannel = raw.cfa[(y % 2) * 2 + parity],
        channel = sensorChannel === 3 ? 1 : sensorChannel
      let first = -1
      for (let x = parity; x < raw.width + 2; x += 2) {
        const clipped =
          x < raw.width &&
          raw.pixels[(y + raw.top) * raw.rawWidth + raw.left + x] >= thresholds[sensorChannel]
        if (clipped && first < 0) first = x
        if (!clipped && first >= 0) {
          for (let yy = Math.max(0, y - 2); yy < Math.min(raw.height, y + 3); yy++)
            masks[channel].fill(
              1,
              yy * raw.width + Math.max(0, first - 2),
              yy * raw.width + Math.min(raw.width, x + 1),
            )
          first = -1
        }
      }
    }
  return masks
}

/** Immutable native camera-channel evidence. RGB inversion removes only the
 * linear color matrix, retaining exact source lens corrections and common WB.
 * The fourth float is a three-bit validity mask, never fusion alpha.
 */
export async function cameraRegistrationWriter(
  directory: string,
  index: number,
  raw: RawSource,
  plan: CorrectionPlan,
  previewWidth: number,
  previewHeight: number,
  measurement: CpuKernelMeasurement = {
    backend: 'scalar',
    heapBytes: 0,
    copyMs: 0,
    processingMs: 0,
  },
) {
  const width = raw.flip & 4 ? plan.height : plan.width,
    height = raw.flip & 4 ? plan.width : plan.height,
    path = join(directory, `source-${index}.camera.f32`),
    cameraToWorking = cameraMatrix(raw),
    inverse = inverseCameraMatrix(cameraToWorking),
    kernel = await createCameraKernel(raw, plan, inverse, measurement, undefined, {
      width: previewWidth,
      height: previewHeight,
    })
  try {
    const masks = kernel?.populateMasks() ?? channelClipping(raw, kernel?.masks),
      reduction =
        kernel?.reduction ??
        createAreaReducer(width, height, { width: previewWidth, height: previewHeight }, 'camera'),
      strips: string[] = [],
      cx = (raw.width - 1) / 2,
      cy = (raw.height - 1) / 2,
      radius = Math.hypot(cx, cy),
      file = await open(path, 'wx')
    let next = 0,
      closed = false,
      staging = new Float32Array(0),
      accelerated = kernel
    const close = async () => {
      if (!closed) {
        closed = true
        try {
          await file.close()
        } finally {
          kernel?.close()
        }
      }
    }
    return {
      close,
      async write(top: number, bytes: Buffer) {
        if (closed || top !== next || bytes.length % (width * 16))
          throw new Error('Invalid camera registration strip.')
        const input = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
          inputRows = input.length / 4 / width
        // GPU readbacks contain 256 rows. Keep conversion and borrowed output
        // bounded to canonical 64-row strips, awaiting writes before reuse.
        for (let offset = 0; offset < inputRows; offset += 64) {
          const rows = Math.min(64, inputRows - offset),
            stripTop = top + offset,
            rgb = input.subarray(offset * width * 4, (offset + rows) * width * 4)
          let output: Float32Array<ArrayBuffer> | undefined
          if (accelerated) {
            try {
              output = accelerated.convert(stripTop, rgb)
            } catch {
              accelerated = undefined
              measurement.backend = 'scalar'
            }
          }
          if (!output) {
            if (staging.length < rgb.length) staging = new Float32Array(rgb.length)
            output = staging.subarray(0, rgb.length)
            for (let row = 0; row < rows; row++)
              for (let x = 0; x < width; x++) {
                const y = stripTop + row,
                  at = (row * width + x) * 4
                let sx = raw.flip & 4 ? y : x,
                  sy = raw.flip & 4 ? x : y
                if (raw.flip & 1) sx = plan.width - 1 - sx
                if (raw.flip & 2) sy = plan.height - 1 - sy
                const qx = sx + plan.left - cx,
                  qy = sy + plan.top - cy,
                  r = masks ? Math.hypot(qx, qy) / radius : 0
                let valid = 0
                for (let channel = 0; channel < 3; channel++) {
                  const value =
                      inverse[channel * 3] * rgb[at] +
                      inverse[channel * 3 + 1] * rgb[at + 1] +
                      inverse[channel * 3 + 2] * rgb[at + 2],
                    channelMask = masks?.[channel]
                  if (!Number.isFinite(value))
                    throw new Error('Non-finite camera registration sample.')
                  output[at + channel] = value
                  let clipped = false
                  if (channelMask) {
                    const scale = radial(plan.lut, r, channel),
                      px = cx + qx * scale,
                      py = cy + qy * scale,
                      ix = Math.floor(px),
                      iy = Math.floor(py),
                      dx = px - ix,
                      dy = py - iy
                    for (let yy = 0; yy < 2 && !clipped; yy++)
                      for (let xx = 0; xx < 2; xx++)
                        if (
                          (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy) > 0 &&
                          channelMask[
                            Math.max(0, Math.min(raw.height - 1, iy + yy)) * raw.width +
                              Math.max(0, Math.min(raw.width - 1, ix + xx))
                          ]
                        )
                          clipped = true
                  }
                  if (!clipped) valid |= 1 << channel
                }
                output[at + 3] = valid
              }
          }
          reduction.add(stripTop, output)
          const out = Buffer.from(output.buffer, output.byteOffset, output.byteLength)
          strips.push(hash(out))
          await file.writeFile(out)
          next += rows
        }
      },
      async finish(): Promise<CameraRegistration> {
        if (next !== height || strips.length !== Math.ceil(height / 64))
          throw new Error('Incomplete camera registration evidence.')
        await close()
        const planes = reduction.finish() as [Plane, Plane, Plane]
        return { version: CAMERA_REGISTRATION_POLICY, path, strips, planes }
      },
    }
  } catch (error) {
    kernel?.close()
    throw error
  }
}

const proxies = new WeakMap<PreparedSource, Map<number, PreparedSource>>()
function channelSource(source: PreparedSource, channel: number) {
  let choices = proxies.get(source)
  if (!choices) proxies.set(source, (choices = new Map()))
  let proxy = choices.get(channel)
  if (!proxy) {
    const camera = source.cameraRegistration!
    proxy = {
      ...source,
      path: camera.path,
      strips: camera.strips,
      plane: camera.planes[channel],
      registrationChannel: channel,
    }
    choices.set(channel, proxy)
  }
  return proxy
}

/** Choose once before ORB/ECC. A channel adds real co-valid evidence rather than
 * another hypothesis; all existing native and parallax checks still apply.
 */
export function registrationSources(sources: PreparedSource[]) {
  const distinct = [...new Set(sources)]
  if (distinct.some((s) => !s.cameraRegistration)) return { sources }
  const count = distinct[0].plane.data.length
  if (distinct.some((s) => s.plane.data.length !== count)) return { sources }
  const coverage = (channel?: number) => {
    let valid = 0
    for (let i = 0; i < count; i++)
      if (
        distinct.every((s) => {
          const plane = channel === undefined ? s.plane : s.cameraRegistration!.planes[channel]
          return !plane.mask || plane.mask[i] !== 0
        })
      )
        valid++
    return valid
  }
  const original = coverage(),
    channels = [0, 1, 2].map((c) => coverage(c)),
    best = channels.indexOf(Math.max(...channels))
  if (channels[best] < original + count * ALIGNMENT_CONSTANTS.cameraChannelCoverageGain)
    return { sources }
  return { sources: sources.map((s) => channelSource(s, best)), channel: CAMERA_CHANNELS[best] }
}
