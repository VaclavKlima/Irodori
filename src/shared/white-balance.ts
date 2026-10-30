/** Irodori v1: Kang 2002 locus, perpendicular CIE 1960 UCS tint (0.0001/unit). */
export const WHITE_BALANCE_MODEL = 'irodori-kang2002-ucs-1'
export type WhiteBalance = { mode: 'as-shot' } | { mode: 'custom'; kelvin: number; tint: number }
export const asShot: WhiteBalance = { mode: 'as-shot' }
export interface WhiteBalanceProfile {
  provider: string
  version: string
  identity: string
  model: typeof WHITE_BALANCE_MODEL
  asShotGains: number[]
  xyzToCamera: number[]
  cameraToWorking: number[]
  ranges: { kelvin: [number, number]; tint: [number, number] }
  estimate: { kelvin: number; tint: number }
}
export const identityMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export function multiplyVector(m: number[], v: number[]): number[] {
  return [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2])
}
export function inverseMatrix(m: number[]): number[] {
  if (m.length !== 9 || !m.every(Number.isFinite)) throw new Error('Invalid camera matrix.')
  const [a, b, c, d, e, f, g, h, i] = m
  const cofactors = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ]
  const det = a * cofactors[0] + b * cofactors[3] + c * cofactors[6]
  if (Math.abs(det) < 1e-8) throw new Error('Singular camera matrix.')
  return cofactors.map((value) => value / det)
}
export function validateWhiteBalance(value: unknown): asserts value is WhiteBalance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid white balance.')
  const wb = value as WhiteBalance
  if (wb.mode === 'as-shot' && Object.keys(wb).length === 1) return
  if (
    wb.mode === 'custom' &&
    Object.keys(wb).length === 3 &&
    Number.isInteger(wb.kelvin) &&
    wb.kelvin >= 2000 &&
    wb.kelvin <= 25000 &&
    wb.kelvin % 50 === 0 &&
    Number.isInteger(wb.tint) &&
    Math.abs(wb.tint) <= 100
  )
    return
  throw new Error(
    'White balance requires As Shot or 2000–25000 K in 50 K steps and integer Tint from -100 to +100.',
  )
}
export function locusUv(kelvin: number): number[] {
  const t = kelvin
  const x =
    t <= 4000
      ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039
  const y =
    t <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483
  const d = -2 * x + 12 * y + 3
  return [(4 * x) / d, (6 * y) / d]
}
export function whiteBalanceNormal(kelvin: number): number[] {
  const a = locusUv(kelvin - 1),
    b = locusUv(kelvin + 1)
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length = Math.hypot(dx, dy)
  // The positive normal points above the locus, toward green illuminants.
  return [dy / length, -dx / length]
}
export function illuminant(kelvin: number, tint: number): number[] {
  const uv = locusUv(kelvin),
    n = whiteBalanceNormal(kelvin)
  const u = uv[0] + n[0] * tint * 0.0001,
    v = uv[1] + n[1] * tint * 0.0001
  return [(3 * u) / (2 * v), 1, (4 - u - 10 * v) / (2 * v)]
}
export function customGains(profile: WhiteBalanceProfile, kelvin: number, tint: number): number[] {
  const response = multiplyVector(profile.xyzToCamera, illuminant(kelvin, tint))
  if (response.some((v) => !Number.isFinite(v) || v <= 0))
    throw new Error('Invalid white-balance camera response.')
  return response.map((v) => (profile.asShotGains[1] * response[1]) / v)
}
export function validateWhiteBalanceProfile(profile: WhiteBalanceProfile): void {
  inverseMatrix(profile.xyzToCamera)
  inverseMatrix(profile.cameraToWorking)
  if (
    profile.model !== WHITE_BALANCE_MODEL ||
    profile.asShotGains.length !== 3 ||
    profile.asShotGains.some((v) => !Number.isFinite(v) || v <= 0)
  )
    throw new Error('Invalid camera white-balance gains.')
  for (const t of [2000, 4000, 6500, 25000])
    for (const tint of [-100, 100]) customGains(profile, t, tint)
}
export function estimateWhiteBalance(profile: WhiteBalanceProfile): {
  kelvin: number
  tint: number
} {
  const xyz = multiplyVector(
    inverseMatrix(profile.xyzToCamera),
    profile.asShotGains.map((v) => 1 / v),
  )
  const d = xyz[0] + 15 * xyz[1] + 3 * xyz[2],
    uv = [(4 * xyz[0]) / d, (6 * xyz[1]) / d]
  let kelvin = 6500,
    distance = Infinity
  for (let t = 2000; t <= 25000; t += 50) {
    const p = locusUv(t),
      candidate = Math.hypot(p[0] - uv[0], p[1] - uv[1])
    if (candidate < distance) {
      distance = candidate
      kelvin = t
    }
  }
  const p = locusUv(kelvin),
    n = whiteBalanceNormal(kelvin)
  return {
    kelvin,
    tint: Math.max(
      -100,
      Math.min(100, Math.round(((uv[0] - p[0]) * n[0] + (uv[1] - p[1]) * n[1]) / 0.0001)),
    ),
  }
}
/** Row-major M diag(custom/as-shot) M^-1; As Shot bypasses all arithmetic. */
export function whiteBalanceMatrix(
  value: WhiteBalance | undefined,
  profile?: WhiteBalanceProfile,
): number[] | null {
  if (!value || value.mode === 'as-shot') return null
  validateWhiteBalance(value)
  if (!profile) throw new Error('White balance is unavailable for this camera.')
  const gains = customGains(profile, value.kelvin, value.tint).map(
    (v, i) => v / profile.asShotGains[i],
  )
  const m = profile.cameraToWorking,
    inverse = inverseMatrix(m)
  return Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce(
      (sum, k) => sum + m[Math.floor(i / 3) * 3 + k] * gains[k] * inverse[k * 3 + (i % 3)],
      0,
    ),
  )
}
