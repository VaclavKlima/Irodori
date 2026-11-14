// Research-only paired diagnostics; no application RAW/HDR rendering claim.
import sharp from 'sharp'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { diagnosticPixels } from './render-proofs.mjs'

const [input, destination] = process.argv.slice(2)
if (!input || !destination)
  throw new Error('Provide photographic result.json and a fresh output directory.')
const result = JSON.parse(await readFile(input, 'utf8'))
if (result.status !== 'passed-proposal-unreviewed')
  throw new Error('Photographic execution has not passed.')
const base = result.source,
  width = result.width,
  height = result.height
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const rgba = await readFile(base.rgbaPath)
if (rgba.length !== width * height * 4 || hash(rgba) !== base.rgbaSha256)
  throw new Error('Native source changed.')
const original = JSON.parse(
  await readFile('artifacts/research/refine-edge/2026-11-13T19-41-14Z/guided/cases.json', 'utf8'),
).cases.find((x) => x.id === result.id)
const methods = [{ title: 'Source', mask: new Uint8Array(width * height) }]
for (const [title, path, expected] of [
  ['SAM', base.maskPath, base.maskSha256],
  ['Feather 4', original.featherPath, original.featherSha256],
  ['CascadePSP', result.coveragePath, result.coverageSha256],
]) {
  const mask = await readFile(path)
  if (mask.length !== width * height || hash(mask) !== expected)
    throw new Error('Coverage changed: ' + title)
  methods.push({ title, mask })
}
const crops = JSON.parse(
  await readFile('assets/tests/references/refine-edge/crops.json', 'utf8'),
).cases.find((x) => x.id === result.id)
const output = resolve(destination)
await mkdir(output, { recursive: false })
const views = [{ name: 'fit', width: 320, height: 240 }, ...crops.regions]
const files = []
for (const view of views) {
  const layers = []
  for (let column = 0; column < methods.length; column++) {
    for (let row = 0; row < 2; row++) {
      const mode = row === 0 ? 'overlay' : 'plus-one-ev'
      const pixels = diagnosticPixels(rgba, methods[column].mask, mode)
      let image = sharp(pixels, { raw: { width, height, channels: 4 } })
      if (view.name === 'fit')
        image = image.resize(view.width, view.height, { fit: 'contain', background: '#181818' })
      else
        image = image.extract({ left: view.x, top: view.y, width: view.width, height: view.height })
      const top = row * (view.height + 28),
        left = column * view.width
      layers.push(
        {
          input: Buffer.from(
            `<svg width="${view.width}" height="28"><rect width="100%" height="100%" fill="#181818"/><text x="8" y="20" fill="white" font-size="14">${methods[column].title} / ${mode}</text></svg>`,
          ),
          left,
          top,
        },
        { input: await image.png().toBuffer(), left, top: top + 28 },
      )
    }
  }
  const path = join(output, view.name + '.png')
  await sharp({
    create: {
      width: 4 * view.width,
      height: 2 * (view.height + 28),
      channels: 4,
      background: '#181818',
    },
  })
    .composite(layers)
    .png()
    .toFile(path)
  files.push({ name: view.name, path, sha256: hash(await readFile(path)) })
}
await writeFile(
  join(output, 'proofs.json'),
  JSON.stringify(
    {
      version: 1,
      id: result.id,
      diagnosticOnly: true,
      nativeRegions: '1 source pixel per output pixel',
      sourceRgbaSha256: base.rgbaSha256,
      candidateCoverageSha256: result.coverageSha256,
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(JSON.stringify({ id: result.id, views: files.length, output }))
