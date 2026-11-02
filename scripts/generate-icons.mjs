import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const directory = fileURLToPath(new URL('../assets/app/icons/', import.meta.url))
const original = await readFile(join(directory, 'little-jizo.png'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
if (sha256(original) !== '42c43377dab4d25b4fef059255c248c7adeafab462a607fbe90388c967e96de5')
  throw new Error('The selected original icon has changed.')
const output = join(directory, 'generated')
await mkdir(output, { recursive: true })
const images = new Map()
const files = []
async function save(file, bytes) {
  await writeFile(join(output, file), bytes)
  files.push({ file, bytes: bytes.length, sha256: sha256(bytes) })
}
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  const png = await sharp(original)
    .resize(size, size, { fit: 'contain', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
  images.set(size, png)
  await save(`icon-${size}.png`, png)
}
const chunks = []
for (const [size, type] of [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
]) {
  const image = images.get(size),
    header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(image.length + 8, 4)
  chunks.push(header, image)
}
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns')
icnsHeader.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4)
await save('irodori.icns', Buffer.concat([icnsHeader, ...chunks]))
const sizes = [16, 24, 32, 48, 64, 128, 256],
  icoHeader = Buffer.alloc(6 + sizes.length * 16)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(sizes.length, 4)
let offset = icoHeader.length
sizes.forEach((size, index) => {
  const at = 6 + index * 16,
    png = images.get(size)
  icoHeader[at] = size === 256 ? 0 : size
  icoHeader[at + 1] = size === 256 ? 0 : size
  icoHeader.writeUInt16LE(1, at + 4)
  icoHeader.writeUInt16LE(32, at + 6)
  icoHeader.writeUInt32LE(png.length, at + 8)
  icoHeader.writeUInt32LE(offset, at + 12)
  offset += png.length
})
await save('irodori.ico', Buffer.concat([icoHeader, ...sizes.map((size) => images.get(size))]))
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      source: '../little-jizo.png',
      sourceSha256: sha256(original),
      generator: 'npm run icons:generate',
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      policy:
        'Unchanged original; deterministic Lanczos3 downsampling, preserved alpha, stripped derivative metadata. PNG payloads in ICNS and ICO.',
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(`Generated ${files.length} icon derivatives; original hash preserved.`)
