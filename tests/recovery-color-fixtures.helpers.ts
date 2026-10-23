export const RECOVERY_PATTERN_KINDS = [
  'dark-gradient',
  'neutral-gradient',
  'saturated-axes',
  'saturated-corners',
  'seeded-hdr-random',
  'high-frequency',
  'monotone-steps',
] as const

export type RecoveryPatternKind = (typeof RECOVERY_PATTERN_KINDS)[number]

export interface RecoveryPatternSpec {
  kind: RecoveryPatternKind
  width: number
  height: number
  /** Encoded display-channel peak, supplied independently for each presentation target. */
  peakEncoded: number
}

export interface RecoveryPatternMetadata extends RecoveryPatternSpec {
  domain: 'encoded-display-rgb'
  alpha: 1
  seed: number | null
  signedChromaticSamples: boolean
  sourceExceeds1024: boolean
  description: string
  monotone?: {
    axis: 'horizontal'
    direction: 'nondecreasing'
    channels: readonly [0, 1, 2]
    rowRegion: { top: number; bottom: number }
    columnRegion: { left: number; right: number }
    identicalRows: true
  }
}

/** Self-contained so Playwright can generate the Float32 source directly in the renderer. */
export function generateRecoveryPattern({
  kind,
  width,
  height,
  peakEncoded,
}: RecoveryPatternSpec): Float32Array {
  const kinds = [
    'dark-gradient',
    'neutral-gradient',
    'saturated-axes',
    'saturated-corners',
    'seeded-hdr-random',
    'high-frequency',
    'monotone-steps',
  ]
  if (
    !kinds.includes(kind) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4) ||
    !Number.isFinite(peakEncoded) ||
    peakEncoded <= 0 ||
    peakEncoded > 65504
  )
    throw new Error('Invalid encoded recovery pattern specification.')

  // These are encoded-channel probes, not scene-linear values or a rendering transform.
  const pixels = new Float32Array(width * height * 4),
    negative = -peakEncoded * 0.125,
    unitX = (x: number) => (width === 1 ? 0 : x / (width - 1))
  let state = 0x4c554d41
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const write = (x: number, y: number, r: number, g: number, b: number) => {
    const offset = (y * width + x) * 4
    pixels[offset] = r
    pixels[offset + 1] = g
    pixels[offset + 2] = b
    pixels[offset + 3] = 1
  }
  const boundaries = (limit: number, sparse: boolean) => {
    const values = [0, limit],
      add = (value: number) => {
        if (value >= 0 && value <= limit) values.push(Math.fround(value))
      }
    // Straddle half-float rounding midpoints, including subnormals and exponent changes.
    for (let exponent = -24; exponent <= Math.floor(Math.log2(limit)); exponent++) {
      const anchor = 2 ** exponent,
        previousSpacing = Math.max(2 ** -24, 2 ** (exponent - 11)),
        nextSpacing = Math.max(2 ** -24, 2 ** (exponent - 10))
      add(anchor)
      for (const midpoint of [anchor - previousSpacing / 2, anchor + nextSpacing / 2]) {
        const epsilon = Math.max(2 ** -34, Math.min(previousSpacing, nextSpacing) / 1024)
        add(midpoint - epsilon)
        add(midpoint)
        add(midpoint + epsilon)
      }
    }
    // Byte rounding thresholds stay below 1; higher HDR values test eventual clipping separately.
    for (let code = 0; code < 255; code += sparse ? 8 : 1) {
      const midpoint = (code + 0.5) / 255,
        epsilon = 2 ** (Math.floor(Math.log2(midpoint)) - 21)
      add(midpoint - epsilon)
      add(midpoint)
      add(midpoint + epsilon)
    }
    for (const value of [0.0031308, 0.04045, 0.0625, 0.125, 0.25, 0.5, 1]) add(value)
    return [...new Set(values)].sort((a, b) => a - b)
  }
  if (kind === 'dark-gradient' || kind === 'neutral-gradient' || kind === 'monotone-steps') {
    const limit = kind === 'dark-gradient' ? Math.min(0.08, peakEncoded) : peakEncoded,
      values = boundaries(limit, kind === 'monotone-steps'),
      scanline = new Float32Array(width)
    if (kind === 'monotone-steps' || width < values.length) {
      for (let x = 0; x < width; x++)
        scanline[x] = values[Math.min(values.length - 1, Math.floor(unitX(x) * values.length))]
    } else {
      // Every boundary is an exact source column; extra columns interpolate monotonically.
      for (let i = 0; i < values.length - 1; i++) {
        const left = Math.round((i * (width - 1)) / (values.length - 1)),
          right = Math.round(((i + 1) * (width - 1)) / (values.length - 1))
        for (let x = left; x <= right; x++)
          scanline[x] = values[i] + ((values[i + 1] - values[i]) * (x - left)) / (right - left)
      }
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) write(x, y, scanline[x], scanline[x], scanline[x])
    return pixels
  }
  const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 1],
    ],
    corners = [
      [0, 0, 0],
      [peakEncoded, peakEncoded, peakEncoded],
      [peakEncoded, 0, 0],
      [0, peakEncoded, 0],
      [0, 0, peakEncoded],
      [peakEncoded, peakEncoded, 0],
      [peakEncoded, 0, peakEncoded],
      [0, peakEncoded, peakEncoded],
      [negative, peakEncoded, 0],
      [peakEncoded, negative, 0],
      [peakEncoded, 0, negative],
      [0, peakEncoded, negative],
      [negative, 0, peakEncoded],
      [0, negative, peakEncoded],
      [negative, peakEncoded, peakEncoded],
      [peakEncoded, negative, peakEncoded],
    ]
  const randomChannel = () => {
    const mode = random(),
      value = random()
    if (mode < 0.3) return peakEncoded * value
    if (mode < 0.5) return peakEncoded * (value * 1.125 - 0.125)
    if (mode < 0.7) return Math.min(peakEncoded, 2 ** (-24 + value * 24))
    if (mode < 0.85) {
      const midpoint = (Math.floor(value * 255) + 0.5) / 255,
        epsilon = 2 ** (Math.floor(Math.log2(midpoint)) - 21)
      return Math.min(peakEncoded, midpoint + (random() < 0.5 ? -epsilon : epsilon))
    }
    const exponent = -14 + Math.floor(value * (Math.floor(Math.log2(peakEncoded)) + 15)),
      spacing = Math.max(2 ** -24, 2 ** (exponent - 10)),
      midpoint = 2 ** exponent + (Math.floor(random() * 1024) + 0.5) * spacing
    return Math.min(peakEncoded, midpoint + (random() < 0.5 ? -1 : 1) * (spacing / 1024))
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (kind === 'saturated-axes') {
        const band = Math.min(5, Math.floor((y * 6) / height)),
          ramp = peakEncoded * unitX(x),
          floor = (y * 6) % height < height / 3 ? negative * unitX(x) : 0,
          mask = axes[band]
        write(x, y, mask[0] ? ramp : floor, mask[1] ? ramp : floor, mask[2] ? ramp : floor)
      } else if (kind === 'saturated-corners') {
        const column = Math.min(3, Math.floor((x * 4) / width)),
          row = Math.min(3, Math.floor((y * 4) / height)),
          color = corners[row * 4 + column]
        write(x, y, color[0], color[1], color[2])
      } else if (kind === 'seeded-hdr-random') {
        write(x, y, randomChannel(), randomChannel(), randomChannel())
      } else {
        const band = Math.min(3, Math.floor((y * 4) / height)),
          high = peakEncoded,
          r = band === 0 ? (x + y) % 2 : Math.floor(x / (band + 1)) % 2,
          g = band === 0 ? x % 2 : Math.floor(y / (band + 2)) % 2,
          b = (x + 2 * y) % 5 < 2,
          impulse = x % 37 === 1 && y % 29 === 2
        write(x, y, impulse || r ? high : 0, impulse || g ? high : 0, b ? high : negative)
      }
    }
  return pixels
}

