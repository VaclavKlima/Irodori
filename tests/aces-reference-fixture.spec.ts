import { expect, test } from '@playwright/test'
import reference from './fixtures/aces-reference.json' with { type: 'json' }
import {
  acesReferenceCtlHashes,
  acesReferenceFixtureContract,
  acesReferenceFixtureProvenance,
  acesReferenceFixtureSha256,
  acesReferenceFixtureTargets,
  assessAcesReferenceFixture,
} from './aces-reference-fixture.helpers'

function fixture() {
  const golden = {
    inputs: Array.from({ length: 1350 }, () => [0, 0, 0]),
    targets: acesReferenceFixtureTargets.map((target) => ({
      ...target,
      rgb: Array.from({ length: 1350 }, () => [0.5, 0.5, 0.5]),
    })),
  }
  const fresh = golden.targets.map((target) => target.rgb.map((rgb) => [...rgb]))
  return { golden, fresh }
}

function pair(anchor: number, actual: number, target = 1) {
  const value = fixture()
  value.golden.targets[target].rgb[0][0] = anchor
  value.fresh[target][0][0] = actual
  return assessAcesReferenceFixture(value.golden, value.fresh)
}

test('portable fixture verification retains the immutable golden and all four CTL hashes', async () => {
  const proof = await acesReferenceFixtureProvenance(reference)
  expect(proof.status).toBe('passed')
  expect(proof.fixture.actual).toBe(acesReferenceFixtureSha256)
  expect(proof.ctl).toHaveLength(4)
  expect(proof.ctl.every((entry) => entry.matches)).toBe(true)
  const name = 'Lib.Academy.Utilities.ctl'
  const changedMetadata = {
    ...reference,
    hashes: { ...acesReferenceCtlHashes, [name]: '0'.repeat(64) },
  }
  const changed = await acesReferenceFixtureProvenance(changedMetadata)
  expect(changed.status).toBe('failed')
  expect(changed.fixture.matches).toBe(true)
  expect(changed.ctl.find((entry) => entry.path.endsWith(name))?.matches).toBe(false)
})

test('complete fixed coverage passes while a legal binary64 neighbor retains failed historical identity', () => {
  const { golden, fresh } = fixture()
  const exact = assessAcesReferenceFixture(golden, fresh)
  expect(exact.status).toBe('passed')
  expect(exact.complete).toBe(true)
  expect(exact.comparedComponentCount).toBe(36450)
  expect(exact.contract).toEqual(acesReferenceFixtureContract)
  expect(exact.historicalExactFloat64.status).toBe('passed')
  const changed = pair(1, 1 + 2 ** -40)
  expect(changed.status).toBe('passed')
  expect(changed.comparedComponentCount).toBe(36450)
  expect(changed.historicalExactFloat64.status).toBe('failed')
  expect(changed.historicalExactFloat64.mismatchCount).toBe(1)
  expect(changed.historicalExactFloat64.maximumAbsoluteDelta).toBe(2 ** -40)
})

test('the binary64 limit rejects drift even when every binary32 output bit matches', () => {
  const result = pair(1, 1 + 2 ** -39)
  expect(result.status).toBe('failed')
  expect(result.violations.binary32).toBe(0)
  expect(result.violations.binary64Bound).toBe(1)
  expect(result.historicalExactFloat64.maximumAbsoluteDelta).toBe(2 ** -39)
})

test('a binary32 midpoint crossing fails even when its binary64 delta is far below the bound', () => {
  const midpoint = 1 + 2 ** -24
  const result = pair(midpoint, midpoint + 2 ** -52)
  expect(result.status).toBe('failed')
  expect(result.violations.binary32).toBe(1)
  expect(result.violations.binary64Bound).toBe(0)
  expect(result.historicalExactFloat64.maximumAbsoluteDelta).toBe(2 ** -52)
})

test('nonfinite outputs and inputs are rejected before exact identity shortcuts', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const result = pair(value, value)
    expect(result.status).toBe('failed')
    expect(result.complete).toBe(false)
    expect(result.violations.finite).toBe(2)
    expect(result.comparedComponentCount).toBe(36449)
  }
  const { golden, fresh } = fixture()
  golden.inputs[0][0] = NaN
  expect(assessAcesReferenceFixture(golden, fresh).violations.finite).toBe(1)
})

test('missing targets, samples, channels and sparse arrays cannot satisfy complete coverage', () => {
  const mutations = [
    ({ fresh }: ReturnType<typeof fixture>) => fresh.pop(),
    ({ fresh }: ReturnType<typeof fixture>) => fresh[0].pop(),
    ({ fresh }: ReturnType<typeof fixture>) => fresh[0][0].pop(),
    ({ fresh }: ReturnType<typeof fixture>) => fresh[0][0].push(0.5),
    ({ fresh }: ReturnType<typeof fixture>) => delete fresh[0],
    ({ fresh }: ReturnType<typeof fixture>) => delete fresh[0][0],
    ({ golden }: ReturnType<typeof fixture>) => delete golden.inputs[0],
    ({ golden }: ReturnType<typeof fixture>) => delete golden.targets[0].rgb[0],
    ({ golden }: ReturnType<typeof fixture>) => {
      golden.targets[0].peak = 2
    },
  ]
  for (const mutate of mutations) {
    const value = fixture()
    mutate(value)
    const result = assessAcesReferenceFixture(value.golden, value.fresh)
    expect(result.status).toBe('failed')
    expect(result.complete).toBe(false)
    expect(result.violations.shape).toBeGreaterThan(0)
  }
})

test('both sides must retain the clipped target range, including near-boundary neighbors', () => {
  const upper = pair(1, 1 + 2 ** -52, 0)
  expect(upper.status).toBe('failed')
  expect(upper.violations.range).toBe(1)
  const negative = pair(-Number.MIN_VALUE, -Number.MIN_VALUE)
  expect(negative.status).toBe('failed')
  expect(negative.violations.range).toBe(2)
})

test('zero signs and nonzero values that round to binary32 zero retain exact binary64 identity', () => {
  expect(pair(0, 0).status).toBe('passed')
  expect(pair(-0, -0).status).toBe('passed')
  for (const [anchor, actual] of [
    [0, -0],
    [-0, 0],
    [0, Number.MIN_VALUE],
  ]) {
    const result = pair(anchor, actual)
    expect(result.status).toBe('failed')
    expect(result.violations.exactZero).toBe(1)
  }
  expect(pair(2 ** -151, 2 ** -151).status).toBe('passed')
  const tiny = pair(2 ** -151, 2 ** -150)
  expect(tiny.status).toBe('failed')
  expect(tiny.violations.binary32).toBe(0)
  expect(tiny.violations.exactTiny).toBe(1)
})

test('eligible near-zero outputs remain constrained by exact binary32 bits without a global ULP waiver', () => {
  for (const [anchor, actual] of [
    [2 ** -149, 2 ** -149 + 2 ** -201],
    [2 ** -126, 2 ** -126 + 2 ** -178],
    [2 ** -70, 2 ** -70 + 2 ** -100],
  ]) {
    const result = pair(anchor, actual)
    expect(result.status).toBe('passed')
    expect(result.violations.binary32).toBe(0)
    expect(result.historicalExactFloat64.status).toBe('failed')
    expect(result.historicalExactFloat64.mismatchCount).toBe(1)
  }
})
