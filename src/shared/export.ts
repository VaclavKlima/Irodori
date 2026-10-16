export const EXPORT_VERSION = 1 as const
export const EXPORT_RENDERING_VERSION = 'jpeg-linear-lanczos3-v4-gpu'
export const EXPORT_CODEC_VERSION = 'libultrahdr-2.0.2-iso-native-v1'

export interface ExportOptions {
  version: 1
  output: 'auto' | 'sdr' | 'hdr'
  quality: number
  size:
    | { mode: 'original' }
    | { mode: 'longest'; edge: number }
    | { mode: 'fit'; width: number; height: number }
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
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 32768
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
  keys(value.size, ['mode', 'edge', 'width', 'height'])
  const size = value.size
  if (size.mode === 'original') keys(size, ['mode'])
  else if (size.mode === 'longest') {
    keys(size, ['mode', 'edge'])
    if (!dimension(size.edge)) throw new Error('Longest edge must be an integer from 1 to 32768.')
  } else if (size.mode === 'fit') {
    keys(size, ['mode', 'width', 'height'])
    if (!dimension(size.width) || !dimension(size.height))
      throw new Error('Width and height must be integers from 1 to 32768.')
  } else throw new Error('Invalid export size.')
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
export function exportGeometry(width: number, height: number, size: ExportOptions['size']) {
  if (!dimension(width) || !dimension(height)) throw new Error('Unsupported export dimensions.')
  const scale =
    size.mode === 'original'
      ? 1
      : size.mode === 'longest'
        ? Math.min(1, size.edge / Math.max(width, height))
        : Math.min(1, size.width / width, size.height / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
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
