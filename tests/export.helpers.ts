import { seedFixtureEdits } from './catalog-fixture.helpers'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { PhotoLibrary } from './photo-library.helpers'
import { processingMetadata } from '../src/main/processing/metadata'
import { automaticLensSettings } from '../src/shared/lens'
import { neutralAdjustments, srgbTransform } from '../src/shared/adjustments'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import { HDR_SOURCE_VERSION } from '../src/shared/hdr'
import type { ExportSource } from '../src/main/export/types'
import type { Photo } from '../src/shared/contracts'
import type { PreviewProcess } from '../src/main/preview-process'

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function workingAsset(bytes: Buffer, width: number, height: number): HdrWorkingAsset {
  return {
    kind: 'hdr-working-v1',
    width,
    height,
    byteLength: bytes.length,
    sha256: sha(bytes),
    strips: Array.from({ length: Math.ceil(height / 64) }, (_, i) => {
      const strip = bytes.subarray(i * width * 64 * 16, (i + 1) * width * 64 * 16)
      return { byteLength: strip.length, sha256: sha(strip) }
    }),
    source: {
      version: HDR_SOURCE_VERSION,
      processing: 'hdr-v1',
      colorSpace: 'rec2020',
      whitePoint: 'D65',
      transfer: 'linear',
      alpha: 'straight',
      normalization: {
        black: [0, 0, 0, 0],
        maximum: 16383,
        gains: [1, 1, 1, 1],
        restoreGain: 1,
        referenceWhite: 1,
        sourceSaturation: null,
      },
      decoder: 'synthetic-export',
      cameraProfile: 'synthetic-export',
      orientation: 'applied-once',
    },
  }
}
export async function exportFixture(
  count = 2,
  metadataProcessor?: Pick<PreviewProcess, 'inspect' | 'close'>,
) {
  const root = await mkdtemp(join(tmpdir(), 'irodori-export-'))
  await mkdir(join(root, 'trash'))
  const library = new PhotoLibrary(
    join(root, 'library'),
    {
      process: async () => {
        throw new Error('Unexpected import preparation.')
      },
      close: async () => {},
    },
    () => {},
    undefined,
    async (path) => {
      await rename(path, join(root, 'trash', basename(path)))
    },
    metadataProcessor,
  )
  await library.open()
  const db = new DatabaseSync(join(root, 'library', 'catalog.sqlite'))
  const photos: Photo[] = []
  for (let i = 0; i < count; i++) {
    const bytes = await sharp({
      create: {
        width: 17,
        height: 11,
        channels: 4,
        background: { r: i % 255, g: Math.floor(i / 255), b: 80, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    const id = sha(bytes),
      directory = join(root, 'library', 'originals', id)
    await mkdir(directory)
    await writeFile(join(directory, 'original.png'), bytes)
    const photo: Photo = {
      id,
      filename: `Photo-${i}.png`,
      format: 'PNG',
      width: 17,
      height: 11,
      bytes: bytes.length,
      importedAt: new Date(1700000000000 + i).toISOString(),
      previewSource: 'image',
      previewUrl: `irodori-photo://library/${id}/preview`,
      thumbnailUrl: `irodori-photo://library/${id}/thumb`,
    }
    photos.push(photo)
    db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'display-referred-v1')").run(
      id,
      photo.importedAt,
      JSON.stringify(photo),
    )
    db.prepare('INSERT INTO processing VALUES (?, ?)').run(
      id,
      JSON.stringify({
        metadata: processingMetadata({}, []),
        settings: automaticLensSettings,
        revision: 0,
      }),
    )
    seedFixtureEdits(db)
  }
  await mkdir(join(root, 'destination'))
  return {
    root,
    library,
    db,
    photos,
    destination: join(root, 'destination'),
    close: async () => {
      await library.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
export async function syntheticExportSource(
  directory: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): Promise<ExportSource> {
  const data = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set([...pixel(x, y), 1], (y * width + x) * 4)
  const bytes = Buffer.from(data.buffer),
    asset = workingAsset(bytes, width, height),
    path = join(directory, 'master.f32')
  await writeFile(path, bytes)
  const metadata = processingMetadata({}, [])
  return {
    hdr: true,
    path,
    identity: { dev: 0, ino: 0, size: bytes.length, mtimeMs: 0, ctimeMs: 0 },
    photo: {
      id: sha(bytes),
      filename: 'Merged.irodori',
      format: 'IRODORI HDR',
      assetKind: 'derived',
      width,
      height,
      bytes: bytes.length,
      importedAt: '',
      previewSource: 'decoded',
      previewUrl: '',
      thumbnailUrl: '',
    },
    processing: {
      metadata,
      settings: automaticLensSettings,
      revision: 4,
      adjustments: neutralAdjustments,
      workingAsset: {
        path,
        width,
        height,
        byteLength: bytes.length,
        sha256: asset.sha256,
        transform: srgbTransform,
        hdr: asset,
      },
    },
  }
}
