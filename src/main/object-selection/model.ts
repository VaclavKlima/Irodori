import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { InferenceSession } from 'onnxruntime-node'

export const OBJECT_SELECTION_MODEL_ID = 'sam2.1-hiera-tiny-f32-labels-v1'
export const OBJECT_SELECTION_MAX_PIXELS = 32_000_000

export function objectSelectionSessionOptions(): InferenceSession.SessionOptions {
  return {
    executionProviders: [{ name: 'webgpu', validationMode: 'basic' }],
    logSeverityLevel: 3,
    extra: { session: { disable_cpu_ep_fallback: '1' } },
  }
}
const graphs = {
  encoder: {
    bytes: 109_384_732,
    sha256: 'ea9b33edd91a35d295eb9490de774a85dc85057de55fa6d94cd67510939631b9',
  },
  decoder: {
    bytes: 16_444_091,
    sha256: '106c9f532dbe04d0c8226295a62625ba594f6a5ffef7d78b95b9b2fcf5f8cf95',
  },
} as const

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Load only the pinned, losslessly packed model; no remote code or model paths from callers. */
export async function loadObjectSelectionGraph(directory: string, name: keyof typeof graphs) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    version: number
    identity: string
    runtime: string
    components: {
      name: string
      bytes: number
      sha256: string
      compression: string
      compressedBytes: number
      compressedSha256: string
      parts: { file: string; bytes: number; sha256: string }[]
    }[]
  }
  const expected = graphs[name]
  const component = manifest.components?.find((entry) => entry.name === name)
  if (
    manifest.version !== 1 ||
    manifest.identity !== OBJECT_SELECTION_MODEL_ID ||
    manifest.runtime !== 'onnxruntime-node@1.31.1' ||
    !component ||
    component.bytes !== expected.bytes ||
    component.sha256 !== expected.sha256 ||
    component.compression !== 'gzip' ||
    !Array.isArray(component.parts) ||
    component.parts.length < 1 ||
    component.parts.length > 4 ||
    component.compressedBytes > expected.bytes + 1024 * 1024
  )
    throw new Error(
      'Object selection model manifest is missing or unsupported. Run npm run setup:object-selection.',
    )
  const parts: Buffer[] = []
  for (const part of component.parts) {
    if (
      !new RegExp(`^${name}\\.onnx\\.gz\\.[0-9]{2}$`).test(part.file) ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 1 ||
      part.bytes > 50 * 1024 * 1024
    )
      throw new Error('Object selection model chunk is invalid.')
    const data = await readFile(join(directory, part.file))
    if (data.byteLength !== part.bytes || sha256(data) !== part.sha256)
      throw new Error(
        'Object selection model chunk is damaged. Run npm run setup:object-selection.',
      )
    parts.push(data)
  }
  const packed = Buffer.concat(parts)
  if (
    packed.byteLength !== component.compressedBytes ||
    sha256(packed) !== component.compressedSha256
  )
    throw new Error('Object selection model archive is damaged.')
  const graph = gunzipSync(packed, { maxOutputLength: expected.bytes })
  if (graph.byteLength !== expected.bytes || sha256(graph) !== expected.sha256)
    throw new Error('Object selection model graph does not match its pinned identity.')
  return graph
}
