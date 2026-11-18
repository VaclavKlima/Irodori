import {
  validateInspectionOptions,
  type InspectionBounds,
  type InspectionRegion,
} from './inspection'
import type { HdrPhotoStatistics } from './hdr-statistics'
import type { PhotoStatistics } from './statistics'

export interface PhotoDiagnosticsRequest {
  photoId: string
  expectedRevision: number
  region?: InspectionRegion
  target?: 'current' | 'sdr'
  targetGeneration?: number
}

export type DiagnosticPart<T> =
  { status: 'available'; value: T } | { status: 'unavailable'; reason: string }

export interface DiagnosticImage {
  label: 'clipping' | 'above-white'
  width: number
  height: number
  mimeType: 'image/png'
  byteLength: number
  sha256: string
  legend: Record<string, string>
  data: string
}

export interface PhotoDiagnosticsResult {
  photoId: string
  revision: number
  gridIdentity: string
  bounds: InspectionBounds
  nativeGrid: { width: number; height: number }
  sourceDynamicRange: 'hdr' | 'sdr'
  target: {
    selection: 'current' | 'sdr'
    mode: 'hdr' | 'sdr'
    colorSpace: 'srgb' | 'display-p3'
    generation: number
    headroom: number | null
  }
  histogram: DiagnosticPart<{
    domain: 'output-hdr' | 'output-sdr'
    exact: true
    statistics: HdrPhotoStatistics | PhotoStatistics
  }>
  clipping: DiagnosticPart<{
    exact: true
    counts: { output: number } | { highlights: number; shadows: number }
  }>
  aboveWhite: DiagnosticPart<{
    domain: 'content-hdr'
    referenceWhite: 1
    exact: true
    count: number
    exceedingHeadroom: number | null
    gamutLimited: number | null
  }>
  images: DiagnosticImage[]
  imagesUnavailable?: string
}

export function validatePhotoDiagnosticsRequest(value: unknown): PhotoDiagnosticsRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !['photoId', 'expectedRevision', 'region', 'target', 'targetGeneration'].includes(key),
    )
  )
    throw new Error('Invalid photo diagnostics request.')
  const request = value as PhotoDiagnosticsRequest
  if (
    typeof request.photoId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.photoId) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0 ||
    (request.target !== undefined && request.target !== 'current' && request.target !== 'sdr')
  )
    throw new Error('Invalid photo diagnostics request.')
  if (request.target === 'sdr' && request.targetGeneration !== undefined)
    throw new Error('A fixed SDR diagnostic does not use a display generation.')
  if (
    request.target !== 'sdr' &&
    (typeof request.targetGeneration !== 'number' ||
      !Number.isSafeInteger(request.targetGeneration) ||
      request.targetGeneration < 0)
  )
    throw new Error('Read the current display generation before requesting current diagnostics.')
  validateInspectionOptions({ region: request.region })
  return structuredClone(request)
}
