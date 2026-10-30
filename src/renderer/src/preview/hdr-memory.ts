import { ACES_DATA_BYTES } from '../../../shared/aces-data'
import { HDR_RENDERING_TABLES_BYTES } from '../../../shared/hdr-rendering-tables'
import { HDR_CACHE_MAX_TILES, hdrCacheTileSize } from './hdr-render-cache'

export type HdrRetentionMethod = 'raw-half-cpu' | 'cpu-staging'
export const HDR_BITMAP_RESERVATION: HdrManagedBytes = Object.freeze({
  ramBytes: 256 * 1024 ** 2,
  vramBytes: 256 * 1024 ** 2,
})
export const HDR_TRANSPORT_CHUNK_BYTES = 1024 ** 2
export const HDR_RETAINED_STAGING_BYTES = 4 * 1024 ** 2
const HISTOGRAM_BYTES = (256 + 512 * 3 + 9) * 4
const ZERO: HdrManagedBytes = Object.freeze({ ramBytes: 0, vramBytes: 0 })

/** Logical managed ownership. GPU bytes include API resources, not measured physical VRAM. */
export interface HdrManagedBytes {
  readonly ramBytes: number
  readonly vramBytes: number
}

/** Capture once per presenter from the resolved resource policy. Do not mutate on drag or resize. */
export interface HdrMemoryLimits extends HdrManagedBytes {
  readonly revision: number
}

export interface HdrRecoveryReservation {
  /** Old raw owners surviving a differently sized replacement, including their host map allowance. */
  readonly rawReplacementOverlap: HdrManagedBytes
  /** Every old raw owner still live while CPU staging completes and drains it. */
  readonly cpuStagingCarry: HdrManagedBytes
}

export interface HdrMemoryRequest {
  readonly width: number
  readonly height: number
  readonly canvasWidth?: number
  readonly canvasHeight?: number
  readonly maximumLayers?: number
  /** Caller probes support and per-buffer adapter limits separately; the planner never bypasses them. */
  readonly rawHalfSupported?: boolean
  readonly diagnostic?: HdrManagedBytes
  /** Opaque pinned/reserved ImageBitmap storage, after evicting optional unpinned entries. */
  readonly bitmapReservation: HdrManagedBytes
  /** Retained exact RGBA16F surfaces, including in-flight retired leases. */
  readonly retainedPresentationBytes?: number
  readonly restoredUpload?: HdrManagedBytes
  readonly recovery?: HdrRecoveryReservation
  /** Any additional caller-owned or retired resources; never substitute a whole-process sample. */
  readonly otherReservations?: HdrManagedBytes
}

function byteCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label} byte count.`)
  return value
}

function integer(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label}.`)
  return value
}

function product(label: string, ...values: number[]) {
  return values.reduce((result, value) => byteCount(result * value, label), 1)
}

function bytes(ramBytes: number, vramBytes: number): HdrManagedBytes {
  return Object.freeze({
    ramBytes: byteCount(ramBytes, 'RAM'),
    vramBytes: byteCount(vramBytes, 'GPU'),
  })
}

function copy(value: HdrManagedBytes = ZERO) {
  return bytes(value.ramBytes, value.vramBytes)
}

function sum(...values: readonly HdrManagedBytes[]): HdrManagedBytes {
  return values.reduce(
    (total, value) => bytes(total.ramBytes + value.ramBytes, total.vramBytes + value.vramBytes),
    ZERO,
  )
}

