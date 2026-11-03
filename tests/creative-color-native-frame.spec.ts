import { expect, test } from '@playwright/test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { nativeCpuMaskCapability } from '../src/main/native-cpu-executable'
import { neutralAdjustments, type AdjustmentParameters } from '../src/shared/adjustments'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import { SDR_TARGET } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import {
  NATIVE_CPU_COLOR_OFFSET,
  NATIVE_MASK_COLOR_OFFSET,
  NATIVE_MASK_REQUEST_BYTES,
  nativeColorValues,
} from '../src/shared/native-color-protocol'
import { controllerFixture, sha } from './native-mask-controller.helpers'

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

test('shipping native masks reject malformed color packets and obsolete requests before their first output byte', async () => {
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
    for (const mask of [true]) {
      const result = await t.controller.renderMask(t.maskRequest(source, { parameters: confirmed }))
      assert.equal(result.kind, 'mask')
      const owner = t.controller.acquireMask(new URL(result.url))
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
      await t.controller.releaseMask(result.sessionId, result.maskId)
    }
    expect(sha(await readFile(source.path))).toBe(source.asset.sha256)
    await t.controller.reset()
    expect(source.handles.size).toBe(0)
  } finally {
    await t.close()
  }
})
