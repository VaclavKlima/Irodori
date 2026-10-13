import type { Photo, PhotoReference } from './contracts'

export const BROWSE_CHUNK_SIZE = 60
export class BrowseCatalogChangedError extends Error {
  constructor() {
    super('The browse catalog changed. Reload the results.')
    this.name = 'BrowseCatalogChangedError'
  }
}
/** contextBridge copies Errors into the renderer realm without custom prototypes. */
export function isBrowseCatalogChanged(error: unknown): boolean {
  return (
    error instanceof BrowseCatalogChangedError ||
    (error instanceof Error && error.message === 'The browse catalog changed. Reload the results.')
  )
}
export type BrowseGrouping = 'date' | 'month' | 'year'
export interface BrowseQuery {
  search: string
  grouping: BrowseGrouping
}
export type CaptureDateOrigin =
  | { kind: 'camera' }
  | { kind: 'merge-reference'; photoId: string; filename: string }
  | { kind: 'unknown' }
export interface BrowsePhoto extends Photo {
  captureDate: string | null
  dateOrigin: CaptureDateOrigin
}
export interface BrowseSection {
  key: string
  label: string
  offset: number
  count: number
  selected: number
}
export interface BrowseSummary {
  revision: number
  total: number
  selected: number
  outsideSelected: number
  sections: BrowseSection[]
}
export interface BrowseChunk {
  revision: number
  offset: number
  photos: BrowsePhoto[]
}
export interface BrowseLocation {
  revision: number
  index: number
  photo: BrowsePhoto
}
export const DEFAULT_BROWSE_QUERY: BrowseQuery = { search: '', grouping: 'date' }

/** Calendar text as recorded by the camera. Offsets never change its day or ordering. */
export function validatedCaptureDate(value?: string): string | null {
  if (typeof value !== 'string') return null
  const match =
    /^(\d{4})([-:])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,18}))?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/.exec(
      value.trim(),
    )
  if (!match) return null
  const [
    ,
    yearText,
    ,
    monthText,
    dayText,
    hour = '00',
    minute = '00',
    second = '00',
    fraction = '',
    ,
    offsetHour = '00',
    offsetMinute = '00',
  ] = match
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour) > 14 ||
    Number(offsetMinute) > 59 ||
    (Number(offsetHour) === 14 && Number(offsetMinute) !== 0)
  )
    return null
  return `${yearText}-${monthText}-${dayText}T${hour}:${minute}:${second}.${fraction.padEnd(18, '0')}`
}

export function browseTerms(search: string): string[] {
  return [...new Set(search.toLowerCase().trim().split(/\s+/).filter(Boolean))]
}
export function browseSectionKey(date: string | null, grouping: BrowseGrouping): string {
  return date?.slice(0, grouping === 'date' ? 10 : grouping === 'month' ? 7 : 4) ?? 'unknown'
}
export function browseSectionLabel(key: string): string {
  if (key === 'unknown') return 'Unknown date'
  const [year, month, day] = key.split('-')
  if (!month) return year
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${day ? `${Number(day)} ` : ''}${months[Number(month) - 1]} ${year}`
}

export interface BrowseSelectionOperations {
  select: (
    photo: PhotoReference,
    query: BrowseQuery,
    modifiers?: { shift?: boolean; toggle?: boolean; click?: boolean },
  ) => Promise<void>
  section: (key: string, query: BrowseQuery, selected: boolean) => Promise<void>
  clear: () => Promise<void>
}
