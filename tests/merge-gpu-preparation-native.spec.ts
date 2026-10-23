import { seedFixtureEdits } from './catalog-fixture.helpers'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from './photo-library.helpers'
import { PreviewProcess } from '../src/main/preview-process'
import { verifyMaster } from '../src/main/merge/store'
import type { PreparedSource } from '../src/main/merge/prepare'
import type { BackgroundTask } from '../src/shared/contracts'
import type { HdrWorkingAsset } from '../src/shared/hdr'
import { automaticLensSettings, type ProcessingMetadata } from '../src/shared/lens'
import {
  ALIGNMENT_CONSTANTS,
  BRK_EXPOSURE_POLICY,
  GPU_CAMERA_PREPARATION,
  GPU_REFERENCE_PREPARATION,
  MERGE_LIMITS,
  type MergeRecipe,
} from '../src/shared/merge'
import { provenance } from '../scripts/research/pipeline/provenance'
import { recordBenchmark } from './benchmark.helpers'

interface SonyManifest {
  version: number
  sequences: { id: string; mode: string; complete: boolean; files: string[] }[]
  files: {
    name: string
    path: string
    sha256: string
    bytes: number
    dimensions: { activeWidth: number; activeHeight: number }
  }[]
}
interface Original {
  path: string
  name: string
  sha256: string
  bytes: number
  width: number
  height: number
  metadata: ProcessingMetadata
}
interface PlaneDescriptor {
  width: number
  height: number
  sha256: string
}
type SourceManifest = Omit<PreparedSource, 'plane' | 'cameraRegistration'> & {
  plane: PlaneDescriptor
  cameraRegistration: {
    version: string
    path: string
    strips: string[]
    planes: PlaneDescriptor[]
  }
}
interface Snapshot {
  sources: SourceManifest[]
  fallback: { source: Omit<SourceManifest, 'cameraRegistration'> } | null
  registration: { key: string; sha256: string; data: string }
  directory: string
}
interface Difference {
  samples: number
  maximumAbsolute: number
  maximumToleranceRatio: number
  rgbMismatches: number
  alphaMismatches: number
  nonfinite: number
  wordMismatches: number
  referenceSha256?: string
  candidateSha256?: string
  referenceStripMismatches?: number
  candidateStripMismatches?: number
  firstMismatch?: { sample: number; reference: number; candidate: number }
  firstAlphaMismatch?: { pixel: number; reference: number; candidate: number }
  firstWordMismatch?: {
    sample: number
    pixel: number
    x: number
    y: number
    channel: number
    reference: number
    candidate: number
    referenceBits: number
    candidateBits: number
  }
}
interface MotionDifference {
  reference: { dimensions: MergeRecipe['maskDimensions']; bytes: number; sha256: string }
  candidate: { dimensions: MergeRecipe['maskDimensions']; bytes: number; sha256: string }
  dimensionsMatch: boolean
  comparedPixels: number
  pixelMismatches: number
  bitMismatches: number
  mismatchesByBit: number[]
  referenceNonzeroPixels: number
  candidateNonzeroPixels: number
  firstMismatches: { x: number; y: number; reference: number; candidate: number; xor: number }[]
}
interface GeometryDifference {
  reference: Pick<MergeRecipe, 'width' | 'height' | 'crop' | 'maskDimensions'>
  candidate: Pick<MergeRecipe, 'width' | 'height' | 'crop' | 'maskDimensions'>
  cropDelta: MergeRecipe['crop']
  sources: {
    id: string
    reference: { model?: string; method?: string; channel?: string; matrix?: number[] }
    candidate: { model?: string; method?: string; channel?: string; matrix?: number[] }
    matrixDelta?: number[]
    maximumMatrixDelta?: number
    scaleDelta: number
  }[]
}
interface Sample {
  stage: 'camera' | 'reference' | 'both'
  backend: 'cpu' | 'gpu'
  iteration: number
  phase: string
  root?: string
  reviewId?: string
  taskId?: string
  completeOperationMs?: number
  createReviewMs?: number
  nativeReviewMs?: number
  diagnosticSnapshotMs?: number
  publicationAndCleanupMs?: number
  qualityAfterClockMs?: number
  recipe?: MergeRecipe
  asset?: HdrWorkingAsset
  task?: BackgroundTask
  snapshot?: Snapshot
  masterComparison?: Difference
  cameraComparisons?: { index: number; native?: Difference; planes?: Difference }[]
  fallbackComparison?: { native?: Difference; plane?: Difference }
  motionComparison?: MotionDifference
  geometryComparison?: GeometryDifference
  comparisonErrors?: { scope: string; error: ReturnType<typeof errorEvidence> }[]
  qualityFailures?: { message?: string; stack?: string }[]
  proofComplete?: boolean
  snapshotRetained?: boolean
  snapshotBytes?: number
  managedOriginalsBefore: { filename: string; sha256: string; bytes: number }[]
  managedOriginalsAfter: { filename: string; sha256: string; bytes: number }[]
  error?: ReturnType<typeof errorEvidence>
  cleanupError?: ReturnType<typeof errorEvidence>
  cleaned?: boolean
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errorEvidence = (error: unknown) =>
  error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'UnknownError', message: String(error) }
const emptyDifference = (): Difference => ({
  samples: 0,
  maximumAbsolute: 0,
  maximumToleranceRatio: 0,
  rgbMismatches: 0,
  alphaMismatches: 0,
  nonfinite: 0,
  wordMismatches: 0,
})

function compareSample(result: Difference, reference: number, candidate: number) {
  const sample = result.samples++
  if (!Number.isFinite(reference) || !Number.isFinite(candidate)) {
    result.nonfinite++
    result.rgbMismatches++
    result.firstMismatch ??= { sample, reference, candidate }
    return
  }
  const absolute = Math.abs(reference - candidate),
    ratio = absolute / (2e-6 + 2e-5 * Math.abs(reference))
  result.maximumAbsolute = Math.max(result.maximumAbsolute, absolute)
  result.maximumToleranceRatio = Math.max(result.maximumToleranceRatio, ratio)
  if (ratio > 1) {
    result.rgbMismatches++
    result.firstMismatch ??= { sample, reference, candidate }
  }
}

async function fileIdentity(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size }
}

async function readExact(file: FileHandle, bytes: Buffer, position: number) {
  let offset = 0
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, position + offset)
    if (!result.bytesRead) throw new Error('Truncated native Float32 comparison input.')
    offset += result.bytesRead
  }
}

/** At most two 64-row RGBA bands are retained, never complete native Float32 files. */
async function compareRgba(
  referencePath: string,
  candidatePath: string,
  width: number,
  height: number,
  referenceStrips: string[],
  candidateStrips: string[],
  exact: boolean,
) {
  const reference = await open(referencePath, 'r'),
    result = emptyDifference(),
    referenceHash = createHash('sha256'),
    candidateHash = createHash('sha256'),
    referenceBuffer = Buffer.allocUnsafe(width * Math.min(64, height) * 16),
    candidateBuffer = Buffer.allocUnsafe(referenceBuffer.length)
  let candidate: FileHandle | undefined
  result.referenceStripMismatches = result.candidateStripMismatches = 0
  try {
    candidate = await open(candidatePath, 'r')
    expect((await reference.stat()).size).toBe(width * height * 16)
    expect((await candidate.stat()).size).toBe(width * height * 16)
    expect(referenceStrips).toHaveLength(Math.ceil(height / 64))
    expect(candidateStrips).toHaveLength(referenceStrips.length)
    for (let top = 0; top < height; top += 64) {
      const rows = Math.min(64, height - top),
        bytes = width * rows * 16,
        a = referenceBuffer.subarray(0, bytes),
        b = candidateBuffer.subarray(0, bytes)
      await readExact(reference, a, top * width * 16)
      await readExact(candidate, b, top * width * 16)
      referenceHash.update(a)
      candidateHash.update(b)
      result.referenceStripMismatches += Number(sha256(a) !== referenceStrips[top / 64])
      result.candidateStripMismatches += Number(sha256(b) !== candidateStrips[top / 64])
      if (exact && b.equals(a)) {
        result.samples += width * rows * 3
        continue
      }
      const af = new Float32Array(a.buffer, a.byteOffset, bytes / 4),
        bf = new Float32Array(b.buffer, b.byteOffset, bytes / 4),
        au = new Uint32Array(a.buffer, a.byteOffset, bytes / 4),
        bu = new Uint32Array(b.buffer, b.byteOffset, bytes / 4)
      for (let p = 0; p < af.length; p += 4) {
        for (let c = 0; c < 3; c++) compareSample(result, af[p + c], bf[p + c])
        for (let c = 0; c < 4; c++)
          if (au[p + c] !== bu[p + c]) {
            result.wordMismatches++
            const pixel = top * width + p / 4
            result.firstWordMismatch ??= {
              sample: pixel * 4 + c,
              pixel,
              x: pixel % width,
              y: Math.floor(pixel / width),
              channel: c,
              reference: af[p + c],
              candidate: bf[p + c],
              referenceBits: au[p + c],
              candidateBits: bu[p + c],
            }
          }
        if (au[p + 3] !== bu[p + 3]) {
          result.alphaMismatches++
          result.firstAlphaMismatch ??= {
            pixel: top * width + p / 4,
            reference: af[p + 3],
            candidate: bf[p + 3],
          }
        }
      }
    }
    result.referenceSha256 = referenceHash.digest('hex')
    result.candidateSha256 = candidateHash.digest('hex')
    return result
  } finally {
    try {
      await reference.close()
    } finally {
      await candidate?.close()
    }
  }
}

async function comparePlaneFiles(
  referencePath: string,
  candidatePath: string,
  qa: PlaneDescriptor[],
  qb: PlaneDescriptor[],
  exact: boolean,
) {
  const a = await readFile(referencePath),
    b = await readFile(candidatePath),
    result = emptyDifference()
  expect(qa.length).toBeGreaterThan(0)
  expect(qb).toHaveLength(qa.length)
  const count = qa[0].width * qa[0].height
  expect(a.length).toBe(count * 5 * qa.length)
  expect(b.length).toBe(a.length)
  for (let c = 0; c < qa.length; c++) {
    expect([qb[c].width, qb[c].height]).toEqual([qa[c].width, qa[c].height])
    const first = c * count * 5,
      ap = a.subarray(first, first + count * 5),
      bp = b.subarray(first, first + count * 5)
    result.referenceStripMismatches =
      (result.referenceStripMismatches ?? 0) + Number(sha256(ap) !== qa[c].sha256)
    result.candidateStripMismatches =
      (result.candidateStripMismatches ?? 0) + Number(sha256(bp) !== qb[c].sha256)
    if (exact && bp.equals(ap)) {
      result.samples += count
      continue
    }
    for (let p = 0; p < count; p++) {
      compareSample(result, ap.readFloatLE(p * 4), bp.readFloatLE(p * 4))
      const referenceBits = ap.readUInt32LE(p * 4),
        candidateBits = bp.readUInt32LE(p * 4)
      if (referenceBits !== candidateBits) {
        result.wordMismatches++
        result.firstWordMismatch ??= {
          sample: c * count + p,
          pixel: p,
          x: p % qa[c].width,
          y: Math.floor(p / qa[c].width),
          channel: c,
          reference: ap.readFloatLE(p * 4),
          candidate: bp.readFloatLE(p * 4),
          referenceBits,
          candidateBits,
        }
      }
      if (ap[count * 4 + p] !== bp[count * 4 + p]) {
        result.alphaMismatches++
        result.firstAlphaMismatch ??= {
          pixel: c * count + p,
          reference: ap[count * 4 + p],
          candidate: bp[count * 4 + p],
        }
      }
    }
  }
  return result
}

async function comparePlanes(
  reference: Snapshot,
  candidate: Snapshot,
  index: number,
  exact: boolean,
) {
  const a = reference.sources[index].cameraRegistration.planes,
    b = candidate.sources[index].cameraRegistration.planes
  expect(a).toHaveLength(3)
  expect(b).toHaveLength(3)
  return comparePlaneFiles(
    join(reference.directory, `source-${index}.camera.plane`),
    join(candidate.directory, `source-${index}.camera.plane`),
    a,
    b,
    exact,
  )
}

function assertDifference(result: Difference, label: string, exact: boolean, check = expect) {
  check(result.samples, `${label}: complete sample coverage`).toBeGreaterThan(0)
  check(result.nonfinite, `${label}: finite samples`).toBe(0)
  check(
    result.rgbMismatches,
    `${label}: RGB tolerance ${JSON.stringify(result.firstMismatch)}`,
  ).toBe(0)
  check(result.alphaMismatches, `${label}: exact validity/alpha`).toBe(0)
  check(result.referenceStripMismatches ?? 0, `${label}: frozen reference checksums`).toBe(0)
  check(result.candidateStripMismatches ?? 0, `${label}: candidate checksums`).toBe(0)
  if (exact)
    check(
      result.wordMismatches,
      `${label}: frozen CPU words ${JSON.stringify(result.firstWordMismatch)}`,
    ).toBe(0)
}

