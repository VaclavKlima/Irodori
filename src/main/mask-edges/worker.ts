import { createHash } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import { endianness } from 'node:os'
import sharp from 'sharp'
import { maskCapabilities } from '../../shared/masks'
import { RawGpuRenderer } from '../gpu/raw-renderer'
import { prepareMaskEdgeCoverage } from './gpu'
import type { MaskEdgeResult, MaskEdgeWorkerReply, MaskEdgeWorkerRequest } from './types'

let owner: RawGpuRenderer | undefined
let busy = false
async function prepare(request: MaskEdgeWorkerRequest): Promise<MaskEdgeResult> {
  if (process.versions.electron || endianness() !== 'LE')
    throw new Error('Mask edges require the isolated little-endian Node GPU worker.')
  if (typeof request.key !== 'string' || !request.key || request.key.length > 1024)
    throw new Error('Mask edges require a frozen coverage identity.')
  owner ??= new RawGpuRenderer()
  const { device } = await owner.mergeDevice()
  const coverage = await prepareMaskEdgeCoverage(
    device,
    request.mask,
    request.width,
    request.height,
    new AbortController().signal,
  )
  if (owner.failure) throw new Error(owner.failure)
  const temporary = `${request.outputPath}.tmp`
  try {
    await sharp(coverage, { raw: { width: request.width, height: request.height, channels: 1 } })
      .toColourspace('b-w')
      .png()
      .toFile(temporary)
    const encoded = await readFile(temporary)
    if (encoded.byteLength > maskCapabilities.maxBaseEncodedBytes)
      throw new Error(
        'Prepared mask coverage exceeds the 8 MiB encoded limit. Simplify the mask or reduce its edge settings.',
      )
    await rename(temporary, request.outputPath)
    return {
      key: request.key,
      path: request.outputPath,
      hash: createHash('sha256').update(encoded).digest('hex'),
      width: request.width,
      height: request.height,
      encodedBytes: encoded.byteLength,
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

process.on('message', (request: MaskEdgeWorkerRequest) => {
  void (async () => {
    if (busy) throw new Error('The mask edge worker is busy.')
    busy = true
    try {
      process.send?.({
        id: request.id,
        result: await prepare(request),
      } satisfies MaskEdgeWorkerReply)
    } finally {
      busy = false
    }
  })().catch((error: unknown) => {
    process.send?.({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies MaskEdgeWorkerReply)
    owner?.close()
    owner = undefined
    process.exit(1)
  })
})
process.on('disconnect', () => {
  owner?.close()
  process.exit(0)
})
