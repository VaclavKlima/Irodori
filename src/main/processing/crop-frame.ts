import type { WorkingFrame } from '../../shared/adjustments'
import { setImmediate } from 'node:timers/promises'
import { cropGeometry, type CropGeometry, type CropSettings } from '../../shared/crop'
import {
  cropFrameMemoryPlan,
  type CropAdmission,
  type CropMemoryPlan,
} from '../../shared/crop-resources'
import { frameByteLength } from '../../shared/preview-frame'
import type { CropGpu } from '../gpu/crop'
import { cropBands, type CropBackend, type CropBandDiagnostics } from './crop-bands'

export interface CropFrameJob {
  readonly settings: CropSettings
  /** Other live/retiring owners; this adapter additionally charges its borrowed input. */
  readonly admission?: CropAdmission
  readonly backend: CropBackend
}
export interface CropFrameReader {
  readonly geometry: CropGeometry
  readonly transform: WorkingFrame['transform']
  readonly memory?: CropMemoryPlan
  readonly diagnostics: Omit<CropBandDiagnostics, 'backend'> & {
    backend: CropBandDiagnostics['backend'] | 'identity'
  }
  /** Bands are borrowed until the next iteration. Early return drains GPU ownership. */
  readonly strips: AsyncGenerator<Float32Array>
}

function reader(
  frame: WorkingFrame,
  job: CropFrameJob,
  signal: AbortSignal,
  retainOutput: boolean,
  makeGpu?: () => Promise<CropGpu>,
): CropFrameReader {
  signal.throwIfAborted()
  const frozen = structuredClone(job),
    geometry = cropGeometry(frame, frozen.settings)
  if (
    !(frame.data instanceof Float32Array) ||
    !(frame.data.buffer instanceof ArrayBuffer) ||
    frame.data.byteLength !== frameByteLength(frame.width, frame.height) * 4 ||
    frame.data.byteLength > 512 * 1024 ** 2
  )
    throw new Error('Invalid crop working frame.')
  if (!['auto', 'cpu', 'gpu'].includes(frozen.backend))
    throw new Error('Invalid crop processing backend.')
  const diagnostics: CropBandDiagnostics = {
    backend: 'cpu',
    cpuTiles: 0,
    gpuTiles: 0,
    precisionRecoveryTiles: 0,
  }
  if (geometry.identity)
    return {
      geometry,
      transform: frame.transform,
      diagnostics: { ...diagnostics, backend: 'identity' },
      strips: (async function* () {
        for (let top = 0; top < frame.height; top += 64) {
          signal.throwIfAborted()
          yield frame.data.subarray(top * frame.width * 4, (top + 64) * frame.width * 4)
        }
      })(),
    }
  if (!frozen.admission) throw new Error('Crop processing requires a frozen resource admission.')
  const memory = cropFrameMemoryPlan(geometry, frozen.admission, retainOutput)
  if (!memory.cpuAccepted)
    throw new Error('Crop preparation exceeds the frozen managed image budgets.')
  if (!geometry.pixelAligned && frozen.backend === 'gpu' && !memory.gpuAccepted)
    throw new Error('Crop GPU preparation exceeds the frozen managed image budgets.')
  const strips = (async function* () {
    // Sharp-authored frames have no strip hashes. Validate once without a second full plane.
    for (let i = 0; i < frame.data.length; i++) {
      if (i % (1024 * 1024) === 0) {
        await setImmediate()
        signal.throwIfAborted()
      }
      if (
        !Number.isFinite(frame.data[i]) ||
        (i % 4 === 3 && (frame.data[i] < 0 || frame.data[i] > 1))
      )
        throw new Error('Invalid crop source pixels.')
    }
    yield* cropBands(
      geometry,
      { left: 0, top: 0, width: frame.width, height: frame.height, data: frame.data },
      memory,
      frozen.backend,
      signal,
      diagnostics,
      makeGpu,
    )
  })()
  return { geometry, transform: frame.transform, memory, diagnostics, strips }
}

/** Preserve authored primaries/transform; cropping never rebrands raster pixels as Rec.2020. */
export function cropFrameReader(
  frame: WorkingFrame,
  job: CropFrameJob,
  signal: AbortSignal,
  makeGpu?: () => Promise<CropGpu>,
): CropFrameReader {
  return reader(frame, job, signal, false, makeGpu)
}

/** Preview consumers explicitly admit a retained output; identity returns the original frame. */
export async function cropWorkingFrame(
  frame: WorkingFrame,
  job: CropFrameJob,
  signal: AbortSignal,
  makeGpu?: () => Promise<CropGpu>,
) {
  const prepared = reader(frame, job, signal, true, makeGpu)
  if (prepared.geometry.identity) return { ...prepared, frame }
  const { width, height } = prepared.geometry,
    data = new Float32Array(width * height * 4)
  let offset = 0
  for await (const strip of prepared.strips) {
    signal.throwIfAborted()
    data.set(strip, offset)
    offset += strip.length
  }
  signal.throwIfAborted()
  if (offset !== data.length) throw new Error('Incomplete crop working frame.')
  return { ...prepared, frame: { data, width, height, transform: prepared.transform } }
}
