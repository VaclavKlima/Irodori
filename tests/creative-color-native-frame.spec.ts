import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { nativeCpuMaskCapability } from '../src/main/native-cpu-executable'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import { SDR_TARGET } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import {
  nativeColorValues,
  NATIVE_CPU_COLOR_OFFSET,
  NATIVE_MASK_COLOR_OFFSET,
  NATIVE_CPU_REQUEST_BYTES,
  NATIVE_MASK_REQUEST_BYTES,
} from '../src/shared/native-color-protocol'
import { buildAcesReference, referenceAces } from './aces-reference'
import { controllerFixture, readPlane, sha } from './native-cpu-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'The shipping helper is Linux x64.',
)
const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: [number, number, number]
    output: [number, number, number]
    primaries: string
    configuration: number
  }[]
}
const vectorsFor = (index: number) =>
  reference.gpuVectors.filter((v) => v.primaries === 'rec2020' && v.configuration === index)
const settings = (index: number): AdjustmentParameters => {
  const c = reference.configurations[index]
  return {
    ...neutralAdjustments,
    ...c.intensity,
    colorMixer: structuredClone(c.mixer),
    colorGrading: structuredClone(c.grading),
  }
}
const encode = (v: number) =>
  Math.round(
    Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) * 255,
  )

test('shipping native CPU pairs compose every independent grading reference with CTL and freeze the full color packet', async () => {
  const t = await controllerFixture()
  try {
    const directory = test.info().outputPath('ctl')
    await mkdir(directory)
    const ctl = buildAcesReference(directory),
      vectors = vectorsFor(0),
      width = vectors.length,
      pixels = new Float32Array(vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
      source = await t.source('independent-creative-native', width, 1, pixels),
      before = referenceAces(
        ctl,
        vectors.map((v) => v.input),
        1,
        'srgb',
      )
    let previous: string | null = null,
      count = 0
    for (let index = 0; index < reference.configurations.length; index++) {
      const request = t.request(source, { parameters: settings(index) }),
        pending = t.controller.render(request)
      Object.assign(request.parameters.colorGrading!.tones.shadows, { hue: 23, saturation: 100 })
      const result = await pending
      await t.controller.acknowledge(request.sessionId, result.pairId, previous)
      previous = result.pairId
      expect(result.parameters).toEqual(settings(index))
      const owner = t.controller.acquire(new URL(result.after.url))!
      assert.ok(owner)
      try {
        const wire = await readFile(join(dirname(owner.path), 'request.bin'))
        expect(wire.length).toBe(NATIVE_CPU_REQUEST_BYTES)
        expect(wire.toString('ascii', 0, 8)).toBe('IRODCPU3')
        const expected = nativeColorValues(settings(index))
        for (let i = 0; i < expected.length; i++)
          expect(wire.readDoubleLE(NATIVE_CPU_COLOR_OFFSET + i * 8)).toBe(expected[i])
      } finally {
        owner.release()
      }
      const afterBytes = await readPlane(t.controller, result.after.url),
        beforeBytes = await readPlane(t.controller, result.before.url),
        expected = referenceAces(
          ctl,
          vectorsFor(index).map((v) => v.output),
          1,
          'srgb',
        )
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          expect(
            Math.abs(afterBytes[x * 4 + c] - encode(expected[x][c])),
            `grade ${index}, pixel ${x}, channel ${c}`,
          ).toBeLessThanOrEqual(1)
          expect(Math.abs(beforeBytes[x * 4 + c] - encode(before[x][c]))).toBeLessThanOrEqual(1)
        }
        expect(afterBytes[x * 4 + 3]).toBe(Math.round(pixels[x * 4 + 3] * 255))
        expect(beforeBytes[x * 4 + 3]).toBe(afterBytes[x * 4 + 3])
      }
      if (index === 0) expect(afterBytes.equals(beforeBytes)).toBe(true)
      count += width
    }
    expect(count).toBe(1260)
    expect(sha(await readFile(source.path))).toBe(source.asset.sha256)
    expect(source.acquisitions).toBe(1)
    expect(source.releases).toBe(0)
    expect(source.handles.size).toBe(1)
    await t.controller.reset()
    expect(source.handles.size).toBe(0)
    expect(source.acquisitions).toBe(source.releases)
  } finally {
    await t.close()
  }
})