export function recoveryPatternMetadata(
  kind: RecoveryPatternKind,
  width: number,
  height: number,
  peakEncoded: number,
): RecoveryPatternMetadata {
  const descriptions: Record<RecoveryPatternKind, string> = {
    'dark-gradient':
      'Row-identical neutral ramp through encoded 0–0.08, half-float midpoints and byte thresholds.',
    'neutral-gradient':
      'Row-identical neutral ramp through the full encoded peak with exact boundary-probe columns.',
    'saturated-axes':
      'Primary and secondary horizontal ramps with signed inactive-channel regions.',
    'saturated-corners':
      'Sixteen flat RGB corner and signed chromatic fields with hard vertical and horizontal edges.',
    'seeded-hdr-random':
      'Fixed xorshift32 mixture of full range, signed colors, dark values and rounding boundaries.',
    'high-frequency':
      'One-pixel checks, short-period stripes, signed diagonal detail and isolated bright impulses.',
    'monotone-steps':
      'Row-identical neutral plateaus around half-float midpoints and sparse byte thresholds.',
  }
  const monotone =
    kind === 'dark-gradient' || kind === 'neutral-gradient' || kind === 'monotone-steps'
  return {
    kind,
    width,
    height,
    peakEncoded,
    domain: 'encoded-display-rgb',
    alpha: 1,
    seed: kind === 'seeded-hdr-random' ? 0x4c554d41 : null,
    signedChromaticSamples: !monotone,
    sourceExceeds1024: Math.max(width, height) > 1024,
    description: descriptions[kind],
    ...(monotone
      ? {
          monotone: {
            axis: 'horizontal' as const,
            direction: 'nondecreasing' as const,
            channels: [0, 1, 2] as const,
            rowRegion: { top: 0, bottom: height },
            columnRegion: { left: 0, right: width },
            identicalRows: true as const,
          },
        }
      : {}),
  }
}
