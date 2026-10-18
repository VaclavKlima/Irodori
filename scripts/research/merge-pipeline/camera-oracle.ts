import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { SRGB_TO_2020 } from '../../../src/shared/hdr'
import { MERGE_LIMITS } from '../../../src/shared/merge'
import type { RawSource } from '../../../src/main/gpu/raw-source'
import type { CorrectionPlan } from '../../../src/main/processing/lens-correction'
import {
  cameraRegistrationWriter,
  type CameraRegistration,
} from '../../../src/main/merge/camera-registration'
import { areaContributions } from '../../../src/main/merge/area'
import type { Plane } from '../../../src/main/merge/math'
import type { CameraStudy, CameraStudyInput } from './camera-study'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const tolerance = (reference: number) => 2e-6 + 2e-5 * Math.abs(reference)

/** The same camera-to-working coefficient convention, with inversion retained in Float64. */
export function inverseCamera(raw: RawSource) {
  const m = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3
    let value = 0
    for (let k = 0; k < 3; k++) value += SRGB_TO_2020[row * 3 + k] * raw.matrix[k * 4 + column]
    return value
  })
  const [a, b, c, d, e, f, g, h, i] = m
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
    throw new Error('Research camera matrix is not invertible.')
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
  ].map((v) => v / determinant)
}

async function readStrip(file: FileHandle, width: number, height: number, top: number) {
  const rows = Math.min(64, height - top),
    bytes = Buffer.allocUnsafe(width * rows * 16)
  let offset = 0
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, top * width * 16 + offset)
    if (!read.bytesRead) throw new Error('Truncated research CPU oracle strip.')
    offset += read.bytesRead
  }
  return bytes
}

/** Invoke the maintained CPU writer itself, retaining its canonical sensor/lens/CA masks. */
export async function cameraOracle(
  directory: string,
  index: number,
  raw: RawSource,
  plan: CorrectionPlan,
  rgba: Float32Array<ArrayBuffer>,
  reducedWidth: number,
  reducedHeight: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const width = raw.flip & 4 ? plan.height : plan.width,
    height = raw.flip & 4 ? plan.width : plan.height
  if (rgba.length !== width * height * 4) throw new Error('Invalid research native oracle size.')
  const started = performance.now(),
    previousKernel = process.env.LUMA_MERGE_CPU_KERNEL
  let writer: Awaited<ReturnType<typeof cameraRegistrationWriter>> | undefined
  let oracle: CameraRegistration
  try {
    // Keep the experimental GPU comparison independent of the optional WASM candidate.
    process.env.LUMA_MERGE_CPU_KERNEL = 'scalar'
    writer = await cameraRegistrationWriter(
      directory,
      index,
      raw,
      plan,
      reducedWidth,
      reducedHeight,
    )
    for (let top = 0; top < height; top += 64) {
      signal?.throwIfAborted()
      const values = rgba.subarray(top * width * 4, Math.min(height, top + 64) * width * 4)
      await writer.write(top, Buffer.from(values.buffer, values.byteOffset, values.byteLength))
    }
    signal?.throwIfAborted()
    oracle = await writer.finish()
  } finally {
    try {
      await writer?.close()
    } finally {
      if (previousKernel === undefined) delete process.env.LUMA_MERGE_CPU_KERNEL
      else process.env.LUMA_MERGE_CPU_KERNEL = previousKernel
    }
  }
  const oracleWallMs = performance.now() - started,
    valid = new Uint8Array(width * height),
    reading = performance.now(),
    file = await open(oracle.path, 'r')
  try {
    if ((await file.stat()).size !== rgba.byteLength)
      throw new Error('Invalid CPU oracle byte count.')
    for (let top = 0; top < height; top += 64) {
      signal?.throwIfAborted()
      const bytes = await readStrip(file, width, height, top)
      if (digest(bytes) !== oracle.strips[top / 64]) throw new Error('Changed CPU oracle strip.')
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      for (let i = 0; i < values.length / 4; i++) {
        const mask = values[i * 4 + 3]
        if (!Number.isInteger(mask) || mask < 0 || mask > 7)
          throw new Error('Invalid canonical mask.')
        valid[top * width + i] = mask
      }
    }
  } finally {
    await file.close()
  }
  return {
    oracle,
    input: {
      width,
      height,
      reducedWidth,
      reducedHeight,
      rgba,
      valid,
      inverse: inverseCamera(raw),
      minimumSignal: MERGE_LIMITS.readNoise * 3,
    } satisfies CameraStudyInput,
    oracleWallMs,
    canonicalMaskExtractionMs: performance.now() - reading,
  }
}

