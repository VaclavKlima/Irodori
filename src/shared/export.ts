import { MAX_FRAME_BYTES } from './preview-frame'

export const EXPORT_VERSION = 1 as const
export const EXPORT_RENDERING_VERSION = 'jpeg-linear-lanczos3-v5-enlargement'
export const EXPORT_CODEC_VERSION = 'libultrahdr-2.0.2-iso-native-v1'
export const EXPORT_RESIZE_VERSION = 'linear-lanczos3-pixel-centers-replicate-v1'
export const EXPORT_MAX_DIMENSION = 32768
export const EXPORT_MAX_PIXELS = MAX_FRAME_BYTES / 16
export const exportResizeCapabilities = {
  methods: ['lanczos3'],
  defaultMethod: 'lanczos3',
  defaultAllowEnlargement: false,
  maxDimension: EXPORT_MAX_DIMENSION,
  maxPixels: EXPORT_MAX_PIXELS,
  version: EXPORT_RESIZE_VERSION,
} as const

interface ResizeChoice {
  allowEnlargement?: boolean
  method?: 'lanczos3'
}

export interface ExportOptions {
  version: 1
  output: 'auto' | 'sdr' | 'hdr'
  quality: number
  size:
    | { mode: 'original' }
    | ({ mode: 'longest'; edge: number } & ResizeChoice)
    | ({ mode: 'fit'; width: number; height: number } & ResizeChoice)
  names: { mode: 'original'; suffix: string } | { mode: 'sequence'; prefix: string }
  metadata: 'camera-copyright' | 'copyright' | 'none'
  existing: 'rename' | 'skip'
}
export const defaultExportOptions: ExportOptions = {
  version: EXPORT_VERSION,
  output: 'auto',
  quality: 90,
  size: { mode: 'original' },
  names: { mode: 'original', suffix: '' },
  metadata: 'camera-copyright',
  existing: 'rename',
}
export const exportPresets = [
  { id: 'maximum', label: 'Maximum quality', quality: 100 },
  { id: 'high', label: 'High quality', quality: 90 },
  { id: 'smaller', label: 'Smaller file', quality: 80 },
] as const
export type ExportAction = (typeof exportPresets)[number]['id'] | 'custom' | 'last-custom'
export interface ExportDestination {
  id: string
  label: string
  available: boolean
}
export interface ExportPreferences {
  version: 1
  destination: ExportDestination | null
  lastCustom: ExportOptions | null
}
export interface ExportCapabilities {
  format: 'jpeg'
  hdr: 'iso-21496-1'
  codec: typeof EXPORT_CODEC_VERSION
  rendering: typeof EXPORT_RENDERING_VERSION
  resize: typeof exportResizeCapabilities
  hdrAvailable: boolean
  hdrUnavailableReason?: string
}
export interface ExportTarget {
  photoId: string
  filename: string
  revision: number
  hdr: boolean
}
export interface ExportPreparation {
  id: string
  targets: ExportTarget[]
  hdr: number
  sdr: number
}
export interface ExportStart {
  preparationId: string
  destinationId: string
  action: ExportAction
  options?: ExportOptions
}

export function validateExportPhotoIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100000 ||
    value.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
  )
    throw new Error('Choose photographs to export.')
  return [...new Set(value)]
}

export interface ExportResult {
  index: number
  photoId: string
  filename: string
  outputName?: string
  status: 'pending' | 'writing' | 'publishing' | 'exported' | 'skipped' | 'failed' | 'cancelled'
  message?: string
}

