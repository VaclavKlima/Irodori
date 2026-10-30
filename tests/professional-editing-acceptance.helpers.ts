import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Photo } from '../src/shared/contracts'
import type { ExportFile, ExportManifest } from '../src/main/export/types'
import { loadUltraHdr } from '../src/main/export/codec'
import { fromHalf, readGainJpeg, reconstruct } from './export-reference'
import { readJpegReferenceSamples } from './jpeg-ycbcr-reference.helpers'
import { referenceBase2020 } from './jpeg-ycbcr-model.helpers'

export async function acceptanceHash(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function managedOriginalHashes(profile: string, photos: Photo[]) {
  return Promise.all(
    photos.map(async (photo) => ({
      photoId: photo.id,
      sha256: await acceptanceHash(
        join(
          profile,
          'library',
          'originals',
          photo.id,
          `original${extname(photo.filename).toLowerCase()}`,
        ),
      ),
    })),
  )
}

/** Observe accepted settings/results without entering the application's catalog writer. */
export function acceptedExport(profile: string, id: string) {
  const db = new DatabaseSync(join(profile, 'library', 'catalog.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT manifest FROM export_jobs WHERE id = ?').get(id) as {
      manifest: string
    }
    const manifest = JSON.parse(row.manifest) as ExportManifest
    const files = (
      db.prepare('SELECT data FROM export_files WHERE job_id = ? ORDER BY ordinal').all(id) as {
        data: string
      }[]
    ).map((value) => JSON.parse(value.data) as ExportFile)
    return { manifest, files }
  } finally {
    db.close()
  }
}

export async function completedTask(page: Page, id: string) {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.irodori.listTasks())).find((task) => task.id === id)
          ?.status,
      { timeout: 600000 },
    )
    .toMatch(/^(completed|cancelled|failed)$/)
  return (await page.evaluate(() => window.irodori.listTasks())).find((task) => task.id === id)!
}

/** Reuse the existing independent ISO Float64 reconstruction and its 0.02 codec bound. */
export async function inspectAcceptedJpeg(
  path: string,
  hdr: boolean,
  width: number,
  height: number,
) {
  const bytes = await readFile(path),
    metadata = await sharp(bytes).metadata()
  expect(metadata).toMatchObject({ format: 'jpeg', width, height })
  expect(metadata.icc).toBeDefined()
  if (!hdr) return { sha256: await acceptanceHash(path), hdr: false, width, height }
  const parsed = readGainJpeg(bytes),
    primary = await sharp(parsed.primary).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    gain = await sharp(parsed.gain, { ignoreIcc: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    ordinary = await sharp(bytes).removeAlpha().raw().toBuffer()
  expect([primary.info.width, primary.info.height, primary.info.channels]).toEqual([
    width,
    height,
    3,
  ])
  expect([gain.info.width, gain.info.height, gain.info.channels]).toEqual([width, height, 3])
  expect(ordinary).toEqual(primary.data)
  const baseSamples = readJpegReferenceSamples(parsed.primary, 'base-ycbcr'),
    gainSamples = readJpegReferenceSamples(parsed.gain, 'gain-rgb')
  expect([baseSamples.width, baseSamples.height]).toEqual([width, height])
  expect([gainSamples.width, gainSamples.height]).toEqual([width, height])
  // Gain codes are RGB8 numerical data, unlike the floating-point base conversion.
  expect(gainSamples.pixels).toEqual(gain.data)
  expect(parsed.metadata.useBase).toBe(false)
  const codec = await loadUltraHdr()
  let maximumError = 0,
    channelComparisons = 0
  for (const headroom of [1, Math.max(1.01, 2 ** parsed.metadata.alternateHeadroom)]) {
    const decoded = codec.inspect(bytes, headroom)
    expect(decoded.pixels).toBeDefined()
    expect(decoded.stride).toBeGreaterThanOrEqual(width)
    expect(decoded.gamut).toBe(2)
    let headroomMaximum = 0
    let worst: { x: number; y: number; channel: number; error: number } | undefined
    let firstNonFinite: typeof worst
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3,
          base = referenceBase2020(baseSamples, x, y),
          map = [0, 1, 2].map((channel) => gainSamples.pixels[offset + channel] / 255),
          expected = reconstruct(base, map, parsed.metadata, headroom)
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(
            fromHalf(decoded.pixels![(y * decoded.stride! + x) * 4 + channel]) - expected[channel],
          )
          channelComparisons++
          const sample = { x, y, channel, error }
          if (!Number.isFinite(error)) firstNonFinite ??= sample
          if (error > headroomMaximum) worst = sample
          // Every channel is evaluated. NaN and Infinity must still fail the same bound.
          headroomMaximum = Math.max(headroomMaximum, error)
        }
      }
    expect(
      headroomMaximum,
      JSON.stringify({ headroom, worst, firstNonFinite }, (_key, value) =>
        typeof value === 'number' && !Number.isFinite(value) ? String(value) : value,
      ),
    ).toBeLessThan(0.02)
    maximumError = Math.max(maximumError, headroomMaximum)
  }
  expect(channelComparisons).toBe(width * height * 3 * 2)
  return {
    sha256: await acceptanceHash(path),
    hdr: true,
    width,
    height,
    maximumIsoError: maximumError,
    channelComparisons,
    oracle: {
      policy: 'raw-ycbcr-base-rgb8-gain-v1',
      base: baseSamples.provenance,
      gain: gainSamples.provenance,
    },
  }
}

export async function durableBundleHashes(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true })
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        sha256: await acceptanceHash(join(directory, entry.name)),
      })),
  )
}
