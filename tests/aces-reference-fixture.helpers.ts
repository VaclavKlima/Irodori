import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const acesReferenceFixtureContract = {
  name: 'aces-reference-fixture-portability',
  version: 1,
  absoluteFloat64Limit: 1e-12,
  inputCount: 1350,
  targetCount: 9,
  componentCount: 36450,
  rationale:
    'Explicit empirical portability bound for the unchanged clipped [0,10] fixture; not a universal C++ error theorem or a rendering tolerance. Every fixed output must also retain exact binary32 bits.',
} as const

export const acesReferenceFixtureSha256 =
  '38268bc56fc6869fff8d9f2255bd79f45f0e0143b572a151e1f2cec4078b72e0'
export const acesReferenceCtlHashes = {
  'Lib.Academy.Utilities.ctl': '142ad05f16816c76eacf70ed9d3d6eb8778029b0e497900867abbf21d712fb03',
  'Lib.Academy.Tonescale.ctl': 'fcb99aad7fdf52ae048886171c18af9107ceeee2709aa33233ef09636fd1c6c4',
  'Lib.Academy.OutputTransform.ctl':
    '34a23e14e29dff47f5575514b7c98f502e2be7784a81709a9ca9b53777b2fdfe',
  'Lib.Academy.ColorSpaces.ctl': '4f07503e00127b00719416d63446d9a6b504798111d94f3860eb74754b6fb00a',
} as const

export const acesReferenceFixtureTargets = [
  { colorSpace: 'srgb', peak: 1 },
  { colorSpace: 'srgb', peak: 2 },
  { colorSpace: 'srgb', peak: 4 },
  { colorSpace: 'srgb', peak: 8 },
  { colorSpace: 'display-p3', peak: 1 },
  { colorSpace: 'display-p3', peak: 2 },
  { colorSpace: 'display-p3', peak: 4 },
  { colorSpace: 'display-p3', peak: 8 },
  { colorSpace: 'rec2020', peak: 10 },
] as const

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Verify immutable fixture bytes and each of the four retained CTL source hashes. */
export async function acesReferenceFixtureProvenance(golden: unknown, root = process.cwd()) {
  const hashes = record(record(golden)?.hashes)
  const fixturePath = resolve(root, 'tests/fixtures/aces-reference.json')
  const fixtureSha256 = sha(await readFile(fixturePath))
  const ctl = await Promise.all(
    Object.entries(acesReferenceCtlHashes).map(async ([name, expected]) => {
      const path = resolve(root, 'third_party/aces-core/lib', name)
      const actual = sha(await readFile(path))
      const metadata = hashes?.[name]
      return {
        path,
        expected,
        actual,
        metadata,
        matches: actual === expected && metadata === expected,
      }
    }),
  )
  return {
    status:
      fixtureSha256 === acesReferenceFixtureSha256 && ctl.every((entry) => entry.matches)
        ? 'passed'
        : 'failed',
    fixture: {
      path: fixturePath,
      expected: acesReferenceFixtureSha256,
      actual: fixtureSha256,
      matches: fixtureSha256 === acesReferenceFixtureSha256,
    },
    ctl,
    historicalProducerEnvironment:
      'Unknown; the historical fixture does not pin compiler/libm/CPU.',
  }
}

const float32 = new Float32Array(1)
const bits32 = new Uint32Array(float32.buffer)
const float64 = new Float64Array(1)
const bits64 = new BigUint64Array(float64.buffer)
const sign64 = 1n << 63n
const mask64 = (1n << 64n) - 1n
function binary32(value: number) {
  float32[0] = value
  return bits32[0]
}
function ordered64(value: number) {
  float64[0] = value
  const bits = bits64[0]
  return bits & sign64 ? ~bits & mask64 : bits | sign64
}

