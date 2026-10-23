// Draft destination until the coordinator adopts scripts/research/compare-native-cpu-render.ts.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'
import {
  adjustHdr,
  contentHdr,
  encodeHdr,
  hdrAdjustmentMatrix,
  outputHdr,
  REC2020_TO_SRGB,
  SDR_TARGET,
  HDR_SOURCE_VERSION,
  HDR_JPEG_SOURCE_VERSION,
  validateHdrSource,
  type HdrSource,
  type DisplayTarget,
} from '../../src/shared/hdr'
import {
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
} from '../../src/shared/adjustments'
import { REC2020_TO_ACES, DISPLAY_RENDERING_VERSION } from '../../src/shared/display-rendering'
import { WHITE_BALANCE_MODEL, type WhiteBalanceProfile } from '../../src/shared/white-balance'
import { hdrRangeColor } from '../../src/renderer/src/preview/hdr-ranges'

const [
  rootArgument,
  executableArgument,
  outputArgument,
  fixtureArgument,
  threadsArgument = '1,4,8',
] = process.argv.slice(2)
if (!rootArgument || !executableArgument || !outputArgument || process.argv.length > 7)
  throw new Error('Expected ROOT EXECUTABLE NEW_OUTPUT [FIXTURE_JSON|-] [1|1,4,8].')
const root = resolve(rootArgument),
  executable = resolve(executableArgument),
  output = resolve(outputArgument)
const threads = threadsArgument.split(',').map(Number)
if (
  !threads.length ||
  new Set(threads).size !== threads.length ||
  threads.some((n) => ![1, 4, 8].includes(n))
)
  throw new Error('Expected distinct thread counts selected from 1,4,8.')
await mkdir(output, { recursive: false })
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
async function fileHash(path: string) {
  const value = createHash('sha256')
  for await (const chunk of createReadStream(path)) value.update(chunk)
  return value.digest('hex')
}
const baseSource: HdrSource = {
  version: HDR_SOURCE_VERSION,
  processing: 'hdr-v1',
  colorSpace: 'rec2020',
  whitePoint: 'D65',
  transfer: 'linear',
  alpha: 'straight',
  decoder: 'synthetic-native-cpu-research',
  cameraProfile: 'synthetic',
  orientation: 'applied-once',
  normalization: {
    black: [0, 0, 0, 0],
    maximum: 1,
    gains: [1, 1, 1, 1],
    restoreGain: 1,
    referenceWhite: 1,
    sourceSaturation: null,
  },
}
const profile: WhiteBalanceProfile = {
  provider: 'synthetic',
  version: '1',
  identity: 'synthetic-native-cpu',
  model: WHITE_BALANCE_MODEL,
  asShotGains: [2, 1, 1.5],
  xyzToCamera: [0.7, 0.2, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8],
  cameraToWorking: [1.4, -0.3, -0.1, -0.1, 1.2, -0.1, 0, -0.1, 1.1],
  ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
  estimate: { kelvin: 6500, tint: 0 },
}
interface Source {
  name: string
  path: string
  width: number
  height: number
  sha256: string
  contract: HdrSource
  whiteBalance?: WhiteBalanceProfile
}
interface Case {
  name: string
  source: Source
  parameters: AdjustmentParameters
  ranges: boolean
  headroom: number | null
  draft?: boolean
}
const combined: AdjustmentParameters = {
  ...neutralAdjustments,
  exposureEv: 1.37,
  contrast: -31,
  highlights: -65,
  shadows: 43,
  whites: 28,
  blacks: -19,
}
const sources: Source[] = []
if (fixtureArgument && fixtureArgument !== '-') {
  const path = resolve(fixtureArgument)
  const fixture = JSON.parse(await readFile(path, 'utf8'))
  const source = fixture.source,
    file = fixture.files?.source
  if (
    fixture.schemaVersion !== 1 ||
    !source ||
    !file ||
    typeof file.path !== 'string' ||
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    !/^[a-f0-9]{64}$/.test(source.workingSha256) ||
    file.sha256 !== source.workingSha256
  )
    throw new Error(
      'Expected a prepare-native-viewport-fixture.ts bundle with actual working-source identity.',
    )
  const sourcePath = resolve(dirname(path), file.path)
  if (isAbsolute(file.path) || !sourcePath.startsWith(`${dirname(path)}/`))
    throw new Error('Fixture source must remain inside its immutable bundle.')
  validateHdrSource(fixture.provenance.sourceContract)
  sources.push({
    name: 'managed-full',
    path: sourcePath,
    width: source.width,
    height: source.height,
    sha256: source.workingSha256,
    contract: fixture.provenance.sourceContract,
    whiteBalance: fixture.provenance.whiteBalance,
  })
} else {
  const reference = JSON.parse(
    await readFile(join(root, 'tests/fixtures/aces-reference.json'), 'utf8'),
  ) as { inputs: number[][] }
  for (const [name, width, height] of [
    ['odd', 97, 131],
    ['skinny', 1, 137],
    ['wide', 129, 1],
    ['draft', 1025, 3],
  ] as const) {
    const data = new Float32Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const value = reference.inputs[i % reference.inputs.length]
      for (let c = 0; c < 3; c++) data[i * 4 + c] = value[c]
      data[i * 4 + 3] = [0, 0.5, 1 / 255, 0.12345, 1, 0.999999][i % 6]
    }
    const bytes = new Uint8Array(data.buffer),
      path = join(output, `${name}.f32`)
    await writeFile(path, bytes, { flag: 'wx' })
    sources.push({
      name,
      path,
      width,
      height,
      sha256: hash(bytes),
      contract: baseSource,
      whiteBalance: profile,
    })
  }
}
for (const source of sources)
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    source.width > 32768 ||
    source.height > 32768 ||
    source.width * source.height * 16 > 512 * 1024 ** 2 ||
    (await stat(source.path)).size !== source.width * source.height * 16 ||
    (await fileHash(source.path)) !== source.sha256
  )
    throw new Error('Input geometry or independently hashed F32 source does not match.')

