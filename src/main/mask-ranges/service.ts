import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { neutralAdjustments } from '../../shared/adjustments'
import { noLensSettings } from '../../shared/lens'
import type { CropAdmission } from '../../shared/crop-resources'
import type { EditState } from '../../shared/edits'
import { maskCanonicalPoint, type PhotoMaskContext } from '../../shared/mask-geometry'
import { sampleMaskRangePixels, MASK_RANGE_VERSION } from '../../shared/mask-ranges'
import {
  validateMaskRangeSampleRequest,
  type MaskRangeSampleRequest,
  type MaskRangeSampleResult,
} from '../../shared/mask-range-sampling'
import { maskCoverageNodes, mapMaskCoverage } from '../../shared/masks-gpu'
import {
  maskCapabilities,
  maskBaseReference,
  hasMaskAdjustments,
  type PreparedMaskCoverage,
  type ResolvedMask,
} from '../../shared/masks'
import type { ExportSource, FileIdentity } from '../export/types'
import { PreviewProcess } from '../preview-process'
import { MaskEdgeProcess } from '../mask-edges/process'
import { verifiedMaskBaseBytes } from '../mask-store'
import type { MaskRangeSource } from './types'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface Owner {
  source(id: string): Promise<ExportSource>
  context(id: string, revision: number): Promise<PhotoMaskContext>
  edits(id: string): Promise<EditState>
  admission(signal: AbortSignal): Promise<CropAdmission>
  reserve(bytes: number): Promise<() => void>
}
interface CachedBase {
  photoId: string
  path: string
  asset: Omit<PreparedMaskCoverage, 'pngBase64'>
  bytes: number
  release: () => void
}
interface SourceEntry {
  photoId: string
  key: string
  directory: string
  source: MaskRangeSource
  fileIdentity: FileIdentity
  release: () => void
}
interface Job {
  photoId: string
  abort: AbortController
  work: Promise<unknown>
}

