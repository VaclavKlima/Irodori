import { expect, test } from '@playwright/test'
import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface ReferenceCase {
  id: string
  width: number
  height: number
  rgba: number[]
  expected: number[]
  unionCoverage: number[]
  roots: { enabled: boolean; amount: number }[]
}
interface NumericReceipt {
  status: string
  stage: string
  foreground: boolean
  cpuFeatureFallback: boolean
  productionEnabled: boolean
  protocolSha256: string
  adapter: string
  cases: {
    id: string
    status: string
    rgbFailures: number
    wordMismatches: number
    maxToleranceRatio: number
    textureJobs: number
  }[]
  legacyChecks: {
    id: string
    format: string
    outsideUnionPixels: number
    outsideUnionDifferences: number
    alphaZeroPixels: number
    alphaZeroDifferences: number
    insideUnionCandidateDifferences: number
    changedInsideUnionPixels: number
    allZeroPixels?: number
    allZeroDifferences?: number
  }[]
  refusals: {
    id: string
    status: string
    reason: string
    cpuFeatureFallback: boolean
  }[]
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const children = new Set<ChildProcess>()
test.afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((accept) => {
          if (child.exitCode !== null || child.signalCode !== null) return accept()
          const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
          timer.unref()
          child.once('close', () => {
            clearTimeout(timer)
            accept()
          })
          child.kill('SIGTERM')
        }),
    ),
  )
  children.clear()
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('owned ordered-mask GPU proof retains independent pixels and actual legacy output', async ({}, info) => {
  test.setTimeout(650_000)
  await mkdir(info.outputDir, { recursive: true })
  const output = info.outputPath('numeric-run')
  const outcome = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
    (accept, reject) => {
      const child = execFile(
        process.execPath,
        [
          resolve('scripts/research/masked-texture/order-run.mjs'),
          '--stage',
          'numeric',
          '--output',
          output,
        ],
        { timeout: 620_000, maxBuffer: 2 * 1024 ** 2 },
        (error, stdout, stderr) => {
          children.delete(child)
          void Promise.all([
            writeFile(info.outputPath('launch.stdout.txt'), stdout),
            writeFile(info.outputPath('launch.stderr.txt'), stderr),
          ]).then(() => accept({ error, stdout, stderr }), reject)
        },
      )
      children.add(child)
    },
  )
  expect(outcome.error, outcome.stderr || outcome.stdout).toBeNull()
  const protocolBytes = await readFile(
    'assets/tests/references/masked-texture/order-protocol-v2.json',
  )
  const protocol = JSON.parse(protocolBytes.toString()) as {
    reference: { file: string; sha256: string }
    gates: { absolute: number; relative: number }
  }
  const referenceBytes = await readFile(protocol.reference.file)
  expect(sha(referenceBytes)).toBe(protocol.reference.sha256)
  const reference = JSON.parse(referenceBytes.toString()) as {
    cases: ReferenceCase[]
    refusals: { id: string }[]
  }
  const report = JSON.parse(await readFile(join(output, 'result.json'), 'utf8')) as NumericReceipt
  expect(report).toMatchObject({
    status: 'passed',
    stage: 'numeric',
    foreground: false,
    cpuFeatureFallback: false,
    productionEnabled: false,
    protocolSha256: sha(protocolBytes),
  })
  expect(report.adapter.length).toBeGreaterThan(0)
  expect(report.adapter).not.toMatch(/llvmpipe|swiftshader|software/i)
  expect(report.cases.map((entry) => entry.id)).toEqual(reference.cases.map((entry) => entry.id))
  for (const entry of reference.cases) {
    const result = report.cases.find((candidate) => candidate.id === entry.id)!
    expect(result).toMatchObject({ status: 'passed', rgbFailures: 0, wordMismatches: 0 })
    expect(result.maxToleranceRatio).toBeLessThanOrEqual(1)
    if (entry.roots.every((root) => !root.enabled || root.amount === 0))
      expect(result.textureJobs).toBe(0)
    const consumers = report.legacyChecks.filter((check) => check.id === entry.id)
    expect(consumers, entry.id).toHaveLength(2)
    expect(new Set(consumers.map((check) => check.format)), entry.id).toEqual(
      new Set(['float32-sdr', 'rgba8']),
    )
    const bytes = await readFile(join(output, `${entry.id}.f32`))
    expect(bytes.byteLength).toBe(entry.width * entry.height * 16)
    const union = await readFile(join(output, `${entry.id}.texture-union.f32`))
    expect(union.byteLength).toBe(entry.width * entry.height * 4)
    for (let pixel = 0; pixel < entry.unionCoverage.length; pixel++) {
      const actual = union.readFloatLE(pixel * 4),
        expected = entry.unionCoverage[pixel]
      expect(Number.isFinite(actual) && actual >= 0 && actual <= 1).toBe(true)
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
        protocol.gates.absolute + protocol.gates.relative * Math.abs(expected),
      )
    }
    if (entry.roots.some((root) => root.enabled && root.amount !== 0)) {
      const legacy = await readFile(join(output, `${entry.id}.working-legacy.f32`)),
        raw = await readFile(join(output, `${entry.id}.working-raw.f32`))
      expect(legacy.byteLength).toBe(bytes.byteLength)
      expect(raw.byteLength).toBe(bytes.byteLength)
      for (let pixel = 0; pixel < entry.width * entry.height; pixel++) {
        const expected =
          union.readFloatLE(pixel * 4) === 0 || entry.rgba[pixel * 4 + 3] === 0 ? legacy : raw
        for (let channel = 0; channel < 4; channel++) {
          const offset = (pixel * 4 + channel) * 4
          expect(bytes.readUInt32LE(offset)).toBe(expected.readUInt32LE(offset))
        }
      }
    }
    for (let index = 0; index < entry.expected.length; index++) {
      const actual = bytes.readFloatLE(index * 4)
      expect(Number.isFinite(actual)).toBe(true)
      if (index % 4 === 3) {
        expect(bytes.readUInt32LE(index * 4)).toBe(
          new Uint32Array(Float32Array.of(entry.rgba[index]).buffer)[0],
        )
      } else {
        expect(Math.abs(actual - entry.expected[index])).toBeLessThanOrEqual(
          protocol.gates.absolute + protocol.gates.relative * Math.abs(entry.expected[index]),
        )
      }
    }
  }
  expect(report.legacyChecks.length).toBeGreaterThan(0)
  expect(new Set(report.legacyChecks.map((entry) => entry.format)).size).toBeGreaterThanOrEqual(2)
  expect(
    report.legacyChecks.reduce((sum, entry) => sum + entry.outsideUnionPixels, 0),
  ).toBeGreaterThan(0)
  expect(
    report.legacyChecks.reduce((sum, entry) => sum + entry.alphaZeroPixels, 0),
  ).toBeGreaterThan(0)
  expect(
    report.legacyChecks.reduce((sum, entry) => sum + (entry.allZeroPixels ?? 0), 0),
  ).toBeGreaterThan(0)
  expect(
    report.legacyChecks.reduce((sum, entry) => sum + entry.changedInsideUnionPixels, 0),
  ).toBeGreaterThan(0)
  for (const entry of report.legacyChecks) {
    expect(entry.outsideUnionDifferences, entry.id).toBe(0)
    expect(entry.alphaZeroDifferences, entry.id).toBe(0)
    expect(entry.insideUnionCandidateDifferences, entry.id).toBe(0)
    if (entry.allZeroPixels) expect(entry.allZeroDifferences, entry.id).toBe(0)
  }
  for (const refusal of reference.refusals) {
    const actual = report.refusals.find((entry) => entry.id === refusal.id)
    expect(actual, refusal.id).toMatchObject({ status: 'passed', cpuFeatureFallback: false })
    expect(actual!.reason.length).toBeGreaterThan(0)
  }
  for (const id of ['prepared-parent-mismatch', 'consumed-context-mismatch', 'resource-budget']) {
    const actual = report.refusals.find((entry) => entry.id === id)
    expect(actual, id).toMatchObject({ status: 'passed', cpuFeatureFallback: false })
    expect(actual!.reason.length).toBeGreaterThan(0)
  }
  expect(JSON.parse(await readFile(join(output, 'worker-exit.json'), 'utf8'))).toMatchObject({
    code: 0,
  })
})
