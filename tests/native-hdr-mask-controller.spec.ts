import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET, type DisplayTarget } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import type { NativeHdrMaskDeclined, NativeHdrMaskResult } from '../src/shared/native-hdr-mask'
import { controllerFixture, scratchNames, sha } from './native-mask-controller.helpers'

test.skip(
  process.platform !== 'linux' || process.arch !== 'x64',
  'Native mask ownership currently supports Linux x64 only.',
)
test.setTimeout(30000)
const edited = {
  ...neutralAdjustments,
  exposureEv: 0.53,
  contrast: 45,
  highlights: -55,
  shadows: 40,
  whites: 20,
  blacks: -25,
  saturation: 40,
  vibrance: 65,
}
function actualMath() {
  const value = process.env.IRODORI_NATIVE_HDR_MASK_TEST_ARITHMETIC_SHA256
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(
      'Set IRODORI_NATIVE_HDR_MASK_TEST_ARITHMETIC_SHA256 to the actual built helper capability; exact native math coverage is mandatory.',
    )
  return value
}
function mask(result: NativeHdrMaskResult | NativeHdrMaskDeclined): NativeHdrMaskResult {
  expect(result.kind).toBe('mask')
  if (result.kind !== 'mask') throw new Error(`Native mask unexpectedly declined: ${result.reason}`)
  return result
}

test('real native helper matches unchanged full-mask CPU analysis for both targets, all domains, Before/After', async () => {
  const arithmeticSha256 = actualMath(),
    t = await controllerFixture({
      mask: {
        arithmeticSha256,
        parameters: (_record, request) =>
          request.comparison === 'before' ? neutralAdjustments : edited,
      },
    })
  try {
    const source = await t.source('mask-real-parity-odd-three-strips'),
      binaryBefore = sha(await readFile(t.executable))
    for (const colorSpace of ['srgb', 'display-p3'] as const)
      for (const domain of ['working-hdr', 'content-hdr', 'output'] as const)
        for (const comparison of ['before', 'after'] as const) {
          const target: DisplayTarget = {
              ...SDR_TARGET,
              mode: 'hdr',
              requested: 'hdr',
              colorSpace,
              peak: 2,
              headroom: 2,
            },
            request = t.maskRequest(source, {
              domain,
              comparison,
              target,
              parameters: comparison === 'before' ? { ...neutralAdjustments } : { ...edited },
            }),
            output = mask(await t.controller.renderMask(request)),
            owner = t.controller.acquireMask(new URL(output.url))
          expect(owner).toBeTruthy()
          const expected = new Uint8Array(source.asset.width * source.asset.height)
          analyzeHdr(
            source.pixels,
            request.parameters,
            source.asset,
            target,
            hdrStatistics(domain, target, source.asset),
            expected,
          )
          try {
            const bytes = await readFile(owner!.path)
            expect(bytes).toEqual(Buffer.from(expected))
            expect(sha(bytes)).toBe(output.sha256)
            expect(output).toMatchObject({
              source: source.ref,
              settingsRevision: source.revision,
              domain,
              comparison,
              parameters: request.parameters,
              target,
              arithmeticSha256,
              width: source.asset.width,
              height: source.asset.height,
              byteLength: expected.length,
            })
            expect(source.handles.size).toBe(0)
            expect(source.acquisitions).toBe(source.releases)
          } finally {
            owner!.release()
            await t.controller.releaseMask(request.sessionId, output.maskId)
          }
        }
    expect(await scratchNames(t.directory)).toEqual([])
    expect(sha(await readFile(t.executable))).toBe(binaryBefore)
    expect(sha(await readFile(source.path))).toBe(source.asset.sha256)
  } finally {
    await t.close()
  }
})

test('the actual helper rejects a different nonzero arithmetic identity before stdout or capability publication', async () => {
  const arithmeticSha256 = actualMath(),
    t = await controllerFixture({ mask: { arithmeticSha256 } })
  try {
    const source = await t.source('wrong-native-math-capability'),
      request = t.maskRequest(source),
      output = mask(await t.controller.renderMask(request)),
      owner = t.controller.acquireMask(new URL(output.url))
    expect(owner).toBeTruthy()
    let encoded: Buffer
    try {
      encoded = await readFile(join(dirname(owner!.path), 'request.bin'))
    } finally {
      owner!.release()
      await t.controller.releaseMask(request.sessionId, output.maskId)
    }
    expect(encoded!.subarray(384, 416).toString('hex')).toBe(arithmeticSha256)
    encoded![384] ^= 1
    const requestPath = join(t.control, 'wrong-mask-math.bin')
    await writeFile(requestPath, encoded!, { flag: 'wx', mode: 0o600 })
    const child = spawn(t.executable, ['--mask-v1', requestPath, '1'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      chunks: Buffer[] = []
    let stderr = '',
      stdoutBytes = 0
    child.stdin.on('error', () => undefined)
    child.stdout.on('data', (part: Buffer) => {
      stdoutBytes += part.length
      if (stdoutBytes <= 65536) chunks.push(part)
    })
    child.stderr.on('data', (part: Buffer) => {
      stderr = (stderr + part.toString()).slice(-65536)
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      },
    )
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      child.stdin.end(source.bytes)
      const result = await closed
      expect(result.code).not.toBe(0)
      expect(result.signal).toBeNull()
      expect(stdoutBytes).toBe(0)
      expect(Buffer.concat(chunks)).toHaveLength(0)
      expect(stderr).toMatch(/arithmetic identity does not match this executable/i)
      expect(source.handles.size).toBe(0)
      expect(await scratchNames(t.directory)).toEqual([])
      expect(await readdir(t.directory)).toEqual([])
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await closed
      }
    }
  } finally {
    await t.close()
  }
})
