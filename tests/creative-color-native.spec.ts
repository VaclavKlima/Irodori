import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { compileCreativeColor, creativeColorValues } from '../src/shared/creative-color'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import type { ColorPrimaries, ColorTriple } from '../src/shared/color-model'

interface Vector {
  input: ColorTriple
  output: ColorTriple
  primaries: ColorPrimaries
  configuration: number
  selection: { first: number; second: number; blend: number; protection: number }
}
const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  vectors: Vector[]
  gpuVectors: Vector[]
}

test('native Float64 mixer/grading agrees with all 5040 independent scalar and Float32-input references', async () => {
  test.skip(
    process.platform !== 'linux' || process.arch !== 'x64',
    'Native build probe currently targets Linux x64.',
  )
  const directory = await mkdtemp(join(tmpdir(), 'irodori-creative-color-'))
  try {
    const binary = join(directory, 'color-reference')
    execFileSync(
      'c++',
      [
        '-std=c++17',
        '-O2',
        '-ffp-contract=off',
        '-fno-fast-math',
        resolve('scripts/research/creative-color-native.cpp'),
        '-o',
        binary,
      ],
      { timeout: 30_000, stdio: 'pipe' },
    )
    const vectors = [...reference.vectors, ...reference.gpuVectors],
      input = Buffer.alloc(16 + reference.configurations.length * 52 * 8 + vectors.length * 32)
    input.write('IRODCLR1')
    input.writeUInt32LE(reference.configurations.length, 8)
    input.writeUInt32LE(vectors.length, 12)
    let at = 16
    for (const config of reference.configurations) {
      const value = compileCreativeColor(config.mixer, config.intensity, config.grading),
        values = creativeColorValues(value)
      assert.equal(values.length, 52)
      for (const v of values) {
        input.writeDoubleLE(v, at)
        at += 8
      }
    }
    for (const v of vectors) {
      input.writeUInt32LE(v.configuration, at)
      input.writeUInt32LE(Number(v.primaries === 'rec2020'), at + 4)
      at += 8
      for (const channel of v.input) {
        input.writeDoubleLE(channel, at)
        at += 8
      }
    }
    assert.equal(at, input.length)
    const output = execFileSync(binary, [], { input, maxBuffer: 1024 ** 2, timeout: 10_000 })
    expect(output.length).toBe(vectors.length * 56)
    let maximumRatio = 0,
      selectionRatio = 0,
      worst: unknown,
      worstSelection: unknown
    for (const [i, v] of vectors.entries()) {
      const base = i * 56
      for (let c = 0; c < 3; c++) {
        const actual = output.readDoubleLE(base + c * 8),
          expected = v.output[c],
          ratio = Math.abs(actual - expected) / (2e-12 + 2e-11 * Math.abs(expected))
        assert.ok(Number.isFinite(actual))
        if (ratio > maximumRatio) {
          maximumRatio = ratio
          worst = { v, c, actual, expected }
        }
      }
      const first = output.readDoubleLE(base + 24),
        second = output.readDoubleLE(base + 32),
        blend = output.readDoubleLE(base + 40),
        protection = output.readDoubleLE(base + 48),
        selected = v.selection
      assert.ok(Number.isInteger(first) && first >= 0 && first < 8)
      assert.equal(second, (first + 1) % 8)
      for (let j = 0; j < 9; j++) {
        const actual = j === 8 ? protection : j === first ? 1 - blend : j === second ? blend : 0,
          expected =
            j === 8
              ? selected.protection
              : j === selected.first
                ? 1 - selected.blend
                : j === selected.second
                  ? selected.blend
                  : 0,
          ratio = Math.abs(actual - expected) / 2e-12
        assert.ok(Number.isFinite(actual))
        if (ratio > selectionRatio) {
          selectionRatio = ratio
          worstSelection = { v, j, actual, expected }
        }
      }
    }
    expect(maximumRatio, JSON.stringify(worst)).toBeLessThanOrEqual(1)
    expect(selectionRatio, JSON.stringify(worstSelection)).toBeLessThanOrEqual(1)
    // Tamper only the first, neutral configuration: each failure precedes any pixel output.
    for (const [component, value] of [
      [0, NaN],
      [1, 0.5],
      [2, 1],
      [3, 1],
      [4, 0],
      [5, 3],
      [6, -0],
      [7, 1],
      [8, -0.2],
      [9, 0.25],
      [40, 0.6],
      [43, -0],
      [47, 1],
      [51, Infinity],
    ] as const) {
      const invalid = Buffer.from(input)
      invalid.writeDoubleLE(value, 16 + component * 8)
      const result = spawnSync(binary, [], {
        input: invalid,
        maxBuffer: 1024 ** 2,
        timeout: 10_000,
      })
      assert.equal(result.status, 1, `invalid parameter ${component}/${value}`)
      assert.equal(result.stdout.length, 0)
      assert.ok(result.stderr.length > 0)
    }
    await test.info().attach('native-creative-color-agreement.json', {
      body: Buffer.from(
        JSON.stringify({ vectors: vectors.length, maximumRatio, selectionRatio }, null, 2),
      ),
      contentType: 'application/json',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
