// Offline research diagnostics only; these are not application RAW/HDR edits or exports.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const protocolPath = 'assets/tests/references/refine-edge/protocol.json'
const cropsPath = 'assets/tests/references/refine-edge/crops.json'
const escape = (text) => text.replace(/[&<>"']/g, (value) => `&#${value.charCodeAt(0)};`)
const lifted = Float64Array.from({ length: 256 }, (_, i) => {
  const value = i / 255
  return 2 * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
})
const linear = Float64Array.from(lifted, (value) => value / 2)
const encode = (value) =>
  Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055))

/** Retain every R8 coverage level; never threshold fractional candidate output. */
export function diagnosticPixels(rgba, coverage, mode) {
  if (rgba.length !== coverage.length * 4 || !['overlay', 'plus-one-ev'].includes(mode))
    throw new Error('Invalid native diagnostic coverage or mode.')
  const output = Buffer.from(rgba)
  for (let i = 0; i < coverage.length; i++) {
    const alpha = coverage[i] / 255
    for (let c = 0; c < 3; c++) {
      const at = i * 4 + c
      output[at] =
        mode === 'overlay'
          ? Math.round(rgba[at] * (1 - 0.45 * alpha) + (c === 0 ? 255 : 40) * 0.45 * alpha)
          : encode(Math.min(1, linear[rgba[at]] * (1 - alpha) + lifted[rgba[at]] * alpha))
    }
  }
  return output
}

async function label(text, width, height = 28) {
  return Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#181818"/><text x="8" y="20" font-size="14" fill="white">${escape(text)}</text></svg>`,
  )
}

async function panel(rgba, width, height, region, fit) {
  let image = sharp(rgba, { raw: { width, height, channels: 4 } })
  if (region)
    image = image.extract({
      left: region.x,
      top: region.y,
      width: region.width,
      height: region.height,
    })
  if (fit) image = image.resize(fit.width, fit.height, { fit: 'contain', background: '#181818' })
  return image.png().toBuffer()
}

function contained(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'))
}

export async function renderProofs(manifestPath, outputPath) {
  const manifestFile = resolve(manifestPath)
  const output = resolve(outputPath)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const cropsBytes = await readFile(cropsPath)
  const crops = JSON.parse(cropsBytes)
  const protocolSha256 = hash(await readFile(protocolPath))
  if (manifest.protocolSha256 !== protocolSha256 || crops.protocolSha256 !== protocolSha256)
    throw new Error('Study protocol changed after freezing candidate inputs.')
  if (manifest.status !== 'passed' || !Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error('No passed native cases to render.')
  for (const entry of manifest.cases) {
    for (const field of ['rgbaPath', 'maskPath', 'featherPath', 'guidedPath']) {
      if (!isAbsolute(entry[field]) || contained(output, entry[field]))
        throw new Error('Proof output overlaps source evidence or uses ambiguous paths.')
    }
  }
  if (contained(output, manifestFile)) throw new Error('Proof output overlaps its input manifest.')
  await mkdir(output, { recursive: false })
  const proofs = []
  for (const entry of manifest.cases) {
    const crop = crops.cases.find((value) => value.id === entry.id)
    if (!crop || crop.width !== entry.width || crop.height !== entry.height)
      throw new Error(`Changed source grid: ${entry.id}`)
    const rgba = await readFile(entry.rgbaPath)
    if (rgba.length !== entry.width * entry.height * 4 || hash(rgba) !== entry.rgbaSha256)
      throw new Error(`Changed native pixels: ${entry.id}`)
    const methods = [
      { id: 'source', title: 'Source', coverage: new Uint8Array(entry.width * entry.height) },
    ]
    for (const [id, title, pathField, shaField] of [
      ['sam', 'SAM baseline', 'maskPath', 'maskSha256'],
      ['feather', 'Feather 4 / shift 0', 'featherPath', 'featherSha256'],
      ['guided', 'RGB guided', 'guidedPath', 'guidedSha256'],
    ]) {
      const coverage = await readFile(entry[pathField])
      if (coverage.length !== entry.width * entry.height || hash(coverage) !== entry[shaField])
        throw new Error(`Changed ${id} coverage: ${entry.id}`)
      methods.push({ id, title, coverage })
    }
    const directory = join(output, entry.id)
    await mkdir(directory)
    const fit = { width: 320, height: 240 }
    const rowHeight = fit.height + 28
    const fitLayers = []
    const cropLayers = new Map(crop.regions.map((region) => [region.name, []]))
    for (let m = 0; m < methods.length; m++) {
      const method = methods[m]
      for (let row = 0; row < 2; row++) {
        const mode = row === 0 ? 'overlay' : 'plus-one-ev'
        const pixels = diagnosticPixels(rgba, method.coverage, mode)
        fitLayers.push(
          {
            input: await label(`${method.title} / ${mode}`, fit.width),
            left: m * fit.width,
            top: row * rowHeight,
          },
          {
            input: await panel(pixels, entry.width, entry.height, null, fit),
            left: m * fit.width,
            top: row * rowHeight + 28,
          },
        )
        for (const region of crop.regions) {
          if (
            region.x < 0 ||
            region.y < 0 ||
            region.x + region.width > entry.width ||
            region.y + region.height > entry.height
          )
            throw new Error(`Review crop outside native source: ${entry.id}/${region.name}`)
          cropLayers.get(region.name).push(
            {
              input: await label(`${method.title} / ${mode}`, region.width),
              left: m * region.width,
              top: row * (region.height + 28),
            },
            {
              input: await panel(pixels, entry.width, entry.height, region),
              left: m * region.width,
              top: row * (region.height + 28) + 28,
            },
          )
        }
      }
      if (method.id !== 'source')
        await sharp(method.coverage, {
          raw: { width: entry.width, height: entry.height, channels: 1 },
        })
          .png()
          .toFile(join(directory, `${method.id}-alpha.png`))
    }
    const fitPath = join(directory, 'fit.png')
    await sharp({
      create: { width: 4 * fit.width, height: 2 * rowHeight, channels: 4, background: '#181818' },
    })
      .composite(fitLayers)
      .png()
      .toFile(fitPath)
    const nativePaths = []
    for (const region of crop.regions) {
      const path = join(directory, `${region.name}-native.png`)
      await sharp({
        create: {
          width: 4 * region.width,
          height: 2 * (region.height + 28),
          channels: 4,
          background: '#181818',
        },
      })
        .composite(cropLayers.get(region.name))
        .png()
        .toFile(path)
      nativePaths.push({ name: region.name, path, sha256: hash(await readFile(path)) })
    }
    proofs.push({
      id: entry.id,
      fitPath,
      fitSha256: hash(await readFile(fitPath)),
      nativePaths,
      coverage: methods.slice(1).map((method) => ({
        method: method.id,
        sha256: hash(method.coverage),
        fractionalPixels: method.coverage.reduce((n, x) => n + (x > 0 && x < 255 ? 1 : 0), 0),
      })),
    })
    await writeFile(
      join(output, 'proofs.json'),
      JSON.stringify(
        {
          version: 1,
          protocolSha256,
          cropsSha256: hash(cropsBytes),
          manifestSha256: hash(await readFile(manifestFile)),
          diagnosticOnly: true,
          physicalAlphaOrHdrClaim: false,
          cases: proofs,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`Rendered ${entry.id}: Fit and ${nativePaths.length} native regions.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4)
    throw new Error('Usage: node render-proofs.mjs <passed-manifest.json> <new-output-directory>')
  await renderProofs(process.argv[2], process.argv[3])
}
