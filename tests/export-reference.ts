/** Independent Float64 ISO reader/oracle. No application rendering or codec functions. */
export interface GainMetadata {
  min: number[]
  max: number[]
  gamma: number[]
  sdrOffset: number[]
  hdrOffset: number[]
  baseHeadroom: number
  alternateHeadroom: number
  useBase: boolean
}
export function readGainJpeg(bytes: Buffer) {
  const eoi = bytes.indexOf(Buffer.from([255, 217]))
  const soi = bytes.indexOf(Buffer.from([255, 216]), eoi + 2)
  if (eoi < 0 || soi < 0) throw new Error('Missing gain-map JPEG.')
  const gain = bytes.subarray(soi)
  const namespace = Buffer.from('urn:iso:std:iso:ts:21496:-1\0')
  let packet: Buffer | undefined
  for (let p = 2; p + 4 < gain.length;) {
    const marker = gain[p + 1],
      length = gain.readUInt16BE(p + 2)
    if (marker === 218) break
    const data = gain.subarray(p + 4, p + 2 + length)
    if (marker === 226 && data.subarray(0, namespace.length).equals(namespace))
      packet = data.subarray(namespace.length)
    p += length + 2
  }
  if (!packet || packet.readUInt16BE(0) !== 0) throw new Error('Missing supported ISO metadata.')
  const data = packet
  let position = 4
  const flags = data[position++]
  if (flags & 4) throw new Error('Unexpected HDR base.')
  const u32 = () => {
    const value = data.readUInt32BE(position)
    position += 4
    return value
  }
  const s32 = () => {
    const value = data.readInt32BE(position)
    position += 4
    return value
  }
  const common = flags & 8 ? u32() : undefined
  const fraction = (signed = false) => {
    const n = signed ? s32() : u32()
    const d = common ?? u32()
    if (!d) throw new Error('Invalid ISO denominator.')
    return n / d
  }
  const baseHeadroom = fraction(),
    alternateHeadroom = fraction()
  const channels = flags & 128 ? 3 : 1
  const values = Array.from({ length: channels }, () => [
    fraction(true),
    fraction(true),
    fraction(),
    fraction(true),
    fraction(true),
  ])
  const field = (i: number) => [0, 1, 2].map((c) => values[Math.min(c, channels - 1)][i])
  const metadata: GainMetadata = {
    min: field(0),
    max: field(1),
    gamma: field(2),
    sdrOffset: field(3),
    hdrOffset: field(4),
    baseHeadroom,
    alternateHeadroom,
    useBase: !!(flags & 64),
  }
  return { primary: bytes.subarray(0, eoi + 2), gain, metadata }
}
export const srgbLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export function to2020(rgb: number[]) {
  return [
    0.627403895934699 * rgb[0] + 0.329283038377883 * rgb[1] + 0.043313065687418 * rgb[2],
    0.069097289358232 * rgb[0] + 0.919540395075459 * rgb[1] + 0.011362315566309 * rgb[2],
    0.01639143887515 * rgb[0] + 0.088013307877226 * rgb[1] + 0.895595253247624 * rgb[2],
  ]
}
export function reconstruct(base: number[], gain: number[], m: GainMetadata, headroom: number) {
  const weight = Math.max(
    0,
    Math.min(1, (Math.log2(headroom) - m.baseHeadroom) / (m.alternateHeadroom - m.baseHeadroom)),
  )
  return base.map(
    (v, c) =>
      (v + m.sdrOffset[c]) *
        2 ** ((m.min[c] + gain[c] ** (1 / m.gamma[c]) * (m.max[c] - m.min[c])) * weight) -
      m.hdrOffset[c],
  )
}
export function fromHalf(v: number) {
  const sign = v & 0x8000 ? -1 : 1,
    exp = (v >> 10) & 31,
    mantissa = v & 1023
  return sign * (exp ? (1 + mantissa / 1024) * 2 ** (exp - 15) : mantissa * 2 ** -24)
}
