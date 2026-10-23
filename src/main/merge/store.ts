import { createHash } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  MERGE_VERSION,
  MERGE_PIPELINE,
  GPU_CAMERA_PREPARATION,
  GPU_REFERENCE_PREPARATION,
  UnsupportedMergeVersionError,
  validateMergeVersion,
  type MergeBundleManifest,
  type MergeManifest,
} from '../../shared/merge'
import { UnsupportedHdrSourceVersionError, validateHdrSource } from '../../shared/hdr'
import { frameByteLength } from '../../shared/preview-frame'

/** Disjoint wall-time aggregates on the caller's process clock, including failures. */
export interface MasterVerificationMeasurements {
  readingMs: number
  hashingMs: number
  pixelValidationMs: number
  metadataMs: number
  closingMs: number
}

export async function durableJson(path: string, data: unknown) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(data))
    await file.sync()
  } finally {
    await file.close()
  }
}
export async function syncDirectory(path: string) {
  if (process.platform === 'win32') return
  const dir = await open(path, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
export async function verifyMaster(
  directory: string,
  manifest: MergeBundleManifest,
  measurements?: MasterVerificationMeasurements,
): Promise<void> {
  await verifyMasterContents(directory, manifest, measurements)
}

async function verifyMasterContents(
  directory: string,
  manifest: MergeBundleManifest,
  measurements?: MasterVerificationMeasurements,
  retainUnsupported = false,
): Promise<UnsupportedMergeVersionError | UnsupportedHdrSourceVersionError | undefined> {
  let unsupported: UnsupportedMergeVersionError | UnsupportedHdrSourceVersionError | undefined
  let phase: keyof MasterVerificationMeasurements = 'metadataMs',
    started = measurements ? performance.now() : 0
  const stage = (next: keyof MasterVerificationMeasurements) => {
    if (!measurements) return
    const now = performance.now()
    measurements[phase] += now - started
    phase = next
    started = now
  }
  try {
    const a = manifest?.asset,
      recipe = manifest?.recipe
    if (
      !manifest ||
      !a ||
      !recipe ||
      !manifest.photo ||
      !manifest.metadata ||
      manifest.photo.assetKind !== 'derived' ||
      a.kind !== 'hdr-working-v1' ||
      recipe.resolution !== 'native' ||
      recipe.version !== manifest.version ||
      !recipe.crop ||
      a.width !== recipe.crop.width ||
      a.height !== recipe.crop.height ||
      !Array.isArray(recipe.sources) ||
      recipe.sources.length < 2 ||
      recipe.sources.some(
        (source) => !source || typeof source !== 'object' || !/^[a-f0-9]{64}$/.test(source.id),
      )
    )
      throw new Error('Invalid merge manifest.')
    // Reuse the ordinary preview geometry boundary before any allocation or
    // file read. Unsupported is never permission to trust malformed metadata.
    const expectedBytes = frameByteLength(a.width, a.height) * 4
    if (
      a.byteLength !== expectedBytes ||
      a.byteLength > 512 * 1024 ** 2 ||
      !Array.isArray(a.strips) ||
      a.strips.length !== Math.ceil(a.height / 64) ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      a.strips.some(
        (strip, index) =>
          !strip ||
          strip.byteLength !== Math.min(64, a.height - index * 64) * a.width * 16 ||
          !/^[a-f0-9]{64}$/.test(strip.sha256),
      ) ||
      !recipe.maskDimensions ||
      !/^[a-f0-9]{64}$/.test(recipe.maskSha256)
    )
      throw new Error('Invalid master dimensions or strip manifest.')
    const maskBytes = frameByteLength(recipe.maskDimensions.width, recipe.maskDimensions.height) / 4
    try {
      validateMergeVersion(manifest.version)
    } catch (error) {
      if (!retainUnsupported || !(error instanceof UnsupportedMergeVersionError)) throw error
      unsupported = error
    }
    // Only the accepted pipeline interprets algorithm-specific recipe fields.
    // Unknown well-formed recipes remain opaque verified recovery provenance.
    if (
      manifest.version === MERGE_VERSION &&
      ((recipe.cameraPreparation !== undefined &&
        recipe.cameraPreparation !== GPU_CAMERA_PREPARATION) ||
        (recipe.referenceFallbackPreparation !== undefined &&
          recipe.referenceFallbackPreparation !== GPU_REFERENCE_PREPARATION) ||
        recipe.sources.some(
          (source) =>
            source.cameraPreparation !== undefined &&
            (source.cameraPreparation !== GPU_CAMERA_PREPARATION ||
              recipe.cameraPreparation !== GPU_CAMERA_PREPARATION),
        ) ||
        JSON.stringify(recipe.pipeline) !== JSON.stringify(MERGE_PIPELINE))
    )
      throw new Error('Invalid merge manifest.')
    try {
      validateHdrSource(a.source)
    } catch (error) {
      if (!retainUnsupported || !(error instanceof UnsupportedHdrSourceVersionError)) throw error
      unsupported ??= error
    }
    stage('readingMs')
    const file = await open(join(directory, 'linear.f32'), 'r')
    stage('hashingMs')
    const digest = createHash('sha256')
    try {
      stage('readingMs')
      const size = (await file.stat()).size
      stage('metadataMs')
      if (size !== a.byteLength) throw new Error('Incomplete merge master.')
      let offset = 0
      const staging = Buffer.allocUnsafe(a.width * Math.min(64, a.height) * 16)
      for (const strip of a.strips) {
        const size = Math.min(a.width * 64 * 16, a.byteLength - offset)
        if (strip.byteLength !== size) throw new Error('Invalid master strip.')
        const bytes = staging.subarray(0, size)
        let read = 0
        stage('readingMs')
        while (read < size) {
          const chunk = await file.read(bytes, read, size - read, offset + read)
          if (!chunk.bytesRead) throw new Error('Incomplete master strip.')
          read += chunk.bytesRead
        }
        stage('hashingMs')
        if (createHash('sha256').update(bytes).digest('hex') !== strip.sha256)
          throw new Error('Damaged master strip.')
        stage('pixelValidationMs')
        const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
        for (let i = 0; i < floats.length; i += 4)
          if (
            !Number.isFinite(floats[i]) ||
            !Number.isFinite(floats[i + 1]) ||
            !Number.isFinite(floats[i + 2]) ||
            !Number.isFinite(floats[i + 3]) ||
            floats[i + 3] < 0 ||
            floats[i + 3] > 1
          )
            throw new Error('Invalid master pixels.')
        stage('hashingMs')
        digest.update(bytes)
        stage('metadataMs')
        offset += size
      }
      stage('hashingMs')
      if (digest.digest('hex') !== a.sha256) throw new Error('Damaged merge master.')
    } finally {
      stage('closingMs')
      await file.close()
    }
    stage('readingMs')
    const mask = await open(join(directory, 'motion.mask'), 'r')
    try {
      const opened = await mask.stat()
      stage('metadataMs')
      if (!opened.isFile() || opened.size !== maskBytes) throw new Error('Damaged merge mask.')
      // Hash the exact admitted length through this owned descriptor, using the
      // same exact owned-descriptor reads as the master, with EOF and final-size
      // checks. The mask itself
      // is never retained, so a complete mask allocation would be unnecessary.
      const storage = Buffer.allocUnsafe(Math.min(maskBytes, 64 * 1024)),
        digest = createHash('sha256')
      for (let offset = 0; offset < maskBytes;) {
        const size = Math.min(storage.length, maskBytes - offset)
        let read = 0
        stage('readingMs')
        while (read < size) {
          const chunk = await mask.read(storage, read, size - read, offset + read)
          if (!chunk.bytesRead) throw new Error('Damaged merge mask.')
          read += chunk.bytesRead
        }
        stage('hashingMs')
        digest.update(storage.subarray(0, size))
        offset += size
      }
      stage('readingMs')
      const extra = Buffer.allocUnsafe(1),
        grew = (await mask.read(extra, 0, 1, maskBytes)).bytesRead,
        final = await mask.stat()
      stage('metadataMs')
      if (
        grew ||
        final.size !== opened.size ||
        final.dev !== opened.dev ||
        final.ino !== opened.ino
      )
        throw new Error('Damaged merge mask.')
      stage('hashingMs')
      if (digest.digest('hex') !== manifest.recipe.maskSha256)
        throw new Error('Damaged merge mask.')
    } finally {
      stage('closingMs')
      await mask.close()
    }
    for (const name of ['thumb.jpg', 'preview.jpg']) {
      stage('readingMs')
      const size = (await stat(join(directory, name))).size
      stage('metadataMs')
      if (!size) throw new Error('Incomplete merge previews.')
    }
    return unsupported
  } finally {
    stage(phase)
  }
}
export interface RetainedUnsupportedMergePublication {
  id: string
  manifestSha256: string
  filename: string
  reason: string
}

/** Verify all bytes before classifying unsupported journals; never publish or erase them. */
export async function recoverMerges(
  root: string,
  db: DatabaseSync,
  publish: (manifest: MergeManifest) => void | Promise<void>,
): Promise<RetainedUnsupportedMergePublication[]> {
  const retained: RetainedUnsupportedMergePublication[] = []
  const pending = join(root, 'merge-publications')
  await mkdir(pending, { recursive: true })
  for (const row of db.prepare('SELECT id, manifest_sha256 FROM merge_publications').all() as {
    id: string
    manifest_sha256: string
  }[]) {
    if (!/^[a-f0-9]{64}$/.test(row.id)) throw new Error('Invalid merge publication journal.')
    const final = join(root, 'originals', row.id),
      stage = join(pending, row.id)
    const directory = await stat(final).then(
      () => final,
      () => stage,
    )
    const manifestBytes = await readFile(join(directory, 'manifest.json'))
    if (createHash('sha256').update(manifestBytes).digest('hex') !== row.manifest_sha256)
      throw new Error('Damaged merge publication manifest.')
    const manifest = JSON.parse(manifestBytes.toString()) as MergeBundleManifest
    if (manifest.photo.id !== row.id) throw new Error('Merge journal identity mismatch.')
    const unsupported = await verifyMasterContents(directory, manifest, undefined, true)
    if (unsupported) {
      retained.push({
        id: row.id,
        manifestSha256: row.manifest_sha256,
        filename: manifest.photo.filename,
        reason: unsupported.message,
      })
      continue
    }
    if (directory !== final) {
      await rename(directory, final)
      await syncDirectory(join(root, 'originals'))
    }
    // No unsupported error means both version fields are verified current.
    await publish(manifest as MergeManifest)
  }
  // Unjournaled directories are retained for recovery, never mistaken for imported RAWs.
  await readdir(pending)
  return retained
}
