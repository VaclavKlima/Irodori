import { createHash } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import {
  detailNoiseEstimateMemory,
  estimateDetailNoise,
} from '../../../src/shared/detail-noise-estimate'
import type { ColorPrimaries } from '../../../src/shared/color-model'
import {
  createPatchwiseResearchGpu,
  PATCHWISE_RESEARCH_EDGE,
  PATCHWISE_RESEARCH_GPU_BYTES,
  PATCHWISE_RESEARCH_WORKING_BYTES,
  type PatchwiseResearchGpu,
  type ResearchChromaSpatialPolicy,
} from './gpu'

/** Internal research protocol, never exposed through Electron or the application bridge. */
interface Request {
  id: string | number
  inputPath: string
  outputPath: string
  width: number
  height: number
  sourceSha256: string
  primaries: ColorPrimaries
  luminance: number
  chroma: number
  chromaSigmaFactor: 0.4 | 0.55
  chromaSpatialPolicy?: ResearchChromaSpatialPolicy
}
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.versions.electron)
    throw new Error('Supply the isolated research output directory to the Node child.')
  const root = await realpath(resolve(process.argv[2])),
    lines = createInterface({ input: process.stdin, crlfDelay: Infinity }),
    controller = new AbortController()
  let gpu: PatchwiseResearchGpu | undefined
  const inside = (path: string) => {
    const distance = relative(root, path)
    if (!distance || distance.startsWith('..') || isAbsolute(distance))
      throw new Error('Research input/output escaped its isolated run directory.')
    return path
  }
  const stop = () => {
    controller.abort(new Error('Research child interrupted.'))
    process.exitCode = 1
    lines.close()
    process.stdin.destroy()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    for await (const line of lines) {
      let id: unknown
      try {
        controller.signal.throwIfAborted()
        if (line.length > 65_536) throw new Error('Research request exceeds its line limit.')
        const parsed: unknown = JSON.parse(line)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Invalid research request object.')
        id = (parsed as { id?: unknown }).id
        const allowed = [
          'id',
          'inputPath',
          'outputPath',
          'width',
          'height',
          'sourceSha256',
          'primaries',
          'luminance',
          'chroma',
          'chromaSigmaFactor',
          'chromaSpatialPolicy',
        ]
        if (
          Object.keys(parsed).some((key) => !allowed.includes(key)) ||
          allowed.slice(0, -1).some((key) => !Object.hasOwn(parsed, key))
        )
          throw new Error('Research request has unknown or missing fields.')
        const request = parsed as Request
        id = request.id
        if (
          !['string', 'number'].includes(typeof id) ||
          (typeof id === 'number' && !Number.isFinite(id)) ||
          ![request.width, request.height].every(
            (v) => Number.isSafeInteger(v) && v >= 1 && v <= PATCHWISE_RESEARCH_EDGE,
          ) ||
          !/^[a-f0-9]{64}$/.test(request.sourceSha256) ||
          typeof request.inputPath !== 'string' ||
          typeof request.outputPath !== 'string' ||
          !['srgb', 'rec2020'].includes(request.primaries) ||
          ![request.luminance, request.chroma].every(
            (v) => Number.isInteger(v) && v >= 0 && v <= 100,
          ) ||
          ![0.4, 0.55].includes(request.chromaSigmaFactor) ||
          (request.chromaSpatialPolicy !== undefined &&
            !['gaussian-search-v1', 'uniform-search-v1'].includes(request.chromaSpatialPolicy))
        )
          throw new Error('Invalid research frame descriptor.')
        const chromaSpatialPolicy = request.chromaSpatialPolicy ?? 'gaussian-search-v1'
        if (gpu && gpu.chromaSpatialPolicy !== chromaSpatialPolicy)
          throw new Error('Research child cannot switch its frozen chroma spatial policy.')
        gpu ??= createPatchwiseResearchGpu(undefined, { chromaSpatialPolicy })
        const started = performance.now(),
          inputPath = inside(await realpath(resolve(request.inputPath))),
          outputPath = inside(resolve(request.outputPath))
        inside(resolve(await realpath(dirname(outputPath)), 'output-check'))
        const bytes = request.width * request.height * 16
        if ((await stat(inputPath)).size !== bytes)
          throw new Error('Research source byte count differs.')
        const encoded = await readFile(inputPath)
        if (encoded.length !== bytes || digest(encoded) !== request.sourceSha256)
          throw new Error('Research source hash differs.')
        const data = new Float32Array(bytes / 4)
        for (let i = 0; i < data.length; i++) data[i] = encoded.readFloatLE(i * 4)
        const image = { width: request.width, height: request.height },
          rectangle = { ...image, left: 0, top: 0 },
          estimatorStarted = performance.now(),
          estimate = await estimateDetailNoise(
            {
              ...image,
              identity: request.sourceSha256,
              sha256: request.sourceSha256,
              primaries: request.primaries,
              async readRow(row, destination, signal) {
                signal.throwIfAborted()
                destination.set(data.subarray(row * image.width * 4, (row + 1) * image.width * 4))
              },
            },
            { maxWorkingBytes: detailNoiseEstimateMemory(image).workingBytes },
            controller.signal,
          ),
          estimatorMs = performance.now() - estimatorStarted,
          gpuStarted = performance.now(),
          result = await gpu.render(
            {
              image,
              tile: rectangle,
              source: { ...rectangle, data },
              estimate,
              luminance: request.luminance,
              chroma: request.chroma,
              chromaSigmaFactor: request.chromaSigmaFactor,
              admission: {
                maxGpuBytes: PATCHWISE_RESEARCH_GPU_BYTES,
                maxWorkingBytes: PATCHWISE_RESEARCH_WORKING_BYTES,
              },
            },
            controller.signal,
          ),
          gpuReadbackMs = performance.now() - gpuStarted,
          output = Buffer.allocUnsafe(bytes)
        for (let i = 0; i < result.length; i++) output.writeFloatLE(result[i], i * 4)
        controller.signal.throwIfAborted()
        await writeFile(outputPath, output, { flag: 'wx' })
        process.stdout.write(
          JSON.stringify({
            id,
            sourceSha256: request.sourceSha256,
            outputSha256: digest(output),
            estimate,
            adapter: gpu.adapter,
            gpuBytes: gpu.allocatedBytes,
            elapsedMs: performance.now() - started,
            estimatorMs,
            gpuReadbackMs,
            nodeVersion: process.version,
            chromaSpatialPolicy: gpu.chromaSpatialPolicy,
          }) + '\n',
        )
      } catch (error) {
        process.stdout.write(
          JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }) +
            '\n',
        )
        process.exitCode = 1
        break
      }
    }
  } finally {
    lines.close()
    process.stdin.destroy()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await gpu?.close()
  }
}
void main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.stack : String(error)) + '\n')
  process.exitCode = 1
})
