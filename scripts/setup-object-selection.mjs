import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const source = resolve(import.meta.dirname, '../assets/app/object-selection')
const outputIndex = process.argv.indexOf('--output')
const output = outputIndex < 0 ? undefined : resolve(process.argv[outputIndex + 1] ?? '')
if (outputIndex >= 0 && !process.argv[outputIndex + 1])
  throw new Error('--output requires a directory.')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
if (manifest.version !== 1 || manifest.identity !== 'sam2.1-hiera-tiny-f32-labels-v1')
  throw new Error('Unsupported bundled object selection model.')
if (output) await mkdir(output, { recursive: true })
for (const [name, bytes, sha256] of [
  ['encoder', 109384732, 'ea9b33edd91a35d295eb9490de774a85dc85057de55fa6d94cd67510939631b9'],
  ['decoder', 16444091, '106c9f532dbe04d0c8226295a62625ba594f6a5ffef7d78b95b9b2fcf5f8cf95'],
]) {
  const component = manifest.components.find((entry) => entry.name === name)
  if (
    !component ||
    component.bytes !== bytes ||
    component.sha256 !== sha256 ||
    component.parts.length < 1 ||
    component.parts.length > 4
  )
    throw new Error(`Unsupported ${name} model descriptor.`)
  const parts = []
  for (const part of component.parts) {
    if (
      !new RegExp(`^${name}\\.onnx\\.gz\\.[0-9]{2}$`).test(part.file) ||
      part.bytes > 50 * 1024 * 1024
    )
      throw new Error('Invalid bundled model chunk.')
    const payload = await readFile(join(source, part.file))
    if (payload.byteLength !== part.bytes || hash(payload) !== part.sha256)
      throw new Error(`Bundled model chunk ${part.file} is damaged.`)
    parts.push(payload)
  }
  const packed = Buffer.concat(parts)
  if (
    packed.byteLength !== component.compressedBytes ||
    hash(packed) !== component.compressedSha256
  )
    throw new Error(`Bundled ${name} archive is damaged.`)
  const graph = gunzipSync(packed, { maxOutputLength: bytes })
  if (graph.byteLength !== bytes || hash(graph) !== sha256)
    throw new Error(`Bundled ${name} graph is damaged.`)
  if (output) {
    const path = join(output, `${name}.onnx`)
    await writeFile(`${path}.tmp`, graph)
    await rename(`${path}.tmp`, path)
  }
  console.log(`${name}: verified ${bytes} bytes, SHA-256 ${sha256}`)
}
console.log(
  'Bundled SAM 2.1 object selection model verified. No Python, download or model inference required.',
)
const automatic = join(source, 'automatic')
const automaticManifest = JSON.parse(await readFile(join(automatic, 'manifest.json'), 'utf8'))
if (
  automaticManifest.version !== 1 ||
  automaticManifest.identity !== 'mask2former-sky-birefnet-background-fp32-v1' ||
  automaticManifest.runtime !== 'onnxruntime-node@1.31.1'
)
  throw new Error('Unsupported bundled automatic selection model.')
for (const [name, bytes, sha256] of [
  ['sky', 287296604, '2035d1c38fff88ee792d32002b269fe29f5c561009e9256200bdd9e3fbfb515f'],
  ['background', 199681624, '50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67'],
]) {
  const component = automaticManifest.components.find((entry) => entry.name === name)
  if (
    !component ||
    component.bytes !== bytes ||
    component.sha256 !== sha256 ||
    component.compression !== 'gzip' ||
    !Array.isArray(component.parts) ||
    component.parts.length < 1 ||
    component.parts.length > 8 ||
    component.compressedBytes > bytes + 1024 * 1024
  )
    throw new Error(`Unsupported ${name} model descriptor.`)
  const parts = []
  for (const part of component.parts) {
    if (
      !new RegExp(`^${name}\\.onnx\\.gz\\.[0-9]{2}$`).test(part.file) ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 1 ||
      part.bytes > 50 * 1024 * 1024
    )
      throw new Error('Invalid automatic model chunk.')
    const payload = await readFile(join(automatic, part.file))
    if (payload.byteLength !== part.bytes || hash(payload) !== part.sha256)
      throw new Error(`Bundled model chunk ${part.file} is damaged.`)
    parts.push(payload)
  }
  const packed = Buffer.concat(parts)
  if (
    packed.byteLength !== component.compressedBytes ||
    hash(packed) !== component.compressedSha256
  )
    throw new Error(`Bundled ${name} archive is damaged.`)
  const graph = gunzipSync(packed, { maxOutputLength: bytes })
  if (graph.byteLength !== bytes || hash(graph) !== sha256)
    throw new Error(`Bundled ${name} graph is damaged.`)
  if (output) {
    const path = join(output, `${name}.onnx`)
    await writeFile(`${path}.tmp`, graph)
    await rename(`${path}.tmp`, path)
  }
  console.log(`${name}: verified ${bytes} bytes, SHA-256 ${sha256}`)
}
