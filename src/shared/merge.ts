import type { Photo } from './contracts'
import type { HdrWorkingAsset } from './hdr'
import type { ProcessingMetadata } from './lens'
import { verifyCaptureSequence, type CaptureMetadata } from './capture-sequence'

export const MERGE_VERSION = 'sony-merge-v4'
export type MergeVersion =
  'sony-merge-v1' | 'sony-merge-v2' | 'sony-merge-v3' | typeof MERGE_VERSION
export const MERGE_PIPELINE = Object.freeze({
  preparation: 'source-lens-common-crop-channel-proof-v4',
  alignment: 'masked-tile-ecc-native-v4',
  exposure: 'brk-tiled-radiometry-v4',
  accumulation: 'tiled-inverse-variance-confidence-v4',
  referenceFallback: 'sony-camera-highlight-blend-frozen-missing-reference-v4',
})
/** Versioned camera evidence arithmetic; omitted fields retain exact CPU preparation. */
export const GPU_CAMERA_PREPARATION = 'gpu-camera-v2-exact'
export type CameraPreparationPolicy = typeof GPU_CAMERA_PREPARATION
export const GPU_REFERENCE_PREPARATION = 'gpu-reference-fallback-v2-compensated'
export type ReferencePreparationPolicy = typeof GPU_REFERENCE_PREPARATION
export interface MergeReadMeasurements {
  bands: {
    requests: number
    cacheHits: number
    cacheMisses: number
    fileReads: number
    readBytes: number
    readingMs: number
    verifiedBytes: number
    hashingMs: number
    copyingMs: number
    allocatedBytes: number
    reusedStripBuffers: number
    peakCacheBytes: number
  }
  nativePlanes: {
    cacheHits: number
    cacheMisses: number
    fileReads: number
    readBytes: number
    readingMs: number
    verifiedBytes: number
    hashingMs: number
    conversionMs: number
    allocatedBytes: number
    stripBufferBytes: number
    peakCacheBytes: number
  }
  sensors: {
    files: number
    readBytes: number
    readingMs: number
    verifiedBytes: number
    hashingMs: number
  }
}
export interface MergeMeasurements {
  /** Relative spans in the merge process; nested/parallel spans must not be added. */
  timeline?: {
    clock: 'merge-worker-performance'
    preflight?: MergeTimingSpan
    preparation: { sourceId: string; span: MergeTimingSpan }[]
    referenceFallback?: MergeTimingSpan
    registration?: MergeTimingSpan
    coverage?: MergeTimingSpan
    accumulation?: MergeTimingSpan
    output?: MergeTimingSpan
  }
  /** Main-process durations, separate from worker clocks and overlapping stage totals. */
  publication?: {
    clock: 'main-performance'
    runtimeMs: number
    operationQueueMs: number
    reviewHandoffMs: number
    sourceVerification?: MergeVerificationTiming
    destinationVerification?: MergeVerificationTiming
    copyingMs: number
    fileSyncMs: number
    manifestMs: number
    directorySyncMs: number
    mutationQueueMs: number
    journalMs: number
    renameMs: number
    catalogCommitMs: number
    cleanupMs: number
  }
  stages: Record<
    | 'decoding'
    | 'preparation'
    | 'matching'
    | 'nativeValidation'
    | 'accumulation'
    | 'output'
    | 'publication',
    number
  >
  preparationProbe?: { runtimeMs: number; openingMs: number; opens: number }
  preparation: {
    backend: 'gpu' | 'cpu'
    adapter?: string
    fallback?: string
    reused: boolean
    decodingMs: number
    preparationMs: number
    cacheLookupMs?: number
    cacheWriteMs?: number
    gpu?: Record<string, number>
    decoder?: {
      opens: number
      openingMs: number
      sensorMs: number
      linearMs: number
      saturationMaskMs: number
    }
    work?: {
      maskRepairMs: number
      cameraRegistrationMs: number
      hashingMs: number
      writingMs: number
      sensorCacheMs: number
      reductionMs: number
      conversionMs: number
      highlightBlendMs?: number
      cameraPreparation?: {
        policy: CameraPreparationPolicy
        backend: 'gpu' | 'cpu'
        fallback?: string
        allocatedGpuBytes: number
        runtimeMs: number
        setupMs?: number
        uploadMs?: number
        dispatchReadbackMs?: number
        verificationMs?: number
        reductionMs?: number
        hashingMs?: number
        writingMs?: number
        closingMs?: number
        batches?: number
        inputBytes?: number
        outputBytes?: number
        scalarRepairs?: number
        thresholdRepairs?: number
        conditionRepairs?: number
        roundingRepairs?: number
      }
      referencePreparation?: {
        policy: ReferencePreparationPolicy
        backend: 'gpu' | 'cpu'
        fallback?: string
        allocatedGpuBytes: number
        runtimeMs: number
        setupMs?: number
        uploadMs?: number
        geometryMs?: number
        conversionMs?: number
        readbackMs?: number
        verificationMs?: number
        scalarRepairs?: number
        prefetchedStrips?: number
        discardedPrefetches?: number
      }
      cpuKernel?: {
        backend: 'wasm-simd' | 'scalar'
        heapBytes: number
        copyMs: number
        processingMs: number
        gainCacheEntries?: 2048 | 32768
      }
    }
  }[]
  referenceFallback?: {
    backend: 'cpu' | 'gpu'
    reused: boolean
    decodingMs: number
    preparationMs: number
    decoder?: MergeMeasurements['preparation'][number]['decoder']
    work?: MergeMeasurements['preparation'][number]['work']
  }
  accumulation: {
    backend: 'gpu' | 'cpu'
    kernel?: 'sensor-warp' | 'prepared-bands'
    referenceReused?: boolean
    adapter?: string
    fallback?: string
    batches?: {
      rows: number
      sourceBytes: number
      readingMs: number
      uploadMs: number
      dispatchMs: number
      readbackMs: number
      writingMs: number
    }
  }
  coverage?: { backend: 'gpu' | 'cpu'; fallback?: string }
  output?: {
    backend: 'gpu' | 'cpu'
    fallback?: string
    conversion?: {
      setupMs: number
      uploadMs: number
      dispatchMs: number
      readbackMs: number
      copyingMs: number
      batches: number
      pairedBatches?: number
      images?: number
      slots?: 1 | 2
      pendingPeak?: number
      timestampStatus?: 'disabled' | 'unavailable' | 'available' | 'error'
      gpuMs?: number
      gpuBatches?: number
      timestampErrors?: number
    }
    work?: {
      validityMs: number
      maskMs: number
      readingMs: number
      compositionMs: number
      thumbnailMs: number
      referenceMs: number
      writingMs: number
      hashingMs: number
      syncMs: number
      closingMs: number
      cpuConversionMs: number
      png: Partial<
        Record<
          'result' | 'reference' | 'overlay',
          {
            ms: number
            bytes: number
            compressionLevel?: number
          }
        >
      >
      jpeg: Partial<Record<'thumbnail' | 'preview', { ms: number; bytes: number }>>
    }
  }
  attempts: {
    sourceId: string
    referenceId: string
    success: boolean
    runtimeMs: number
    lane?: number
    queuedMs?: number
    /** Dispatch and completion observations on the merge process clock. */
    timeline?: { submittedMs: number; admittedMs: number; completedMs: number }
    reads?: MergeReadMeasurements
    patches?: { samplingMs: number; optimizationMs: number; count: number; pixels: number }
    diagnostics?: AlignmentDiagnostics[]
    reason?: string
  }[]
  disk: { readBytes: number; writtenBytes: number }
  reads?: MergeReadMeasurements
  peak: { workerBytes: number; gpuBytes: number; wasmBytes: number }
  runtimeMs: number
}
export interface MergeTimingSpan {
  startedMs: number
  completedMs: number
}
export interface MergeVerificationTiming {
  readingMs: number
  hashingMs: number
  pixelValidationMs: number
  metadataMs: number
  closingMs: number
}
export const MERGE_LIMITS = Object.freeze({
  minSources: 2,
  maxSources: 32,
  noiseSpreadEv: 0.1,
  rotationDegrees: 5,
  translationFraction: 0.1,
  coverage: 0.7,
  maxPixels: 24_000_000,
  stripRows: 64,
  previewEdge: 1024,
  exposureToleranceEv: 0.25,
  minimumOverlapSamples: 128,
  readNoise: 0.0015,
  shotNoise: 0.0001,
  maskRadius: 3,
})
export const ALIGNMENT_CONSTANTS = Object.freeze({
  version: 'opencv-4.13.0-orb-ecc-tile-ic-v4' as const,
  minimumInliers: 30,
  minimumCells: 6,
  grid: 4,
  ransacPixels: 2,
  nativeAccuracy: 0.5,
  minimumPatchAgreement: 0.7,
  minimumPatches: 8,
  nativePatchEdge: 160,
  trainingGrid: 12,
  validationGrid: 11,
  motionValidationGrid: 19,
  shadowFloor: 0.004,
  motionPatchEdge: 320,
  motionTrainingGrid: 16,
  motionPatchCorrelation: 0.98,
  motionValidFraction: 0.25,
  motionConsensusPixels: 0.8,
  maximumTileOffsetPixels: 3,
  maximumCompetingSupport: 0.4,
  minimumNativeCells: 4,
  eccTrainingGrid: 32,
  eccRefinementGrid: 48,
  eccValidationGrid: 35,
  eccPatchEdge: 160,
  eccConsensusPixels: 2,
  cameraRegistrationPolicy: 'unclipped-camera-channel-v1' as const,
  cameraRegistrationPaths: 'rgb-features-camera-features-rgb-ecc-v1' as const,
  cameraChannelCoverageGain: 0.02,
})
export const BRK_EXPOSURE_POLICY = Object.freeze({
  version: MERGE_PIPELINE.exposure,
  grid: 48,
  samplesPerTile: 16,
  minimumTileSamples: 4,
  minimumTiles: 8,
  minimumCells: 4,
  minimumSupport: 0.35,
  minimumAgreement: 0.7,
  residualEv: 0.1,
  maximumMetadataDeltaEv: 1,
  sourceExclusionFeatherPixels: 64,
})
export interface ExposureDiagnostics {
  policy: typeof BRK_EXPOSURE_POLICY
  referenceId: string
  nominalEv: number
  measuredEv: number
  metadataDeltaEv: number
  usableTiles: number
  trainingTiles: number
  trainingSamples: number
  validationSamples: number
  validationCells: number
  agreement: number
  medianResidualEv: number
  excludedTiles: number
}
export type MergeMode = 'hdr' | 'noise'
export interface MergeSettings {
  mode: MergeMode
  autoAlign: boolean
  deghost: boolean
  strength: number
  referenceId: string
  autoCrop: boolean
}
export interface MergeCapture {
  shutterSeconds: number
  iso: number
  aperture: number
  focalLength: number
  focusDistance?: number
}
export interface MergeSource {
  photo: Photo
  capture: MergeCapture
  relativeEv: number
  metadata: ProcessingMetadata
  /** Read from the managed original and frozen for the lifetime of this review. */
  captureMetadata?: CaptureMetadata
}
export type MergeMatrix = [number, number, number, number, number, number, number, number, number]
export interface AlignmentDiagnostics {
  algorithm: typeof ALIGNMENT_CONSTANTS.version
  model: 'similarity' | 'projective' | 'identity'
  matches: number
  inliers: number
  cells: number
  nativePatches: {
    x: number
    y: number
    dx: number
    dy: number
    correlation: number
    accepted: boolean
  }[]
  movingRegions: { left: number; top: number; width: number; height: number }[]
  via?: string
  method?: 'orb' | 'ecc-patches' | 'identical'
  registrationChannel?: 'red' | 'green' | 'blue'
  reason?: string
  usableCoverage?: number
  patchSupport?: number
  motionSupport?: { observations: number; candidates: number; training: number; heldOut: number }
  runtimeMs: number
  wasmMemoryBytes: number
}
export interface MergeFailure {
  code: 'alignment' | 'exposure' | 'coverage' | 'cancelled' | 'processing'
  message: string
  filenames: string[]
  diagnostics: AlignmentDiagnostics[]
  measurements?: MergeMeasurements
}
export class MergeError extends Error {
  constructor(readonly failure: MergeFailure) {
    super(failure.message)
    this.name = 'MergeError'
  }
}
export function mergeFailure(error: unknown): MergeFailure {
  if (error instanceof MergeError) return error.failure
  return {
    code: 'processing',
    message:
      error instanceof Error && 'code' in error
        ? 'Merge processing could not read or write its managed working data.'
        : error instanceof Error
          ? error.message
          : 'Merge processing failed.',
    filenames: [],
    diagnostics: [],
  }
}
export interface MergeDiagnostics {
  reviewId: string
  revision: number
  status: 'pending' | 'ready' | 'failed'
  sources: { id: string; filename: string; diagnostics?: AlignmentDiagnostics }[]
  error?: MergeFailure
  measurements?: MergeMeasurements
}
/** Inverse warp from reference coordinates to source, rotating about the image center. */
export interface MergeTransform {
  x: number
  y: number
  angle: number
  correlation: number
  matrix?: MergeMatrix
  diagnostics?: AlignmentDiagnostics
  tiles?: { columns: number; rows: number; width: number; height: number; offsets: number[] }
}
export interface MergeCrop {
  left: number
  top: number
  width: number
  height: number
}
export interface MergePreparation {
  policy: typeof MERGE_PIPELINE.preparation
  capture: import('./capture-sequence').CaptureSequence
  /** Centered crop in unrotated decoder coordinates, before registration. */
  commonCrop: MergeCrop
  sources: { id: string; width: number; height: number; flip: number; lensIdentity: string }[]
}
export interface MergeRecipe {
  resolution: 'preview' | 'native'
  maskDimensions: { width: number; height: number }
  version: MergeVersion
  constants: typeof MERGE_LIMITS
  alignment?: typeof ALIGNMENT_CONSTANTS
  pipeline?: typeof MERGE_PIPELINE
  cameraPreparation?: CameraPreparationPolicy
  referenceFallbackPreparation?: ReferencePreparationPolicy
  measurements?: MergeMeasurements
  settings: MergeSettings
  sources: {
    id: string
    filename: string
    capture: MergeCapture
    scale: number
    transform: MergeTransform
    decoder: string
    cameraProfile: string
    lensIdentity: string
    photometry?: ExposureDiagnostics
    cameraPreparation?: CameraPreparationPolicy
  }[]
  width: number
  height: number
  crop: MergeCrop
  preparation?: MergePreparation
  affectedPercent: number
  referenceClippedPercent: number
  maskSha256: string
}
export interface MergeReview {
  id: string
  revision: number
  sources: MergeSource[]
  settings: MergeSettings
  scratchBytes: number
}
export interface MergePreview {
  reviewId: string
  revision: number
  resultUrl: string
  referenceUrl: string
  overlayUrl: string
  width: number
  height: number
  recipe: MergeRecipe
}
export interface MergeManifest {
  version: MergeVersion
  asset: HdrWorkingAsset
  recipe: MergeRecipe
  photo: Photo
  metadata: ProcessingMetadata
}
export function mergeUnavailable(count: number): string | undefined {
  return count < 2
    ? 'Select at least two verified Sony RAW photographs.'
    : count > 32
      ? 'Select no more than 32 photographs.'
      : undefined
}
/** Early menu checks only; review validation owns camera and capture compatibility. */
export function groupMergeUnavailable(originals: readonly Photo[]): string | undefined {
  if (originals.length < MERGE_LIMITS.minSources)
    return 'The group needs at least two original Sony RAW photographs.'
  if (originals.length > MERGE_LIMITS.maxSources)
    return 'Group merge supports no more than 32 originals.'
  if (originals.some((photo) => photo.format.toUpperCase() !== 'ARW'))
    return 'Every group original must be a Sony ARW. Unsupported originals cannot be omitted.'
  return undefined
}
export function validateMergeSettings(value: MergeSettings, ids: string[]): void {
  if (
    !value ||
    Object.keys(value).sort().join() !== 'autoAlign,autoCrop,deghost,mode,referenceId,strength' ||
    !['hdr', 'noise'].includes(value.mode) ||
    !ids.includes(value.referenceId) ||
    !Number.isInteger(value.strength) ||
    value.strength < 0 ||
    value.strength > 100 ||
    ![value.autoAlign, value.autoCrop, value.deghost].every((v) => typeof v === 'boolean')
  )
    throw new Error('Invalid merge settings.')
}
export function exposure(capture: MergeCapture): number {
  return (capture.shutterSeconds * capture.iso) / capture.aperture ** 2
}
export function verifiedBracket(sources: MergeSource[]) {
  if (sources.some((s) => !s.captureMetadata)) return null
  const capture = verifyCaptureSequence(
    sources.map((s) => ({ id: s.photo.id, metadata: s.captureMetadata! })),
  )
  return capture?.kind === 'bracket' ? capture : null
}
export function validateMergeSources(sources: MergeSource[], mode: MergeMode): void {
  const unavailable = mergeUnavailable(sources.length)
  if (unavailable) throw new Error(unavailable)
  if (new Set(sources.map((s) => s.photo.id)).size !== sources.length)
    throw new Error('Duplicate merge sources.')
  const first = sources[0]
  const bracket = mode === 'hdr' && verifiedBracket(sources)
  for (const s of sources) {
    const m = s.metadata,
      c = s.capture
    if (
      s.photo.assetKind === 'derived' ||
      !m.hdrEligible ||
      !['ZV-1', 'ZV-1A'].includes(m.model ?? '') ||
      !m.whiteBalance ||
      ![c.shutterSeconds, c.iso, c.aperture, c.focalLength].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new Error(
        `${s.photo.filename}: a verified Sony RAW with numeric capture metadata is required.`,
      )
    if (m.model !== first.metadata.model || m.make !== first.metadata.make)
      throw new Error(`${s.photo.filename}: camera differs from ${first.photo.filename}.`)
    if (!bracket && (s.photo.width !== first.photo.width || s.photo.height !== first.photo.height))
      throw new Error(`${s.photo.filename}: dimensions differ from ${first.photo.filename}.`)
    if (!bracket && c.aperture !== first.capture.aperture)
      throw new Error(
        `${s.photo.filename}: aperture differs from ${first.photo.filename}. Aperture changes require HDR mode and one verified continuous BRK trigger.`,
      )
    if (c.focalLength !== first.capture.focalLength)
      throw new Error(`${s.photo.filename}: focal length differs from ${first.photo.filename}.`)
    if (
      c.focusDistance !== undefined &&
      first.capture.focusDistance !== undefined &&
      c.focusDistance !== first.capture.focusDistance
    )
      throw new Error(`${s.photo.filename}: focus distance differs from ${first.photo.filename}.`)
  }
  const evs = sources.map((s) => Math.log2(exposure(s.capture)))
  if (mode === 'noise' && Math.max(...evs) - Math.min(...evs) > MERGE_LIMITS.noiseSpreadEv + 1e-9)
    throw new Error(
      'Noise reduction requires exposures within 0.1 EV. Use HDR mode for this selection.',
    )
}
