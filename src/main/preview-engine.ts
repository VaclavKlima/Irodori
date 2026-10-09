import { imageStatistics } from '../shared/statistics'
import { captureMetadata, type CaptureMetadata } from '../shared/capture-sequence'
import { extname } from 'node:path'
import { renderHdr } from './processing/hdr-processing'
import { resolveWhiteBalance } from './processing/white-balance'
import {
  renderAdjustments,
  neutralAdjustments,
  srgbTransform,
  ADJUSTMENT_VERSION,
  type WorkingFrame,
} from '../shared/adjustments'
import { createHash } from 'node:crypto'
import { frameByteLength } from '../shared/preview-frame'
import { RawGpuRenderer } from './gpu/raw-renderer'
import { rawDecoder } from './processing/decoders'
import { processingMetadata } from './processing/metadata'
import { LENS_RENDER_VERSION } from './processing/lens-correction'
import type { ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import { appliedCorrections, automaticLensSettings } from '../shared/lens'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ExifTool, type Tags } from 'exiftool-vendored'
import type { PhotoMetadata } from '../shared/contracts'
import type { FullPreviewResult, PreviewResult, PreviewStage } from './preview-types'

type ExtractEmbedded = (tool: ExifTool, path: string, output: string) => Promise<void>
const extractEmbedded: ExtractEmbedded = async (tool, path, output) => {
  for (const extract of [tool.extractJpgFromRaw.bind(tool), tool.extractPreview.bind(tool)]) {
    try {
      await extract(path, output)
      // Metadata alone can succeed for a truncated JPEG. Decode to validate it.
      await sharp(output).resize(1, 1).toBuffer()
      return
    } catch {
      await rm(output, { force: true })
    }
  }
  throw new Error('No usable embedded preview')
}

