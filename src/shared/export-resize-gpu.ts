import { MAX_FRAME_BYTES } from './preview-frame'
import { resizeWeights, type ResizeWeight } from './export-resize-weights'

export const RESIZE_GPU_PARAMETER_BYTES = 32
export type ResizeGpuChannels = 1 | 3 | 6

export interface ResizeGpuPlan {
  readonly width: number
  readonly height: number
  readonly outWidth: number
  readonly outHeight: number
  readonly channels: ResizeGpuChannels
  readonly identity: boolean
  readonly maxRows: number
  readonly inputRowBytes: number
  readonly outputRowBytes: number
  readonly horizontalCacheBytes: number
  readonly rowMapBytes: number
  readonly gpuBytes: number
  /** Conservative host parameter construction, snapshots, row I/O and cache indices. */
  readonly hostBytes: number
  /** Per-output (word offset,count), followed by (source index,weight hi,weight lo,padding). */
  readonly horizontalTaps: Uint32Array<ArrayBuffer>
  readonly verticalTaps: Uint32Array<ArrayBuffer>
}

function dimensions(
  width: number,
  height: number,
  channels: number,
): asserts channels is ResizeGpuChannels {
  if (
    ![width, height].every((v) => Number.isSafeInteger(v) && v > 0 && v <= 32768) ||
    width * height * 16 > MAX_FRAME_BYTES ||
    ![1, 3, 6].includes(channels)
  )
    throw new Error('Invalid GPU export resize dimensions or channels.')
}

function packAxis(axis: readonly (readonly ResizeWeight[])[]): Uint32Array<ArrayBuffer> {
  const count = axis.reduce((sum, taps) => sum + taps.length, 0),
    data = new Uint32Array(axis.length * 2 + count * 4),
    floats = new Float32Array(data.buffer)
  let at = axis.length * 2
  for (const [i, taps] of axis.entries()) {
    data[i * 2] = at
    data[i * 2 + 1] = taps.length
    for (const tap of taps) {
      data[at] = tap.index
      floats[at + 1] = tap.weight
      floats[at + 2] = tap.weight - floats[at + 1]
      at += 4
    }
  }
  return data
}

function storage(
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: ResizeGpuChannels,
  identity: boolean,
  maxRows: number,
  horizontalTaps: Uint32Array<ArrayBuffer>,
  verticalTaps: Uint32Array<ArrayBuffer>,
) {
  const inputRowBytes = width * channels * 4,
    outputRowBytes = outWidth * channels * 4,
    horizontalCacheBytes = identity ? 0 : maxRows * outputRowBytes,
    rowMapBytes = identity ? 0 : maxRows * 4,
    tableBytes = horizontalTaps.byteLength + verticalTaps.byteLength,
    tapCount =
      (horizontalTaps.length + verticalTaps.length - (identity ? 0 : 2 * (outWidth + outHeight))) /
      4,
    gpuBytes = identity
      ? 0
      : RESIZE_GPU_PARAMETER_BYTES +
        inputRowBytes +
        horizontalCacheBytes +
        2 * outputRowBytes +
        tableBytes +
        rowMapBytes,
    hostBytes =
      3 * inputRowBytes +
      3 * outputRowBytes +
      4 * tableBytes +
      2 * rowMapBytes +
      (identity
        ? 0
        : 128 * (tapCount + outWidth + outHeight) + 64 * maxRows + 2 * RESIZE_GPU_PARAMETER_BYTES)
  if (![gpuBytes, hostBytes].every((v) => Number.isSafeInteger(v) && v >= 0))
    throw new Error('Invalid GPU export resize allocation.')
  return {
    width,
    height,
    outWidth,
    outHeight,
    channels,
    identity,
    maxRows,
    inputRowBytes,
    outputRowBytes,
    horizontalCacheBytes,
    rowMapBytes,
    gpuBytes,
    hostBytes,
    horizontalTaps,
    verticalTaps,
  }
}

/** The existing Float64 normalized, edge-coalesced weights are parameters, not a CPU filter. */
export function compileResizeGpu(
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  channels: number,
): ResizeGpuPlan {
  dimensions(width, height, channels)
  dimensions(outWidth, outHeight, channels)
  const identity = width === outWidth && height === outHeight
  if (identity)
    return Object.freeze(
      storage(
        width,
        height,
        outWidth,
        outHeight,
        channels,
        true,
        1,
        new Uint32Array(0),
        new Uint32Array(0),
      ),
    )
  const horizontal = resizeWeights(width, outWidth),
    vertical = resizeWeights(height, outHeight),
    maxRows = vertical.reduce((maximum, taps) => Math.max(maximum, taps.length), 0)
  return Object.freeze(
    storage(
      width,
      height,
      outWidth,
      outHeight,
      channels,
      false,
      maxRows,
      packAxis(horizontal),
      packAxis(vertical),
    ),
  )
}

/** Snapshot mutable typed controls once; reject malformed packets before device initialization. */
export function snapshotResizeGpuPlan(plan: ResizeGpuPlan): ResizeGpuPlan {
  dimensions(plan.width, plan.height, plan.channels)
  dimensions(plan.outWidth, plan.outHeight, plan.channels)
  const identity = plan.width === plan.outWidth && plan.height === plan.outHeight
  const axis = (value: Uint32Array<ArrayBuffer>, input: number, output: number) => {
    if (!(value instanceof Uint32Array) || !(value.buffer instanceof ArrayBuffer))
      throw new Error('Invalid GPU export resize tap table.')
    const copy = new Uint32Array(value),
      floats = new Float32Array(copy.buffer)
    if (identity) {
      if (copy.length !== 0) throw new Error('Invalid identity resize tap table.')
      return { copy, maximum: 1 }
    }
    let cursor = output * 2,
      maximum = 0
    for (let i = 0; i < output; i++) {
      const count = copy[i * 2 + 1]
      if (!count || count > input || copy[i * 2] !== cursor || cursor + count * 4 > copy.length)
        throw new Error('Invalid GPU export resize tap table.')
      maximum = Math.max(maximum, count)
      let previous = -1
      for (let j = 0; j < count; j++) {
        const at = cursor + j * 4
        if (
          copy[at] <= previous ||
          copy[at] >= input ||
          !Number.isFinite(floats[at + 1]) ||
          !Number.isFinite(floats[at + 2])
        )
          throw new Error('Invalid GPU export resize tap value.')
        previous = copy[at]
      }
      cursor += count * 4
    }
    if (cursor !== copy.length) throw new Error('Invalid GPU export resize tap table length.')
    return { copy, maximum }
  }
  const horizontal = axis(plan.horizontalTaps, plan.width, plan.outWidth),
    vertical = axis(plan.verticalTaps, plan.height, plan.outHeight),
    result = storage(
      plan.width,
      plan.height,
      plan.outWidth,
      plan.outHeight,
      plan.channels,
      identity,
      vertical.maximum,
      horizontal.copy,
      vertical.copy,
    )
  for (const key of [
    'identity',
    'maxRows',
    'inputRowBytes',
    'outputRowBytes',
    'horizontalCacheBytes',
    'rowMapBytes',
    'gpuBytes',
    'hostBytes',
  ] as const)
    if (result[key] !== plan[key]) throw new Error('Invalid GPU export resize plan.')
  return Object.freeze(result)
}
