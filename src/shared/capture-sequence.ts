export const CAPTURE_METADATA_VERSION = 2
export const CAPTURE_SEQUENCE_PROFILE = 'sony-zv1a-arw-continuous-v1'
export const CAPTURE_SEQUENCE_PROFILES = {
  continuous: CAPTURE_SEQUENCE_PROFILE,
  continuousHigh: 'sony-zv1a-arw-continuous-hi-v1',
  bracket: 'sony-zv1a-arw-brk-v1',
} as const

/** Capture facts are independent of processing metadata and immutable merge recipes. */
export interface CaptureMetadata {
  version: number
  make?: string
  model?: string
  serial?: string
  format: string
  dateTimeOriginal?: string
  subSecTimeOriginal?: string
  offsetTimeOriginal?: string
  preciseTime?: string
  driveMode?: number
  releaseMode?: number
  releaseMode2?: number
  releaseMode3?: number
  sequenceNumber?: number
  sequenceImageNumber?: number
  sequenceFileNumber?: number
  sequenceLength?: number
  shutterSeconds?: number
}

export function captureMetadata(tags: Record<string, unknown>, format: string): CaptureMetadata {
  const string = (key: string) =>
    typeof tags[key] === 'string' ? (tags[key] as string) : undefined
  const number = (key: string) =>
    typeof tags[key] === 'number' && Number.isSafeInteger(tags[key])
      ? (tags[key] as number)
      : undefined
  const rawDate = string('ExifIFD:DateTimeOriginal')
  const date = rawDate?.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T')
  // readRaw preserves these ASCII digits. Never convert a fractional field to a number.
  const rawFraction = tags['ExifIFD:SubSecTimeOriginal']
  const fraction =
    typeof rawFraction === 'string'
      ? rawFraction
      : typeof rawFraction === 'number' && Number.isSafeInteger(rawFraction) && rawFraction >= 0
        ? String(rawFraction)
        : undefined
  const offset = string('ExifIFD:OffsetTimeOriginal')
  return {
    version: CAPTURE_METADATA_VERSION,
    format: format.toUpperCase(),
    make: string('IFD0:Make'),
    model: string('IFD0:Model'),
    serial: string('ExifIFD:BodySerialNumber') ?? string('Sony:SerialNumber'),
    dateTimeOriginal: rawDate,
    subSecTimeOriginal: fraction,
    offsetTimeOriginal: offset,
    preciseTime:
      date && fraction && /^\d+$/.test(fraction) ? `${date}.${fraction}${offset ?? ''}` : undefined,
    driveMode: number('Sony:DriveMode'),
    releaseMode: number('Sony:ReleaseMode'),
    releaseMode2: number('Sony:ReleaseMode2'),
    releaseMode3: number('Sony:ReleaseMode3'),
    sequenceNumber: number('Sony:SequenceNumber'),
    sequenceImageNumber: number('Sony:SequenceImageNumber'),
    sequenceFileNumber: number('Sony:SequenceFileNumber'),
    sequenceLength: number('Sony:SequenceLength'),
    shutterSeconds:
      typeof tags['ExifIFD:ExposureTime'] === 'number' &&
      Number.isFinite(tags['ExifIFD:ExposureTime']) &&
      tags['ExifIFD:ExposureTime'] > 0
        ? tags['ExifIFD:ExposureTime']
        : undefined,
  }
}

const precision = 10n ** 18n
export function preciseCaptureTime(value?: string): bigint | null {
  const parts = value?.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,18})(Z|[+-]\d{2}:\d{2})?$/,
  )
  if (!parts) return null
  const local = Date.parse(`${parts[1]}Z`)
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== parts[1])
    return null
  let offset = 0
  if (parts[3] && parts[3] !== 'Z') {
    const hours = Number(parts[3].slice(1, 3)),
      minutes = Number(parts[3].slice(4))
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
    offset = (hours * 60 + minutes) * (parts[3][0] === '-' ? -1 : 1)
  }
  return BigInt(local / 1000 - offset * 60) * precision + BigInt(parts[2].padEnd(18, '0'))
}

export interface CaptureSequence {
  key: string
  profile: (typeof CAPTURE_SEQUENCE_PROFILES)[keyof typeof CAPTURE_SEQUENCE_PROFILES]
  ids: string[]
  kind: 'continuous' | 'bracket'
  expectedLength: number | null
  complete: boolean
}