/** Matched resident numerical scope: no clipping geometry, decoding, hashing or file writes. */
export function cpuCameraStage(input: CameraStudyInput): [Plane, Plane, Plane] {
  const { width, height, reducedWidth, reducedHeight, inverse, rgba, valid } = input,
    count = reducedWidth * reducedHeight,
    xs = areaContributions(width, reducedWidth),
    ys = areaContributions(height, reducedHeight),
    sums = Array.from({ length: 3 }, () => new Float64Array(count)),
    weights = Array.from({ length: 3 }, () => new Float64Array(count)),
    totals = new Float64Array(count),
    camera = new Float32Array(3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      for (let c = 0; c < 3; c++)
        camera[c] =
          inverse[c * 3] * rgba[from] +
          inverse[c * 3 + 1] * rgba[from + 1] +
          inverse[c * 3 + 2] * rgba[from + 2]
      for (const [px, wx] of xs[x])
        for (const [py, wy] of ys[y]) {
          const at = py * reducedWidth + px,
            weight = wx * wy
          totals[at] += weight
          for (let c = 0; c < 3; c++)
            if (valid[y * width + x] & (1 << c) && camera[c] > input.minimumSignal) {
              sums[c][at] += camera[c] * weight
              weights[c][at] += weight
            }
        }
    }
  return [0, 1, 2].map((c) => {
    const data = new Float32Array(count),
      mask = new Uint8Array(count)
    for (let i = 0; i < count; i++) {
      mask[i] = weights[c][i] > 0 && Math.abs(weights[c][i] - totals[i]) < 1e-8 ? 255 : 0
      data[i] = mask[i] ? sums[c][i] / weights[c][i] : 0
    }
    return { width: reducedWidth, height: reducedHeight, data, mask }
  }) as [Plane, Plane, Plane]
}

export interface CameraComparison {
  samples: number
  differingWords: number
  nonFinite: number
  overTolerance: number
  maskMismatches: number
  maximumAbsoluteError: number
  maximumToleranceRatio: number
  worst?: unknown
}
function comparison(): CameraComparison {
  return {
    samples: 0,
    differingWords: 0,
    nonFinite: 0,
    overTolerance: 0,
    maskMismatches: 0,
    maximumAbsoluteError: 0,
    maximumToleranceRatio: 0,
  }
}
function sample(
  result: CameraComparison,
  reference: number,
  actual: number,
  index: number,
  channel: number,
) {
  result.samples++
  if (!Number.isFinite(reference) || !Number.isFinite(actual)) {
    result.nonFinite++
    result.worst = { index, channel, reference: String(reference), actual: String(actual) }
    return
  }
  const error = Math.abs(actual - reference),
    ratio = error / tolerance(reference)
  if (!Object.is(actual, reference)) result.differingWords++
  if (ratio > 1) result.overTolerance++
  if (ratio > result.maximumToleranceRatio)
    result.worst = { index, channel, reference, actual, ratio }
  result.maximumAbsoluteError = Math.max(result.maximumAbsoluteError, error)
  result.maximumToleranceRatio = Math.max(result.maximumToleranceRatio, ratio)
}

export function comparePlanes(reference: [Plane, Plane, Plane], actual: [Plane, Plane, Plane]) {
  const result = comparison()
  for (let c = 0; c < 3; c++) {
    if (actual[c].width !== reference[c].width || actual[c].height !== reference[c].height)
      throw new Error('Research plane dimensions changed.')
    for (let i = 0; i < reference[c].data.length; i++) {
      sample(result, reference[c].data[i], actual[c].data[i], i, c)
      result.maskMismatches += Number(reference[c].mask![i] !== actual[c].mask![i])
    }
  }
  return result
}

export async function compareCameraStudy(
  study: CameraStudy,
  input: CameraStudyInput,
  oracle: CameraRegistration,
  signal?: AbortSignal,
) {
  const native = comparison(),
    reduced = comparison(),
    file = await open(oracle.path, 'r'),
    started = performance.now()
  try {
    for await (const strip of study.nativeStrips(signal)) {
      const bytes = await readStrip(file, input.width, input.height, strip.top)
      if (digest(bytes) !== oracle.strips[strip.top / 64])
        throw new Error('Changed CPU native evidence.')
      const reference = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      for (let i = 0; i < strip.data.length; i += 4) {
        for (let c = 0; c < 3; c++)
          sample(native, reference[i + c], strip.data[i + c], strip.top * input.width + i / 4, c)
        native.maskMismatches += Number(reference[i + 3] !== strip.data[i + 3])
      }
    }
  } finally {
    await file.close()
  }
  for await (const strip of study.reducedStrips(signal))
    for (let i = 0; i < strip.data.length; i += 4) {
      const at = strip.top * input.reducedWidth + i / 4,
        bits = strip.data[i + 3]
      if (!Number.isInteger(bits) || bits < 0 || bits > 7)
        throw new Error('Invalid GPU reduced mask.')
      for (let c = 0; c < 3; c++) {
        sample(reduced, oracle.planes[c].data[at], strip.data[i + c], at, c)
        reduced.maskMismatches += Number(oracle.planes[c].mask![at] !== (bits & (1 << c) ? 255 : 0))
      }
    }
  if (
    native.samples !== input.width * input.height * 3 ||
    reduced.samples !== input.reducedWidth * input.reducedHeight * 3
  )
    throw new Error('Incomplete research camera evidence comparison.')
  return { native, reduced, proofReadbackAndComparisonMs: performance.now() - started }
}
