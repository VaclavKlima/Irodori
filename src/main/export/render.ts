import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ExifTool } from 'exiftool-vendored'
import { exportRenditions } from './renditions'
import { encodeExportHdr } from './encoder'
import { validatePrimary } from './jpeg'
import type { ExportDiagnostics, ExportRenderJob, ExportRenderResult } from './types'

export { rasterLinear } from './raster'

/** Construct a small EXIF allowlist before HDR packaging; never copy source metadata wholesale. */
async function metadata(
  job: ExportRenderJob,
): Promise<Record<string, Record<string, string>> | undefined> {
  if (job.options.metadata === 'none' || job.source.photo.assetKind === 'derived') return undefined
  const tool = new ExifTool({ maxProcs: 1 })
  try {
    const tags = (await tool.readRaw(job.source.path, {
      readArgs: [
        '-n',
        '-Copyright',
        '-Artist',
        '-Make',
        '-Model',
        '-LensModel',
        '-DateTimeOriginal',
        '-FNumber',
        '-ExposureTime',
        '-ISO',
        '-FocalLength',
      ],
    })) as Record<string, unknown>
    const ifd0: Record<string, string> = {},
      ifd2: Record<string, string> = {}
    const copy = (name: string, dest: Record<string, string>, outputName = name) => {
      const value = tags[name]
      if ((typeof value === 'string' || typeof value === 'number') && String(value).length < 2048)
        dest[outputName] = String(value)
    }
    for (const name of ['Copyright', 'Artist']) copy(name, ifd0)
    if (job.options.metadata === 'camera-copyright') {
      for (const name of ['Make', 'Model']) copy(name, ifd0)
      for (const name of [
        'LensModel',
        'DateTimeOriginal',
        'FNumber',
        'ExposureTime',
        'FocalLength',
      ])
        copy(name, ifd2)
      copy('ISO', ifd2, 'ISOSpeedRatings')
    }
    return { IFD0: ifd0, IFD2: ifd2 }
  } finally {
    await tool.end()
  }
}

export async function renderExport(job: ExportRenderJob): Promise<ExportRenderResult> {
  const start = performance.now()
  sharp.concurrency(1)
  sharp.cache(false)
  const metadataStarted = performance.now()
  let metadataMs = 0,
    sdrEncodeMs = 0
  const pendingTags = metadata(job).finally(() => {
    metadataMs = performance.now() - metadataStarted
  })
  const encodeSdr = async (
    rgb: Buffer,
    geometry: { width: number; height: number },
    exif: Awaited<ReturnType<typeof metadata>>,
  ) => {
    const started = performance.now()
    let encoder = sharp(rgb, { raw: { ...geometry, channels: 3 } }).withIccProfile('srgb')
    if (exif) encoder = encoder.withExif(exif)
    try {
      return await encoder
        .jpeg({
          quality: job.options.quality,
          chromaSubsampling: '4:4:4',
          progressive: false,
          optimiseCoding: true,
        })
        .toBuffer()
    } finally {
      sdrEncodeMs = performance.now() - started
    }
  }
  const [rendered, tags] = await Promise.allSettled([
    exportRenditions(job, undefined, (rgb, geometry) =>
      pendingTags.then((exif) => encodeSdr(rgb, geometry, exif)),
    ),
    pendingTags,
  ])
  if (rendered.status === 'rejected') throw rendered.reason
  if (tags.status === 'rejected') throw tags.reason
  const rendition = rendered.value
  const { rgb, half, geometry, contentHeadroom } = rendition
  const diagnostics: ExportDiagnostics = {
    renderer: rendition.diagnostics.renderer,
    adapter: rendition.diagnostics.adapter,
    rendererFallback: rendition.diagnostics.rendererFallback,
    gpuMemoryBytes: rendition.diagnostics.gpuPeakBytes,
    encoder: 'sdr',
    stages: {
      renditionMs: rendition.diagnostics.renderMs,
      resizeMs: rendition.diagnostics.resizeMs,
      gpuInitializeMs: rendition.diagnostics.gpuInitializeMs,
      gpuTilesMs: rendition.diagnostics.gpuTilesMs,
      gpuPackingMs: rendition.diagnostics.gpuPackingMs,
      metadataMs,
    },
  }
  const sdr = await (rendition.earlyPrimary ?? encodeSdr(rgb, geometry, tags.value))
  diagnostics.stages.sdrEncodeMs = sdrEncodeMs
  let stage: number
  let output = sdr
  let renderedPath: string | undefined,
    primaryWritten = false
  if (half) {
    stage = performance.now()
    const encoded = await encodeExportHdr(
      half,
      geometry.width,
      geometry.height,
      sdr,
      job.options.quality,
      contentHeadroom,
      job.directory,
    )
    output = encoded.output
    renderedPath = encoded.path
    primaryWritten = encoded.primaryWritten
    diagnostics.encoder = encoded.backend
    diagnostics.encoderMemory = encoded.memory
    diagnostics.encoderFallback = encoded.fallback
    diagnostics.stages.hdrEncodeMs = performance.now() - stage
    stage = performance.now()
    validatePrimary(output, sdr)
    diagnostics.stages.primaryValidationMs = performance.now() - stage
  }
  stage = performance.now()
  const info = await sharp(output).metadata()
  if (
    info.format !== 'jpeg' ||
    info.width !== geometry.width ||
    info.height !== geometry.height ||
    !info.icc ||
    info.isProgressive
  )
    throw new Error('Invalid exported JPEG.')
  const path = renderedPath ?? join(job.directory, 'output.jpg')
  if (!renderedPath) await writeFile(path, output, { flag: 'wx' })
  // Retained only inside this disposable job directory, useful to correctness tests.
  if (!primaryWritten) await writeFile(join(job.directory, 'sdr.jpg'), sdr, { flag: 'wx' })
  const sha256 = createHash('sha256').update(output).digest('hex')
  diagnostics.stages.validationAndWriteMs = performance.now() - stage
  diagnostics.stages.workerMs = performance.now() - start
  return { path, sha256, diagnostics }
}
