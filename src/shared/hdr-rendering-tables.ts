import { ACES_DATA_BYTES, packAces } from './aces-data'
import {
  DISPLAY_RENDERING_VERSION,
  HDR_CONTENT_VERSION,
  HDR_CONTENT_TARGET,
  prepareDisplayRendering,
} from './display-rendering'

export const HDR_RENDERING_TABLES_VERSION = `${DISPLAY_RENDERING_VERSION}:${HDR_CONTENT_VERSION}:fixed-sdr-srgb-p3-v1`
export const HDR_RENDERING_TABLES_BYTES = ACES_DATA_BYTES * 3
/** Pinned packed bytes for this version; recomputation tests guard numerical or packing changes. */
export const HDR_RENDERING_TABLE_HASHES = Object.freeze({
  version: HDR_RENDERING_TABLES_VERSION,
  hdr: '923ef46f98ad869d271e72180b4336e1d4903d7475f60758884ffe63d2cc1a99',
  srgb: '174645d4a3ae7cb0c88b24d3f647d09d1c175de279fa8f7aea23439ecba1cafd',
  'display-p3': '1c843785d48548630df2fcb29897da7e796ecba36c1d384a445767c04bf39e30',
})

/** Target-only CPU data. Consumers must not mutate or transfer these shared buffers. */
export interface HdrRenderingTables {
  readonly version: string
  readonly packed: Float32Array<ArrayBuffer>
  readonly sdr: Readonly<Record<'srgb' | 'display-p3', Float32Array<ArrayBuffer>>>
  readonly preparationMs: number
}

/** Preserve the existing three target preparations and their Float32 packing exactly. */
export function prepareHdrRenderingTableData(): HdrRenderingTables {
  const started = performance.now()
  const packed = packAces(prepareDisplayRendering(HDR_CONTENT_TARGET))
  const sdr = {
    srgb: packAces(prepareDisplayRendering({ mode: 'sdr', peak: 1, colorSpace: 'srgb' })),
    'display-p3': packAces(
      prepareDisplayRendering({ mode: 'sdr', peak: 1, colorSpace: 'display-p3' }),
    ),
  }
  return {
    version: HDR_RENDERING_TABLES_VERSION,
    packed,
    sdr,
    preparationMs: performance.now() - started,
  }
}

export function validateHdrRenderingTables(value: unknown): asserts value is HdrRenderingTables {
  const tables = value as Partial<HdrRenderingTables> | null
  if (
    !tables ||
    tables.version !== HDR_RENDERING_TABLES_VERSION ||
    !Number.isFinite(tables.preparationMs) ||
    tables.preparationMs! < 0 ||
    [tables.packed, tables.sdr?.srgb, tables.sdr?.['display-p3']].some(
      (table) =>
        !(table instanceof Float32Array) ||
        table.byteLength !== ACES_DATA_BYTES ||
        !table.every(Number.isFinite),
    )
  )
    throw new Error('Invalid fixed HDR rendering tables.')
}
