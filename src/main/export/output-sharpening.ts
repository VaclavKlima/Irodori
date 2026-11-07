import { open } from 'node:fs/promises'
import {
  DETAIL_BAND_ROWS,
  detailStreamMemoryPlan,
  type DetailAdmission,
} from '../../shared/detail-resources'
import { ExportResourceError, validateExportAdmission } from '../../shared/export-resources'
import { resolveOutputSharpening, type OutputSharpeningMode } from '../../shared/output-sharpening'
import { neutralNoiseReduction } from '../../shared/spatial-detail'
import { detailBands, type DetailBandDiagnostics } from '../processing/detail-bands'
import { createSpatialDetailGpu } from '../gpu/spatial-detail'

/** Filtering owners are sequential; retain encoder planes and bounded strip I/O, not prior GPUs. */
export function outputSharpeningMemoryPlan(
  width: number,
  height: number,
  channels: 3 | 6,
  admission: DetailAdmission,
  retainedBytes: number,
) {
  validateExportAdmission(admission)
  if (![3, 6].includes(channels) || !Number.isSafeInteger(retainedBytes) || retainedBytes < 0)
    throw new Error('Invalid output sharpening allocation.')
  const readerBytes = 2 * width * Math.min(DETAIL_BAND_ROWS, height) * channels * 4,
    filterAdmission = {
      policy: admission.policy,
      reservation: {
        ramBytes: admission.reservation.ramBytes + retainedBytes + readerBytes,
        vramBytes: admission.reservation.vramBytes,
      },
    },
    filter = detailStreamMemoryPlan({ width, height }, filterAdmission, true)
  if (!filter.cpuAccepted || !filter.gpuAccepted)
    throw new ExportResourceError('Output sharpening exceeds the frozen managed image budgets.')
  return {
    admission: filterAdmission,
    memory: {
      ramBytes: filter.gpu.ramBytes - admission.reservation.ramBytes,
      vramBytes: filter.gpu.vramBytes - admission.reservation.vramBytes,
    },
  }
}

/** Each output rendition uses the existing protected GPU filter once, at final output pixels. */
export async function sharpenOutputRenditions(
  path: string,
  width: number,
  height: number,
  channels: 3 | 6,
  mode: Exclude<OutputSharpeningMode, 'off'>,
  admission: DetailAdmission,
  retainedBytes: number,
  accept: (data: Float32Array, top: number, rendition: 'sdr' | 'hdr') => void,
  signal = new AbortController().signal,
  makeGpu = createSpatialDetailGpu,
) {
  signal.throwIfAborted()
  const frozen = structuredClone(admission),
    settings = resolveOutputSharpening({ outputSharpening: mode }),
    plan = outputSharpeningMemoryPlan(width, height, channels, frozen, retainedBytes),
    passes: ({ rendition: 'sdr' | 'hdr' } & DetailBandDiagnostics)[] = [],
    file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== width * height * channels * 4)
      throw new Error('Incomplete output sharpening rendition.')
    for (const offset of channels === 6 ? ([0, 3] as const) : ([0] as const)) {
      signal.throwIfAborted()
      const rendition = offset === 0 ? 'sdr' : 'hdr',
        diagnostics: (typeof passes)[number] = {
          rendition,
          backend: 'gpu',
          cpuTiles: 0,
          gpuTiles: 0,
          precisionRecoveryTiles: 0,
          maxSourceStrips: 0,
        },
        values = (async function* () {
          for (let top = 0; top < height; top += DETAIL_BAND_ROWS) {
            signal.throwIfAborted()
            const count = width * Math.min(DETAIL_BAND_ROWS, height - top),
              raw = new Float32Array(count * channels),
              bytes = Buffer.from(raw.buffer),
              pixels = new Float32Array(count * 4)
            let read = 0
            while (read < bytes.byteLength) {
              signal.throwIfAborted()
              const part = await file.read(
                bytes,
                read,
                bytes.byteLength - read,
                top * width * channels * 4 + read,
              )
              if (!part.bytesRead) throw new Error('Incomplete output sharpening strip.')
              read += part.bytesRead
            }
            for (let i = 0; i < count; i++) {
              for (let c = 0; c < 3; c++) pixels[i * 4 + c] = raw[i * channels + offset + c]
              pixels[i * 4 + 3] = 1
            }
            yield pixels
          }
        })()
      let top = 0
      for await (const band of detailBands(
        { width, height },
        { kind: 'strips', values },
        {
          ...plan.admission,
          backend: 'gpu',
          primaries: rendition === 'sdr' ? 'srgb' : 'rec2020',
          noiseReduction: neutralNoiseReduction,
          detailSharpening: settings,
        },
        signal,
        diagnostics,
        makeGpu,
      )) {
        signal.throwIfAborted()
        accept(band, top, rendition)
        top += band.length / (width * 4)
      }
      if (top !== height) throw new Error('Incomplete output sharpening result.')
      passes.push(diagnostics)
    }
    return { ...settings, mode, width, height, passes, memory: plan.memory }
  } finally {
    await file.close()
  }
}