export class PreviewEngine {
  private tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })

  private working?: { key: string; frame: WorkingFrame }

  async inspectCapture(path: string): Promise<CaptureMetadata> {
    if (this.tool.ended) this.tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })
    try {
      const tags = await this.tool.readRaw(path, { readArgs: ['-G1', '-n'] })
      return captureMetadata(tags as Record<string, unknown>, extname(path).slice(1))
    } finally {
      await this.tool.end()
    }
  }

  async inspect(path: string): Promise<ProcessingMetadata> {
    if (this.tool.ended) this.tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })
    try {
      const metadata = processingMetadata(
        { ...(await this.tool.read(path, ['-G1', '-n']).catch(() => ({}))) },
        rawDecoder(path) ? undefined : [],
      )
      const decoder = rawDecoder(path)
      if (decoder) {
        const session = await decoder.open(path)
        try {
          metadata.whiteBalance = resolveWhiteBalance(session.metadata)
          metadata.hdrEligible = session.metadata.hdrEligible
        } finally {
          session.close()
        }
      }
      return metadata
    } finally {
      await this.tool.end()
    }
  }

  constructor(
    private extract: ExtractEmbedded = extractEmbedded,
    private backend = process.env.LUMA_PREVIEW_BACKEND ?? 'auto',
    private gpu: Pick<RawGpuRenderer, 'render' | 'close' | 'releaseFrame'> &
      Partial<Pick<RawGpuRenderer, 'mergeDevice'>> = new RawGpuRenderer(),
  ) {
    sharp.concurrency(1)
    sharp.cache({ memory: 32, files: 0, items: 20 })
  }

  async process(path: string, output: string): Promise<PreviewResult> {
    if (this.tool.ended) this.tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })
    const tags: Tags = await this.tool.read(path).catch(() => ({}))
    const rawTags = await this.tool.readRaw(path, { readArgs: ['-G1', '-n'] }).catch(() => ({}))
    const capture = captureMetadata(rawTags as Record<string, unknown>, extname(path).slice(1))
    const processing = processingMetadata({ ...rawTags }, rawDecoder(path) ? undefined : [])
    if (rawDecoder(path)) {
      const session = await rawDecoder(path)!.open(path)
      try {
        processing.whiteBalance = resolveWhiteBalance(session.metadata)
        processing.hdrEligible = session.metadata.hdrEligible
      } finally {
        session.close()
      }
    }
    let input = sharp(path)
    let source: PreviewResult['source'] = 'image'
    let rawDimensions: { width: number; height: number } | undefined
    const embedded = join(output, 'embedded.jpg')
    try {
      if (rawDecoder(path)) {
        try {
          await this.extract(this.tool, path, embedded)
          input = sharp(embedded)
          const details = await input.metadata()
          // An extracted JPEG may omit the source's orientation metadata.
          if (!details.orientation && typeof tags.Orientation === 'number') {
            input = sharp(await input.withMetadata({ orientation: tags.Orientation }).toBuffer())
          }
          source = 'embedded'
        } catch {
          // Finish ExifTool before synchronous RAW work, so forced decoder
          // cancellation cannot leave its subprocess behind.
          await this.tool.end()
          const session = await rawDecoder(path)!.open(path)
          try {
            const { width, height, flip } = session.dimensions
            rawDimensions = flip & 4 ? { width: height, height: width } : { width, height }
            const decoded = session.display(true)
            input = sharp(decoded.data, {
              raw: { width: decoded.width, height: decoded.height, channels: 3 },
            })
            source = 'decoded'
          } finally {
            session.close()
          }
        }
      }
      await this.tool.end()
      const details = await input.metadata()
      const rotated = details.orientation !== undefined && details.orientation >= 5
      const width = rawDimensions?.width ?? Number(tags.ImageWidth ?? details.width)
      const height = rawDimensions?.height ?? Number(tags.ImageHeight ?? details.height)
      const metadata: PhotoMetadata = {
        width: source !== 'decoded' && rotated ? height : width,
        height: source !== 'decoded' && rotated ? width : height,
        camera: text(tags.Model),
        lens: text(tags.LensModel ?? tags.LensID),
        capturedAt: tags.DateTimeOriginal?.toString(),
        aperture: tags.FNumber ? `f/${tags.FNumber}` : undefined,
        shutter: tags.ExposureTime ? `${tags.ExposureTime} s` : undefined,
        iso: text(tags.ISO),
        focalLength: text(tags.FocalLength),
      }
      const normalized = input.autoOrient().toColourspace('srgb')
      await normalized
        .clone()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(join(output, 'preview.jpg'))
      await normalized
        .clone()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(join(output, 'thumb.jpg'))
      return { metadata, source, processing, captureMetadata: capture }
    } finally {
      await this.tool.end()
      await rm(embedded, { force: true })
    }
  }

  async renderFull(
    path: string,
    output: string,
    onStage?: (stage: PreviewStage) => void,
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult> {
    if (rawDecoder(path) || options?.metadata.mergeMaster) {
      options ??= {
        metadata: await this.inspect(path),
        settings: automaticLensSettings,
        revision: 0,
      }
      onStage?.('unpack')
      this.releaseFrame()
      return renderHdr(path, output, options, this.gpu, this.backend)
    }
    const started = performance.now()
    const timings: Record<string, number> = {}
    const workingKey = JSON.stringify([
      path,
      options?.metadata.lensProfile.identity,
      options?.metadata.whiteBalance?.identity,
      options?.settings,
    ])
    const adjustments = options?.adjustments ?? neutralAdjustments
    let working = this.working?.key === workingKey ? this.working.frame : undefined
    if (!working && options?.workingAsset) {
      const asset = options.workingAsset
      if (
        asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
        asset.byteLength > 512 * 1024 ** 2 ||
        (await stat(asset.path)).size !== asset.byteLength
      )
        throw new Error('Invalid working preview size.')
      const bytes = await readFile(asset.path)
      if (
        asset.byteLength !== frameByteLength(asset.width, asset.height) * 4 ||
        bytes.byteLength !== asset.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== asset.sha256
      )
        throw new Error('The working preview is damaged.')
      working = {
        data: new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4),
        width: asset.width,
        height: asset.height,
        transform: asset.transform,
      }
    }
    const input = sharp(path).autoOrient()
    let frame: { data: Buffer; width: number; height: number } | undefined
    const backend: 'cpu' | 'gpu' = 'cpu'
    if (working) {
      frame = {
        data: Buffer.from(renderAdjustments(working.data, adjustments, working.transform)),
        width: working.width,
        height: working.height,
      }
      timings.reusedWorking = 1
    }

    if (!frame && !rawDecoder(path)) {
      const dimensions = await input.metadata()
      if (frameByteLength(dimensions.width, dimensions.height) * 4 > 512 * 1024 ** 2)
        throw new Error('This photo exceeds the floating-point preview memory limit.')
      const { data, info } = await input
        .toColourspace('scrgb')
        .ensureAlpha()
        .raw({ depth: 'float' })
        .toBuffer({ resolveWithObject: true })
      frameByteLength(info.width, info.height)
      working = {
        data: new Float32Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength / 4),
        width: info.width,
        height: info.height,
        transform: srgbTransform,
      }
      frame = {
        data: Buffer.from(renderAdjustments(working.data, adjustments, working.transform)),
        width: info.width,
        height: info.height,
      }
    }
    if (working && working.data.byteLength <= 384 * 1024 ** 2)
      this.working = { key: workingKey, frame: working }
    if (!frame) {
      const dimensions = await input.metadata()
      frameByteLength(dimensions.width, dimensions.height)
      const { data, info } = await input
        .withIccProfile('srgb')
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      frame = { data, width: info.width, height: info.height }
    }
    const byteLength = frameByteLength(frame.width, frame.height)
    if (frame.data.byteLength !== byteLength)
      throw new Error('The decoder returned an incomplete pixel buffer.')
    const cacheStarted = performance.now()
    onStage?.('cache')
    let linear: FullPreviewResult['linear']
    if (options?.prepareLinear && working) {
      const bytes = Buffer.from(
        working.data.buffer,
        working.data.byteOffset,
        working.data.byteLength,
      )
      await writeFile(join(output, 'linear.f32'), bytes)
      linear = {
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        transform: working.transform,
      }
    }
    const sha256 = createHash('sha256').update(frame.data).digest('hex')
    await writeFile(join(output, 'full.rgba'), frame.data)
    const placeholder = await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })
      .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    await writeFile(join(output, 'placeholder.png'), placeholder)
    timings.cacheMs = performance.now() - cacheStarted
    timings.totalMs = performance.now() - started
    return {
      linear,
      adjustments,
      width: frame.width,
      height: frame.height,
      format: 'rgba8-srgb',
      byteLength,
      sha256,
      renderId:
        'raster-display-referred-v1' +
        '-' +
        ADJUSTMENT_VERSION +
        '-' +
        JSON.stringify(adjustments) +
        JSON.stringify(options?.metadata.whiteBalance?.identity ?? null) +
        (options &&
        Object.values(appliedCorrections(options.metadata.lensProfile, options.settings)).some(
          Boolean,
        )
          ? `-${LENS_RENDER_VERSION}`
          : ''),
      settingsRevision: options?.revision ?? 0,
      appliedCorrections: options
        ? appliedCorrections(options.metadata.lensProfile, options.settings)
        : undefined,
      placeholderBytes: placeholder.byteLength,
      diagnostics: { backend, timings },
    }
  }

  async statistics(path: string, frame: { width: number; height: number; sha256: string }) {
    const length = frameByteLength(frame.width, frame.height)
    if ((await stat(path)).size !== length) throw new Error('Invalid statistics frame.')
    const data = await readFile(path)
    if (
      data.byteLength !== length ||
      createHash('sha256').update(data).digest('hex') !== frame.sha256
    )
      throw new Error('Damaged statistics frame.')
    return imageStatistics(data)
  }

  releaseFrame(): void {
    this.working = undefined
    this.gpu.releaseFrame()
  }

  async close(): Promise<void> {
    this.working = undefined
    this.gpu.close()
    await this.tool.end()
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}
