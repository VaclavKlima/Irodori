/** Independent pre-consolidation CPU oracle; never used by an application entry point. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PreviewEngine } from '../src/main/preview-engine'
import type { FullPreviewResult } from '../src/main/preview-types'
import { rawDecoder } from '../src/main/processing/decoders'
import { readRasterWorking } from '../src/main/processing/detail-preview'
import { neutralAdjustments, renderAdjustments } from '../src/shared/adjustments'
import type { ProcessingOptions } from '../src/shared/lens'
import { automaticLensSettings } from '../src/shared/lens'
import { renderHdrReference } from './hdr-processing-reference'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export class ReferencePreviewEngine extends PreviewEngine {
  constructor() {
    super(undefined, 'auto')
  }
  override async renderFull(
    path: string,
    output: string,
    _stage?: Parameters<PreviewEngine['renderFull']>[2],
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult> {
    if (rawDecoder(path) || options?.metadata.mergeMaster || options?.workingAsset?.hdr) {
      options ??= {
        metadata: await this.inspect(path),
        settings: automaticLensSettings,
        revision: 0,
      }
      return renderHdrReference(
        path,
        output,
        options,
        {
          render: async () => {
            throw new Error('The scalar oracle cannot select GPU preparation.')
          },
          releaseFrame() {},
        },
        'cpu',
      )
    }
    return super.renderFull(path, output, undefined, options)
  }
  override async renderPreparedFull(
    output: string,
    options: ProcessingOptions,
    _backend?: 'auto' | 'cpu' | 'gpu',
  ): Promise<FullPreviewResult> {
    void _backend
    const asset = options.workingAsset
    if (!asset) throw new Error('The reference requires an admitted working source.')
    if (asset.hdr) return this.renderFull(asset.path, output, undefined, options)
    const frame = await readRasterWorking(asset, new AbortController().signal),
      data = renderAdjustments(
        frame.data,
        options.adjustments ?? neutralAdjustments,
        frame.transform,
      )
    await writeFile(join(output, 'full.rgba'), data)
    await sharp(data, { raw: { width: frame.width, height: frame.height, channels: 4 } })
      .resize({ width: 96, height: 96, fit: 'inside' })
      .png()
      .toFile(join(output, 'placeholder.png'))
    return {
      width: frame.width,
      height: frame.height,
      format: 'rgba8-srgb',
      byteLength: data.byteLength,
      sha256: hash(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
      placeholderBytes: (await readFile(join(output, 'placeholder.png'))).byteLength,
      renderId: 'independent-scalar-raster-reference',
      settingsRevision: options.revision,
      adjustments: options.adjustments,
      diagnostics: { backend: 'cpu', proofBackend: 'cpu', timings: {} },
    }
  }
}