test('shipping native range analysis includes the confirmed grade and preserves its exact source, request and arithmetic identity', async () => {
  const capability = await nativeCpuMaskCapability(resolve('vendor'))
  let confirmed = settings(0)
  const t = await controllerFixture({
    mask: {
      arithmeticSha256: capability.arithmeticSha256,
      parameters: () => confirmed,
    },
  })
  try {
    const vectors = vectorsFor(0),
      source = await t.source(
        'native-creative-diagnostics',
        vectors.length,
        1,
        new Float32Array(vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
      )
    for (const index of [0, 1, 6, 9]) {
      confirmed = settings(index)
      for (const domain of ['working-hdr', 'content-hdr', 'output'] as const) {
        const target = { ...SDR_TARGET, mode: 'hdr' as const, peak: 2, headroom: 2 },
          request = t.maskRequest(source, {
            parameters: structuredClone(confirmed),
            domain,
            target,
          }),
          result = await t.controller.renderMask(request)
        assert.equal(result.kind, 'mask')
        const owner = t.controller.acquireMask(new URL(result.url))!
        assert.ok(owner)
        try {
          const expected = new Uint8Array(vectors.length)
          analyzeHdr(
            source.pixels,
            confirmed,
            source.asset,
            target,
            hdrStatistics(domain, target, source.asset),
            expected,
          )
          expect(await readFile(owner.path)).toEqual(Buffer.from(expected))
          const wire = await readFile(join(dirname(owner.path), 'request.bin'))
          expect(wire.length).toBe(NATIVE_MASK_REQUEST_BYTES)
          expect(wire.subarray(384, 416).toString('hex')).toBe(capability.arithmeticSha256)
          const color = nativeColorValues(confirmed)
          for (let i = 0; i < color.length; i++)
            expect(wire.readDoubleLE(NATIVE_MASK_COLOR_OFFSET + i * 8)).toBe(color[i])
          expect(result.parameters).toEqual(confirmed)
        } finally {
          owner.release()
          await t.controller.releaseMask(result.sessionId, result.maskId)
        }
      }
    }
    expect(sha(await readFile(source.path))).toBe(source.asset.sha256)
    expect(source.handles.size).toBe(0)
    expect(source.acquisitions).toBe(source.releases)
  } finally {
    await t.close()
  }
})

async function rejectsBeforeOutput(executable: string, path: string, bytes: Buffer, mask: boolean) {
  const child = spawn(executable, mask ? ['--mask-v1', path, '1'] : [path, '-', '1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdoutBytes = 0,
    stderr = ''
  child.stdout.on('data', (part: Buffer) => {
    stdoutBytes += part.length
  })
  child.stderr.on('data', (part: Buffer) => {
    stderr = (stderr + part.toString()).slice(-65536)
  })
  child.stdin.on('error', () => undefined)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      },
    ),
    timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    child.stdin.end(bytes)
    const result = await closed
    expect(result.code).not.toBe(0)
    expect(result.signal).toBeNull()
    expect(stdoutBytes).toBe(0)
    expect(stderr).toMatch(/color|contract|regular file|bounded mask request/i)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await closed
    }
  }
}

test('both shipping native modes reject malformed color packets and obsolete requests before their first output byte', async () => {
  const capability = await nativeCpuMaskCapability(resolve('vendor')),
    confirmed = settings(9),
    t = await controllerFixture({
      mask: {
        arithmeticSha256: capability.arithmeticSha256,
        parameters: () => confirmed,
      },
    })
  try {
    const source = await t.source('malformed-native-creative', 3, 1)
    for (const mask of [false, true]) {
      const result = mask
          ? await t.controller.renderMask(t.maskRequest(source, { parameters: confirmed }))
          : await t.controller.render(t.request(source, { parameters: confirmed })),
        owner =
          'kind' in result
            ? (assert.equal(result.kind, 'mask'), t.controller.acquireMask(new URL(result.url)))
            : t.controller.acquire(new URL(result.after.url))
      assert.ok(owner)
      let wire: Buffer
      try {
        wire = await readFile(join(dirname(owner.path), 'request.bin'))
      } finally {
        owner.release()
      }
      const at = mask ? NATIVE_MASK_COLOR_OFFSET : NATIVE_CPU_COLOR_OFFSET,
        changes: [string, (value: Buffer) => Buffer][] = [
          [
            'obsolete-version',
            (v) => {
              v.writeUInt32LE(2, 8)
              return v
            },
          ],
          ['truncated-packet', (v) => v.subarray(0, -8)],
          [
            'nonfinite',
            (v) => {
              v.writeDoubleLE(NaN, at + 8 * 8)
              return v
            },
          ],
          [
            'intensity-mismatch',
            (v) => {
              v.writeDoubleLE(0, at)
              return v
            },
          ],
          [
            'activity-mismatch',
            (v) => {
              v.writeDoubleLE(0, at + 2 * 8)
              return v
            },
          ],
          [
            'invalid-unit-rotation',
            (v) => {
              v.writeDoubleLE(-0.1, at + 8 * 8)
              return v
            },
          ],
          [
            'invalid-tone-strength',
            (v) => {
              v.writeDoubleLE(0.5, at + 40 * 8)
              v.writeDoubleLE(0.5, at + 41 * 8)
              return v
            },
          ],
          [
            'negative-zero-padding',
            (v) => {
              v.writeDoubleLE(-0, at + 6 * 8)
              return v
            },
          ],
        ]
      for (const [name, change] of changes) {
        const path = join(t.control, `${mask ? 'mask' : 'pair'}-${name}.bin`)
        await writeFile(path, change(Buffer.from(wire!)), { flag: 'wx', mode: 0o600 })
        await rejectsBeforeOutput(t.executable, path, source.bytes, mask)
      }
      if ('kind' in result) await t.controller.releaseMask(result.sessionId, result.maskId)
      else await t.controller.release(result.sessionId, result.pairId)
    }
    expect(sha(await readFile(source.path))).toBe(source.asset.sha256)
    await t.controller.reset()
    expect(source.handles.size).toBe(0)
  } finally {
    await t.close()
  }
})
