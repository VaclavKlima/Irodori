import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import {
  createPatchwiseResearchGpu,
  PATCHWISE_RESEARCH_GPU_BYTES,
  PATCHWISE_RESEARCH_WORKING_BYTES,
  type ResearchNoiseSnapshot,
} from '../scripts/research/strong-noise/gpu'

const children = new Set<ChildProcess>()
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function runNode(args: string[], input: string, info: TestInfo, name: string) {
  const logs = info.outputPath(name)
  await mkdir(logs, { recursive: true })
  return new Promise<{ error: Error | null; stdout: string }>((accept, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { timeout: 60_000, maxBuffer: 2 * 1024 ** 2 },
      (error, stdout, stderr) => {
        children.delete(child)
        void Promise.all([
          writeFile(join(logs, 'stdout.txt'), stdout),
          writeFile(join(logs, 'stderr.txt'), stderr),
        ]).then(() => accept({ error, stdout }), reject)
      },
    )
    children.add(child)
    child.stdin!.end(input)
  })
}
test.afterEach(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((accept) => {
          if (child.exitCode !== null || child.signalCode !== null) return accept()
          child.once('close', () => accept())
          child.kill('SIGTERM')
        }),
    ),
  )
  children.clear()
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('isolated research child verifies complete source hashes, freezes whole-source noise and retains sequential output/cleanup', async ({}, info) => {
  const width = 17,
    height = 13,
    data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          (((x * 17 + y * 31) % 43) - 21) / 8,
          (((x * 7 + y * 13) % 37) - 18) / 16,
          (((x * 23 + y * 5) % 41) - 20) / 32,
          [0, 0.25, 0.5, 1][(x + 3 * y) % 4],
        ],
        (y * width + x) * 4,
      )
  await mkdir(info.outputDir, { recursive: true })
  const inputPath = info.outputPath('source.f32'),
    outputPath = info.outputPath('filtered.f32'),
    neutralPath = info.outputPath('neutral.f32'),
    bytes = Buffer.alloc(data.byteLength)
  for (let i = 0; i < data.length; i++) bytes.writeFloatLE(data[i], i * 4)
  await writeFile(inputPath, bytes)
  const built = await runNode(
    [resolve('scripts/research/strong-noise/build-gpu-child.mjs'), info.outputPath('bundle')],
    '',
    info,
    'build',
  )
  expect(built.error).toBeNull()
  const { bundle, metafile } = JSON.parse(built.stdout) as { bundle: string; metafile: string },
    inputs = JSON.parse(await readFile(metafile, 'utf8')).inputs as Record<string, unknown>
  expect(Object.keys(inputs)).toContain('scripts/research/strong-noise/gpu.ts')
  expect(Object.keys(inputs)).toContain('src/shared/detail-noise-estimate.ts')
  expect(Object.keys(inputs).some((path) => path.includes('node_modules/webgpu'))).toBe(false)
  const request = {
      id: 0,
      inputPath,
      outputPath,
      width,
      height,
      sourceSha256: sha(bytes),
      primaries: 'rec2020',
      luminance: 75,
      chroma: 100,
      chromaSigmaFactor: 0.55,
    },
    result = await runNode(
      [bundle, info.outputDir],
      JSON.stringify(request) +
        '\n' +
        JSON.stringify({ ...request, id: 1, outputPath: neutralPath, luminance: 0, chroma: 0 }) +
        '\n',
      info,
      'child',
    )
  expect(result.error, result.stdout).toBeNull()
  const responses = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as {
    id: number
    sourceSha256: string
    outputSha256: string
    estimate: ResearchNoiseSnapshot
    gpuBytes: number
    estimatorMs: number
    gpuReadbackMs: number
  }[]
  expect(responses.map((row) => row.id)).toEqual([0, 1])
  const actual = await readFile(outputPath),
    neutral = await readFile(neutralPath)
  expect(neutral).toEqual(bytes)
  expect(responses[0].sourceSha256).toBe(sha(bytes))
  expect(responses[0].outputSha256).toBe(sha(actual))
  expect(responses[1].outputSha256).toBe(sha(neutral))
  expect(responses[0].gpuBytes).toBe(PATCHWISE_RESEARCH_GPU_BYTES)
  expect(responses[0].estimate.source).toMatchObject({
    width,
    height,
    sha256: sha(bytes),
    identity: sha(bytes),
    primaries: 'rec2020',
  })
  expect(responses[0].estimate.variance.every((v) => Number.isFinite(v) && v >= 0)).toBe(true)
  const gpu = createPatchwiseResearchGpu()
  try {
    const expected = await gpu.render(
      {
        image: { width, height },
        tile: { left: 0, top: 0, width, height },
        source: { left: 0, top: 0, width, height, data },
        estimate: responses[0].estimate,
        luminance: 75,
        chroma: 100,
        chromaSigmaFactor: 0.55,
        admission: {
          maxGpuBytes: PATCHWISE_RESEARCH_GPU_BYTES,
          maxWorkingBytes: PATCHWISE_RESEARCH_WORKING_BYTES,
        },
      },
      new AbortController().signal,
    )
    for (let i = 0; i < expected.length; i++) expect(actual.readFloatLE(i * 4)).toBe(expected[i])
  } finally {
    await gpu.close()
  }
  const invalid = await runNode(
    [bundle, info.outputDir],
    JSON.stringify({
      ...request,
      outputPath: info.outputPath('invalid.f32'),
      sourceSha256: '0'.repeat(64),
    }) + '\n',
    info,
    'wrong-hash',
  )
  expect(invalid.error).not.toBeNull()
  expect(JSON.parse(invalid.stdout).error).toContain('hash differs')
  const escaped = await runNode(
    [bundle, info.outputDir],
    JSON.stringify({
      ...request,
      inputPath: resolve('package.json'),
      outputPath: info.outputPath('escaped.f32'),
    }) + '\n',
    info,
    'escaped-input',
  )
  expect(escaped.error).not.toBeNull()
  expect(JSON.parse(escaped.stdout).error).toContain('escaped')
  await writeFile(
    info.outputPath('summary.json'),
    JSON.stringify(
      {
        sequentialReplies: responses.length,
        wholeSourceHashVerified: true,
        retainedNeutralBytesExact: true,
        parentAndChildGpuExact: true,
        wrongHashRefused: true,
        escapedInputRefused: true,
        gpuBytes: responses[0].gpuBytes,
      },
      null,
      2,
    ),
  )
})
