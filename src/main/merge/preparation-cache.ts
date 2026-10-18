import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MERGE_PIPELINE,
  MERGE_LIMITS,
  GPU_CAMERA_PREPARATION,
  GPU_REFERENCE_PREPARATION,
} from '../../shared/merge'
import type { PreparedSource } from './prepare'
import { validateSensorCache } from './sensor-cache'
import { CAMERA_REGISTRATION_POLICY } from './camera-registration'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
/** Small manifests describe immutable, checksummed binary planes. Native strips verify on read. */
export async function savePreparation(
  directory: string,
  index: number,
  reference: string,
  source: PreparedSource,
) {
  const bytes = Buffer.concat([
    Buffer.from(
      source.plane.data.buffer,
      source.plane.data.byteOffset,
      source.plane.data.byteLength,
    ),
    Buffer.from(source.plane.mask ?? new Uint8Array(source.plane.data.length).fill(255)),
  ])
  await writeFile(join(directory, `source-${index}.plane`), bytes)
  let cameraBytes = Buffer.alloc(0)
  const camera = source.cameraRegistration
  if (camera) {
    cameraBytes = Buffer.concat(
      camera.planes.flatMap((p) => [
        Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength),
        Buffer.from(p.mask!),
      ]),
    )
    await writeFile(join(directory, `source-${index}.camera.plane`), cameraBytes)
  }
  const json = JSON.stringify({
    version: MERGE_PIPELINE.preparation,
    reference,
    source: {
      ...source,
      plane: { width: source.plane.width, height: source.plane.height, sha256: hash(bytes) },
      cameraRegistration: camera && {
        ...camera,
        planes: camera.planes.map((p, c) => ({
          width: p.width,
          height: p.height,
          sha256: hash(cameraBytes.subarray(c * p.data.length * 5, (c + 1) * p.data.length * 5)),
        })),
      },
    },
  })
  await writeFile(join(directory, `source-${index}.json`), json)
  return bytes.length + cameraBytes.length + Buffer.byteLength(json)
}
export async function loadPreparation(
  directory: string,
  index: number,
  reference: string,
  read: (bytes: number) => void = () => {},
  identity?: string,
  expected?: Pick<PreparedSource, 'cameraPreparation' | 'referenceFallbackPreparation'>,
): Promise<PreparedSource | undefined> {
  let json: string
  try {
    json = await readFile(join(directory, `source-${index}.json`), 'utf8')
    read(Buffer.byteLength(json))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const cached = JSON.parse(json)
  if (cached.reference !== reference) return
  const p = cached.source as PreparedSource
  if (
    expected &&
    (p.cameraPreparation !== expected.cameraPreparation ||
      p.referenceFallbackPreparation !== expected.referenceFallbackPreparation)
  )
    return
  if (cached.version && (cached.version !== MERGE_PIPELINE.preparation || p.identity !== identity))
    return
  if (
    p.path !== join(directory, `source-${index}.f32`) ||
    (p.cameraPreparation !== undefined && p.cameraPreparation !== GPU_CAMERA_PREPARATION) ||
    (p.cameraPreparation !== undefined && !p.cameraRegistration) ||
    (p.referenceFallbackPreparation !== undefined &&
      p.referenceFallbackPreparation !== GPU_REFERENCE_PREPARATION) ||
    !Number.isSafeInteger(p.width) ||
    !Number.isSafeInteger(p.height) ||
    p.width < 1 ||
    p.height < 1 ||
    p.width * p.height > MERGE_LIMITS.maxPixels ||
    !Number.isSafeInteger(p.plane.width) ||
    !Number.isSafeInteger(p.plane.height) ||
    p.plane.width < 1 ||
    p.plane.height < 1 ||
    Math.max(p.plane.width, p.plane.height) > MERGE_LIMITS.previewEdge ||
    !Array.isArray(p.strips) ||
    p.strips.length !== Math.ceil(p.height / 64) ||
    !p.strips.every((h) => /^[a-f0-9]{64}$/.test(h)) ||
    (await stat(p.path)).size !== p.width * p.height * 16
  )
    throw new Error('Invalid source preparation.')
  if (cached.version) {
    if (cached.version !== MERGE_PIPELINE.preparation) return
    const bytes = await readFile(join(directory, `source-${index}.plane`)),
      count = p.plane.width * p.plane.height
    read(bytes.length)
    if (bytes.length !== count * 5 || hash(bytes) !== cached.source.plane.sha256)
      throw new Error('Damaged merge preparation plane.')
    p.plane.data = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + count * 4),
    )
    p.plane.mask = new Uint8Array(bytes.subarray(count * 4))
  } else {
    // Legacy preparation manifests remain readable for existing interrupted reviews and fixtures.
    p.plane.data = Float32Array.from(cached.source.plane.data)
    p.plane.mask = cached.source.plane.mask ? Uint8Array.from(cached.source.plane.mask) : undefined
  }
  if (
    p.plane.data.length !== p.plane.width * p.plane.height ||
    !p.plane.data.every(Number.isFinite) ||
    (p.plane.mask &&
      (p.plane.mask.length !== p.plane.data.length ||
        !p.plane.mask.every((v) => v === 0 || v === 255)))
  )
    throw new Error('Invalid source preparation.')
  if (p.sensor) await validateSensorCache(p.sensor, directory, index, p.width, p.height)
  if (p.cameraRegistration) {
    const camera = p.cameraRegistration,
      count = p.plane.width * p.plane.height
    if (
      camera.version !== CAMERA_REGISTRATION_POLICY ||
      camera.path !== join(directory, `source-${index}.camera.f32`) ||
      !Array.isArray(camera.strips) ||
      camera.strips.length !== Math.ceil(p.height / 64) ||
      !camera.strips.every((h) => /^[a-f0-9]{64}$/.test(h)) ||
      !Array.isArray(camera.planes) ||
      camera.planes.length !== 3 ||
      camera.planes.some((q) => q.width !== p.plane.width || q.height !== p.plane.height) ||
      (await stat(camera.path)).size !== p.width * p.height * 16
    )
      throw new Error('Invalid camera registration preparation.')
    const cameraBytes = await readFile(join(directory, `source-${index}.camera.plane`))
    read(cameraBytes.length)
    if (cameraBytes.length !== count * 15) throw new Error('Damaged camera registration planes.')
    for (let c = 0; c < 3; c++) {
      const q = camera.planes[c],
        part = cameraBytes.subarray(c * count * 5, (c + 1) * count * 5)
      if (hash(part) !== cached.source.cameraRegistration.planes[c].sha256)
        throw new Error('Damaged camera registration plane.')
      q.data = new Float32Array(part.buffer.slice(part.byteOffset, part.byteOffset + count * 4))
      q.mask = new Uint8Array(part.subarray(count * 4))
      if (!q.data.every(Number.isFinite) || !q.mask.every((v) => v === 0 || v === 255))
        throw new Error('Invalid camera registration plane.')
    }
  }
  return p
}