function geometryDifference(reference: MergeRecipe, candidate: MergeRecipe): GeometryDifference {
  const dimensions = (recipe: MergeRecipe) => ({
    width: recipe.width,
    height: recipe.height,
    crop: recipe.crop,
    maskDimensions: recipe.maskDimensions,
  })
  const model = (source: MergeRecipe['sources'][number]) => ({
    model: source.transform.diagnostics?.model,
    method: source.transform.diagnostics?.method,
    channel: source.transform.diagnostics?.registrationChannel,
    matrix: source.transform.matrix,
  })
  return {
    reference: dimensions(reference),
    candidate: dimensions(candidate),
    cropDelta: {
      left: candidate.crop.left - reference.crop.left,
      top: candidate.crop.top - reference.crop.top,
      width: candidate.crop.width - reference.crop.width,
      height: candidate.crop.height - reference.crop.height,
    },
    sources: candidate.sources.map((source) => {
      const before = reference.sources.find((entry) => entry.id === source.id)
      if (!before) throw new Error('A compared registration source is missing from the reference.')
      const a = model(before),
        b = model(source),
        matrixDelta =
          a.matrix && b.matrix && a.matrix.length === b.matrix.length
            ? b.matrix.map((value, index) => value - a.matrix![index])
            : undefined
      return {
        id: source.id,
        reference: a,
        candidate: b,
        matrixDelta,
        maximumMatrixDelta: matrixDelta ? Math.max(...matrixDelta.map(Math.abs)) : undefined,
        scaleDelta: source.scale - before.scale,
      }
    }),
  }
}

async function motionIdentity(path: string) {
  if ((await stat(path)).size > MERGE_LIMITS.maxPixels)
    throw new Error('Motion snapshot exceeds the native mask bound.')
  const digest = createHash('sha256')
  let bytes = 0,
    nonzero = 0
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk)
    bytes += chunk.length
    for (const value of chunk) nonzero += Number(value !== 0)
  }
  return { bytes, sha256: digest.digest('hex'), nonzero }
}

/** Hash complete masks and compare every native pixel using two fixed 64 KiB buffers. */
async function compareMotion(
  referencePath: string,
  candidatePath: string,
  referenceDimensions: MergeRecipe['maskDimensions'],
  candidateDimensions: MergeRecipe['maskDimensions'],
): Promise<MotionDifference> {
  const a = await motionIdentity(referencePath),
    b = await motionIdentity(candidatePath),
    result: MotionDifference = {
      reference: { dimensions: referenceDimensions, bytes: a.bytes, sha256: a.sha256 },
      candidate: { dimensions: candidateDimensions, bytes: b.bytes, sha256: b.sha256 },
      dimensionsMatch:
        referenceDimensions.width === candidateDimensions.width &&
        referenceDimensions.height === candidateDimensions.height,
      comparedPixels: 0,
      pixelMismatches: 0,
      bitMismatches: 0,
      mismatchesByBit: Array.from({ length: 8 }, () => 0),
      referenceNonzeroPixels: a.nonzero,
      candidateNonzeroPixels: b.nonzero,
      firstMismatches: [],
    }
  if (
    a.bytes !== referenceDimensions.width * referenceDimensions.height ||
    b.bytes !== candidateDimensions.width * candidateDimensions.height
  )
    throw new Error('Incomplete motion snapshot; pixel comparison cannot be completed.')
  // Distinct native grids have no shared linear pixel index. Retain both full
  // identities and fail the unchanged dimensions gate after other proofs finish.
  if (!result.dimensionsMatch) return result
  const reference = await open(referencePath, 'r'),
    bufferA = Buffer.allocUnsafe(64 * 1024),
    bufferB = Buffer.allocUnsafe(bufferA.length)
  let candidate: FileHandle | undefined
  try {
    candidate = await open(candidatePath, 'r')
    for (let offset = 0; offset < a.bytes; offset += bufferA.length) {
      const count = Math.min(bufferA.length, a.bytes - offset),
        before = bufferA.subarray(0, count),
        after = bufferB.subarray(0, count)
      await readExact(reference, before, offset)
      await readExact(candidate, after, offset)
      for (let i = 0; i < count; i++) {
        const xor = before[i] ^ after[i]
        if (!xor) continue
        result.pixelMismatches++
        for (let bit = 0; bit < 8; bit++)
          if (xor & (1 << bit)) {
            result.bitMismatches++
            result.mismatchesByBit[bit]++
          }
        if (result.firstMismatches.length < 16)
          result.firstMismatches.push({
            x: (offset + i) % referenceDimensions.width,
            y: Math.floor((offset + i) / referenceDimensions.width),
            reference: before[i],
            candidate: after[i],
            xor,
          })
      }
      result.comparedPixels += count
    }
    return result
  } finally {
    try {
      await reference.close()
    } finally {
      await candidate?.close()
    }
  }
}

function workingIdentity(source: Omit<SourceManifest, 'cameraRegistration'>, exact = true) {
  return {
    width: source.width,
    height: source.height,
    ...(exact
      ? { strips: source.strips, plane: source.plane }
      : { plane: { width: source.plane.width, height: source.plane.height } }),
    decoder: source.decoder,
    cameraProfile: source.cameraProfile,
    normalization: source.normalization,
    sensor: source.sensor && {
      version: source.sensor.version,
      raw: source.sensor.raw,
      gains: source.sensor.gains,
      correction: source.sensor.correction,
      sensor: { bytes: source.sensor.sensor.bytes, sha256: source.sensor.sensor.sha256 },
      alpha: { bytes: source.sensor.alpha.bytes, sha256: source.sensor.alpha.sha256 },
      lens: { bytes: source.sensor.lens.bytes, sha256: source.sensor.lens.sha256 },
    },
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'runtimeMs',
            'wasmMemoryBytes',
            'cameraPreparation',
            'cameraEvidence',
            'referenceFallbackPreparation',
          ].includes(key) && !/^(?:id|path)$|(?:Id|Ids|Path|Paths)$/.test(key),
      )
      .map(([key, item]) => [key, normalize(item)]),
  )
}

function assertRegistrationCameraEvidence(snapshot: Snapshot, check = expect) {
  const recorded = JSON.parse(snapshot.registration.data) as {
    cameraEvidence?: { strips: string[]; planes: string[] }[]
  }
  check(sha256(Buffer.from(snapshot.registration.data)), 'Registration data checksum').toBe(
    snapshot.registration.sha256,
  )
  if (snapshot.sources.some((source) => source.cameraPreparation !== undefined))
    check(
      recorded.cameraEvidence,
      'GPU policy registration binds the retained camera evidence',
    ).toEqual(
      snapshot.sources.map((source) => ({
        strips: source.cameraRegistration.strips,
        planes: source.cameraRegistration.planes.map((plane) => plane.sha256),
      })),
    )
  else
    check(
      recorded.cameraEvidence,
      'Legacy CPU registration provenance stays unchanged',
    ).toBeUndefined()
}

async function snapshotPrepared(directory: string, snapshotDirectory: string): Promise<Snapshot> {
  await mkdir(snapshotDirectory, { recursive: true })
  const sources: SourceManifest[] = []
  for (let index = 0; index < 3; index++) {
    const manifest = JSON.parse(
      await readFile(join(directory, `source-${index}.json`), 'utf8'),
    ) as {
      source: SourceManifest
    }
    sources.push(manifest.source)
    // Both roots are test-owned directories on the same project filesystem.
    // Immutable hard links retain evidence without adding a timed full-file copy.
    for (const suffix of ['camera.f32', 'camera.plane'])
      await link(
        join(directory, `source-${index}.${suffix}`),
        join(snapshotDirectory, `source-${index}.${suffix}`),
      )
  }
  const fallback = await readFile(join(directory, 'reference-fallback/source-0.json'), 'utf8')
      .then((text) => JSON.parse(text) as Snapshot['fallback'])
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      }),
    registration = JSON.parse(
      await readFile(join(directory, 'registration.json'), 'utf8'),
    ) as Snapshot['registration'],
    result = { sources, fallback, registration, directory: snapshotDirectory }
  if (fallback)
    for (const suffix of ['f32', 'plane'])
      await link(
        join(directory, 'reference-fallback', `source-0.${suffix}`),
        join(snapshotDirectory, `reference-fallback.${suffix}`),
      )
  await writeFile(join(snapshotDirectory, 'preparation.json'), JSON.stringify(result, null, 2))
  return result
}

async function entries(path: string) {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
}

async function seedLibrary(root: string, originals: Original[], sample: Sample) {
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  try {
    for (const original of originals) {
      const directory = join(root, 'originals', original.sha256),
        path = join(directory, 'original.arw')
      await mkdir(directory, { recursive: true })
      await cp(original.path, path)
      const identity = await fileIdentity(path)
      sample.managedOriginalsBefore.push({ filename: original.name, ...identity })
      expect(identity).toEqual({ sha256: original.sha256, bytes: original.bytes })
      db.prepare("INSERT INTO photos VALUES (?, ?, ?, 'hdr-v1')").run(
        original.sha256,
        '2026-10-18T00:00:00.000Z',
        JSON.stringify({
          id: original.sha256,
          filename: original.name,
          format: 'ARW',
          width: original.width,
          height: original.height,
          bytes: original.bytes,
          importedAt: '2026-10-18T00:00:00.000Z',
          thumbnailUrl: '',
          previewUrl: '',
          previewSource: 'decoded',
        }),
      )
      db.prepare('INSERT INTO processing VALUES (?, ?)').run(
        original.sha256,
        JSON.stringify({
          processing: 'hdr-v1',
          metadata: original.metadata,
          settings: automaticLensSettings,
          revision: 0,
        }),
      )
      seedFixtureEdits(db)
    }
  } finally {
    db.close()
  }
}

function assertNativeValidation(recipe: MergeRecipe, check = expect) {
  const moving = recipe.sources.filter((source) => source.id !== recipe.settings.referenceId)
  check(moving).toHaveLength(2)
  for (const source of moving) {
    const d = source.transform.diagnostics!
    check(d.algorithm).toBe(ALIGNMENT_CONSTANTS.version)
    check(d.nativePatches.length).toBeGreaterThanOrEqual(ALIGNMENT_CONSTANTS.minimumPatches)
    check(
      d.nativePatches.filter((p) => p.accepted).length / d.nativePatches.length,
    ).toBeGreaterThanOrEqual(ALIGNMENT_CONSTANTS.minimumPatchAgreement)
    check(source.photometry?.validationCells).toBeGreaterThanOrEqual(
      BRK_EXPOSURE_POLICY.minimumCells,
    )
    check(source.photometry?.agreement).toBeGreaterThanOrEqual(BRK_EXPOSURE_POLICY.minimumAgreement)
    check(source.photometry?.medianResidualEv).toBeLessThanOrEqual(BRK_EXPOSURE_POLICY.residualEv)
  }
  const attempts = recipe.measurements!.attempts.filter((attempt) => attempt.success)
  check(attempts).toHaveLength(2)
  for (const attempt of attempts) {
    check(attempt.patches?.count).toBeGreaterThanOrEqual(ALIGNMENT_CONSTANTS.minimumPatches)
    check(attempt.reads?.nativePlanes.verifiedBytes).toBeGreaterThan(0)
    check(attempt.reads?.nativePlanes.verifiedBytes).toBe(attempt.reads?.nativePlanes.readBytes)
  }
}

