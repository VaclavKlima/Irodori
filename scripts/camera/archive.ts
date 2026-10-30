import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

export const archiveLimit = 64 * 1024 ** 2
export const expandedLimit = 128 * 1024 ** 2
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export function safeRuntimePath(name: string) {
  if (
    !/^[A-Za-z0-9_./-]{1,200}$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe runtime archive path: ${name}`)
  return name
}

export interface ArchiveFile {
  path: string
  mode: number
  bytes: Buffer
}

// Our distribution format is deliberately limited to regular USTAR files: no
// links, devices, extensions, duplicate names or extraction through system tar.
export function unpackRuntimeArchive(archive: Buffer): ArchiveFile[] {
  if (archive.length > archiveLimit) throw new Error('Runtime archive exceeds download limit.')
  const tar = gunzipSync(archive, { maxOutputLength: expandedLimit })
  const files: ArchiveFile[] = []
  const names = new Set<string>()
  const string = (header: Buffer, start: number, end: number) =>
    header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '')
  const number = (header: Buffer, start: number, end: number) => {
    const value = string(header, start, end).trim()
    if (!/^[0-7]+$/.test(value)) throw new Error('Invalid USTAR numeric field.')
    return parseInt(value, 8)
  }
  let offset = 0
  for (; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const checksum = number(header, 148, 156)
    const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0)
    if (checksum !== sum || string(header, 257, 263) !== 'ustar')
      throw new Error('Invalid USTAR header/checksum.')
    if (header[156] !== 0 && header[156] !== 48)
      throw new Error('Only regular files are permitted in runtime archives.')
    if (header.subarray(157, 257).some((byte) => byte !== 0))
      throw new Error('Archive link targets are forbidden.')
    const prefix = string(header, 345, 500)
    const path = safeRuntimePath((prefix ? `${prefix}/` : '') + string(header, 0, 100))
    if (names.has(path) || files.length >= 1024)
      throw new Error('Duplicate/oversized archive index.')
    names.add(path)
    const mode = number(header, 100, 108)
    const size = number(header, 124, 136)
    if (![0o644, 0o755].includes(mode) || size < 1 || offset + 512 + size > tar.length)
      throw new Error('Invalid runtime file size/mode.')
    files.push({ path, mode, bytes: tar.subarray(offset + 512, offset + 512 + size) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (
    files.length === 0 ||
    offset + 1024 > tar.length ||
    tar.length % 512 !== 0 ||
    tar.subarray(offset).some((byte) => byte !== 0)
  )
    throw new Error('Incomplete runtime archive or unexpected trailing content.')
  return files
}

export function packRuntimeArchive(files: ArchiveFile[]) {
  const chunks: Buffer[] = []
  for (const file of files) {
    safeRuntimePath(file.path)
    const header = Buffer.alloc(512)
    const parts = file.path.split('/')
    const name = parts.pop()!
    const prefix = parts.join('/')
    if (name.length > 100 || prefix.length > 155) throw new Error('USTAR path is too long.')
    header.write(name)
    header.write(prefix, 345)
    const octal = (value: number, start: number, length: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii')
    octal(file.mode, 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(file.bytes.length, 124, 12)
    octal(0, 136, 12)
    header.fill(32, 148, 156)
    header[156] = 48
    header.write('ustar\0', 257)
    header.write('00', 263)
    octal(
      header.reduce((sum, byte) => sum + byte, 0),
      148,
      8,
    )
    chunks.push(header, file.bytes, Buffer.alloc((512 - (file.bytes.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}