/** Compare all fixed outputs without changing the fresh Float64 rendering oracle. */
export function assessAcesReferenceFixture(golden: unknown, independent: unknown) {
  const violations = {
    shape: 0,
    finite: 0,
    range: 0,
    binary32: 0,
    binary64Bound: 0,
    exactZero: 0,
    exactTiny: 0,
  }
  const examples: { kind: keyof typeof violations; path: string; detail: unknown }[] = []
  const fail = (kind: keyof typeof violations, path: string, detail: unknown) => {
    violations[kind]++
    if (examples.length < 32) examples.push({ kind, path, detail })
  }
  const array = (value: unknown, path: string, length: number): unknown[] => {
    if (!Array.isArray(value)) {
      fail('shape', path, { expected: length, actual: typeof value })
      return []
    }
    if (value.length !== length) fail('shape', path, { expected: length, actual: value.length })
    return value
  }
  const finite = (value: unknown, path: string): value is number => {
    if (typeof value === 'number' && Number.isFinite(value)) return true
    fail('finite', path, { actual: String(value) })
    return false
  }
  const fixture = record(golden)
  const inputs = array(fixture?.inputs, 'inputs', acesReferenceFixtureContract.inputCount)
  for (let index = 0; index < acesReferenceFixtureContract.inputCount; index++) {
    const input = array(inputs[index], `inputs[${index}]`, 3)
    for (let channel = 0; channel < 3; channel++)
      finite(input[channel], `inputs[${index}][${channel}]`)
  }
  const targets = array(fixture?.targets, 'targets', acesReferenceFixtureContract.targetCount)
  const freshTargets = array(independent, 'independent', acesReferenceFixtureContract.targetCount)
  let comparedComponentCount = 0
  let exactMismatchCount = 0
  let maximumAbsoluteDelta = 0
  let maximumRelativeDelta = 0
  let relativeDeltaOverflowCount = 0
  let zeroAnchorDeltaCount = 0
  let maximumUlpDistance = 0n
  let worstAbsolute: unknown
  let worstRelative: unknown
  let worstUlp: unknown
  const historicalExamples: unknown[] = []
  for (const [targetIndex, expectedTarget] of acesReferenceFixtureTargets.entries()) {
    const target = record(targets[targetIndex])
    if (target?.peak !== expectedTarget.peak || target?.colorSpace !== expectedTarget.colorSpace)
      fail('shape', `targets[${targetIndex}]`, {
        expected: expectedTarget,
        actual: { peak: target?.peak, colorSpace: target?.colorSpace },
      })
    const retainedRows = array(
      target?.rgb,
      `targets[${targetIndex}].rgb`,
      acesReferenceFixtureContract.inputCount,
    )
    const freshRows = array(
      freshTargets[targetIndex],
      `independent[${targetIndex}]`,
      acesReferenceFixtureContract.inputCount,
    )
    for (let index = 0; index < acesReferenceFixtureContract.inputCount; index++) {
      const retained = array(retainedRows[index], `targets[${targetIndex}].rgb[${index}]`, 3)
      const fresh = array(freshRows[index], `independent[${targetIndex}][${index}]`, 3)
      for (let channel = 0; channel < 3; channel++) {
        const path = `target${targetIndex}/input${index}/channel${channel}`
        const anchor = retained[channel]
        const value = fresh[channel]
        const anchorFinite = finite(anchor, `golden/${path}`)
        const valueFinite = finite(value, `fresh/${path}`)
        if (!anchorFinite || !valueFinite) continue
        let inRange = true
        for (const [name, component] of [
          ['golden', anchor],
          ['fresh', value],
        ] as const)
          if (component < 0 || component > expectedTarget.peak) {
            inRange = false
            fail('range', `${name}/${path}`, { actual: component, peak: expectedTarget.peak })
          }
        if (!inRange) continue
        comparedComponentCount++
        const delta = Math.abs(value - anchor)
        const anchorBits = ordered64(anchor)
        const freshBits = ordered64(value)
        const ulp = anchorBits > freshBits ? anchorBits - freshBits : freshBits - anchorBits
        const detail = {
          target: expectedTarget,
          index,
          channel,
          golden: anchor,
          actual: value,
          goldenNegativeZero: Object.is(anchor, -0),
          actualNegativeZero: Object.is(value, -0),
          delta,
        }
        if (!Object.is(value, anchor)) {
          exactMismatchCount++
          if (historicalExamples.length < 16)
            historicalExamples.push({ ...detail, ulpDistance: ulp.toString() })
        }
        if (delta > maximumAbsoluteDelta) {
          maximumAbsoluteDelta = delta
          worstAbsolute = detail
        }
        if (anchor !== 0) {
          const relative = delta / Math.abs(anchor)
          if (!Number.isFinite(relative)) relativeDeltaOverflowCount++
          else if (relative > maximumRelativeDelta) {
            maximumRelativeDelta = relative
            worstRelative = detail
          }
        } else if (delta !== 0) zeroAnchorDeltaCount++
        if (ulp > maximumUlpDistance) {
          maximumUlpDistance = ulp
          worstUlp = detail
        }
        const retainedBinary32 = binary32(anchor)
        const freshBinary32 = binary32(value)
        if (retainedBinary32 !== freshBinary32)
          fail('binary32', path, { ...detail, retainedBinary32, freshBinary32 })
        if (delta > acesReferenceFixtureContract.absoluteFloat64Limit)
          fail('binary64Bound', path, detail)
        if (anchor === 0 && !Object.is(value, anchor)) fail('exactZero', path, detail)
        if (anchor !== 0 && Math.fround(anchor) === 0 && !Object.is(value, anchor))
          fail('exactTiny', path, detail)
      }
    }
  }
  const complete =
    comparedComponentCount === acesReferenceFixtureContract.componentCount &&
    violations.shape === 0 &&
    violations.finite === 0 &&
    violations.range === 0
  return {
    contract: acesReferenceFixtureContract,
    status:
      complete && Object.values(violations).every((count) => count === 0) ? 'passed' : 'failed',
    complete,
    comparedComponentCount,
    violations,
    examples,
    historicalExactFloat64: {
      status: complete ? (exactMismatchCount === 0 ? 'passed' : 'failed') : 'incomplete',
      criterion: 'Exact binary64 identity; retained independently from the new portable contract.',
      comparedComponentCount,
      mismatchCount: exactMismatchCount,
      maximumAbsoluteDelta,
      maximumRelativeDelta,
      relativeDeltaOverflowCount,
      zeroAnchorDeltaCount,
      maximumUlpDistance: maximumUlpDistance.toString(),
      worstAbsolute,
      worstRelative,
      worstUlp,
      examples: historicalExamples,
    },
  }
}