// Real RAW preparation, native alignment and six durable publications are intentionally
// outside fast tests. Every operation owns fresh workers and an isolated managed library.
/* eslint-disable no-empty-pattern */
test('three fresh Sony HDR pairs retain exact working evidence and complete GPU preparation quality through publication', async ({}, info) => {
  test.setTimeout(15 * 60 * 1000)
  const pairSetting = process.env.LUMA_MERGE_GPU_PREPARATION_PAIRS,
    pairs = pairSetting === '1' ? 1 : 3,
    stageSetting = process.env.LUMA_MERGE_GPU_PREPARATION_STAGE,
    stage = (stageSetting ?? 'camera') as Sample['stage'],
    expectedSamples = pairs * 2,
    fixtureRoot = resolve('tests/fixtures/research-sony'),
    manifestPath = join(fixtureRoot, 'manifest.json'),
    manifestBytes = await readFile(manifestPath),
    manifest = JSON.parse(manifestBytes.toString('utf8')) as SonyManifest,
    sequence = manifest.sequences.find((entry) => entry.mode === 'hdr'),
    originals: Original[] = [],
    samples: Sample[] = [],
    failures: unknown[] = [],
    previousCamera = process.env.LUMA_MERGE_CAMERA_PREPARATION,
    previousReference = process.env.LUMA_MERGE_REFERENCE_PREPARATION,
    libraries = info.outputPath('libraries'),
    inspector = new PreviewProcess(resolve('out/main/preview-worker.js'))
  let reference: { snapshot: Snapshot; sample: Sample; master: string } | undefined
  expect(
    pairSetting === undefined || pairSetting === '1' || pairSetting === '3',
    'LUMA_MERGE_GPU_PREPARATION_PAIRS accepts 1 for diagnostics or 3 for complete native acceptance.',
  ).toBe(true)
  expect(
    ['camera', 'reference', 'both'].includes(stage),
    'LUMA_MERGE_GPU_PREPARATION_STAGE accepts camera (default), reference, or both.',
  ).toBe(true)
  expect(manifest.version).toBe(1)
  expect(sequence?.complete, 'The committed native HDR bracket is required.').toBe(true)
  expect(sequence!.files).toHaveLength(3)
  try {
    for (const name of sequence!.files) {
      const entry = manifest.files.find((file) => file.name === name)!,
        path = resolve(fixtureRoot, entry.path)
      expect(path.startsWith(`${fixtureRoot}${sep}`)).toBe(true)
      expect(await fileIdentity(path)).toEqual({ sha256: entry.sha256, bytes: entry.bytes })
      originals.push({
        path,
        name,
        sha256: entry.sha256,
        bytes: entry.bytes,
        width: entry.dimensions.activeWidth,
        height: entry.dimensions.activeHeight,
        metadata: await inspector.inspect(path, new AbortController().signal),
      })
    }
  } finally {
    await inspector.close()
  }
  const workerChunks = (await readdir('out/main/chunks'))
      .filter((name) => name.endsWith('.js'))
      .sort(),
    source = {
      ...(await provenance([
        manifestPath,
        'package-lock.json',
        'tests/merge-gpu-preparation-native.spec.ts',
        'out/main/merge-worker.js',
        'out/main/preview-worker.js',
        'out/main/alignment-worker.js',
        ...workerChunks.map((name) => join('out/main/chunks', name)),
        'src/main/library.ts',
        'src/main/gpu/raw-renderer.ts',
        'src/main/merge/process.ts',
        'src/main/preview-process.ts',
        'src/main/preview-engine.ts',
        'src/main/preview-worker.ts',
        'src/main/merge/alignment-pool.ts',
        'src/main/merge/alignment-worker.ts',
        'src/main/merge/engine.ts',
        'src/main/merge/prepare.ts',
        'src/main/merge/camera-registration.ts',
        'src/main/merge/gpu-camera-registration.ts',
        'src/main/merge/gpu-reference-fallback.ts',
        'src/main/merge/fallback-geometry.ts',
        'src/main/merge/camera-preparation-policy.ts',
        'src/main/merge/cpu-kernels.ts',
        'src/main/merge/kernels/prepare.c',
        'vendor/merge-kernels/manifest.json',
        'vendor/merge-kernels/luma-merge-kernels.wasm',
        'src/main/merge/preparation-cache.ts',
        'src/main/merge/store.ts',
        'src/shared/merge.ts',
      ])),
      build:
        'Built production merge/preview/alignment workers and shared chunks; main PhotoLibrary through Playwright.',
    }
  await mkdir(libraries, { recursive: true })
  try {
    for (let iteration = 0; iteration < pairs; iteration++)
      for (const backend of ['cpu', 'gpu'] as const) {
        const cameraGpu = backend === 'gpu' && stage !== 'reference',
          referenceGpu = backend === 'gpu' && stage !== 'camera'
        process.env.LUMA_MERGE_CAMERA_PREPARATION = cameraGpu ? 'gpu' : 'cpu'
        process.env.LUMA_MERGE_REFERENCE_PREPARATION = referenceGpu ? 'gpu' : 'cpu'
        const sample: Sample = {
            stage,
            backend,
            iteration,
            phase: 'setup',
            managedOriginalsBefore: [],
            managedOriginalsAfter: [],
          },
          root = await mkdtemp(join(libraries, `${backend}-${iteration}-`)),
          snapshotDirectory = info.outputPath(`${backend}-${iteration}-native`)
        sample.root = root
        samples.push(sample)
        let observe = () => {},
          taskId = '',
          timer: ReturnType<typeof setTimeout> | undefined,
          qualityErrorStart = info.errors.length
        const library = new PhotoLibrary(
          root,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          () => observe(),
          undefined,
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
          resolve('out/main/merge-worker.js'),
          undefined,
          new PreviewProcess(resolve('out/main/preview-worker.js')),
        )
        try {
          await library.open()
          await seedLibrary(root, originals, sample)
          expect(await entries(join(root, 'merge-reviews'))).toEqual([])
          sample.phase = 'create-review'
          const started = performance.now(),
            review = await library.createMergeReview(
              originals.map((original) => original.sha256),
              'hdr',
            ),
            created = performance.now()
          sample.reviewId = review.id
          sample.createReviewMs = created - started
          sample.phase = 'native-review'
          const preview = await library.requestMergePreview(review.id, review.revision),
            ready = performance.now()
          sample.nativeReviewMs = ready - created
          sample.recipe = preview.recipe
          sample.phase = 'diagnostic-snapshot'
          const snapshot = await snapshotPrepared(
              join(root, 'merge-reviews', review.id, 'prepared'),
              snapshotDirectory,
            ),
            publishing = performance.now()
          sample.snapshot = snapshot
          sample.diagnosticSnapshotMs = publishing - ready
          sample.phase = 'publication'
          const complete = new Promise<{ task: BackgroundTask; at: number }>(
            (resolveTask, reject) => {
              timer = setTimeout(
                () => reject(new Error('Native preparation publication did not complete.')),
                180000,
              )
              observe = () => {
                const task = library.listTasks().find((item) => item.id === taskId)
                if (task?.finishedAt)
                  resolveTask({ task: structuredClone(task), at: performance.now() })
              }
            },
          )
          taskId = library.startMerge(review.id, review.revision)
          sample.taskId = taskId
          observe()
          const completed = await complete
          clearTimeout(timer)
          timer = undefined
          observe = () => {}
          sample.task = completed.task
          sample.completeOperationMs = completed.at - started
          sample.publicationAndCleanupMs = completed.at - publishing
          sample.phase = 'quality'
          qualityErrorStart = info.errors.length
          const checking = performance.now(),
            check = expect.configure({ soft: true }),
            collect = async (scope: string, proof: () => Promise<void>) => {
              try {
                await proof()
              } catch (error) {
                const errors = (sample.comparisonErrors ??= [])
                errors.push({ scope, error: errorEvidence(error) })
              }
            }
          check(completed.task.status, JSON.stringify(library.taskErrors(taskId))).toBe('completed')
          check(review.revision).toBe(0)
          check(preview.recipe.resolution).toBe('native')
          check(preview.recipe.settings).toMatchObject({
            mode: 'hdr',
            autoAlign: true,
            autoCrop: true,
            deghost: true,
          })
          check(preview.recipe.settings).toEqual(review.settings)
          check(preview.width).toBe(preview.recipe.crop.width)
          check(preview.height).toBe(preview.recipe.crop.height)
          check(Math.max(preview.width, preview.height)).toBeGreaterThan(5000)
          check(preview.recipe.measurements!.preparation).toHaveLength(3)
          for (const prepared of preview.recipe.measurements!.preparation) {
            check(prepared.backend).toBe('gpu')
            check(prepared.reused).toBe(false)
            if (cameraGpu) {
              check(prepared.work?.cameraPreparation).toMatchObject({
                policy: GPU_CAMERA_PREPARATION,
                backend: 'gpu',
              })
              check(prepared.work?.cameraPreparation?.fallback).toBeUndefined()
            } else check(prepared.work?.cameraPreparation).toBeUndefined()
          }
          check(preview.recipe.cameraPreparation).toBe(
            cameraGpu ? GPU_CAMERA_PREPARATION : undefined,
          )
          check(preview.recipe.referenceFallbackPreparation).toBe(
            referenceGpu ? GPU_REFERENCE_PREPARATION : undefined,
          )
          for (const prepared of snapshot.sources) {
            check(prepared.cameraPreparation).toBe(cameraGpu ? GPU_CAMERA_PREPARATION : undefined)
            check(prepared.referenceFallbackPreparation).toBeUndefined()
          }
          for (const prepared of preview.recipe.sources)
            check(prepared.cameraPreparation).toBe(cameraGpu ? GPU_CAMERA_PREPARATION : undefined)
          assertRegistrationCameraEvidence(snapshot, check)
          check(snapshot.fallback, 'The native bracket exercises reference fallback').toBeTruthy()
          check(snapshot.fallback?.source.referenceFallbackPreparation).toBe(
            referenceGpu ? GPU_REFERENCE_PREPARATION : undefined,
          )
          check(snapshot.fallback?.source.cameraPreparation).toBeUndefined()
          await collect('independent native registration validation', async () =>
            assertNativeValidation(preview.recipe, check),
          )
          const measurements = completed.task.mergeMeasurements!
          for (const fallback of [
            preview.recipe.measurements!.referenceFallback,
            measurements.referenceFallback,
          ]) {
            check(fallback?.backend, 'Actual reference fallback backend').toBe(
              referenceGpu ? 'gpu' : 'cpu',
            )
            check(fallback?.reused, 'Fresh reference fallback preparation').toBe(false)
            if (referenceGpu) {
              check(fallback?.work?.referencePreparation).toMatchObject({
                policy: GPU_REFERENCE_PREPARATION,
                backend: 'gpu',
              })
              check(fallback?.work?.referencePreparation?.fallback).toBeUndefined()
            } else check(fallback?.work?.referencePreparation).toBeUndefined()
          }
          check(measurements.accumulation.backend).toBe('gpu')
          check(measurements.output?.backend).toBe('gpu')
          check(measurements.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
          check(measurements.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
          check(preview.recipe.measurements!.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
          check(preview.recipe.measurements!.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
          check(library.getActiveMergeReview()).toBeNull()
          check(await entries(join(root, 'merge-reviews'))).toEqual([])
          check(await entries(join(root, 'merge-publications'))).toEqual([])
          const { manifest: published, reproducible } = await library.getMergeProvenance(
              completed.task.resultPhotoId!,
            ),
            masterDirectory = join(root, 'originals', completed.task.resultPhotoId!),
            master = join(snapshotDirectory, 'linear.f32')
          sample.asset = published.asset
          check(reproducible).toBe(true)
          check(published.recipe).toEqual(preview.recipe)
          await collect('published master verification', () =>
            verifyMaster(masterDirectory, published),
          )
          await collect('published master snapshot', () =>
            link(join(masterDirectory, 'linear.f32'), master),
          )
          await collect('published motion snapshot', async () => {
            const path = join(masterDirectory, 'motion.mask')
            if ((await stat(path)).size > MERGE_LIMITS.maxPixels)
              throw new Error('Motion snapshot exceeds the native mask bound.')
            await link(path, join(snapshotDirectory, 'motion.mask'))
          })
          const db = new DatabaseSync(join(root, 'catalog.sqlite'))
          try {
            check(db.prepare('SELECT COUNT(*) AS count FROM merge_publications').get()).toEqual({
              count: 0,
            })
          } finally {
            db.close()
          }
          for (const original of originals) {
            const identity = await fileIdentity(
              join(root, 'originals', original.sha256, 'original.arw'),
            )
            sample.managedOriginalsAfter.push({ filename: original.name, ...identity })
            check(identity).toEqual({ sha256: original.sha256, bytes: original.bytes })
          }
          if (!reference && backend === 'cpu') {
            reference = { snapshot, sample, master }
            sample.proofComplete = !sample.comparisonErrors?.length
          } else {
            check(
              reference,
              'A successful frozen CPU operation must precede every candidate.',
            ).toBeDefined()
            if (!reference) throw new Error('No frozen CPU reference is available for comparison.')
            const frozen = reference!,
              exact = backend === 'cpu',
              // The compensated v2 camera writer promises the CPU's Float32 words.
              cameraExact = true,
              fallbackExact = !referenceGpu
            await collect('registration and crop differences', async () => {
              sample.geometryComparison = geometryDifference(frozen.sample.recipe!, preview.recipe)
            })
            await collect('complete motion mask comparison', async () => {
              sample.motionComparison = await compareMotion(
                join(frozen.snapshot.directory, 'motion.mask'),
                join(snapshot.directory, 'motion.mask'),
                frozen.sample.recipe!.maskDimensions,
                preview.recipe.maskDimensions,
              )
            })
            sample.cameraComparisons = []
            for (let index = 0; index < 3; index++) {
              const a = frozen.snapshot.sources[index],
                b = snapshot.sources[index],
                comparison: NonNullable<Sample['cameraComparisons']>[number] = { index }
              sample.cameraComparisons.push(comparison)
              await collect(`native camera source ${index}`, async () => {
                comparison.native = await compareRgba(
                  join(frozen.snapshot.directory, `source-${index}.camera.f32`),
                  join(snapshot.directory, `source-${index}.camera.f32`),
                  a.width,
                  a.height,
                  a.cameraRegistration.strips,
                  b.cameraRegistration.strips,
                  cameraExact,
                )
              })
              await collect(`reduced camera source ${index}`, async () => {
                comparison.planes = await comparePlanes(
                  frozen.snapshot,
                  snapshot,
                  index,
                  cameraExact,
                )
              })
            }
            if (snapshot.fallback && frozen.snapshot.fallback) {
              const a = frozen.snapshot.fallback.source,
                b = snapshot.fallback.source,
                comparison = (sample.fallbackComparison = {} as NonNullable<
                  Sample['fallbackComparison']
                >)
              await collect('native reference fallback', async () => {
                comparison.native = await compareRgba(
                  join(frozen.snapshot.directory, 'reference-fallback.f32'),
                  join(snapshot.directory, 'reference-fallback.f32'),
                  a.width,
                  a.height,
                  a.strips,
                  b.strips,
                  fallbackExact,
                )
              })
              await collect('reduced reference fallback', async () => {
                comparison.plane = await comparePlaneFiles(
                  join(frozen.snapshot.directory, 'reference-fallback.plane'),
                  join(snapshot.directory, 'reference-fallback.plane'),
                  [a.plane],
                  [b.plane],
                  fallbackExact,
                )
              })
            }
            await collect('complete Float32 master comparison', async () => {
              sample.masterComparison = await compareRgba(
                frozen.master,
                master,
                published.asset.width,
                published.asset.height,
                frozen.sample.asset!.strips.map((strip) => strip.sha256),
                published.asset.strips.map((strip) => strip.sha256),
                exact,
              )
            })
            // Preserve every gate, but finish independent pixel proofs before a
            // motion/crop/registration discrepancy can fail this operation.
            check([
              preview.recipe.width,
              preview.recipe.height,
              preview.recipe.crop,
              preview.recipe.maskDimensions,
              preview.recipe.maskSha256,
            ]).toEqual([
              frozen.sample.recipe!.width,
              frozen.sample.recipe!.height,
              frozen.sample.recipe!.crop,
              frozen.sample.recipe!.maskDimensions,
              frozen.sample.recipe!.maskSha256,
            ])
            check(snapshot.sources).toHaveLength(frozen.snapshot.sources.length)
            check(Boolean(snapshot.fallback)).toBe(Boolean(frozen.snapshot.fallback))
            if (snapshot.fallback && frozen.snapshot.fallback)
              check(workingIdentity(snapshot.fallback.source, fallbackExact)).toEqual(
                workingIdentity(frozen.snapshot.fallback.source, fallbackExact),
              )
            for (
              let index = 0;
              index < Math.min(snapshot.sources.length, frozen.snapshot.sources.length);
              index++
            ) {
              const a = frozen.snapshot.sources[index],
                b = snapshot.sources[index]
              check(workingIdentity(b), `Working source ${index} remains exact`).toEqual(
                workingIdentity(a),
              )
              check(b.cameraRegistration.version).toBe(a.cameraRegistration.version)
            }
            for (const [index, comparison] of sample.cameraComparisons.entries()) {
              check(
                comparison.native,
                `Native camera source ${index} proof is present`,
              ).toBeDefined()
              check(
                comparison.planes,
                `Reduced camera source ${index} proof is present`,
              ).toBeDefined()
              if (comparison.native)
                assertDifference(
                  comparison.native,
                  `Native camera source ${index}`,
                  cameraExact,
                  check,
                )
              if (comparison.planes)
                assertDifference(
                  comparison.planes,
                  `Reduced camera source ${index}`,
                  cameraExact,
                  check,
                )
            }
            if (frozen.snapshot.fallback) {
              check(
                sample.fallbackComparison?.native,
                'Native reference fallback proof is present',
              ).toBeDefined()
              check(
                sample.fallbackComparison?.plane,
                'Reduced reference fallback proof is present',
              ).toBeDefined()
              if (sample.fallbackComparison?.native)
                assertDifference(
                  sample.fallbackComparison.native,
                  'Native reference fallback',
                  fallbackExact,
                  check,
                )
              if (sample.fallbackComparison?.plane)
                assertDifference(
                  sample.fallbackComparison.plane,
                  'Reduced reference fallback',
                  fallbackExact,
                  check,
                )
            }
            check(sample.masterComparison, 'Complete Float32 master proof is present').toBeDefined()
            if (sample.masterComparison) {
              assertDifference(sample.masterComparison, 'Complete Float32 master', exact, check)
              check(sample.masterComparison.candidateSha256).toBe(published.asset.sha256)
              check(sample.masterComparison.referenceSha256).toBe(frozen.sample.asset!.sha256)
            }
            check(sample.motionComparison, 'Complete motion mask proof is present').toBeDefined()
            if (sample.motionComparison) {
              const motion = sample.motionComparison
              check(motion.dimensionsMatch, 'Motion mask coordinate grids match').toBe(true)
              check(motion.comparedPixels, 'Every motion pixel is compared').toBe(
                motion.reference.bytes,
              )
              check(motion.reference.sha256, 'Frozen reference motion checksum').toBe(
                frozen.sample.recipe!.maskSha256,
              )
              check(motion.candidate.sha256, 'Candidate motion checksum').toBe(
                preview.recipe.maskSha256,
              )
              check(motion.pixelMismatches, 'Exact motion mask pixels').toBe(0)
              check(motion.bitMismatches, 'Exact motion mask bits').toBe(0)
            }
            if (cameraExact)
              check(normalize(JSON.parse(snapshot.registration.data))).toEqual(
                normalize(JSON.parse(frozen.snapshot.registration.data)),
              )
            sample.proofComplete =
              !sample.comparisonErrors?.length &&
              sample.cameraComparisons.length === 3 &&
              sample.cameraComparisons.every(
                (comparison) => comparison.native && comparison.planes,
              ) &&
              (!frozen.snapshot.fallback ||
                (!!sample.fallbackComparison?.native && !!sample.fallbackComparison.plane)) &&
              !!sample.masterComparison &&
              !!sample.motionComparison?.dimensionsMatch
          }
          check(sample.proofComplete, 'All available native quality proofs completed').toBe(true)
          sample.qualityFailures = [
            ...info.errors
              .slice(qualityErrorStart)
              .map(({ message, stack }) => ({ message, stack })),
            ...(sample.comparisonErrors ?? []).map(({ scope, error }) => ({
              message: `${scope}: ${error.message}`,
              stack: 'stack' in error ? error.stack : undefined,
            })),
          ]
          sample.qualityAfterClockMs = performance.now() - checking
          sample.phase = sample.qualityFailures.length ? 'failed-quality' : 'complete'
          if (sample.qualityFailures.length) {
            const error = new Error(
              `${backend} operation ${iteration + 1} failed ${sample.qualityFailures.length} retained quality checks.`,
            )
            sample.error = errorEvidence(error)
            failures.push(error)
          }
        } catch (error) {
          sample.error = errorEvidence(error)
          failures.push(error)
          sample.qualityFailures ??= info.errors
            .slice(qualityErrorStart)
            .map(({ message, stack }) => ({ message, stack }))
          if (taskId)
            sample.task = structuredClone(library.listTasks().find((task) => task.id === taskId))
        } finally {
          if (timer) clearTimeout(timer)
          observe = () => {}
          try {
            await library.close()
            await rm(root, { recursive: true, force: true })
            sample.cleaned = true
          } catch (error) {
            sample.cleanupError = errorEvidence(error)
            failures.push(error)
          }
          sample.snapshotRetained =
            (backend === 'cpu' && iteration === 0) ||
            reference?.snapshot.directory === snapshotDirectory ||
            (backend === 'gpu' && (sample.phase !== 'complete' || !!sample.cleanupError))
          if (sample.snapshotRetained)
            sample.snapshotBytes = (
              await Promise.all(
                (await entries(snapshotDirectory)).map(
                  async (name) => (await stat(join(snapshotDirectory, name))).size,
                ),
              )
            ).reduce((sum, bytes) => sum + bytes, 0)
          else await rm(snapshotDirectory, { recursive: true, force: true })
          await writeFile(
            info.outputPath(`${backend}-${iteration}.json`),
            JSON.stringify(sample, null, 2),
          )
        }
      }
  } finally {
    if (previousCamera === undefined) delete process.env.LUMA_MERGE_CAMERA_PREPARATION
    else process.env.LUMA_MERGE_CAMERA_PREPARATION = previousCamera
    if (previousReference === undefined) delete process.env.LUMA_MERGE_REFERENCE_PREPARATION
    else process.env.LUMA_MERGE_REFERENCE_PREPARATION = previousReference
    const originalsAfter = []
    for (const original of originals) {
      try {
        const identity = await fileIdentity(original.path)
        originalsAfter.push({ filename: original.name, ...identity })
        expect(identity).toEqual({ sha256: original.sha256, bytes: original.bytes })
      } catch (error) {
        failures.push(error)
      }
    }
    const times = (backend: 'cpu' | 'gpu') =>
        samples
          .filter(
            (sample) => sample.backend === backend && sample.completeOperationMs !== undefined,
          )
          .map((sample) => sample.completeOperationMs!),
      cpu = times('cpu'),
      gpu = times('gpu'),
      median = (values: number[]) =>
        values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null,
      paired = Array.from({ length: pairs }, (_, iteration) => {
        const control = samples.find(
            (sample) => sample.backend === 'cpu' && sample.iteration === iteration,
          ),
          candidate = samples.find(
            (sample) => sample.backend === 'gpu' && sample.iteration === iteration,
          )
        return {
          iteration,
          cpuMs: control?.completeOperationMs,
          gpuMs: candidate?.completeOperationMs,
          candidateOverControl:
            control?.completeOperationMs && candidate?.completeOperationMs
              ? candidate.completeOperationMs / control.completeOperationMs
              : null,
        }
      }),
      evidence = info.outputPath('merge-gpu-preparation-native.json'),
      completedValidations = samples.filter((sample) => sample.phase === 'complete').length,
      completeProofs = samples.filter((sample) => sample.proofComplete).length,
      retainedSnapshotBytes = samples.reduce((sum, sample) => sum + (sample.snapshotBytes ?? 0), 0),
      acceptanceComplete =
        pairs === 3 &&
        samples.length === 6 &&
        completedValidations === 6 &&
        !failures.length &&
        retainedSnapshotBytes <= 7 * 1024 ** 3,
      record = {
        classification:
          'Matched complete service operations; visible workflow remains a separate acceptance.',
        stage,
        controlPolicies: { camera: 'cpu', reference: 'cpu' },
        candidatePolicies: {
          camera: stage === 'reference' ? 'cpu' : GPU_CAMERA_PREPARATION,
          reference: stage === 'camera' ? 'cpu' : GPU_REFERENCE_PREPARATION,
        },
        freshLibrariesAndWorkers: true,
        includesFreshCaptureAdmission: true,
        includesRawDecoding: true,
        includesNativeReviewAndValidation: true,
        includesDurablePublicationAndCleanup: true,
        includesBoundedSnapshotStaging: true,
        excludesImportAndMetadataSetup: true,
        includesElectronPresentation: false,
        snapshotPolicy:
          'Immutable same-filesystem hard links; first frozen CPU and all failed GPU camera/plane/reference-fallback/master/motion snapshots retained. Passing nonreference snapshots removed. Fixed three-pair limit permits at most four retained native snapshots within 7 GiB; no earlier invocation evidence is removed.',
        clock:
          'Uninterrupted performance.now before createMergeReview through immediate completed task event after review cleanup.',
        ordinaryRunsPerBackend: pairs,
        requestedPairs: pairSetting ?? '3',
        diagnosticOnly: pairs !== 3,
        expectedSamples,
        measuredSamples: samples.length,
        completedValidations,
        completeProofs,
        acceptanceComplete,
        retainedSnapshotBytes,
        snapshotStorageLimitBytes: 7 * 1024 ** 3,
        cpu,
        gpu,
        paired,
        cpuMedianMs: median(cpu),
        gpuMedianMs: median(gpu),
        cpuMaximumMs: cpu.length ? Math.max(...cpu) : null,
        gpuMaximumMs: gpu.length ? Math.max(...gpu) : null,
        timingAdoption:
          'Diagnostic pairs cannot establish acceptance. Adoption requires three complete ordinary pairs, all numerical/lifecycle gates, matched performance and separate visible workflow acceptance.',
        referenceDirectory: reference?.snapshot.directory,
        originalManifestSha256: sha256(manifestBytes),
        originalsBefore: originals.map(({ name, sha256, bytes }) => ({
          filename: name,
          sha256,
          bytes,
        })),
        originalsAfter,
        failures: failures.map(errorEvidence),
        samples,
        provenance: source,
      }
    if (retainedSnapshotBytes > record.snapshotStorageLimitBytes)
      failures.push(
        new Error('Retained native snapshots exceed the fixed 7 GiB evidence allowance.'),
      )
    record.failures = failures.map(errorEvidence)
    await writeFile(evidence, JSON.stringify(record, null, 2))
    const summaries = samples.map((sample) => {
      const camera = (sample.cameraComparisons ?? []).flatMap((comparison) =>
          [comparison.native, comparison.planes].filter((proof): proof is Difference => !!proof),
        ),
        maximum = (key: 'maximumToleranceRatio' | 'maximumAbsolute') =>
          camera.length ? Math.max(...camera.map((proof) => proof[key])) : null
      return {
        stage,
        backend: sample.backend,
        iteration: sample.iteration,
        phase: sample.phase,
        completeOperationMs: sample.completeOperationMs,
        stagesMs: sample.task?.mergeMeasurements?.stages,
        cameraPolicies: sample.recipe?.measurements?.preparation.map((prepared) => ({
          policy: prepared.work?.cameraPreparation?.policy ?? 'legacy-cpu',
          backend: prepared.work?.cameraPreparation?.backend ?? 'cpu',
          runtimeMs: prepared.work?.cameraPreparation?.runtimeMs,
        })),
        referencePolicy: {
          policy: sample.recipe?.referenceFallbackPreparation ?? 'legacy-cpu',
          backend: sample.recipe?.measurements?.referenceFallback?.backend,
          work: sample.recipe?.measurements?.referenceFallback?.work?.referencePreparation,
        },
        proofComplete: sample.proofComplete ?? false,
        failedQualityChecks: sample.qualityFailures?.length ?? 0,
        comparisonErrors: sample.comparisonErrors?.map(({ scope, error }) => ({
          scope,
          message: error.message.slice(0, 300),
        })),
        firstQualityFailures: sample.qualityFailures
          ?.slice(0, 2)
          .map((error) => error.message?.slice(0, 300)),
        cameraMaximumToleranceRatio: maximum('maximumToleranceRatio'),
        cameraMaximumAbsoluteError: maximum('maximumAbsolute'),
        cameraValidityMismatches: camera.reduce((sum, proof) => sum + proof.alphaMismatches, 0),
        cameraFirstWordMismatch: camera.find((proof) => proof.firstWordMismatch)?.firstWordMismatch,
        fallbackNativeMaximumToleranceRatio:
          sample.fallbackComparison?.native?.maximumToleranceRatio,
        fallbackNativeMaximumAbsoluteError: sample.fallbackComparison?.native?.maximumAbsolute,
        fallbackNativeAlphaMismatches: sample.fallbackComparison?.native?.alphaMismatches,
        fallbackPlaneMaximumToleranceRatio: sample.fallbackComparison?.plane?.maximumToleranceRatio,
        fallbackPlaneMaximumAbsoluteError: sample.fallbackComparison?.plane?.maximumAbsolute,
        fallbackPlaneMaskMismatches: sample.fallbackComparison?.plane?.alphaMismatches,
        masterMaximumToleranceRatio: sample.masterComparison?.maximumToleranceRatio,
        masterRgbMismatches: sample.masterComparison?.rgbMismatches,
        masterAlphaMismatches: sample.masterComparison?.alphaMismatches,
        masterFirstWordMismatch: sample.masterComparison?.firstWordMismatch,
        motionPixelMismatches: sample.motionComparison?.pixelMismatches,
        motionBitMismatches: sample.motionComparison?.bitMismatches,
        cropDelta: sample.geometryComparison?.cropDelta,
        sourceGeometry: sample.geometryComparison?.sources.map((geometry) => ({
          referenceModel: geometry.reference.model,
          candidateModel: geometry.candidate.model,
          maximumMatrixDelta: geometry.maximumMatrixDelta,
        })),
        snapshotRetained: sample.snapshotRetained,
        evidence: info.outputPath(`${sample.backend}-${sample.iteration}.json`),
      }
    })
    await recordBenchmark(info, {
      family: 'merge',
      measurements: {
        classification: record.classification,
        stage,
        controlPolicies: record.controlPolicies,
        candidatePolicies: record.candidatePolicies,
        diagnosticOnly: record.diagnosticOnly,
        acceptanceComplete,
        ordinaryRunsPerBackend: pairs,
        measuredSamples: samples.length,
        completedValidations,
        completeProofs,
        cpuMs: cpu,
        gpuMs: gpu,
        cpuMedianMs: record.cpuMedianMs,
        gpuMedianMs: record.gpuMedianMs,
        cpuMaximumMs: record.cpuMaximumMs,
        gpuMaximumMs: record.gpuMaximumMs,
        retainedSnapshotBytes,
        samples: summaries,
        fullEvidence: evidence,
        timingAdoption: record.timingAdoption,
      },
      gates: [],
      evidence: [evidence],
    })
  }
  if (failures.length) throw failures[0]
  expect(samples).toHaveLength(expectedSamples)
  expect(samples.filter((sample) => sample.phase === 'complete')).toHaveLength(expectedSamples)
})

interface NativeLifecycleRun {
  directory: string
  output: string
  result: import('../src/main/merge/engine').MergeResult
}
interface NativeLifecycleContext {
  root: string
  library: PhotoLibrary
  sample: Sample
  runs: NativeLifecycleRun[]
  notify: () => void
}
interface NativeLifecycleCapture {
  label: string
  reviewId: string
  revision: number
  recipe: MergeRecipe
  asset: HdrWorkingAsset
  snapshot: Snapshot
}
interface NativeLifecycleProof {
  camera: { native?: Difference; planes?: Difference }[]
  fallback?: { native?: Difference; plane?: Difference }
  master?: Difference
  motion?: MotionDifference
  geometry: GeometryDifference
  errors: { scope: string; error: ReturnType<typeof errorEvidence> }[]
}

async function nativeLifecycleOriginals(): Promise<Original[]> {
  const fixtureRoot = resolve('tests/fixtures/research-sony'),
    manifest = JSON.parse(
      await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'),
    ) as SonyManifest,
    sequence = manifest.sequences.find((entry) => entry.mode === 'hdr'),
    inspector = new PreviewProcess(resolve('out/main/preview-worker.js')),
    originals: Original[] = []
  expect(manifest.version).toBe(1)
  expect(sequence?.complete).toBe(true)
  expect(sequence!.files).toHaveLength(3)
  try {
    for (const name of sequence!.files) {
      const entry = manifest.files.find((file) => file.name === name)!,
        path = resolve(fixtureRoot, entry.path)
      expect(path.startsWith(`${fixtureRoot}${sep}`)).toBe(true)
      expect(await fileIdentity(path)).toEqual({
        sha256: entry.sha256,
        bytes: entry.bytes,
      })
      originals.push({
        path,
        name,
        sha256: entry.sha256,
        bytes: entry.bytes,
        width: entry.dimensions.activeWidth,
        height: entry.dimensions.activeHeight,
        metadata: await inspector.inspect(path, new AbortController().signal),
      })
    }
    return originals
  } finally {
    await inspector.close()
  }
}

function setNativeLifecyclePolicies(camera: boolean, reference: boolean) {
  const previous = {
    camera: process.env.LUMA_MERGE_CAMERA_PREPARATION,
    reference: process.env.LUMA_MERGE_REFERENCE_PREPARATION,
  }
  process.env.LUMA_MERGE_CAMERA_PREPARATION = camera ? 'gpu' : 'cpu'
  process.env.LUMA_MERGE_REFERENCE_PREPARATION = reference ? 'gpu' : 'cpu'
  return () => {
    if (previous.camera === undefined) delete process.env.LUMA_MERGE_CAMERA_PREPARATION
    else process.env.LUMA_MERGE_CAMERA_PREPARATION = previous.camera
    if (previous.reference === undefined) delete process.env.LUMA_MERGE_REFERENCE_PREPARATION
    else process.env.LUMA_MERGE_REFERENCE_PREPARATION = previous.reference
  }
}

async function openNativeLifecycleLibrary(
  info: import('@playwright/test').TestInfo,
  originals: Original[],
  label: string,
  stage: Sample['stage'],
  recipe?: MergeRecipe,
): Promise<NativeLifecycleContext> {
  const libraries = info.outputPath('lifecycle-libraries')
  await mkdir(libraries, { recursive: true })
  const root = await mkdtemp(join(libraries, `${label}-`)),
    context: NativeLifecycleContext = {
      root,
      library: undefined as unknown as PhotoLibrary,
      sample: {
        stage,
        backend: label === 'control' ? 'cpu' : 'gpu',
        iteration: 0,
        phase: 'setup',
        managedOriginalsBefore: [],
        managedOriginalsAfter: [],
      },
      runs: [],
      notify: () => {},
    },
    library = new PhotoLibrary(
      root,
      new PreviewProcess(resolve('out/main/preview-worker.js')),
      () => context.notify(),
      undefined,
      undefined,
      new PreviewProcess(resolve('out/main/preview-worker.js')),
      resolve('out/main/merge-worker.js'),
      undefined,
      new PreviewProcess(resolve('out/main/preview-worker.js')),
    )
  context.library = library
  // Only this Node test process owns the injection. PhotoLibrary still performs
  // capture admission, native review, durable publication and normal cleanup.
  library.merges.worker.run = async (job, signal) => {
    signal.throwIfAborted()
    const { runMerge } = await import('../src/main/merge/engine'),
      result = await runMerge({ ...job, ...(recipe ? { recipe } : {}) })
    signal.throwIfAborted()
    context.runs.push({ directory: job.directory, output: job.output, result })
    return result
  }
  try {
    await library.open()
    await seedLibrary(root, originals, context.sample)
    expect(await entries(join(root, 'merge-reviews'))).toEqual([])
    return context
  } catch (error) {
    await library.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function captureNativeLifecycle(
  info: import('@playwright/test').TestInfo,
  context: NativeLifecycleContext,
  review: { id: string; revision: number },
  label: string,
): Promise<NativeLifecycleCapture> {
  const preview = await context.library.requestMergePreview(review.id, review.revision),
    run = context.runs.at(-1)!,
    snapshotDirectory = info.outputPath(`${label}-native`)
  expect(preview.recipe).toEqual(run.result.recipe)
  expect(preview.recipe.resolution).toBe('native')
  expect(Math.max(preview.width, preview.height)).toBeGreaterThan(5000)
  expect(preview.recipe.measurements!.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
  expect(preview.recipe.measurements!.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
  try {
    const snapshot = await snapshotPrepared(run.directory, snapshotDirectory)
    // Cache changes rewrite reduced planes in place. Keep these smaller files
    // independent while immutable native files remain cheap hard links.
    for (let index = 0; index < snapshot.sources.length; index++) {
      const name = `source-${index}.camera.plane`
      await rm(join(snapshotDirectory, name))
      await cp(join(run.directory, name), join(snapshotDirectory, name))
    }
    if (snapshot.fallback) {
      await rm(join(snapshotDirectory, 'reference-fallback.plane'))
      await cp(
        join(run.directory, 'reference-fallback', 'source-0.plane'),
        join(snapshotDirectory, 'reference-fallback.plane'),
      )
    }
    for (const name of ['linear.f32', 'motion.mask'])
      await link(join(run.output, name), join(snapshot.directory, name))
    return {
      label,
      reviewId: review.id,
      revision: review.revision,
      recipe: preview.recipe,
      asset: run.result.asset,
      snapshot,
    }
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true })
    throw error
  }
}

async function publishNativeLifecycle(
  context: NativeLifecycleContext,
  capture: NativeLifecycleCapture,
  originals: Original[],
) {
  let taskId = '',
    timer: ReturnType<typeof setTimeout> | undefined
  try {
    const complete = new Promise<BackgroundTask>((resolveTask, reject) => {
      timer = setTimeout(() => reject(new Error('Lifecycle publication did not complete.')), 180000)
      context.notify = () => {
        const task = context.library.listTasks().find((entry) => entry.id === taskId)
        if (task?.finishedAt) resolveTask(structuredClone(task))
      }
    })
    taskId = context.library.startMerge(capture.reviewId, capture.revision)
    context.notify()
    const task = await complete
    context.sample.task = task
    expect(task.status, JSON.stringify(context.library.taskErrors(taskId))).toBe('completed')
    const { manifest, reproducible } = await context.library.getMergeProvenance(task.resultPhotoId!)
    expect(reproducible).toBe(true)
    expect(manifest.recipe).toEqual(capture.recipe)
    expect(manifest.asset).toEqual(capture.asset)
    await verifyMaster(join(context.root, 'originals', task.resultPhotoId!), manifest)
    expect(context.library.getActiveMergeReview()).toBeNull()
    expect(await entries(join(context.root, 'merge-reviews'))).toEqual([])
    expect(await entries(join(context.root, 'merge-publications'))).toEqual([])
    expect(task.mergeMeasurements!.peak.gpuBytes).toBeLessThanOrEqual(1024 ** 3)
    expect(task.mergeMeasurements!.peak.wasmBytes).toBeLessThanOrEqual(512 * 1024 ** 2)
    const db = new DatabaseSync(join(context.root, 'catalog.sqlite'))
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM merge_publications').get()).toEqual({
        count: 0,
      })
      expect(db.prepare('SELECT COUNT(*) AS count FROM derived_assets').get()).toEqual({ count: 1 })
    } finally {
      db.close()
    }
    for (const original of originals) {
      const managed = await fileIdentity(
          join(context.root, 'originals', original.sha256, 'original.arw'),
        ),
        fixture = await fileIdentity(original.path)
      context.sample.managedOriginalsAfter.push({
        filename: original.name,
        ...managed,
      })
      expect(managed).toEqual({
        sha256: original.sha256,
        bytes: original.bytes,
      })
      expect(fixture).toEqual(managed)
    }
    context.sample.phase = 'complete'
    context.sample.task = task
    return task
  } finally {
    if (timer) clearTimeout(timer)
    context.notify = () => {}
  }
}

async function closeNativeLifecycle(context: NativeLifecycleContext) {
  try {
    await context.library.close()
  } finally {
    await rm(context.root, { recursive: true, force: true })
    context.sample.cleaned = true
  }
}

/** Functional lifecycle evidence retains diagnostics and hashes; native binary links are temporary. */
async function removeNativeLifecycleSnapshots(captures: NativeLifecycleCapture[]) {
  for (const capture of captures)
    await rm(capture.snapshot.directory, { recursive: true, force: true })
}

async function compareNativeLifecycle(
  reference: NativeLifecycleCapture,
  candidate: NativeLifecycleCapture,
): Promise<NativeLifecycleProof> {
  const result: NativeLifecycleProof = {
      camera: [],
      geometry: geometryDifference(reference.recipe, candidate.recipe),
      errors: [],
    },
    collect = async (scope: string, proof: () => Promise<void>) => {
      try {
        await proof()
      } catch (error) {
        result.errors.push({ scope, error: errorEvidence(error) })
      }
    }
  for (let index = 0; index < 3; index++) {
    const comparison: NativeLifecycleProof['camera'][number] = {},
      a = reference.snapshot.sources[index],
      b = candidate.snapshot.sources[index]
    result.camera.push(comparison)
    await collect(`native camera ${index}`, async () => {
      comparison.native = await compareRgba(
        join(reference.snapshot.directory, `source-${index}.camera.f32`),
        join(candidate.snapshot.directory, `source-${index}.camera.f32`),
        a.width,
        a.height,
        a.cameraRegistration.strips,
        b.cameraRegistration.strips,
        true,
      )
    })
    await collect(`reduced camera ${index}`, async () => {
      comparison.planes = await comparePlanes(reference.snapshot, candidate.snapshot, index, true)
    })
  }
  if (reference.snapshot.fallback && candidate.snapshot.fallback) {
    const a = reference.snapshot.fallback.source,
      b = candidate.snapshot.fallback.source,
      comparison = (result.fallback = {} as NonNullable<NativeLifecycleProof['fallback']>)
    await collect('native reference fallback', async () => {
      comparison.native = await compareRgba(
        join(reference.snapshot.directory, 'reference-fallback.f32'),
        join(candidate.snapshot.directory, 'reference-fallback.f32'),
        a.width,
        a.height,
        a.strips,
        b.strips,
        true,
      )
    })
    await collect('reduced reference fallback', async () => {
      comparison.plane = await comparePlaneFiles(
        join(reference.snapshot.directory, 'reference-fallback.plane'),
        join(candidate.snapshot.directory, 'reference-fallback.plane'),
        [a.plane],
        [b.plane],
        true,
      )
    })
  }
  await collect('complete Float32 master', async () => {
    result.master = await compareRgba(
      join(reference.snapshot.directory, 'linear.f32'),
      join(candidate.snapshot.directory, 'linear.f32'),
      reference.asset.width,
      reference.asset.height,
      reference.asset.strips.map((strip) => strip.sha256),
      candidate.asset.strips.map((strip) => strip.sha256),
      true,
    )
  })
  await collect('complete motion mask', async () => {
    result.motion = await compareMotion(
      join(reference.snapshot.directory, 'motion.mask'),
      join(candidate.snapshot.directory, 'motion.mask'),
      reference.recipe.maskDimensions,
      candidate.recipe.maskDimensions,
    )
  })
  return result
}

function assertNativeLifecycleProof(
  reference: NativeLifecycleCapture,
  candidate: NativeLifecycleCapture,
  proof: NativeLifecycleProof,
) {
  const check = expect.configure({ soft: true })
  check(proof.errors).toEqual([])
  assertRegistrationCameraEvidence(reference.snapshot, check)
  assertRegistrationCameraEvidence(candidate.snapshot, check)
  check(candidate.asset).toEqual(reference.asset)
  check([
    candidate.recipe.width,
    candidate.recipe.height,
    candidate.recipe.crop,
    candidate.recipe.maskDimensions,
    candidate.recipe.maskSha256,
  ]).toEqual([
    reference.recipe.width,
    reference.recipe.height,
    reference.recipe.crop,
    reference.recipe.maskDimensions,
    reference.recipe.maskSha256,
  ])
  check(candidate.snapshot.sources.map((source) => workingIdentity(source))).toEqual(
    reference.snapshot.sources.map((source) => workingIdentity(source)),
  )
  check(Boolean(candidate.snapshot.fallback)).toBe(Boolean(reference.snapshot.fallback))
  if (candidate.snapshot.fallback && reference.snapshot.fallback)
    check(workingIdentity(candidate.snapshot.fallback.source)).toEqual(
      workingIdentity(reference.snapshot.fallback.source),
    )
  check(proof.camera).toHaveLength(3)
  for (const [index, camera] of proof.camera.entries()) {
    check(camera.native, `Complete native camera proof ${index}`).toBeDefined()
    check(camera.planes, `Complete reduced camera proof ${index}`).toBeDefined()
    if (camera.native) assertDifference(camera.native, `Recovered camera ${index}`, true, check)
    if (camera.planes)
      assertDifference(camera.planes, `Recovered camera plane ${index}`, true, check)
  }
  if (reference.snapshot.fallback) {
    check(proof.fallback?.native).toBeDefined()
    check(proof.fallback?.plane).toBeDefined()
    if (proof.fallback?.native)
      assertDifference(proof.fallback.native, 'Recovered fallback', true, check)
    if (proof.fallback?.plane)
      assertDifference(proof.fallback.plane, 'Recovered fallback plane', true, check)
  }
  check(proof.master).toBeDefined()
  if (proof.master) {
    assertDifference(proof.master, 'Recovered complete Float32 master', true, check)
    check(proof.master.referenceSha256).toBe(reference.asset.sha256)
    check(proof.master.candidateSha256).toBe(candidate.asset.sha256)
  }
  check(proof.motion).toBeDefined()
  if (proof.motion) {
    check(proof.motion.dimensionsMatch).toBe(true)
    check(proof.motion.comparedPixels).toBe(proof.motion.reference.bytes)
    check(proof.motion.reference.sha256).toBe(reference.recipe.maskSha256)
    check(proof.motion.candidate.sha256).toBe(candidate.recipe.maskSha256)
    check(proof.motion.pixelMismatches).toBe(0)
    check(proof.motion.bitMismatches).toBe(0)
  }
  check(normalize(JSON.parse(candidate.snapshot.registration.data))).toEqual(
    normalize(JSON.parse(reference.snapshot.registration.data)),
  )
}

interface NativeReadbackFault {
  calls: number
  maps: {
    mapCalls: number
    completedMaps: number
    injectedFailures: number
    scopesPushed: number
    scopesPopped: number
    resources: { kind: string; destroyed: number; mappedAtDestroy: boolean }[]
  }[]
}

async function injectNativeReadbackFault(stage: 'camera' | 'reference') {
  const { RawGpuRenderer } = await import('../src/main/gpu/raw-renderer'),
    original = RawGpuRenderer.prototype.mergeDevice,
    evidence: NativeReadbackFault = { calls: 0, maps: [] },
    converters = stage === 'camera' ? 3 : 1,
    message = `Injected complete-operation ${stage} second-readback failure.`
  RawGpuRenderer.prototype.mergeDevice = async function () {
    const actual = await original.call(this)
    if (++evidence.calls > converters) return actual
    const record: NativeReadbackFault['maps'][number] = {
      mapCalls: 0,
      completedMaps: 0,
      injectedFailures: 0,
      scopesPushed: 0,
      scopesPopped: 0,
      resources: [],
    }
    evidence.maps.push(record)
    const own = <T extends GPUBuffer | GPUTexture>(resource: T, kind: string): T => {
        const item = { kind, destroyed: 0, mappedAtDestroy: false },
          destroy = resource.destroy.bind(resource)
        record.resources.push(item)
        Object.defineProperty(resource, 'destroy', {
          value: () => {
            item.destroyed++
            item.mappedAtDestroy ||= 'mapState' in resource && resource.mapState !== 'unmapped'
            destroy()
          },
        })
        return resource
      },
      device = new Proxy(actual.device, {
        get(target, key) {
          if (key === 'createBuffer')
            return (descriptor: GPUBufferDescriptor) => {
              const buffer = own(target.createBuffer(descriptor), 'buffer')
              if (descriptor.usage & GPUBufferUsage.MAP_READ) {
                const map = buffer.mapAsync.bind(buffer)
                Object.defineProperty(buffer, 'mapAsync', {
                  value: async (...args: Parameters<GPUBuffer['mapAsync']>) => {
                    record.mapCalls++
                    if (record.mapCalls === 2) {
                      record.injectedFailures++
                      throw new Error(message)
                    }
                    await map(...args)
                    record.completedMaps++
                  },
                })
              }
              return buffer
            }
          if (key === 'createTexture')
            return (descriptor: GPUTextureDescriptor) =>
              own(target.createTexture(descriptor), 'texture')
          if (key === 'pushErrorScope')
            return (filter: GPUErrorFilter) => {
              record.scopesPushed++
              return target.pushErrorScope(filter)
            }
          if (key === 'popErrorScope')
            return async () => {
              try {
                return await target.popErrorScope()
              } finally {
                record.scopesPopped++
              }
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    // render() retains its real cached device. Only separately admitted camera
    // or fallback resources see this proxy, preserving all working-strip bytes.
    return { ...actual, device }
  }
  return {
    evidence,
    message,
    restore: () => {
      RawGpuRenderer.prototype.mergeDevice = original
    },
  }
}

for (const stage of ['camera', 'reference'] as const) {
  test(`complete ${stage} GPU failure replays exact CPU preparation before durable publication`, async ({}, info) => {
    test.setTimeout(10 * 60 * 1000)
    const originals = await nativeLifecycleOriginals(),
      contexts: NativeLifecycleContext[] = [],
      captures: NativeLifecycleCapture[] = [],
      restorePolicies = setNativeLifecyclePolicies(false, false),
      evidence: {
        classification: string
        stage: string
        fault?: NativeReadbackFault
        comparison?: NativeLifecycleProof
        error?: ReturnType<typeof errorEvidence>
      } = {
        classification:
          'Complete isolated Node service lifecycle; fault injection, not performance acceptance.',
        stage,
      }
    let fault: Awaited<ReturnType<typeof injectNativeReadbackFault>> | undefined
    try {
      const control = await openNativeLifecycleLibrary(info, originals, 'control', stage)
      contexts.push(control)
      const controlReview = await control.library.createMergeReview(
          originals.map((original) => original.sha256),
          'hdr',
        ),
        frozen = await captureNativeLifecycle(info, control, controlReview, 'control')
      captures.push(frozen)
      await publishNativeLifecycle(control, frozen, originals)
      await closeNativeLifecycle(control)
      setNativeLifecyclePolicies(stage === 'camera', stage === 'reference')
      fault = await injectNativeReadbackFault(stage)
      evidence.fault = fault.evidence
      const candidate = await openNativeLifecycleLibrary(info, originals, 'recovery', stage)
      contexts.push(candidate)
      const candidateReview = await candidate.library.createMergeReview(
          originals.map((original) => original.sha256),
          'hdr',
        ),
        recovered = await captureNativeLifecycle(info, candidate, candidateReview, 'recovery')
      captures.push(recovered)
      await publishNativeLifecycle(candidate, recovered, originals)
      evidence.comparison = await compareNativeLifecycle(frozen, recovered)
      const check = expect.configure({ soft: true }),
        converters = stage === 'camera' ? 3 : 1
      check(fault.evidence.maps).toHaveLength(converters)
      for (const record of fault.evidence.maps) {
        check(record.mapCalls).toBe(2)
        check(record.completedMaps).toBe(1)
        check(record.injectedFailures).toBe(1)
        check(record.scopesPopped).toBe(record.scopesPushed)
        check(record.resources.length).toBeGreaterThan(0)
        for (const resource of record.resources) {
          check(resource.destroyed, `${resource.kind}: released once`).toBe(1)
          check(
            resource.mappedAtDestroy,
            `${resource.kind}: no mapped resource survives failure`,
          ).toBe(false)
        }
      }
      check(recovered.recipe.cameraPreparation).toBe(
        stage === 'camera' ? GPU_CAMERA_PREPARATION : undefined,
      )
      check(recovered.recipe.referenceFallbackPreparation).toBe(
        stage === 'reference' ? GPU_REFERENCE_PREPARATION : undefined,
      )
      for (const prepared of recovered.recipe.measurements!.preparation) {
        check(prepared.backend, 'Working source stays on the real GPU').toBe('gpu')
        check(prepared.reused).toBe(false)
        if (stage === 'camera') {
          check(prepared.work?.cameraPreparation).toMatchObject({
            policy: GPU_CAMERA_PREPARATION,
            backend: 'cpu',
          })
          check(prepared.work?.cameraPreparation?.fallback).toContain(fault.message)
          check(prepared.work?.cameraPreparation?.allocatedGpuBytes).toBeGreaterThan(0)
        } else check(prepared.work?.cameraPreparation).toBeUndefined()
      }
      const fallback = recovered.recipe.measurements!.referenceFallback
      check(fallback?.backend).toBe('cpu')
      check(fallback?.reused).toBe(false)
      if (stage === 'reference') {
        check(fallback?.work?.referencePreparation).toMatchObject({
          policy: GPU_REFERENCE_PREPARATION,
          backend: 'cpu',
        })
        check(fallback?.work?.referencePreparation?.fallback).toContain(fault.message)
        check(fallback?.work?.referencePreparation?.allocatedGpuBytes).toBeGreaterThan(0)
        check(recovered.snapshot.fallback?.source.gpuBytes).toBeGreaterThan(0)
        check(recovered.snapshot.fallback?.source.referenceFallbackPreparation).toBe(
          GPU_REFERENCE_PREPARATION,
        )
      } else check(fallback?.work?.referencePreparation).toBeUndefined()
      assertNativeValidation(recovered.recipe, check)
      assertNativeLifecycleProof(frozen, recovered, evidence.comparison)
    } catch (error) {
      evidence.error = errorEvidence(error)
      throw error
    } finally {
      fault?.restore()
      restorePolicies()
      for (const context of contexts)
        if (!context.sample.cleaned) await closeNativeLifecycle(context)
      await writeFile(
        info.outputPath(`${stage}-complete-recovery.json`),
        JSON.stringify(
          {
            ...evidence,
            captures,
            samples: contexts.map((context) => context.sample),
            binarySnapshotsRetained: false,
          },
          null,
          2,
        ),
      )
      await removeNativeLifecycleSnapshots(captures)
    }
  })
}

test('legacy native CPU recipe ignores GPU selectors through fresh preparation and durable publication', async ({}, info) => {
  test.setTimeout(10 * 60 * 1000)
  const originals = await nativeLifecycleOriginals(),
    contexts: NativeLifecycleContext[] = [],
    captures: NativeLifecycleCapture[] = [],
    restorePolicies = setNativeLifecyclePolicies(false, false),
    evidence: {
      comparison?: NativeLifecycleProof
      error?: ReturnType<typeof errorEvidence>
    } = {}
  try {
    const control = await openNativeLifecycleLibrary(info, originals, 'control', 'both')
    contexts.push(control)
    const review = await control.library.createMergeReview(
        originals.map((original) => original.sha256),
        'hdr',
      ),
      frozen = await captureNativeLifecycle(info, control, review, 'legacy-control')
    captures.push(frozen)
    await publishNativeLifecycle(control, frozen, originals)
    await closeNativeLifecycle(control)
    expect(frozen.recipe.cameraPreparation).toBeUndefined()
    expect(frozen.recipe.referenceFallbackPreparation).toBeUndefined()
    setNativeLifecyclePolicies(true, true)
    const candidate = await openNativeLifecycleLibrary(
      info,
      originals,
      'replay',
      'both',
      frozen.recipe,
    )
    contexts.push(candidate)
    const replayReview = await candidate.library.createMergeReview(
        originals.map((original) => original.sha256),
        'hdr',
      ),
      replay = await captureNativeLifecycle(info, candidate, replayReview, 'legacy-replay')
    captures.push(replay)
    await publishNativeLifecycle(candidate, replay, originals)
    evidence.comparison = await compareNativeLifecycle(frozen, replay)
    const check = expect.configure({ soft: true })
    check(replay.recipe.cameraPreparation).toBeUndefined()
    check(replay.recipe.referenceFallbackPreparation).toBeUndefined()
    for (const prepared of replay.recipe.measurements!.preparation) {
      check(prepared.reused).toBe(false)
      check(prepared.work?.cameraPreparation).toBeUndefined()
    }
    check(replay.recipe.measurements!.referenceFallback?.reused).toBe(false)
    check(replay.recipe.measurements!.referenceFallback?.backend).toBe('cpu')
    check(replay.recipe.measurements!.referenceFallback?.work?.referencePreparation).toBeUndefined()
    for (const prepared of replay.snapshot.sources)
      check(prepared.cameraPreparation).toBeUndefined()
    check(replay.snapshot.fallback?.source.referenceFallbackPreparation).toBeUndefined()
    check(replay.recipe.sources.map((source) => source.transform)).toEqual(
      frozen.recipe.sources.map((source) => source.transform),
    )
    assertNativeLifecycleProof(frozen, replay, evidence.comparison)
  } catch (error) {
    evidence.error = errorEvidence(error)
    throw error
  } finally {
    restorePolicies()
    for (const context of contexts) if (!context.sample.cleaned) await closeNativeLifecycle(context)
    await writeFile(
      info.outputPath('legacy-native-replay.json'),
      JSON.stringify(
        {
          classification:
            'Fresh legacy recipe replay with GPU selectors enabled; exact persisted arithmetic.',
          ...evidence,
          captures,
          samples: contexts.map((context) => context.sample),
          binarySnapshotsRetained: false,
        },
        null,
        2,
      ),
    )
    await removeNativeLifecycleSnapshots(captures)
  }
})

for (const stage of ['camera', 'reference'] as const) {
  test(`native ${stage} policy cache proves identity, reuse and corruption rejection before publication`, async ({}, info) => {
    test.setTimeout(10 * 60 * 1000)
    const originals = await nativeLifecycleOriginals(),
      captures: NativeLifecycleCapture[] = [],
      restorePolicies = setNativeLifecyclePolicies(false, false),
      evidence: {
        cacheProof?: NativeLifecycleProof
        cameraCacheProof?: NativeLifecycleProof
        restoredProof?: NativeLifecycleProof
        corruption?: {
          path: string
          offset: number
          restored: boolean
          rejected?: ReturnType<typeof errorEvidence>
        }
        error?: ReturnType<typeof errorEvidence>
      } = {}
    let context: NativeLifecycleContext | undefined
    try {
      context = await openNativeLifecycleLibrary(info, originals, 'cache', stage)
      let review = await context.library.createMergeReview(
        originals.map((original) => original.sha256),
        'hdr',
      )
      const cpu = await captureNativeLifecycle(info, context, review, 'cache-cpu')
      captures.push(cpu)
      expect(cpu.recipe.measurements!.preparation.every((prepared) => !prepared.reused)).toBe(true)
      expect(cpu.recipe.measurements!.referenceFallback?.reused).toBe(false)
      setNativeLifecyclePolicies(stage === 'camera', stage === 'reference')
      review = await context.library.updateMergeReview(review.id, review.revision, review.settings)
      const gpu = await captureNativeLifecycle(info, context, review, 'cache-gpu')
      captures.push(gpu)
      expect(gpu.recipe.cameraPreparation).toBe(
        stage === 'camera' ? GPU_CAMERA_PREPARATION : undefined,
      )
      expect(gpu.recipe.referenceFallbackPreparation).toBe(
        stage === 'reference' ? GPU_REFERENCE_PREPARATION : undefined,
      )
      for (let index = 0; index < 3; index++) {
        const prepared = gpu.recipe.measurements!.preparation[index]
        expect(prepared.reused).toBe(stage === 'reference')
        if (stage === 'camera') {
          expect(gpu.snapshot.sources[index].identity).not.toBe(
            cpu.snapshot.sources[index].identity,
          )
          expect(prepared.work?.cameraPreparation).toMatchObject({
            policy: GPU_CAMERA_PREPARATION,
            backend: 'gpu',
          })
          expect(prepared.work?.cameraPreparation?.fallback).toBeUndefined()
        } else
          expect(gpu.snapshot.sources[index].identity).toBe(cpu.snapshot.sources[index].identity)
      }
      expect(gpu.recipe.measurements!.referenceFallback?.reused).toBe(false)
      expect(gpu.snapshot.fallback?.source.identity).not.toBe(
        cpu.snapshot.fallback?.source.identity,
      )
      expect(gpu.recipe.measurements!.referenceFallback?.backend).toBe(
        stage === 'reference' ? 'gpu' : 'cpu',
      )
      if (stage === 'reference') {
        expect(
          gpu.recipe.measurements!.referenceFallback?.work?.referencePreparation,
        ).toMatchObject({ policy: GPU_REFERENCE_PREPARATION, backend: 'gpu' })
        expect(
          gpu.recipe.measurements!.referenceFallback?.work?.referencePreparation?.fallback,
        ).toBeUndefined()
      }
      review = await context.library.updateMergeReview(review.id, review.revision, review.settings)
      const cached = await captureNativeLifecycle(info, context, review, 'cache-reused')
      captures.push(cached)
      expect(
        cached.recipe.measurements!.preparation.every(
          (prepared) => prepared.reused && prepared.work === undefined,
        ),
      ).toBe(true)
      expect(cached.recipe.measurements!.referenceFallback?.reused).toBe(true)
      expect(cached.recipe.measurements!.referenceFallback?.work).toBeUndefined()
      expect(cached.snapshot.sources.map((source) => source.identity)).toEqual(
        gpu.snapshot.sources.map((source) => source.identity),
      )
      expect(cached.snapshot.fallback?.source.identity).toBe(gpu.snapshot.fallback?.source.identity)
      evidence.cacheProof = await compareNativeLifecycle(gpu, cached)
      if (stage === 'camera') {
        // A legacy registration record with matching working-strip checksums is
        // insufficient for a versioned camera policy: its camera proof is required.
        const registrationPath = join(context.runs.at(-1)!.directory, 'registration.json'),
          registration = JSON.parse(
            await readFile(registrationPath, 'utf8'),
          ) as Snapshot['registration'],
          data = JSON.parse(registration.data) as { cameraEvidence?: unknown }
        delete data.cameraEvidence
        registration.data = JSON.stringify(data)
        registration.sha256 = sha256(Buffer.from(registration.data))
        await writeFile(registrationPath, JSON.stringify(registration))
        review = await context.library.updateMergeReview(
          review.id,
          review.revision,
          review.settings,
        )
        const reproved = await captureNativeLifecycle(
          info,
          context,
          review,
          'cache-camera-reproved',
        )
        captures.push(reproved)
        expect(reproved.recipe.measurements!.preparation.every((prepared) => prepared.reused)).toBe(
          true,
        )
        expect(reproved.recipe.measurements!.referenceFallback?.reused).toBe(true)
        expect(
          reproved.recipe.measurements!.attempts.filter((attempt) => attempt.success),
        ).toHaveLength(2)
        assertNativeValidation(reproved.recipe)
        assertRegistrationCameraEvidence(reproved.snapshot)
        evidence.cameraCacheProof = await compareNativeLifecycle(gpu, reproved)
      }
      const prepared = context.runs.at(-1)!.directory,
        damaged =
          stage === 'camera'
            ? join(prepared, 'source-0.camera.plane')
            : join(prepared, 'reference-fallback', 'source-0.plane'),
        file = await open(damaged, 'r+'),
        original = Buffer.alloc(1)
      evidence.corruption = { path: damaged, offset: 0, restored: false }
      try {
        await readExact(file, original, 0)
        await file.write(Buffer.from([original[0] ^ 1]), 0, 1, 0)
        review = await context.library.updateMergeReview(
          review.id,
          review.revision,
          review.settings,
        )
        try {
          await context.library.requestMergePreview(review.id, review.revision)
          throw new Error('Corrupted preparation was unexpectedly accepted.')
        } catch (error) {
          evidence.corruption.rejected = errorEvidence(error)
          expect(errorEvidence(error).message).toContain(
            stage === 'camera'
              ? 'Damaged camera registration plane.'
              : 'Damaged merge preparation plane.',
          )
        }
        expect(() => context!.library.startMerge(review.id, review.revision)).toThrow(
          'Wait for the current merge preview',
        )
        expect(await entries(join(context.root, 'merge-publications'))).toEqual([])
        const db = new DatabaseSync(join(context.root, 'catalog.sqlite'))
        try {
          expect(db.prepare('SELECT COUNT(*) AS count FROM derived_assets').get()).toEqual({
            count: 0,
          })
          expect(db.prepare('SELECT COUNT(*) AS count FROM merge_publications').get()).toEqual({
            count: 0,
          })
        } finally {
          db.close()
        }
      } finally {
        await file.write(original, 0, 1, 0)
        await file.close()
        evidence.corruption.restored = true
      }
      review = await context.library.updateMergeReview(review.id, review.revision, review.settings)
      const restored = await captureNativeLifecycle(info, context, review, 'cache-restored')
      captures.push(restored)
      expect(restored.recipe.measurements!.preparation.every((prepared) => prepared.reused)).toBe(
        true,
      )
      expect(restored.recipe.measurements!.referenceFallback?.reused).toBe(true)
      evidence.restoredProof = await compareNativeLifecycle(gpu, restored)
      await publishNativeLifecycle(context, restored, originals)
      assertNativeLifecycleProof(gpu, cached, evidence.cacheProof)
      const reproved = captures.find((capture) => capture.label === 'cache-camera-reproved')
      if (reproved && evidence.cameraCacheProof)
        assertNativeLifecycleProof(gpu, reproved, evidence.cameraCacheProof)
      assertNativeLifecycleProof(gpu, restored, evidence.restoredProof)
    } catch (error) {
      evidence.error = errorEvidence(error)
      throw error
    } finally {
      restorePolicies()
      if (context && !context.sample.cleaned) await closeNativeLifecycle(context)
      await writeFile(
        info.outputPath(`${stage}-native-cache.json`),
        JSON.stringify(
          {
            classification:
              'Versioned native preparation cache identity and durable recovery; no timing adoption.',
            stage,
            ...evidence,
            captures,
            sample: context?.sample,
            binarySnapshotsRetained: false,
          },
          null,
          2,
        ),
      )
      await removeNativeLifecycleSnapshots(captures)
    }
  })
}

test('native reference cancellation during drained GPU close removes the completed owned file', async ({}, info) => {
  test.setTimeout(5 * 60 * 1000)
  const originals = await nativeLifecycleOriginals(),
    restorePolicies = setNativeLifecyclePolicies(false, true),
    controller = new AbortController(),
    reason = new Error('Injected native reference cancellation during drained close.'),
    { RawGpuRenderer } = await import('../src/main/gpu/raw-renderer'),
    { mergePreparation } = await import('../src/main/merge/preparation-policy'),
    { prepareReferenceFallback } = await import('../src/main/merge/prepare'),
    renderer = new RawGpuRenderer(),
    evidence: {
      readbacks: { top: number; rows: number }[]
      resources: { destroyed: number; mappedAtDestroy: boolean }[]
      closeAbortCalls: number
      completedBytesAtClose?: number
      rejected?: ReturnType<typeof errorEvidence>
      error?: ReturnType<typeof errorEvidence>
    } = { readbacks: [], resources: [], closeAbortCalls: 0 }
  let context: NativeLifecycleContext | undefined
  try {
    context = await openNativeLifecycleLibrary(info, originals, 'close-abort', 'reference')
    const review = await context.library.createMergeReview(
        originals.map((original) => original.sha256),
        'hdr',
      ),
      paths = review.sources.map((source) =>
        join(context!.root, 'originals', source.photo.id, 'original.arw'),
      ),
      preparation = await mergePreparation(paths, review.sources, review.settings, async () => {})
    expect(preparation).toBeDefined()
    const index = review.sources.findIndex(
        (source) => source.photo.id === review.settings.referenceId,
      ),
      source = review.sources[index],
      raw = preparation!.sources[index],
      width = raw.flip & 4 ? preparation!.commonCrop.height : preparation!.commonCrop.width,
      height = raw.flip & 4 ? preparation!.commonCrop.width : preparation!.commonCrop.height,
      directory = join(context.root, 'close-abort'),
      target = join(directory, 'source-0.f32'),
      actual = await renderer.mergeDevice(),
      own = <T extends GPUBuffer | GPUTexture>(resource: T): T => {
        const item = { destroyed: 0, mappedAtDestroy: false },
          destroy = resource.destroy.bind(resource)
        evidence.resources.push(item)
        Object.defineProperty(resource, 'destroy', {
          value: () => {
            item.destroyed++
            item.mappedAtDestroy ||= 'mapState' in resource && resource.mapState !== 'unmapped'
            destroy()
          },
        })
        return resource
      },
      queue = new Proxy(actual.device.queue, {
        get(targetQueue, key) {
          if (key === 'onSubmittedWorkDone')
            return async () => {
              await targetQueue.onSubmittedWorkDone()
              // Upload fences precede all readbacks. The next fence after a
              // completed readback is the converter's final drained close.
              if (evidence.readbacks.length && !controller.signal.aborted) {
                evidence.completedBytesAtClose = (await stat(target)).size
                evidence.closeAbortCalls++
                controller.abort(reason)
              }
            }
          const value = Reflect.get(targetQueue, key, targetQueue)
          return typeof value === 'function' ? value.bind(targetQueue) : value
        },
      }),
      device = new Proxy(actual.device, {
        get(targetDevice, key) {
          if (key === 'queue') return queue
          if (key === 'createBuffer')
            return (descriptor: GPUBufferDescriptor) => own(targetDevice.createBuffer(descriptor))
          if (key === 'createTexture')
            return (descriptor: GPUTextureDescriptor) => own(targetDevice.createTexture(descriptor))
          const value = Reflect.get(targetDevice, key, targetDevice)
          return typeof value === 'function' ? value.bind(targetDevice) : value
        },
      })
    renderer.mergeDevice = async () => ({ ...actual, device })
    await mkdir(directory, { recursive: true })
    let rejected: unknown
    try {
      await prepareReferenceFallback(
        paths[index],
        directory,
        0,
        source,
        source,
        async () => controller.signal.throwIfAborted(),
        preparation!,
        renderer,
        GPU_REFERENCE_PREPARATION,
        {
          signal: controller.signal,
          hooks: {
            checkpoint: (event) => {
              if (event.phase === 'readback')
                evidence.readbacks.push({ top: event.top!, rows: event.rows! })
            },
          },
        },
      )
    } catch (error) {
      rejected = error
      evidence.rejected = errorEvidence(error)
    }
    const check = expect.configure({ soft: true })
    check(rejected, 'Close cancellation remains cancellation, with no CPU replay').toBe(reason)
    check(evidence.closeAbortCalls).toBe(1)
    check(evidence.completedBytesAtClose, 'All native output was owned before cancellation').toBe(
      width * height * 16,
    )
    check(evidence.readbacks).toHaveLength(Math.ceil(height / 64))
    check(evidence.readbacks.at(-1)).toEqual({
      top: Math.floor((height - 1) / 64) * 64,
      rows: ((height - 1) % 64) + 1,
    })
    check(evidence.resources.length).toBeGreaterThan(0)
    for (const resource of evidence.resources) {
      check(resource.destroyed).toBe(1)
      check(resource.mappedAtDestroy).toBe(false)
    }
    check(await entries(directory), 'Completed cancelled source must be removed').toEqual([])
    await context.library.disposeMergeReview(review.id)
    check(context.library.getActiveMergeReview()).toBeNull()
    check(await entries(join(context.root, 'merge-reviews'))).toEqual([])
    check(await entries(join(context.root, 'merge-publications'))).toEqual([])
    for (const original of originals)
      check(
        await fileIdentity(join(context.root, 'originals', original.sha256, 'original.arw')),
      ).toEqual({ sha256: original.sha256, bytes: original.bytes })
  } catch (error) {
    evidence.error = errorEvidence(error)
    throw error
  } finally {
    renderer.close()
    restorePolicies()
    if (context && !context.sample.cleaned) await closeNativeLifecycle(context)
    await writeFile(
      info.outputPath('reference-native-close-cancellation.json'),
      JSON.stringify(
        {
          classification:
            'Real reference RAW preparation cancelled only after completed native output and drained GPU close; no publication.',
          ...evidence,
          sample: context?.sample,
        },
        null,
        2,
      ),
    )
  }
})

interface NativeSharedDeviceLoss {
  mergeDeviceCalls: number
  mapCalls: number
  completedMaps: number
  rejectedMaps: number
  actualDeviceDestroys: number
  unavailable: ReturnType<typeof errorEvidence>[]
  loss?: { reason: GPUDeviceLostReason; message: string }
}

async function injectNativeSharedDeviceLoss() {
  const { RawGpuRenderer } = await import('../src/main/gpu/raw-renderer'),
    original = RawGpuRenderer.prototype.mergeDevice,
    evidence: NativeSharedDeviceLoss = {
      mergeDeviceCalls: 0,
      mapCalls: 0,
      completedMaps: 0,
      rejectedMaps: 0,
      actualDeviceDestroys: 0,
      unavailable: [],
    }
  let supplied = false
  RawGpuRenderer.prototype.mergeDevice = async function () {
    evidence.mergeDeviceCalls++
    let actual: Awaited<ReturnType<typeof original>>
    try {
      actual = await original.call(this)
    } catch (error) {
      evidence.unavailable.push(errorEvidence(error))
      throw error
    }
    if (supplied) return actual
    supplied = true
    const device = new Proxy(actual.device, {
      get(target, key) {
        if (key === 'createBuffer')
          return (descriptor: GPUBufferDescriptor) => {
            const buffer = target.createBuffer(descriptor)
            if (descriptor.usage & GPUBufferUsage.MAP_READ) {
              const map = buffer.mapAsync.bind(buffer)
              Object.defineProperty(buffer, 'mapAsync', {
                value: async (...args: Parameters<GPUBuffer['mapAsync']>) => {
                  evidence.mapCalls++
                  if (evidence.mapCalls === 2) {
                    // Destroy the renderer's actual cached device. A failed map
                    // alone would leave later RAW/fusion/output GPU users healthy.
                    evidence.actualDeviceDestroys++
                    actual.device.destroy()
                    const info = await actual.device.lost
                    evidence.loss = { reason: info.reason, message: info.message }
                  }
                  try {
                    await map(...args)
                    evidence.completedMaps++
                  } catch (error) {
                    evidence.rejectedMaps++
                    throw error
                  }
                },
              })
            }
            return buffer
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ...actual, device }
  }
  return {
    evidence,
    restore: () => {
      RawGpuRenderer.prototype.mergeDevice = original
    },
  }
}

for (const stage of ['camera', 'reference'] as const) {
  test(`shared device loss during ${stage} preparation completes exact CPU recovery and durable publication`, async ({}, info) => {
    test.setTimeout(10 * 60 * 1000)
    const originals = await nativeLifecycleOriginals(),
      contexts: NativeLifecycleContext[] = [],
      captures: NativeLifecycleCapture[] = [],
      previousBackend = process.env.LUMA_MERGE_BACKEND,
      restorePolicies = setNativeLifecyclePolicies(stage === 'camera', false),
      { RawGpuRenderer } = await import('../src/main/gpu/raw-renderer'),
      originalMergeDevice = RawGpuRenderer.prototype.mergeDevice,
      evidence: {
        classification: string
        stage: string
        controlDeviceDenials: number
        fault?: NativeSharedDeviceLoss
        comparison?: NativeLifecycleProof
        error?: ReturnType<typeof errorEvidence>
      } = {
        classification:
          'Real shared Dawn device destruction and complete CPU recovery; isolated service lifecycle, not performance acceptance.',
        stage,
        controlDeviceDenials: 0,
      }
    let fault: Awaited<ReturnType<typeof injectNativeSharedDeviceLoss>> | undefined
    try {
      process.env.LUMA_MERGE_BACKEND = stage === 'camera' ? 'cpu' : 'gpu'
      if (stage === 'reference')
        RawGpuRenderer.prototype.mergeDevice = async function () {
          evidence.controlDeviceDenials++
          throw new Error('Injected GPU accumulation/output denial for matched CPU control.')
        }
      const control = await openNativeLifecycleLibrary(info, originals, 'control', stage)
      contexts.push(control)
      const controlReview = await control.library.createMergeReview(
          originals.map((original) => original.sha256),
          'hdr',
        ),
        frozen = await captureNativeLifecycle(info, control, controlReview, 'shared-loss-control')
      captures.push(frozen)
      await publishNativeLifecycle(control, frozen, originals)
      await closeNativeLifecycle(control)
      RawGpuRenderer.prototype.mergeDevice = originalMergeDevice
      process.env.LUMA_MERGE_BACKEND = 'gpu'
      setNativeLifecyclePolicies(stage === 'camera', stage === 'reference')
      fault = await injectNativeSharedDeviceLoss()
      evidence.fault = fault.evidence
      const candidate = await openNativeLifecycleLibrary(info, originals, 'shared-loss', stage)
      contexts.push(candidate)
      const review = await candidate.library.createMergeReview(
          originals.map((original) => original.sha256),
          'hdr',
        ),
        recovered = await captureNativeLifecycle(info, candidate, review, 'shared-loss-recovered')
      captures.push(recovered)
      await publishNativeLifecycle(candidate, recovered, originals)
      evidence.comparison = await compareNativeLifecycle(frozen, recovered)
      const check = expect.configure({ soft: true }),
        controlMeasurements = frozen.recipe.measurements!,
        recoveredMeasurements = recovered.recipe.measurements!
      check(
        fault.evidence.actualDeviceDestroys,
        'Actual cached renderer device was destroyed',
      ).toBe(1)
      check(fault.evidence.loss?.reason).toBe('destroyed')
      check(fault.evidence.mapCalls).toBe(2)
      check(fault.evidence.completedMaps, 'One converter strip completed before loss').toBe(1)
      check(fault.evidence.rejectedMaps).toBe(1)
      for (const measurements of [controlMeasurements, recoveredMeasurements]) {
        check(measurements.accumulation.backend).toBe('cpu')
        check(measurements.output?.backend).toBe('cpu')
        check(measurements.preparation.every((prepared) => !prepared.reused)).toBe(true)
        check(measurements.referenceFallback?.backend).toBe('cpu')
        check(measurements.referenceFallback?.reused).toBe(false)
      }
      check(frozen.recipe.cameraPreparation).toBe(
        stage === 'camera' ? GPU_CAMERA_PREPARATION : undefined,
      )
      check(recovered.recipe.cameraPreparation).toBe(
        stage === 'camera' ? GPU_CAMERA_PREPARATION : undefined,
      )
      check(frozen.recipe.referenceFallbackPreparation).toBeUndefined()
      check(recovered.recipe.referenceFallbackPreparation).toBe(
        stage === 'reference' ? GPU_REFERENCE_PREPARATION : undefined,
      )
      for (let index = 0; index < 3; index++) {
        const controlPreparation = controlMeasurements.preparation[index],
          recoveredPreparation = recoveredMeasurements.preparation[index]
        check(controlPreparation.backend).toBe(stage === 'camera' ? 'cpu' : 'gpu')
        check(recoveredPreparation.backend).toBe(stage === 'camera' ? 'cpu' : 'gpu')
        if (stage === 'camera') {
          check(controlPreparation.work?.cameraPreparation).toMatchObject({
            policy: GPU_CAMERA_PREPARATION,
            backend: 'cpu',
          })
          check(recoveredPreparation.work?.cameraPreparation).toMatchObject({
            policy: GPU_CAMERA_PREPARATION,
            backend: 'cpu',
          })
          check(recoveredPreparation.work?.cameraPreparation?.fallback?.length).toBeGreaterThan(0)
          check(recovered.recipe.sources[index].cameraPreparation).toBe(GPU_CAMERA_PREPARATION)
          check(recovered.snapshot.sources[index].cameraPreparation).toBe(GPU_CAMERA_PREPARATION)
        } else {
          check(controlPreparation.work?.cameraPreparation).toBeUndefined()
          check(recoveredPreparation.work?.cameraPreparation).toBeUndefined()
        }
      }
      if (stage === 'reference') {
        check(evidence.controlDeviceDenials).toBeGreaterThan(0)
        check(controlMeasurements.referenceFallback?.work?.referencePreparation).toBeUndefined()
        check(recoveredMeasurements.referenceFallback?.work?.referencePreparation).toMatchObject({
          policy: GPU_REFERENCE_PREPARATION,
          backend: 'cpu',
        })
        check(
          recoveredMeasurements.referenceFallback?.work?.referencePreparation?.fallback?.length,
        ).toBeGreaterThan(0)
        check(
          recoveredMeasurements.referenceFallback?.work?.referencePreparation?.allocatedGpuBytes,
        ).toBeGreaterThan(0)
        check(recovered.snapshot.fallback?.source.gpuBytes).toBeGreaterThan(0)
        check(recovered.snapshot.fallback?.source.referenceFallbackPreparation).toBe(
          GPU_REFERENCE_PREPARATION,
        )
      } else {
        const referenceIndex = recovered.recipe.sources.findIndex(
            (source) => source.id === recovered.recipe.settings.referenceId,
          ),
          attempted = recoveredMeasurements.preparation[referenceIndex]
        check(attempted.work?.cameraPreparation?.allocatedGpuBytes).toBeGreaterThan(0)
        check(recovered.snapshot.sources[referenceIndex].gpuBytes).toBeGreaterThan(0)
        check(recoveredMeasurements.peak.gpuBytes).toBeGreaterThanOrEqual(
          recovered.snapshot.sources[referenceIndex].gpuBytes!,
        )
      }
      assertNativeValidation(frozen.recipe, check)
      assertNativeValidation(recovered.recipe, check)
      assertNativeLifecycleProof(frozen, recovered, evidence.comparison)
    } catch (error) {
      evidence.error = errorEvidence(error)
      throw error
    } finally {
      fault?.restore()
      RawGpuRenderer.prototype.mergeDevice = originalMergeDevice
      if (previousBackend === undefined) delete process.env.LUMA_MERGE_BACKEND
      else process.env.LUMA_MERGE_BACKEND = previousBackend
      restorePolicies()
      for (const context of contexts)
        if (!context.sample.cleaned) await closeNativeLifecycle(context)
      await writeFile(
        info.outputPath(`${stage}-shared-device-loss.json`),
        JSON.stringify(
          {
            ...evidence,
            captures,
            samples: contexts.map((context) => context.sample),
            binarySnapshotsRetained: false,
          },
          null,
          2,
        ),
      )
      await removeNativeLifecycleSnapshots(captures)
    }
  })
}