/** One canonical source and one sequential GPU owner, shared by sampling and all range consumers. */
export class MaskRangeService {
  private decoder: Pick<PreviewProcess, 'renderFull' | 'close'>
  private runtime: Pick<MaskEdgeProcess, 'prepare' | 'close'>
  private tail: Promise<unknown> = Promise.resolve()
  private jobs = new Set<Job>()
  private source?: SourceEntry
  private cache = new Map<string, CachedBase>()
  private removing = new Set<string>()
  private closed = false
  constructor(
    private root: string,
    private owner: Owner,
    dependencies: {
      decoder?: Pick<PreviewProcess, 'renderFull' | 'close'>
      runtime?: Pick<MaskEdgeProcess, 'prepare' | 'close'>
    } = {},
  ) {
    this.decoder = dependencies.decoder ?? new PreviewProcess()
    this.runtime = dependencies.runtime ?? new MaskEdgeProcess()
  }
  private enqueue<T>(
    photoId: string,
    external: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed || this.removing.has(photoId))
      return Promise.reject(
        new Error('Range masks are unavailable while the photograph is closing or being removed.'),
      )
    const abort = new AbortController()
    const signal = external ? AbortSignal.any([external, abort.signal]) : abort.signal
    const work = this.tail.then(() => {
      signal.throwIfAborted()
      return run(signal)
    })
    const job: Job = { photoId, abort, work }
    this.jobs.add(job)
    this.tail = work.catch(() => undefined)
    return work.finally(() => this.jobs.delete(job))
  }
  sample(value: MaskRangeSampleRequest, external?: AbortSignal): Promise<MaskRangeSampleResult> {
    const request = validateMaskRangeSampleRequest(value)
    return this.enqueue(request.photoId, external, async (signal) => {
      const [context, source, state] = await Promise.all([
        this.owner.context(request.photoId, request.expectedRevision),
        this.owner.source(request.photoId),
        this.owner.edits(request.photoId),
      ])
      if (
        state.revision !== request.expectedRevision ||
        context.renderingIdentity !== request.renderingIdentity
      )
        throw new Error('The photograph changed. Refresh the range sampler.')
      const prepared = await this.prepareSource(source, signal)
      if (
        prepared.width !== context.geometry.canonicalWidth ||
        prepared.height !== context.geometry.canonicalHeight
      )
        throw new Error('The canonical range source differs from the presented geometry.')
      const canonicalPoint = maskCanonicalPoint(
        { x: request.point.x * context.width, y: request.point.y * context.height },
        context.geometry,
      )
      if (
        canonicalPoint.x < 0 ||
        canonicalPoint.x > 1 ||
        canonicalPoint.y < 0 ||
        canonicalPoint.y > 1
      )
        throw new Error('Choose a sample inside the photograph.')
      const cx = Math.min(prepared.width - 1, Math.floor(canonicalPoint.x * prepared.width))
      const cy = Math.min(prepared.height - 1, Math.floor(canonicalPoint.y * prepared.height))
      const left = Math.max(0, cx - 3),
        top = Math.max(0, cy - 3)
      const width = Math.min(prepared.width - 1, cx + 3) - left + 1,
        height = Math.min(prepared.height - 1, cy + 3) - top + 1
      const pixels = new Float32Array(width * height * 4)
      const file = await open(prepared.path, 'r')
      try {
        await this.validateCanonicalSource(prepared)
        for (let row = 0; row < height; row++) {
          signal.throwIfAborted()
          const target = Buffer.from(pixels.buffer, row * width * 16, width * 16)
          const result = await file.read(
            target,
            0,
            target.byteLength,
            ((top + row) * prepared.width + left) * 16,
          )
          if (result.bytesRead !== target.byteLength)
            throw new Error('The canonical range sample is incomplete.')
        }
      } finally {
        await file.close()
      }
      await this.validateCanonicalSource(prepared)
      const sampled = sampleMaskRangePixels(pixels, prepared.primaries)
      const [after, afterContext, afterSource] = await Promise.all([
        this.owner.edits(request.photoId),
        this.owner.context(request.photoId, request.expectedRevision),
        this.owner.source(request.photoId),
      ])
      signal.throwIfAborted()
      if (
        after.revision !== request.expectedRevision ||
        afterContext.renderingIdentity !== request.renderingIdentity ||
        this.sourceKey(afterSource) !== this.sourceKey(source)
      )
        throw new Error('The photograph changed while sampling the range.')
      return {
        photoId: request.photoId,
        revision: request.expectedRevision,
        sourceIdentity: prepared.identity,
        canonicalPoint,
        ...sampled,
        ...(sampled.color
          ? {}
          : { reason: 'This source area has no defined color. Use Luminance range for black.' }),
      }
    })
  }
  prepareMasks(
    source: ExportSource,
    masks: readonly ResolvedMask[],
    external?: AbortSignal,
    force = false,
  ): Promise<ResolvedMask[]> {
    const selected = masks.filter((mask) => force || (mask.enabled && hasMaskAdjustments(mask)))
    const ranges = [
      ...new Map(
        selected
          .flatMap((mask) => maskCoverageNodes(mask))
          .filter((node) => node.range)
          .map((node) => [node.id, node]),
      ).values(),
    ]
    if (!ranges.length) return Promise.resolve([...masks])
    return this.enqueue(source.photo.id, external, async (signal) => {
      const prepared = await this.prepareSource(source, signal)
      const unique = new Set(ranges.map((node) => digest(node.range)))
      this.checkMemory(
        prepared.width,
        prepared.height,
        unique.size,
        await this.owner.admission(signal),
      )
      const assets = new Map<string, PreparedMaskCoverage>()
      let encoded = 0
      for (const node of ranges) {
        signal.throwIfAborted()
        const key = digest([MASK_RANGE_VERSION, prepared.identity, node.range])
        let entry = this.cache.get(key)
        if (!entry) {
          await this.prune(maskCapabilities.maxBaseEncodedBytes)
          let release = await this.owner.reserve(maskCapabilities.maxBaseEncodedBytes)
          const directory = join(this.root, 'cache', 'mask-ranges', 'coverage', randomUUID()),
            path = join(directory, 'coverage.png')
          try {
            await mkdir(directory, { recursive: true })
            const result = await this.runtime.prepare(
              node,
              prepared.width,
              prepared.height,
              key,
              path,
              signal,
              { source: prepared, parameters: node.range! },
            )
            if (
              result.key !== key ||
              result.width !== prepared.width ||
              result.height !== prepared.height ||
              result.encodedBytes > maskCapabilities.maxBaseEncodedBytes
            )
              throw new Error('Prepared range coverage identity or dimensions changed.')
            const bytes = await readFile(path)
            const asset = {
              version: 1 as const,
              key,
              width: prepared.width,
              height: prepared.height,
              hash: result.hash,
            }
            verifiedMaskBaseBytes({
              ...maskBaseReference(asset),
              pngBase64: bytes.toString('base64'),
            })
            if (bytes.byteLength !== result.encodedBytes)
              throw new Error('Prepared range coverage bytes changed.')
            release()
            release = () => undefined
            release = await this.owner.reserve(bytes.byteLength)
            entry = { photoId: source.photo.id, path, asset, bytes: bytes.byteLength, release }
            this.cache.set(key, entry)
          } catch (error) {
            await rm(directory, { recursive: true, force: true })
            release()
            throw error
          }
        }
        this.cache.delete(key)
        this.cache.set(key, entry)
        let data: Buffer, asset: PreparedMaskCoverage
        try {
          data = await readFile(entry.path)
          asset = { ...entry.asset, pngBase64: data.toString('base64') }
          verifiedMaskBaseBytes({ ...maskBaseReference(asset), pngBase64: asset.pngBase64 })
        } catch (error) {
          this.cache.delete(key)
          await rm(join(entry.path, '..'), { recursive: true, force: true })
          entry.release()
          throw error
        }
        encoded += data.byteLength
        if (encoded > maskCapabilities.maxLiveBaseEncodedBytes)
          throw new Error('Prepared ranges exceed the 32 MiB live coverage transfer limit.')
        assets.set(node.id, asset)
      }
      await this.validateSource(source)
      await this.validateCanonicalSource(prepared)
      signal.throwIfAborted()
      return masks.map((mask) =>
        mapMaskCoverage(mask, (node) => {
          const next = { ...node }
          delete next.preparedRangeBase
          return assets.has(node.id) ? { ...next, preparedRangeBase: assets.get(node.id)! } : next
        }),
      )
    })
  }
  private sourceKey(source: ExportSource) {
    return digest([
      MASK_RANGE_VERSION,
      source.photo.id,
      source.identity,
      source.processing.metadata,
      source.processing.metadata.hdrJpeg?.state === 'supported'
        ? 'hdr-v1'
        : source.processing.processing,
    ])
  }
  private async validateSource(source: ExportSource) {
    const info = await lstat(source.path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
        (key) =>
          info[key as keyof typeof info] !== source.identity[key as keyof typeof source.identity],
      )
    )
      throw new Error('The original photograph changed while preparing range coverage.')
  }
  private async validateCanonicalSource(source: MaskRangeSource) {
    const entry = this.source
    if (!entry || entry.source !== source)
      throw new Error('The canonical range source lease changed.')
    try {
      const info = await lstat(source.path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
          (key) => info[key as keyof typeof info] !== entry.fileIdentity[key as keyof FileIdentity],
        )
      )
        throw new Error('The cached canonical range source changed. Retry GPU to rebuild it.')
    } catch (error) {
      this.source = undefined
      await this.runtime.close()
      await rm(entry.directory, { recursive: true, force: true })
      entry.release()
      throw error
    }
  }
  private checkMemory(width: number, height: number, count: number, admission: CropAdmission) {
    const pixels = width * height
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 32768 ||
      height > 32768 ||
      pixels > maskCapabilities.maxBasePixels
    )
      throw new Error('Range masks support canonical sources up to 32 megapixels.')
    if (pixels * count > maskCapabilities.maxBaseAtlasBytes)
      throw new Error('Range masks exceed the 256 MiB native coverage atlas limit.')
    // Decode/linear-source owners, one encoded R8 plane and bounded source/readback strips.
    const ram =
      admission.reservation.ramBytes +
      pixels * (36 + count) +
      maskCapabilities.maxLiveBaseEncodedBytes * 4
    const vram =
      admission.reservation.vramBytes +
      pixels * 16 +
      width * Math.min(64, height) * 24 +
      pixels * count
    if (ram > admission.policy.ram.effectiveBytes || vram > admission.policy.vram.effectiveBytes)
      throw new Error(
        'Range preparation exceeds the current image-memory budget. Close other processing or increase the resource budget, then retry GPU.',
      )
  }
  private async prepareSource(source: ExportSource, signal: AbortSignal): Promise<MaskRangeSource> {
    const key = this.sourceKey(source)
    await this.validateSource(source)
    if (this.source?.key === key) {
      await this.validateCanonicalSource(this.source.source)
      return this.source.source
    }
    await this.runtime.close()
    if (this.source) {
      await rm(this.source.directory, { recursive: true, force: true })
      this.source.release()
      this.source = undefined
    }
    const directory = join(this.root, 'cache', 'mask-ranges', 'source', randomUUID())
    this.checkMemory(
      Math.max(source.photo.width, source.photo.height),
      Math.min(source.photo.width, source.photo.height),
      1,
      await this.owner.admission(signal),
    )
    // The temporary raster rendition and its bounded thumbnail share this lease
    // until only the canonical Float32 source remains in the owned directory.
    let release = await this.owner.reserve(
      source.photo.width * source.photo.height * 20 + 64 * 1024,
    )
    let decoderClosed = false
    try {
      await mkdir(directory, { recursive: true })
      const raw =
        source.processing.processing === 'hdr-v1' ||
        Boolean(source.processing.metadata.hdrJpeg?.state === 'supported')
      const options = {
        ...source.processing,
        processing: raw ? ('hdr-v1' as const) : source.processing.processing,
        settings: { ...noLensSettings },
        adjustments: structuredClone(neutralAdjustments),
        workingAsset: undefined,
        crop: undefined,
        noiseReduction: undefined,
        detailSharpening: undefined,
        firstSurface: undefined,
        prepareLinear: true,
        workingOnly: raw,
      }
      const frame = await this.decoder.renderFull(source.path, directory, signal, options)
      signal.throwIfAborted()
      if (!frame.linear) throw new Error('The canonical linear range source is unavailable.')
      const path = join(directory, 'linear.f32')
      const width = frame.linear.hdr?.width ?? frame.width,
        height = frame.linear.hdr?.height ?? frame.height
      this.checkMemory(width, height, 1, await this.owner.admission(signal))
      const info = await lstat(path)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== width * height * 16 ||
        frame.linear.byteLength !== info.size
      )
        throw new Error('The canonical range source is incomplete.')
      const file = await open(path, 'r')
      const hash = createHash('sha256')
      try {
        for await (const chunk of file.createReadStream({ autoClose: false, signal }))
          hash.update(chunk)
      } finally {
        await file.close()
      }
      if (hash.digest('hex') !== frame.linear.sha256)
        throw new Error('The canonical range source hash changed.')
      await this.validateSource(source)
      await this.decoder.close(true)
      decoderClosed = true
      for (const entry of await readdir(directory))
        if (entry !== 'linear.f32')
          await rm(join(directory, entry), { recursive: true, force: true })
      release()
      release = () => undefined
      release = await this.owner.reserve(info.size)
      const canonical: MaskRangeSource = {
        path,
        width,
        height,
        byteLength: info.size,
        sha256: frame.linear.sha256,
        identity: digest([key, width, height, frame.linear.sha256]),
        primaries: frame.linear.hdr ? 'rec2020' : 'srgb',
      }
      const fileIdentity: FileIdentity = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      }
      this.source = {
        photoId: source.photo.id,
        key,
        directory,
        source: canonical,
        fileIdentity,
        release,
      }
      release = () => undefined
      await this.validateCanonicalSource(canonical)
      return canonical
    } catch (error) {
      if (!decoderClosed) {
        await this.decoder.close(true)
        decoderClosed = true
      }
      await rm(directory, { recursive: true, force: true })
      release()
      throw error
    } finally {
      if (!decoderClosed) await this.decoder.close(true)
    }
  }
  private async prune(incoming = 0) {
    let bytes = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    for (const [key, entry] of this.cache) {
      if (bytes + incoming <= 64 * 1024 ** 2) break
      this.cache.delete(key)
      await rm(join(entry.path, '..'), { recursive: true, force: true })
      entry.release()
      bytes -= entry.bytes
    }
  }
  async beginRemoval(photoId: string) {
    this.removing.add(photoId)
    const jobs = [...this.jobs].filter((job) => job.photoId === photoId)
    for (const job of jobs) job.abort.abort()
    await Promise.allSettled(jobs.map((job) => job.work))
    if (this.source?.photoId === photoId) {
      await rm(this.source.directory, { recursive: true, force: true })
      this.source.release()
      this.source = undefined
    }
    for (const [key, entry] of this.cache)
      if (entry.photoId === photoId) {
        this.cache.delete(key)
        await rm(join(entry.path, '..'), { recursive: true, force: true })
        entry.release()
      }
  }
  endRemoval(photoId: string) {
    this.removing.delete(photoId)
  }
  async close() {
    this.closed = true
    for (const job of this.jobs) job.abort.abort()
    await this.tail
    await this.runtime.close()
    await this.decoder.close(true)
    if (this.source) {
      await rm(this.source.directory, { recursive: true, force: true })
      this.source.release()
      this.source = undefined
    }
    for (const entry of this.cache.values()) {
      await rm(join(entry.path, '..'), { recursive: true, force: true })
      entry.release()
    }
    this.cache.clear()
  }
}
