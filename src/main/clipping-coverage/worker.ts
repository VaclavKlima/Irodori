import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { endianness } from 'node:os'
import { clippingCoverageMemory } from '../../shared/clipping-coverage'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { prepareNativeMaskEdges } from '../mask-edges/native'
import { sampleClippingCoverage } from './gpu'
import type {
  ClippingCoverageResult,
  ClippingCoverageWorkerReply,
  ClippingCoverageWorkerRequest,
} from './types'

let owner: RawGpuRenderer | undefined
let busy = false

async function prepare(request: ClippingCoverageWorkerRequest): Promise<ClippingCoverageResult> {
  if (process.versions.electron || endianness() !== 'LE')
    throw new Error('Clipping coverage requires the isolated little-endian Node GPU worker.')
  if (typeof request.key !== 'string' || !request.key || request.key.length > 1024)
    throw new Error('Clipping coverage requires a frozen source and edit identity.')
  const memory = clippingCoverageMemory(request.width, request.height, request.parameters)
  if (!memory.maskCount) throw new Error('Clipping coverage requires active local adjustments.')
  owner ??= new RawGpuRenderer()
  const { device } = await owner.mergeDevice()
  const signal = new AbortController().signal
  const prepared = await prepareNativeMaskEdges(
    device,
    request.parameters,
    request.parameters.maskGeometry?.canonicalWidth ?? request.width,
    request.parameters.maskGeometry?.canonicalHeight ?? request.height,
    memory.vramBytes,
    { signal },
  )
  const temporary = `${request.outputPath}.tmp`
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporary, 'wx', 0o600)
    const digest = createHash('sha256')
    const stripSha256: string[] = []
    let byteLength = 0
    const maskCount = await sampleClippingCoverage(
      device,
      prepared.adjustments,
      request.width,
      request.height,
      signal,
      async (bytes) => {
        digest.update(bytes)
        stripSha256.push(createHash('sha256').update(bytes).digest('hex'))
        let written = 0
        while (written < bytes.byteLength) {
          const result = await file!.write(
            bytes,
            written,
            bytes.byteLength - written,
            byteLength + written,
          )
          if (!result.bytesWritten)
            throw new Error('Clipping coverage file stopped accepting bytes.')
          written += result.bytesWritten
        }
        byteLength += bytes.byteLength
      },
    )
    if (owner.failure) throw new Error(owner.failure)
    if (maskCount !== memory.maskCount || byteLength !== memory.byteLength)
      throw new Error('Clipping coverage returned an incomplete source grid.')
    await file.close()
    file = undefined
    await rename(temporary, request.outputPath)
    return {
      path: request.outputPath,
      sha256: digest.digest('hex'),
      stripSha256,
      byteLength,
      maskCount,
      width: request.width,
      height: request.height,
      key: request.key,
    }
  } finally {
    await file?.close()
    await rm(temporary, { force: true })
  }
}

process.on('message', (request: ClippingCoverageWorkerRequest) => {
  void (async () => {
    if (busy) throw new Error('The clipping coverage worker is busy.')
    busy = true
    try {
      process.send?.({
        id: request.id,
        result: await prepare(request),
      } satisfies ClippingCoverageWorkerReply)
    } finally {
      busy = false
    }
  })().catch((error: unknown) => {
    process.send?.({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ClippingCoverageWorkerReply)
    owner?.close()
    owner = undefined
    process.exit(1)
  })
})
process.on('disconnect', () => {
  owner?.close()
  process.exit(0)
})