function verifiedMode(m: CaptureMetadata): CaptureSequence['profile'] | null {
  if (
    ![1, CAPTURE_METADATA_VERSION].includes(m.version) ||
    m.make?.toUpperCase() !== 'SONY' ||
    m.model !== 'ZV-1A' ||
    m.format !== 'ARW' ||
    // The observed profiles have no DriveMode tag.
    m.driveMode !== undefined
  )
    return null
  if (m.releaseMode === 2 && m.releaseMode3 === 1 && m.sequenceLength === 0) {
    if (m.releaseMode2 === 1) return CAPTURE_SEQUENCE_PROFILES.continuous
    if (m.releaseMode2 === 33) return CAPTURE_SEQUENCE_PROFILES.continuousHigh
  }
  if (
    m.version === CAPTURE_METADATA_VERSION &&
    m.releaseMode === 5 &&
    m.releaseMode2 === 2 &&
    m.releaseMode3 === 2 &&
    m.sequenceLength === 3
  )
    return CAPTURE_SEQUENCE_PROFILES.bracket
  return null
}
function frame(m: CaptureMetadata): number | null {
  const n = m.sequenceNumber
  return verifiedMode(m) &&
    n !== undefined &&
    n >= 1 &&
    Number.isSafeInteger(n) &&
    (m.sequenceLength === 0 || n <= m.sequenceLength!) &&
    n === m.sequenceImageNumber &&
    n === m.sequenceFileNumber
    ? n
    : null
}
function singleShot(m: CaptureMetadata): boolean {
  return (
    (m.releaseMode === 0 && m.releaseMode2 === 0 && m.releaseMode3 === 0) ||
    (m.releaseMode === 5 && m.releaseMode2 === 23 && m.releaseMode3 === 2 && m.sequenceLength === 1)
  )
}

function timingLimit(a: CaptureMetadata, b: CaptureMetadata, bracket: boolean): bigint {
  if (!bracket) return precision
  const shutter = (m: CaptureMetadata) =>
    Number.isFinite(m.shutterSeconds) && m.shutterSeconds! > 0 ? m.shutterSeconds! : 0
  const seconds = Math.max(shutter(a), shutter(b)),
    nanoseconds = seconds * 1e9
  // Keep finite metadata from overflowing during conversion to a timing bound.
  return (
    (Number.isFinite(nanoseconds)
      ? BigInt(Math.ceil(nanoseconds)) * 10n ** 9n
      : BigInt(Math.ceil(seconds)) * precision) + precision
  )
}

/** Contiguous prefixes qualify, including a BRK capture stopped after frame two. */
export function detectCaptureSequences(
  photos: { id: string; metadata: CaptureMetadata }[],
): CaptureSequence[] {
  const cameras = new Map<string, typeof photos>()
  for (const photo of photos) {
    const m = photo.metadata
    const key = JSON.stringify([m.make, m.model, m.serial, m.format, m.offsetTimeOriginal])
    const list = cameras.get(key) ?? []
    list.push(photo)
    cameras.set(key, list)
  }
  const result: CaptureSequence[] = []
  for (const [camera, photos] of cameras) {
    // A continuous frame with unknown timing could overlap any candidate from this camera.
    if (
      photos.some(
        (p) => !singleShot(p.metadata) && preciseCaptureTime(p.metadata.preciseTime) === null,
      )
    )
      continue
    const ordered = photos
      .map((p) => ({
        ...p,
        time: preciseCaptureTime(p.metadata.preciseTime),
        frame: frame(p.metadata),
        profile: verifiedMode(p.metadata),
      }))
      .filter((p): p is typeof p & { time: bigint } => p.time !== null)
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id.localeCompare(b.id)))
    let candidate: typeof ordered = [],
      valid = false
    const finish = () => {
      if (valid && candidate.length >= 2) {
        const profile = candidate[0].profile!,
          bracket = profile === CAPTURE_SEQUENCE_PROFILES.bracket
        result.push({
          key: `${profile}:${camera}:${candidate[0].metadata.preciseTime}`,
          profile,
          ids: candidate.map((p) => p.id),
          kind: bracket ? 'bracket' : 'continuous',
          expectedLength: bracket ? 3 : null,
          complete: !bracket || candidate.length === 3,
        })
      }
    }
    for (let index = 0; index < ordered.length; index++) {
      const p = ordered[index],
        previous = ordered[index - 1]
      const overlap = previous?.time === p.time || ordered[index + 1]?.time === p.time
      if (p.frame === 1) {
        finish()
        candidate = [p]
        valid = !overlap
      } else if (candidate.length) {
        const last = candidate[candidate.length - 1]
        if (
          singleShot(p.metadata) ||
          JSON.stringify([
            p.metadata.releaseMode,
            p.metadata.releaseMode2,
            p.metadata.releaseMode3,
            p.metadata.sequenceLength,
          ]) !==
            JSON.stringify([
              last.metadata.releaseMode,
              last.metadata.releaseMode2,
              last.metadata.releaseMode3,
              last.metadata.sequenceLength,
            ])
        ) {
          finish()
          candidate = []
          valid = false
          continue
        }
        if (p.frame === null) {
          valid = false
        } else {
          valid &&=
            !overlap &&
            p.frame === (last.frame ?? 0) + 1 &&
            p.time > last.time &&
            p.time - last.time <=
              timingLimit(
                last.metadata,
                p.metadata,
                p.profile === CAPTURE_SEQUENCE_PROFILES.bracket,
              )
          candidate.push(p)
        }
      }
    }
    finish()
  }
  return result
}

/** Group membership is never evidence of a shared shutter trigger. */
export function verifyCaptureSequence(
  photos: { id: string; metadata: CaptureMetadata }[],
): CaptureSequence | null {
  if (new Set(photos.map((p) => p.id)).size !== photos.length) return null
  const sequences = detectCaptureSequences(photos)
  return sequences.length === 1 && sequences[0].ids.length === photos.length ? sequences[0] : null
}
