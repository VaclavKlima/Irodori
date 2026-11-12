import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { neutralAdjustments } from '../src/shared/adjustments'
import { SDR_TARGET, type DisplayTarget } from '../src/shared/hdr'
import { analyzeHdr, hdrStatistics } from '../src/shared/hdr-statistics'
import type { NativeHdrMaskDeclined, NativeHdrMaskResult } from '../src/shared/native-hdr-mask'
import { nativeColorValues, NATIVE_MASK_REQUEST_BYTES } from '../src/shared/native-color-protocol'
import {
  nativeLocalMaskRoots,
  nativeLocalMaskValues,
} from '../src/shared/native-local-mask-protocol'
import { writeNativeCpuMask } from '../src/main/native-cpu-mask-sink'
import maskColorReference from '../assets/tests/references/mask-color/reference.json' with { type: 'json' }
import { maskColorReferenceMasks } from './helpers/mask-color'
import {
  controllerFixture,
  realNativeExecutable,
  scratchNames,
  sha,
} from './native-mask-controller.helpers'

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

/** Independent analytic coverage: this isolates exact classification and ordered
 * Light arithmetic from the separately qualified GPU coverage evaluator. */
function localPacket(
  pixels: Float32Array,
  locals: number[][],
  coverage: Float32Array,
  width = pixels.length / 4,
) {
  const count = locals.length,
    height = pixels.length / 4 / width,
    request = Buffer.alloc(NATIVE_MASK_REQUEST_BYTES + count * 128),
    source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  request.write(count ? 'MASKCPU4' : 'MASKCPU3')
  request.writeUInt32LE(count ? 4 : 3, 8)
  request.writeUInt32LE(2 | 16, 12) // Authored Rec.2020 with known headroom.
  request.writeUInt32LE(width, 16)
  request.writeUInt32LE(height, 20)
  request.writeUInt32LE(64, 24)
  request.writeUInt32LE(count, 28)
  request.writeBigUInt64LE(BigInt(source.byteLength), 32)
  Buffer.from(sha(source), 'hex').copy(request, 40)
  Buffer.from(sha(Buffer.from('independent-native-local-mask-packet')), 'hex').copy(request, 72)
  for (const offset of [152, 224, 296])
    identity.forEach((value, index) => request.writeDoubleLE(value, offset + index * 8))
  request.writeDoubleLE(2, 368)
  request.writeDoubleLE(2, 376)
  Buffer.from(actualMath(), 'hex').copy(request, 384)
  nativeColorValues(neutralAdjustments).forEach((value, index) =>
    request.writeDoubleLE(value, 432 + index * 8),
  )
  locals.forEach((local, index) => {
    expect([7, 16]).toContain(local.length)
    ;(local.length === 7 ? [...local, ...identity] : local).forEach((value, field) =>
      request.writeDoubleLE(value, NATIVE_MASK_REQUEST_BYTES + index * 128 + field * 8),
    )
  })
  const input: Buffer[] = []
  for (let row = 0; row < height; row += 64) {
    const end = Math.min(height, row + 64)
    input.push(source.subarray(row * width * 16, end * width * 16))
    input.push(
      Buffer.from(
        coverage.buffer,
        coverage.byteOffset + row * width * count * 4,
        (end - row) * width * count * 4,
      ),
    )
  }
  return { request, input: Buffer.concat(input) }
}