function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid export settings.')
}
const dimension = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= EXPORT_MAX_DIMENSION
function namePart(value: unknown, empty: boolean): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    (empty || value.trim().length > 0) &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/[/\\:<>"|?*]/.test(value) &&
    !/[. ]$/.test(value)
  )
}
export function validateExportOptions(value: unknown): ExportOptions {
  keys(value, ['version', 'output', 'quality', 'size', 'names', 'metadata', 'existing'])
  if (
    value.version !== 1 ||
    !['auto', 'sdr', 'hdr'].includes(String(value.output)) ||
    !Number.isSafeInteger(value.quality) ||
    Number(value.quality) < 1 ||
    Number(value.quality) > 100 ||
    !['camera-copyright', 'copyright', 'none'].includes(String(value.metadata)) ||
    !['rename', 'skip'].includes(String(value.existing))
  )
    throw new Error('Invalid export settings.')
  validateSize(value.size)
  keys(value.names, ['mode', 'suffix', 'prefix'])
  if (value.names.mode === 'original') {
    keys(value.names, ['mode', 'suffix'])
    if (!namePart(value.names.suffix, true))
      throw new Error('Use a filename suffix without path separators or reserved characters.')
  } else if (value.names.mode === 'sequence') {
    keys(value.names, ['mode', 'prefix'])
    if (!namePart(value.names.prefix, false))
      throw new Error('Use a filename prefix without path separators or reserved characters.')
  } else throw new Error('Invalid export naming.')
  return structuredClone(value) as unknown as ExportOptions
}
function validateSize(size: unknown): asserts size is ExportOptions['size'] {
  keys(size, ['mode', 'edge', 'width', 'height', 'allowEnlargement', 'method'])
  if (size.mode === 'original') keys(size, ['mode'])
  else if (size.mode === 'longest') {
    keys(size, ['mode', 'edge', 'allowEnlargement', 'method'])
    if (!dimension(size.edge)) throw new Error('Longest edge must be an integer from 1 to 32768.')
  } else if (size.mode === 'fit') {
    keys(size, ['mode', 'width', 'height', 'allowEnlargement', 'method'])
    if (!dimension(size.width) || !dimension(size.height))
      throw new Error('Width and height must be integers from 1 to 32768.')
  } else throw new Error('Invalid export size.')
  if (
    ('allowEnlargement' in size && typeof size.allowEnlargement !== 'boolean') ||
    ('method' in size && size.method !== 'lanczos3')
  )
    throw new Error('Choose Lanczos3 and a valid enlargement option.')
}
export function exportAllowsEnlargement(size: ExportOptions['size']): boolean {
  return size.mode !== 'original' && size.allowEnlargement === true
}
export function exportGeometry(width: number, height: number, size: ExportOptions['size']) {
  if (!dimension(width) || !dimension(height)) throw new Error('Unsupported export dimensions.')
  validateSize(size)
  const limit = exportAllowsEnlargement(size) ? Infinity : 1
  const scale =
    size.mode === 'original'
      ? 1
      : size.mode === 'longest'
        ? Math.min(limit, size.edge / Math.max(width, height))
        : Math.min(limit, size.width / width, size.height / height)
  const geometry = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
  if (geometry.width * geometry.height > EXPORT_MAX_PIXELS)
    throw new Error('Export exceeds the floating-point image limit. Choose smaller dimensions.')
  return geometry
}
export function exportFilename(filename: string, names: ExportOptions['names'], index: number) {
  const stem =
    names.mode === 'sequence'
      ? `${names.prefix}${String(index + 1).padStart(4, '0')}`
      : filename.replace(/^.*[/\\]/, '').replace(/\.[^.]*$/, '') + names.suffix
  const safe =
    [...stem]
      .map((c) =>
        c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || /[/\\:<>"|?*]/.test(c) ? '_' : c,
      )
      .join('')
      .replace(/[. ]+$/, '')
      .slice(0, 180) || 'Photo'
  const encoder = new TextEncoder()
  const codepoints = [...safe]
  while (encoder.encode(codepoints.join('')).length > 220) codepoints.pop()
  const stemName = codepoints.join('')
  return `${/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stemName) ? '_' : ''}${stemName}.jpg`
}
export function exportCounts(preparation: ExportPreparation, output: ExportOptions['output']) {
  return output === 'sdr'
    ? { hdr: 0, sdr: preparation.targets.length }
    : output === 'hdr'
      ? { hdr: preparation.targets.length, sdr: 0 }
      : { hdr: preparation.hdr, sdr: preparation.sdr }
}

export type ExportWorkerPhase =
  'rendition-rendered' | 'sdr-jpeg-obtained' | 'hdr-encoded' | 'output-validated-written'

/** Actual completed worker stages; epochs are stamped by the producer after work. */
export interface ExportWorkerProgress {
  version: 'export-worker-progress-v1'
  exportId: string
  fileIndex: number
  photoId: string
  settingsRevision: number
  attemptId: string
  sequence: number
  phase: ExportWorkerPhase
  completed: number
  total: number
  producedAtEpochMs: number
}

/** Volatile observation only; never persisted into export history or manifests. */
export interface ExportWorkerProgressSnapshot {
  counter: number
  dropped: number
  active?: { fileIndex: number; attemptId: string }
  events: ExportWorkerProgress[]
}