const cases: Case[] = []
for (const source of sources) {
  const edits: [string, AdjustmentParameters][] =
    fixtureArgument && fixtureArgument !== '-'
      ? [
          ['neutral', neutralAdjustments],
          ['combined', combined],
        ]
      : [
          ['neutral', neutralAdjustments],
          ['exposure', { ...neutralAdjustments, exposureEv: -2.37 }],
          ['contrast', { ...neutralAdjustments, contrast: 80 }],
          ['highlights', { ...neutralAdjustments, highlights: -100 }],
          ['shadows', { ...neutralAdjustments, shadows: 100 }],
          ['whites', { ...neutralAdjustments, whites: -100 }],
          ['blacks', { ...neutralAdjustments, blacks: 100 }],
          ['combined', combined],
        ]
  if (source.whiteBalance)
    edits.push([
      'wb-combined',
      { ...combined, whiteBalance: { mode: 'custom', kelvin: 8000, tint: 40 } },
    ])
  for (const [name, parameters] of edits)
    cases.push({
      name: `${source.name}-${name}`,
      source,
      parameters,
      ranges: false,
      headroom: null,
      draft: source.name === 'draft',
    })
  cases.push({
    name: `${source.name}-ranges`,
    source,
    parameters: combined,
    ranges: true,
    headroom: 2,
    draft: source.name === 'draft',
  })
  if (!fixtureArgument || fixtureArgument === '-') {
    const display: HdrSource = {
      version: HDR_JPEG_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      decoder: 'synthetic-native-cpu-research',
      orientation: 'applied-once',
      normalization: { referenceWhite: 1, sourceSaturation: null },
      display: { encoding: 'iso-21496-1-jpeg', headroom: 8, referenceWhiteNits: 203 },
    }
    cases.push({
      name: `${source.name}-display-ranges`,
      source: { ...source, contract: display },
      parameters: combined,
      ranges: true,
      headroom: null,
      draft: source.name === 'draft',
    })
  }
}

