import { createHash } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  MERGE_VERSION,
  MERGE_PIPELINE,
  GPU_CAMERA_PREPARATION,
  GPU_REFERENCE_PREPARATION,
  type MergeManifest,
} from '../../shared/merge'
import { validateHdrSource } from '../../shared/hdr'

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
  manifest: MergeManifest,
  measurements?: MasterVerificationMeasurements,
) {
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
    if (
      !['sony-merge-v1', 'sony-merge-v2', 'sony-merge-v3', MERGE_VERSION].includes(
        manifest.version,
      ) ||
      manifest.photo.assetKind !== 'derived' ||
      manifest.recipe.resolution !== 'native' ||
      manifest.asset.width !== manifest.recipe.crop.width ||
      manifest.asset.height !== manifest.recipe.crop.height ||
      manifest.recipe.version !== manifest.version ||
      (manifest.recipe.cameraPreparation !== undefined &&
        manifest.recipe.cameraPreparation !== GPU_CAMERA_PREPARATION) ||
      (manifest.recipe.referenceFallbackPreparation !== undefined &&
        manifest.recipe.referenceFallbackPreparation !== GPU_REFERENCE_PREPARATION) ||
      manifest.recipe.sources.some(
        (source) =>
          source.cameraPreparation !== undefined &&
          (source.cameraPreparation !== GPU_CAMERA_PREPARATION ||
            manifest.recipe.cameraPreparation !== GPU_CAMERA_PREPARATION),
      ) ||
      (manifest.version === MERGE_VERSION &&
        JSON.stringify(manifest.recipe.pipeline) !== JSON.stringify(MERGE_PIPELINE))
    )
      throw new Error('Invalid merge manifest.')
    const a = manifest.asset
    validateHdrSource(a.source)
    if (
      a.byteLength !== a.width * a.height * 16 ||
      a.byteLength > 512 * 1024 ** 2 ||
      a.strips.length !== Math.ceil(a.height / 64)
    )
      throw new Error('Invalid master dimensions.')
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
    const mask = await readFile(join(directory, 'motion.mask'))
    stage('metadataMs')
    if (
      mask.length !==
      manifest.recipe.maskDimensions.width * manifest.recipe.maskDimensions.height
    )
      throw new Error('Damaged merge mask.')
    stage('hashingMs')
    if (createHash('sha256').update(mask).digest('hex') !== manifest.recipe.maskSha256)
      throw new Error('Damaged merge mask.')
    for (const name of ['thumb.jpg', 'preview.jpg']) {
      stage('readingMs')
      const size = (await stat(join(directory, name))).size
      stage('metadataMs')
      if (!size) throw new Error('Incomplete merge previews.')
    }
  } finally {
    stage(phase)
  }
}
/** Recover publication before disposable staging cleanup. Failed validation retains evidence. */
export async function recoverMerges(
  root: string,
  db: DatabaseSync,
  publish: (manifest: MergeManifest) => void,
) {
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
    const manifest = JSON.parse(manifestBytes.toString()) as MergeManifest
    if (manifest.photo.id !== row.id) throw new Error('Merge journal identity mismatch.')
    await verifyMaster(directory, manifest)
    if (directory !== final) {
      await rename(directory, final)
      await syncDirectory(join(root, 'originals'))
    }
    publish(manifest)
  }
  // Unjournaled directories are retained for recovery, never mistaken for imported RAWs.
  await readdir(pending)
}