async function localOutput(request: Buffer, input: Buffer, threads: 1 | 4 | 8 = 4) {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-local-clipping-native-')),
    requestPath = join(directory, 'request.bin'),
    outputPath = join(directory, 'mask.r8'),
    file = await open(outputPath, 'wx+', 0o600)
  let child: ReturnType<typeof spawn> | undefined,
    closed: Promise<void> | undefined,
    timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(requestPath, request, { flag: 'wx', mode: 0o600 })
    child = spawn(await realNativeExecutable(), ['--mask-v1', requestPath, String(threads)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdin!.on('error', () => undefined)
    child.stderr!.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-8192)
    })
    closed = new Promise<void>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code, signal) =>
        code === 0 && !signal
          ? resolve()
          : reject(new Error(`Native local mask failed (${code}/${signal}): ${stderr}`)),
      )
    })
    void closed.catch(() => undefined)
    timeout = setTimeout(() => child?.kill('SIGKILL'), 15000)
    const result = writeNativeCpuMask({
      stdout: child.stdout!,
      expectedRequest: request,
      threads,
      closedSuccessfully: closed,
      file,
      signal: new AbortController().signal,
    })
    child.stdin!.end(input)
    await result
    return await readFile(outputPath)
  } finally {
    if (timeout) clearTimeout(timeout)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed?.catch(() => undefined)
    await file.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('GPU coverage zero preserves exact Float64 white/headroom neighbours across odd native strips', async () => {
  const greys = [
      0.9999999403953552, 1, 1.0000001192092896, 2, 2.000000238418579, 2.0000030994415283,
    ],
    pixels = new Float32Array(
      Array.from({ length: 3 * 129 }, (_, index) => {
        const value = greys[index % greys.length]
        return [value, value, value, 1]
      }).flat(),
    ),
    zero = new Float32Array(pixels.length / 4),
    baseline = localPacket(pixels, [], new Float32Array(), 3),
    masked = localPacket(pixels, [[1, 0, 0, 0, 0, 0, 0]], zero, 3),
    expected = Buffer.from(
      Array.from(
        { length: pixels.length / 4 },
        (_, index) => [0, 0, 4, 4, 6, 7][index % greys.length],
      ),
    )
  expect(await localOutput(baseline.request, baseline.input)).toEqual(expected)
  expect(await localOutput(masked.request, masked.input)).toEqual(expected)
})

test('native exact clipping consumes top-first roots in reverse and fractional coverage before classification', async () => {
  const pixels = new Float32Array([0.02, 0.02, 0.02, 1, 1, 1, 1, 1, 0.02, 0.02, 0.02, 0]),
    exposure = [5, 0, 0, 0, 0, 0, 0],
    blackLift = [0, 0, 0, 0, 0, 100, 0],
    ordered = localPacket(pixels, [exposure, blackLift], new Float32Array([1, 1, 0, 0, 1, 1])),
    reversed = localPacket(pixels, [blackLift, exposure], new Float32Array([1, 1, 0, 0, 1, 1])),
    fractional = localPacket(
      new Float32Array([1, 1, 1, 1]),
      [[1, 0, 0, 0, 0, 0, 0]],
      new Float32Array([0.5]),
    )
  // Black lift before +5 EV crosses reference white; the reverse remains below.
  expect(await localOutput(ordered.request, ordered.input)).toEqual(Buffer.from([4, 0, 0]))
  expect(await localOutput(reversed.request, reversed.input)).toEqual(Buffer.from([0, 0, 0]))
  expect(await localOutput(fractional.request, fractional.input)).toEqual(Buffer.from([4]))
})

test('native local WB and saturation classify independent Decimal80 mask-color references including fractional and inactive coverage', async () => {
  const selected = [
      'warm',
      'cool',
      'desaturate',
      'saturate',
      'color-only',
      'one-half-blend',
      'ordered-mixed',
      'neutral',
      'zero-coverage',
      'disabled',
    ],
    changed = new Set<string>()
  // Authored content and an identity proof matrix isolate the unchanged four-bit
  // predicates from tone rendering. The committed Decimal80 vectors are the
  // independent color oracle; no test-side WB/Light/Lab algorithm is reproduced.
  for (const id of selected) {
    const entry = maskColorReference.cases.find((item) => item.id === id)!,
      masks = maskColorReferenceMasks(id),
      parameters = { localMasks: masks },
      roots = nativeLocalMaskRoots(parameters),
      values = nativeLocalMaskValues(parameters),
      locals = Array.from({ length: roots.length }, (_, index) =>
        Array.from(values.subarray(index * 16, (index + 1) * 16)),
      ),
      peak = id === 'warm' || id === 'cool' ? 1.01 : 2,
      luminance = (rgb: number[]) =>
        rgb[0] * 0.2627002120112671 + rgb[1] * 0.6779980715188708 + rgb[2] * 0.059301716469862,
      classify = (rgb: number[]) => {
        const content = rgb.map((value) => Math.max(0, value)),
          y = luminance(content)
        return (
          Number(content.some((value) => value > peak + 2e-6)) |
          (Number(y > peak) << 1) |
          (Number(y > 1) << 2)
        )
      },
      vectors = maskColorReference.vectors
        .filter(
          (vector) => vector.case === id && vector.primaries === 'rec2020' && vector.white === 1,
        )
        .map((vector) => ({ input: vector.input, output: vector.output }))
    // WB is linear. Scaling the independent white vector makes its changed
    // channel cross the selected peak while luminance stays far from white.
    if (id === 'warm' || id === 'cool') {
      const white = vectors.find((vector) => vector.input.every((value) => value === 1))!
      vectors.push({
        input: white.input.map((value) => value * 0.95),
        output: white.output.map((value) => value * 0.95),
      })
    }
    const unambiguous = vectors.filter((vector) => {
      const content = vector.output.map((value) => Math.max(0, value)),
        y = luminance(content)
      return (
        Math.abs(y - 1) > 0.001 &&
        Math.abs(y - peak) > 0.001 &&
        content.every((value) => Math.abs(value - peak - 2e-6) > 0.001)
      )
    })
    expect(unambiguous.length, id).toBeGreaterThan(0)
    if (unambiguous.some((vector) => classify(vector.input) !== classify(vector.output)))
      changed.add(id)
    const coverage = roots.map(
        (root) => entry.masks[masks.findIndex((mask) => mask.id === root.id)].coverage,
      ),
      pixels = new Float32Array(unambiguous.flatMap((vector) => [...vector.input, 1])),
      packet = localPacket(pixels, locals, new Float32Array(unambiguous.flatMap(() => coverage))),
      expected = Buffer.from(unambiguous.map((vector) => classify(vector.output)))
    packet.request.writeDoubleLE(peak, 368)
    packet.request.writeDoubleLE(peak, 376)
    if (['neutral', 'zero-coverage', 'disabled'].includes(id)) {
      expect(roots).toHaveLength(0)
      expect(packet.request.subarray(0, 8).toString()).toBe('MASKCPU3')
    }
    expect(await localOutput(packet.request, packet.input), id).toEqual(expected)
  }
  expect([...changed]).toEqual(expect.arrayContaining(['warm', 'cool', 'saturate', 'desaturate']))
})

test('native local packet rejects malformed counts, invalid controls and nonfinite GPU coverage', async () => {
  const pixels = new Float32Array([1, 1, 1, 1]),
    make = () => localPacket(pixels, [[1, 0, 0, 0, 0, 0, 0]], new Float32Array([1]))
  for (const corrupt of [
    (request: Buffer) => request.writeUInt32LE(33, 28),
    (request: Buffer) => request.writeUInt32LE(0, 28),
    (request: Buffer) => request.writeDoubleLE(6, NATIVE_MASK_REQUEST_BYTES),
    (request: Buffer) => request.writeDoubleLE(NaN, NATIVE_MASK_REQUEST_BYTES + 56),
  ]) {
    const p = make()
    corrupt(p.request)
    await expect(localOutput(p.request, p.input)).rejects.toThrow()
  }
  for (const value of [NaN, Infinity, -1, 1.01]) {
    const p = localPacket(pixels, [[1, 0, 0, 0, 0, 0, 0]], new Float32Array([value]))
    await expect(localOutput(p.request, p.input)).rejects.toThrow()
  }
  const p = make()
  await expect(localOutput(p.request, p.input.subarray(0, p.input.length - 1))).rejects.toThrow()
  await expect(localOutput(p.request, Buffer.concat([p.input, Buffer.from([0])]))).rejects.toThrow()
})