function requestFor(value: Case, generation: number) {
  const { source, parameters } = value
  const scale = value.draft ? 1024 / Math.max(source.width, source.height) : 1
  const width = Math.max(1, Math.round(source.width * scale)),
    height = Math.max(1, Math.round(source.height * scale))
  const wb = hdrAdjustmentMatrix(parameters, source.whiteBalance)
  const flags =
    Number(!!wb) |
    (Number(!!source.contract.display) << 1) |
    (Number(value.ranges) << 2) |
    (Number(sameAdjustments(parameters, neutralAdjustments)) << 3) |
    (Number(value.headroom !== null) << 4)
  const request = Buffer.alloc(400)
  request.write('LUMACPU1')
  request.writeUInt32LE(1, 8)
  request.writeUInt32LE(flags, 12)
  for (const [at, n] of [
    [16, source.width],
    [20, source.height],
    [24, width],
    [28, height],
  ])
    request.writeUInt32LE(n, at)
  for (const at of [32, 40, 48]) request.writeBigUInt64LE(BigInt(generation), at)
  Buffer.from(source.sha256, 'hex').copy(request, 56)
  Buffer.from(
    hash(
      JSON.stringify({
        source: source.sha256,
        parameters,
        ranges: value.ranges,
        headroom: value.headroom,
        width,
        height,
        rendering: DISPLAY_RENDERING_VERSION,
      }),
    ),
    'hex',
  ).copy(request, 88)
  request.writeBigUInt64LE(BigInt(source.width * source.height * 16), 120)
  REC2020_TO_ACES.flat().forEach((v, i) => request.writeDoubleLE(v, 128 + i * 8))
  REC2020_TO_SRGB.forEach((v, i) => request.writeDoubleLE(v, 200 + i * 8))
  ;[
    parameters.exposureEv,
    parameters.contrast,
    parameters.highlights,
    parameters.shadows,
    parameters.whites,
    parameters.blacks,
  ].forEach((v, i) => request.writeDoubleLE(v, 272 + i * 8))
  ;(wb ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).forEach((v, i) => request.writeDoubleLE(v, 320 + i * 8))
  request.writeDoubleLE(value.headroom ?? 0, 392)
  return { request, width, height, wb }
}
const magic = (text: string) => Buffer.from(text)
async function writeAll(file: FileHandle, bytes: Uint8Array | Uint8ClampedArray) {
  let offset = 0
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null)
    if (!result.bytesWritten) throw new Error('Incomplete response write.')
    offset += result.bytesWritten
  }
}
async function oracle(
  value: Case,
  request: Buffer,
  width: number,
  height: number,
  wb: number[] | null,
  path: string,
) {
  const source = await open(value.source.path, 'r'),
    destination = await open(path, 'wx')
  let nextRow = 0,
    computeMs = 0,
    readMs = 0
  const target: DisplayTarget = { ...SDR_TARGET, headroom: value.headroom }
  const neutral = sameAdjustments(value.parameters, neutralAdjustments)
  const started = performance.now()
  try {
    await writeAll(
      destination,
      Buffer.concat([magic('LUMARGB1'), Buffer.from([144, 1, 0, 0]), request, Buffer.alloc(4)]),
    )
    for (let row = 0; row < value.source.height; row += 64) {
      const rows = Math.min(64, value.source.height - row),
        bytes = Buffer.alloc(value.source.width * rows * 16)
      const readStarted = performance.now()
      let offset = 0
      while (offset < bytes.length) {
        const read = await source.read(
          bytes,
          offset,
          bytes.length - offset,
          row * value.source.width * 16 + offset,
        )
        if (!read.bytesRead) throw new Error('Incomplete oracle input strip.')
        offset += read.bytesRead
      }
      readMs += performance.now() - readStarted
      const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
      const first = nextRow
      let endRow = first
      while (
        endRow < height &&
        Math.floor(((endRow + 0.5) * value.source.height) / height) < row + rows
      )
        endRow++
      const after = new Uint8ClampedArray((endRow - first) * width * 4),
        before = new Uint8ClampedArray(after.length)
      const computeStarted = performance.now()
      while (nextRow < height) {
        const y = Math.floor(((nextRow + 0.5) * value.source.height) / height)
        if (y >= row + rows) break
        for (let column = 0; column < width; column++) {
          const x = Math.floor(((column + 0.5) * value.source.width) / width),
            at = ((y - row) * value.source.width + x) * 4
          const rgb: [number, number, number] = [data[at], data[at + 1], data[at + 2]]
          const adjusted = adjustHdr(rgb, value.parameters, wb ?? undefined)
          const a = outputHdr(adjusted, SDR_TARGET, value.source.contract).rgb
          const b = neutral ? a : outputHdr(rgb, SDR_TARGET, value.source.contract).rgb
          const aRange = value.ranges
            ? hdrRangeColor(contentHdr(adjusted, value.source.contract).rgb, target, x, y)
            : null
          const bRange = neutral
            ? aRange
            : value.ranges
              ? hdrRangeColor(contentHdr(rgb, value.source.contract).rgb, target, x, y)
              : null
          const out = ((nextRow - first) * width + column) * 4
          for (let c = 0; c < 3; c++) {
            after[out + c] = Math.round((aRange?.[c] ?? encodeHdr(a[c])) * 255)
            before[out + c] = Math.round((bRange?.[c] ?? encodeHdr(b[c])) * 255)
          }
          after[out + 3] = before[out + 3] = Math.round(data[at + 3] * 255)
        }
        nextRow++
      }
      computeMs += performance.now() - computeStarted
      if (nextRow === first) continue
      const header = Buffer.alloc(24)
      header.write('LUMAROW1')
      header.writeUInt32LE(first, 8)
      header.writeUInt32LE(nextRow - first, 12)
      header.writeUInt32LE(after.length, 16)
      await writeAll(destination, header)
      await writeAll(destination, after)
      await writeAll(destination, before)
    }
    const trailer = Buffer.from(
      JSON.stringify({ implementation: 'unchanged-shared-js-functions', computeMs, readMs }),
    )
    const header = Buffer.alloc(12)
    header.write('LUMAEND1')
    header.writeUInt32LE(trailer.length, 8)
    await writeAll(destination, header)
    await writeAll(destination, trailer)
  } finally {
    await source.close()
    await destination.close()
  }
  return { computeMs, readMs, elapsedMs: performance.now() - started }
}
async function native(requestPath: string, sourcePath: string, count: number, path: string) {
  const started = performance.now(),
    child = spawn(executable, [requestPath, sourcePath, String(count)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  let stderr = '',
    failed: Error | undefined
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65536)
  })
  const closed = new Promise<void>((resolveClose, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) =>
      code === 0 ? resolveClose() : reject(new Error(`Native exit ${code}/${signal}: ${stderr}`)),
    )
  })
  const kill = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  const timer = setTimeout(kill, 10 * 60_000)
  const interrupted = () => {
    failed = new Error('Comparison interrupted.')
    kill()
  }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const results = await Promise.allSettled([
      pipeline(child.stdout, createWriteStream(path, { flags: 'wx' })),
      closed,
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    if (failed) throw failed
    return { elapsedMs: performance.now() - started, stderr }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
}
async function compare(
  actualPath: string,
  expectedPath: string,
  request: Buffer,
  width: number,
  height: number,
  count: number,
) {
  const actual = await open(actualPath, 'r'),
    expected = await open(expectedPath, 'r')
  let changedRgb = 0,
    changedAlpha = 0,
    maximumRgb = 0,
    maximumAlpha = 0,
    sum = 0,
    squared = 0,
    comparedRgb = 0,
    row = 0
  const worst: unknown[] = []
  async function exact(file: Awaited<ReturnType<typeof open>>, length: number) {
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const result = await file.read(bytes, offset, length - offset, null)
      if (!result.bytesRead) throw new Error('Truncated response.')
      offset += result.bytesRead
    }
    return bytes
  }
  try {
    for (const [file, workers] of [
      [actual, count],
      [expected, 0],
    ] as const) {
      const header = await exact(file, 416)
      if (
        header.subarray(0, 8).toString() !== 'LUMARGB1' ||
        header.readUInt32LE(8) !== 400 ||
        !header.subarray(12, 412).equals(request) ||
        header.readUInt32LE(412) !== workers
      )
        throw new Error('Response request identity or protocol header mismatch.')
    }
    while (row < height) {
      const a = await exact(actual, 24),
        b = await exact(expected, 24)
      if (
        !a.equals(b) ||
        a.subarray(0, 8).toString() !== 'LUMAROW1' ||
        a.readUInt32LE(8) !== row ||
        !a.readUInt32LE(12) ||
        a.readUInt32LE(12) > 64 ||
        a.readUInt32LE(20) !== 0 ||
        a.readUInt32LE(16) !== width * a.readUInt32LE(12) * 4 ||
        row + a.readUInt32LE(12) > height
      )
        throw new Error('Invalid or reordered output strip.')
      const length = a.readUInt32LE(16)
      for (const plane of ['after', 'before']) {
        const av = await exact(actual, length),
          bv = await exact(expected, length)
        for (let i = 0; i < length; i++) {
          const difference = av[i] - bv[i],
            absolute = Math.abs(difference)
          if (i % 4 === 3) {
            if (difference) changedAlpha++
            maximumAlpha = Math.max(maximumAlpha, absolute)
          } else {
            comparedRgb++
            sum += difference
            squared += difference ** 2
            if (difference) changedRgb++
            if (absolute > maximumRgb) {
              maximumRgb = absolute
              worst.length = 0
            }
            if (absolute && absolute === maximumRgb && worst.length < 8)
              worst.push({
                plane,
                x: Math.floor(i / 4) % width,
                y: row + Math.floor(i / 4 / width),
                channel: i % 4,
                actual: av[i],
                expected: bv[i],
              })
          }
        }
      }
      row += a.readUInt32LE(12)
    }
    const trailers: unknown[] = []
    for (const file of [actual, expected]) {
      const header = await exact(file, 12),
        length = header.readUInt32LE(8)
      if (header.subarray(0, 8).toString() !== 'LUMAEND1' || !length || length > 65536)
        throw new Error('Missing bounded completion trailer.')
      trailers.push(JSON.parse((await exact(file, length)).toString()))
      const tail = Buffer.alloc(1)
      if ((await file.read(tail, 0, 1, null)).bytesRead) throw new Error('Trailing response data.')
    }
    return {
      passed: !changedRgb && !changedAlpha,
      changedRgb,
      changedAlpha,
      maximumRgb,
      maximumAlpha,
      meanSignedRgb: sum / comparedRgb,
      rmsRgb: Math.sqrt(squared / comparedRgb),
      comparedRgb,
      worst,
      native: trailers[0],
      oracle: trailers[1],
    }
  } finally {
    await actual.close()
    await expected.close()
  }
}
const results: unknown[] = []
const protocolResults: unknown[] = []
let failed = 0
const summary = {
  schemaVersion: 1,
  implementation: 'float64-ctl-cpu-strip-v1',
  productionIntegration: false,
  renderingVersion: DISPLAY_RENDERING_VERSION,
  executable: { path: executable, sha256: await fileHash(executable) },
  fixture:
    fixtureArgument && fixtureArgument !== '-'
      ? resolve(fixtureArgument)
      : 'generated isolated numerical corpus',
  criterion: { maximumRgb: 0, maximumAlpha: 0, emergencyRecoveryToleranceApplies: false },
  sources: sources.map(({ path, width, height, sha256, name }) => ({
    path,
    width,
    height,
    sha256,
    name,
  })),
  limitations: [
    'No app integration, presentation, history, resource Settings or physical memory cap is established.',
    'Native wall time includes child launch, bounded source reads, pipe transport and saved output; JavaScript oracle timing excludes browser bitmap construction.',
    'The caller hashes source files before and after trials; the child validates exact lengths and stable metadata, not SHA-256.',
    'Synthetic sources are isolated numerical fixtures, never catalog photographs.',
  ],
  results,
  protocolResults,
}
try {
  const first = requestFor(cases[0], 1)
  const invalid: { name: string; bytes: Buffer; threads: number }[] = [
    { name: 'zero-source-identity', bytes: Buffer.from(first.request), threads: 1 },
    { name: 'wrong-input-length', bytes: Buffer.from(first.request), threads: 1 },
    { name: 'unknown-flags', bytes: Buffer.from(first.request), threads: 1 },
    { name: 'unsupported-thread-count', bytes: Buffer.from(first.request), threads: 2 },
  ]
  invalid[0].bytes.fill(0, 56, 88)
  invalid[1].bytes.writeBigUInt64LE(1n, 120)
  invalid[2].bytes.writeUInt32LE(32, 12)
  for (const value of invalid) {
    const path = join(output, `reject-${value.name}.request`)
    await writeFile(path, value.bytes, { flag: 'wx' })
    let rejected = false,
      diagnostic = ''
    try {
      await native(
        path,
        cases[0].source.path,
        value.threads,
        join(output, `reject-${value.name}.bin`),
      )
    } catch (error) {
      rejected = true
      diagnostic = String(error)
    }
    if (!rejected) failed++
    protocolResults.push({ name: value.name, passed: rejected, diagnostic })
  }
  let generation = 0
  for (const value of cases) {
    const { request, width, height, wb } = requestFor(value, ++generation),
      requestPath = join(output, `${value.name}.request`)
    await writeFile(requestPath, request, { flag: 'wx' })
    const oraclePath = join(output, `${value.name}.oracle.bin`),
      oracleTiming = await oracle(value, request, width, height, wb, oraclePath)
    for (const count of threads) {
      const path = join(output, `${value.name}.native-${count}.bin`)
      try {
        const timing = await native(requestPath, value.source.path, count, path)
        const proof = await compare(path, oraclePath, request, width, height, count)
        if (!proof.passed) failed++
        results.push({
          name: value.name,
          threads: count,
          width,
          height,
          sourceSha256: value.source.sha256,
          settings: value.parameters,
          ranges: value.ranges,
          headroom: value.headroom,
          draft: !!value.draft,
          requestSha256: hash(request),
          nativePath: path,
          oraclePath,
          timing,
          oracleTiming,
          ...proof,
        })
      } catch (error) {
        failed++
        results.push({
          name: value.name,
          threads: count,
          passed: false,
          error: String(error),
          nativePath: path,
          oraclePath,
        })
      }
      await writeFile(
        join(output, 'summary.json'),
        JSON.stringify(
          {
            ...summary,
            passed: results.length + protocolResults.length - failed,
            failed,
            complete: false,
          },
          null,
          2,
        ) + '\n',
      )
    }
  }
  for (const source of sources)
    if ((await fileHash(source.path)) !== source.sha256)
      throw new Error('Source hash changed during the experiment.')
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        ...summary,
        passed: results.length + protocolResults.length - failed,
        failed,
        complete: true,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(
    JSON.stringify({
      output,
      passed: results.length + protocolResults.length - failed,
      failed,
      complete: true,
    }),
  )
  if (failed) process.exitCode = 1
} catch (error) {
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(
      {
        ...summary,
        passed: results.length + protocolResults.length - failed,
        failed,
        complete: false,
        error: String(error),
      },
      null,
      2,
    ) + '\n',
  )
  throw error
}