export function freezeHdrMemoryLimits(value: HdrMemoryLimits): Readonly<HdrMemoryLimits> {
  const checked = copy(value)
  if (!Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error('Invalid HDR memory policy revision.')
  return Object.freeze({ ...checked, revision: value.revision })
}

export function fitsBoth(ownership: HdrManagedBytes, limits: HdrMemoryLimits) {
  return ownership.ramBytes <= limits.ramBytes && ownership.vramBytes <= limits.vramBytes
}

/** Restored native backing can overlap source upload. These browser allowances are estimates. */
export function hdrRestoredUploadMemory(width: number, height: number): HdrManagedBytes {
  integer(width, 'restored canvas width')
  integer(height, 'restored canvas height')
  const canvasBytes = product('restored native backing', width, height, 32)
  return bytes(canvasBytes + HDR_RETAINED_STAGING_BYTES + 64 * 1024, canvasBytes)
}

/**
 * Conservative managed-resource admission. Source mip arithmetic and tile128 selection are unchanged.
 * RAM and GPU maxima are tested independently; never add them to claim unique resident memory.
 */
export function hdrPresentationMemory(request: HdrMemoryRequest, limits: HdrMemoryLimits) {
  const frozenLimits = freezeHdrMemoryLimits(limits)
  const width = integer(request.width, 'HDR width')
  const height = integer(request.height, 'HDR height')
  const canvasWidth = byteCount(request.canvasWidth ?? 0, 'canvas width')
  const canvasHeight = byteCount(request.canvasHeight ?? 0, 'canvas height')
  if ((canvasWidth === 0) !== (canvasHeight === 0))
    throw new Error('HDR canvas dimensions must both be zero or positive.')
  const maximumLayers = integer(request.maximumLayers ?? HDR_CACHE_MAX_TILES, 'HDR array layers')
  if (request.rawHalfSupported !== undefined && typeof request.rawHalfSupported !== 'boolean')
    throw new Error('Invalid HDR recovery support state.')
  const retainedPresentationBytes = byteCount(
    request.retainedPresentationBytes ?? 0,
    'retained presentation',
  )
  if (!request.bitmapReservation)
    throw new Error('HDR planning requires an explicit pinned/reserved bitmap ownership estimate.')
  const bitmapReservation = copy(request.bitmapReservation)
  const diagnostic = copy(request.diagnostic)
  const restoredUpload = copy(request.restoredUpload)
  const otherReservations = copy(request.otherReservations)
  const rawOverlap = copy(request.recovery?.rawReplacementOverlap)
  const cpuStagingCarry = copy(request.recovery?.cpuStagingCarry)
  const sourcePixels = product('source pixels', width, height)
  const canvasPixels = product('canvas pixels', canvasWidth, canvasHeight)
  let sourceTextureBytes = 0,
    maskPyramidBytes = 0
  for (
    let w = width, h = height;
    ;
    w = Math.max(1, Math.floor(w / 2)), h = Math.max(1, Math.floor(h / 2))
  ) {
    sourceTextureBytes = byteCount(sourceTextureBytes + product('source mip', w, h, 16), 'mips')
    if (w === 1 && h === 1) break
  }
  for (let w = width, h = height; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
    maskPyramidBytes = byteCount(maskPyramidBytes + product('mask mip', w, h), 'mask pyramid')
    if (w === 1 && h === 1) break
  }
  const stripBytes = product('64-row strip', width, Math.min(64, height), 16)
  const samplePlaneBytes = product(
    'source samples',
    Math.min(65536, sourcePixels) + Math.min(8192, sourcePixels),
    16,
  )
  const paddedReadbackBytes = canvasPixels
    ? product(
        'recovery readback',
        Math.ceil(product('half row', canvasWidth, 8) / 256),
        256,
        canvasHeight,
      )
    : 0
  const nativeBackingBytes = product('native browser backing allowance', canvasPixels, 32)
  const overlaySourceBytes = product('maximum overlay staging', sourcePixels, 4)
  const overlayCanvasBytes = product('overlay canvas', canvasPixels, 4)
  const tileSize = hdrCacheTileSize(width, height)
  const tileBytes = product('cached tile', tileSize + 2, tileSize + 2, 16)
  const sourceGridTiles = product(
    'source tile grid',
    Math.ceil(width / tileSize),
    Math.ceil(height / tileSize),
  )
  const lookupBytes = product('GPU lookup', sourceGridTiles, 8)
  const jobBytes = HDR_CACHE_MAX_TILES * 16
  const maximumSlots = Math.min(HDR_CACHE_MAX_TILES, maximumLayers, sourceGridTiles * 4)

  const owners = Object.freeze({
    source: bytes(0, sourceTextureBytes),
    // Three credited input strips, three asynchronous digest snapshots, and three
    // writeTexture host-staging copies may overlap. GPU staging remains three strips.
    uploadStaging: bytes(stripBytes * 9, stripBytes * 3),
    transport: bytes(HDR_TRANSPORT_CHUNK_BYTES * 2, 0),
    // Source module, analysis worker and transient structured clone may coexist.
    samples: bytes(samplePlaneBytes * 3, 0),
    // A previous published mask and a new worker pyramid may overlap at generation handoff.
    analysis: bytes(maskPyramidBytes * 2 + stripBytes * 2 + HISTOGRAM_BYTES * 2, 0),
    // GPU APIs do not expose native canvas swapchain count or a possible host mirror.
    nativeCanvas: bytes(nativeBackingBytes, nativeBackingBytes),
    // Worst-case compact overlay array + CPU backing, plus its possible GPU backing.
    // Existing overlay implementation can use source dimensions; no per-mip paging is added.
    overlay: bytes(
      overlaySourceBytes * 2 + overlayCanvasBytes,
      overlaySourceBytes + overlayCanvasBytes,
    ),
    tablesAndHistogram: bytes(
      HDR_RENDERING_TABLES_BYTES + HISTOGRAM_BYTES,
      ACES_DATA_BYTES * 3 + 192 * 2 + HISTOGRAM_BYTES * 2,
    ),
    // Bounded JS metadata estimate and simultaneous lookup/jobs arrays. This is not V8 heap accounting.
    cacheControl: bytes(
      lookupBytes * 2 + jobBytes * 2 + HDR_CACHE_MAX_TILES * 256,
      lookupBytes + jobBytes,
    ),
    cpuStaging: bytes(HDR_RETAINED_STAGING_BYTES * 2, 0),
    // Two owned half planes + rare CPU float16 canvas + mapped host allowance.
    rawRecovery: bytes(canvasPixels * 24 + paddedReadbackBytes, paddedReadbackBytes),
    retainedPresentation: bytes(0, retainedPresentationBytes),
    bitmapReservation,
    diagnostic,
    otherReservations,
    bookkeeping: bytes(64 * 1024, 0),
  })
  const common = sum(
    owners.source,
    owners.transport,
    owners.samples,
    owners.tablesAndHistogram,
    owners.retainedPresentation,
    owners.bitmapReservation,
    owners.diagnostic,
    owners.otherReservations,
    owners.bookkeeping,
  )
  const uploadPeak = sum(
    common,
    owners.uploadStaging,
    bytes(HDR_RETAINED_STAGING_BYTES, 0),
    restoredUpload,
  )
  const presentationBase = sum(
    common,
    owners.analysis,
    owners.nativeCanvas,
    owners.overlay,
    owners.cacheControl,
    owners.cpuStaging,
  )
  const minimumTile = bytes(0, tileBytes)
  const rawMinimum = sum(presentationBase, owners.rawRecovery, rawOverlap, minimumTile)
  const rawHalf =
    canvasPixels > 0 && request.rawHalfSupported !== false && fitsBoth(rawMinimum, frozenLimits)
  const retentionMethod = rawHalf ? ('raw-half-cpu' as const) : ('cpu-staging' as const)
  const uncachedPresentation = sum(
    presentationBase,
    rawHalf ? sum(owners.rawRecovery, rawOverlap) : cpuStagingCarry,
  )
  // A required tile is still charged when no slot fits, so fitsBoth reports rejection honestly.
  const availableGpuBytes = frozenLimits.vramBytes - uncachedPresentation.vramBytes
  const cacheSlots = Math.max(1, Math.min(maximumSlots, Math.floor(availableGpuBytes / tileBytes)))
  const tileStorage = bytes(0, product('tile cache', cacheSlots, tileBytes))
  const presentationPeak = sum(uncachedPresentation, tileStorage)
  const peak = bytes(
    Math.max(uploadPeak.ramBytes, presentationPeak.ramBytes),
    Math.max(uploadPeak.vramBytes, presentationPeak.vramBytes),
  )
  return Object.freeze({
    limits: frozenLimits,
    owners,
    tileSize,
    tileBytes,
    cacheSlots,
    tileStorage,
    cacheBytes: tileStorage.vramBytes + owners.cacheControl.vramBytes,
    retentionMethod,
    uploadPeak,
    presentationPeak,
    peak,
    accepted: fitsBoth(peak, frozenLimits),
    // Debug allowance sum only: opaque backing may be charged to both resource budgets.
    total: Math.max(
      uploadPeak.ramBytes + uploadPeak.vramBytes,
      presentationPeak.ramBytes + presentationPeak.vramBytes,
    ),
    rawMinimum,
    minimumPresentation: sum(uncachedPresentation, minimumTile),
  })
}

interface RetainedPresentationMemory {
  readonly budget: number
  pauseRetaining: () => () => void
  clearAndDrain: () => Promise<void>
}

type HeadroomRequest = Omit<HdrMemoryRequest, 'retainedPresentationBytes'>

/** Preserve existing pause/clear/drain ownership. Optional retained surfaces never force CPU staging. */
export class HdrPresentationHeadroom {
  readonly limits: Readonly<HdrMemoryLimits>
  private bypass = false
  private closed = false
  private draining?: Promise<void>
  private resumeRetaining?: () => void
  constructor(
    limits: HdrMemoryLimits,
    private cache: RetainedPresentationMemory | null,
  ) {
    this.limits = freezeHdrMemoryLimits(limits)
  }
  get bypassed() {
    return this.bypass
  }
  get eligible() {
    return !!this.cache && !this.bypass && !this.closed
  }
  get reservationBytes() {
    return this.eligible ? byteCount(this.cache!.budget, 'retained presentation budget') : 0
  }
  plan(request: HeadroomRequest) {
    if (this.closed) throw new Error('HDR presentation headroom is closed.')
    // A drain may await fences. Capture scalars and nested reservations before yielding.
    const captured = Object.freeze({
      ...request,
      bitmapReservation: copy(request.bitmapReservation),
      diagnostic: copy(request.diagnostic),
      restoredUpload: copy(request.restoredUpload),
      otherReservations: copy(request.otherReservations),
      recovery: Object.freeze({
        rawReplacementOverlap: copy(request.recovery?.rawReplacementOverlap),
        cpuStagingCarry: copy(request.recovery?.cpuStagingCarry),
      }),
    })
    const memory = (retainedPresentationBytes = this.reservationBytes) =>
      hdrPresentationMemory({ ...captured, retainedPresentationBytes }, this.limits)
    const reserved = memory()
    const ordinary = this.eligible ? memory(0) : reserved
    if (
      this.eligible &&
      (!reserved.accepted ||
        (reserved.retentionMethod === 'cpu-staging' && ordinary.retentionMethod === 'raw-half-cpu'))
    ) {
      this.bypass = true
      this.resumeRetaining = this.cache!.pauseRetaining()
      this.draining = this.cache!.clearAndDrain()
    }
    return this.draining ? this.draining.then(() => memory()) : reserved
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    const resume = this.resumeRetaining
    this.resumeRetaining = undefined
    if (resume) void this.draining!.then(resume, resume)
  }
}
