import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const CROP_SIZE = 512
const HEADER_HEIGHT = 54
const ROW_HEIGHT = CROP_SIZE + HEADER_HEIGHT
const BOARD_WIDTH = CROP_SIZE * 3
const FOOTER_HEIGHT = 104
const BOARD_HEIGHT = ROW_HEIGHT * 2 + FOOTER_HEIGHT
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function inside(directory, path) {
  const remainder = relative(directory, path)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

function lines(text, limit) {
  const result = []
  let line = ''
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > limit) {
      result.push(line)
      line = ''
    }
    let remaining = word
    while (remaining.length > limit) {
      if (line) result.push(line)
      result.push(remaining.slice(0, limit))
      remaining = remaining.slice(limit)
      line = ''
    }
    line = line ? `${line} ${remaining}` : remaining
  }
  if (line) result.push(line)
  return result
}

function svgPanel(width, height, content) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#202020"/><g font-family="DejaVu Sans,sans-serif" fill="#f1f1f1">${content}</g></svg>`,
  )
}

function svgText(text, x, y, size = 16, fill = '#f1f1f1') {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${escape(text)}</text>`
}

function header(name, controls) {
  return svgPanel(
    CROP_SIZE,
    HEADER_HEIGHT,
    svgText(name, 12, 23, 19) +
      svgText(
        `Amount ${controls.amount} | Radius ${controls.radius} | Threshold ${controls.threshold}`,
        12,
        45,
        14,
      ),
  )
}

function scopePanel(entry, region) {
  const paragraphs = [
    `${entry.id} / ${region.name}`,
    'Native 512 x 512; one source pixel per PNG pixel.',
    'Full native source filtered before crop extraction; complete neighbor halos retained.',
    'Noise reduction: luminance 0, chroma 0. Saved-detail controls only.',
    'Strong settings are stress cases, not recommended defaults.',
    'Processing appearance proof; no compositor capture or physical HDR measurement.',
    `Credit: ${entry.credit}`,
    `License: ${entry.license}`,
  ]
  let y = 28
  const text = []
  for (const paragraph of paragraphs) {
    for (const line of lines(paragraph, 51)) {
      text.push(svgText(line, 16, y, 16))
      y += 22
    }
    y += 10
  }
  requireValue(y <= CROP_SIZE, 'Scope text exceeds native board tile')
  return svgPanel(CROP_SIZE, CROP_SIZE, text.join(''))
}

function footer(entry) {
  const text = [
    `Credit: ${entry.credit} | ${entry.license}`,
    `Source: ${entry.sourceUrl ?? entry.notice}`,
    'Changes: native crop + saved-detail Amount/Radius/Threshold variants; neutral NR; no board resampling.',
  ]
  let y = 23
  const content = []
  for (const paragraph of text) {
    for (const line of lines(paragraph, 172)) {
      content.push(svgText(line, 14, y, 15))
      y += 22
    }
  }
  requireValue(y <= FOOTER_HEIGHT + 5, 'Credit text exceeds board footer')
  return svgPanel(BOARD_WIDTH, FOOTER_HEIGHT, content.join(''))
}

function sameRegion(left, right) {
  return ['name', 'left', 'top', 'width', 'height'].every((key) => left?.[key] === right?.[key])
}

async function loadBoards(reportPath, protocolPath, outputPath) {
  const [reportBytes, protocolBytes] = await Promise.all([
    readFile(reportPath),
    readFile(protocolPath),
  ])
  const report = JSON.parse(reportBytes)
  const protocol = JSON.parse(protocolBytes)
  requireValue(
    report.status === 'generated-awaiting-visual-review',
    'Input report must be generated-awaiting-visual-review',
  )
  requireValue(sha256(protocolBytes) === report.protocolSha256, 'Frozen protocol SHA-256 mismatch')
  requireValue(
    protocol.noiseReduction?.luminance === 0 && protocol.noiseReduction?.chroma === 0,
    'The photographic review requires neutral noise reduction',
  )
  requireValue(
    protocol.cases?.length === 3 && report.cases?.length === 3,
    'Expected three frozen photographic cases',
  )
  requireValue(protocol.variants?.length === 5, 'Expected five frozen variants')
  const caseIds = new Set()
  const boards = []
  for (const entry of protocol.cases) {
    requireValue(
      /^[a-z0-9-]+$/.test(entry.id) && !caseIds.has(entry.id),
      'Invalid or duplicate photographic case ID',
    )
    caseIds.add(entry.id)
    requireValue(entry.credit && entry.license, `Missing credit/license: ${entry.id}`)
    const matches = report.cases.filter((item) => item.id === entry.id)
    requireValue(matches.length === 1, `Missing/duplicate report case: ${entry.id}`)
    const item = matches[0]
    requireValue(
      entry.regions?.length === 2 && item.regions?.length === 2,
      `Expected two native regions: ${entry.id}`,
    )
    requireValue(item.variants?.length === 5, `Expected five variants: ${entry.id}`)
    const regionNames = new Set()
    for (const region of entry.regions) {
      requireValue(
        /^[a-z0-9-]+$/.test(region.name) && !regionNames.has(region.name),
        `Invalid or duplicate region: ${entry.id}`,
      )
      regionNames.add(region.name)
      requireValue(
        region.width === CROP_SIZE &&
          region.height === CROP_SIZE &&
          item.regions.some((candidate) => sameRegion(region, candidate)),
        `Native region differs from protocol: ${entry.id}/${region.name}`,
      )
      const crops = []
      for (const [index, expected] of protocol.variants.entries()) {
        const variant = item.variants[index]
        requireValue(
          variant.name === expected.name &&
            ['amount', 'radius', 'threshold'].every(
              (key) => variant.controls?.[key] === expected[key],
            ),
          `Variant order/controls differ from protocol: ${entry.id}/${expected.name}`,
        )
        requireValue(variant.crops?.length === 2, 'Expected two crops per variant')
        const selected = variant.crops.filter((crop) => sameRegion(crop.region, region))
        requireValue(selected.length === 1, `Missing/duplicate crop: ${region.name}`)
        const crop = selected[0]
        requireValue(crop.sourcePixelsPerPngPixel === 1, 'Crop must retain native source pixels')
        const cropPath = isAbsolute(crop.path)
          ? resolve(crop.path)
          : resolve(dirname(reportPath), crop.path)
        requireValue(!inside(outputPath, cropPath), 'Output overlaps source crop')
        const bytes = await readFile(cropPath)
        requireValue(sha256(bytes) === crop.sha256, `Crop SHA-256 mismatch: ${cropPath}`)
        const metadata = await sharp(bytes).metadata()
        requireValue(
          metadata.format === 'png' &&
            metadata.width === CROP_SIZE &&
            metadata.height === CROP_SIZE &&
            !metadata.orientation &&
            (metadata.pages ?? 1) === 1,
          `Crop must be an unoriented single native 512x512 PNG: ${cropPath}`,
        )
        crops.push({
          name: variant.name,
          controls: {
            amount: expected.amount,
            radius: expected.radius,
            threshold: expected.threshold,
          },
          path: cropPath,
          sha256: crop.sha256,
          width: metadata.width,
          height: metadata.height,
          bytes,
        })
      }
      boards.push({
        entry,
        region,
        crops,
        nativeSourceSize: { width: item.asset.width, height: item.asset.height },
      })
    }
  }
  requireValue(boards.length === 6, 'Expected exactly six native photographic boards')
  return {
    boards,
    reportSha256: sha256(reportBytes),
    protocolSha256: sha256(protocolBytes),
    protocol,
  }
}

function externalLink(url, text) {
  if (!url) return escape(text)
  const parsed = new URL(url)
  requireValue(['https:', 'file:'].includes(parsed.protocol), 'Unsupported attribution URL')
  return `<a href="${escape(parsed.href)}">${escape(text)}</a>`
}

async function gallery(boards, protocol, index) {
  const sections = []
  for (const [position, board] of boards.entries()) {
    const bytes = await readFile(board.path)
    requireValue(sha256(bytes) === board.sha256, 'Board changed before HTML embedding')
    const image = `data:image/png;base64,${bytes.toString('base64')}`
    const imageId = `native-board-${position}`
    const noticeUrl = `https://github.com/VaclavKlima/Irodori/blob/main/${board.notice}`
    sections.push(
      `<section><h2>${escape(board.caseId)} / ${escape(board.region.name)}</h2>
<p>${escape(board.credit)}. ${externalLink(board.sourceUrl ?? noticeUrl, 'Source / notice')}. ${externalLink(board.licenseUrl, board.license)}. Changes: native crop, saved-detail sharpening variants and labeled montage. Noise reduction remains neutral.</p>
<p><a href="#${imageId}" download="${escape(board.file)}" data-image-download="${imageId}">Save native PNG</a> (${board.width} x ${board.height}); source ${board.nativeSourceSize.width} x ${board.nativeSourceSize.height}; crop origin ${board.region.left}, ${board.region.top}.</p>
<div class="board"><img id="${imageId}" src="${image}" width="${board.width}" height="${board.height}" alt="Five native sharpening variants for ${escape(board.caseId)} ${escape(board.region.name)}" /></div></section>`,
    )
  }
  const embeddedJson = (value) =>
    `data:application/json;base64,${Buffer.from(JSON.stringify(value, null, 2)).toString('base64')}`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Native detail photographic review</title><style>
body{margin:24px;background:#181818;color:#e7e7e7;font:15px/1.5 system-ui,sans-serif}a{color:#bcd5ee}h1{font-size:25px}h2{font-size:19px;margin-top:32px}p{max-width:1100px}.board{overflow:auto;border:1px solid #454545}img{display:block;width:${BOARD_WIDTH}px;height:${BOARD_HEIGHT}px;max-width:none}code{overflow-wrap:anywhere}
</style></head><body><h1>Native detail photographic review</h1>
<p>Six self-contained processing appearance boards. Each 512 x 512 crop is placed without resampling. View at browser zoom 100% for one PNG pixel per CSS pixel; scroll horizontally to keep native size. The full native source was filtered before crop extraction to retain complete neighborhoods. These are processing proofs, not compositor captures or physical HDR measurements.</p>
<p>${escape(protocol.scope)}</p><p>Order: neutral, standard, fine-unprotected, wide-unprotected, wide-protected. Strong settings are stress cases, not recommended defaults. The fifth variant uses Threshold 100 to suppress weaker high-pass changes; luminance/chroma NR stay at zero.</p>
<p>Attribution and licenses accompany every board. Changes are declared per source; retain applicable source attribution and share-alike terms. Project-permission forest material has no general open-content license.</p>
<p><a href="${embeddedJson(index)}" download="index.json">Save hash and native-size index</a> | <a href="${embeddedJson(protocol)}" download="protocol.json">Save frozen source protocol</a></p>${sections.join('\n')}<script>
for (const link of document.querySelectorAll('[data-image-download]')) {
  link.href = document.getElementById(link.dataset.imageDownload).src
}
</script></body></html>\n`
}

async function main() {
  requireValue(
    process.argv.length === 4,
    'Usage: node scripts/research/render-detail-review.mjs <result.json> <fresh-output-dir>',
  )
  const reportPath = resolve(process.argv[2])
  const protocolPath = join(dirname(reportPath), 'protocol.json')
  const outputPath = resolve(process.argv[3])
  const artifactsRoot = join(projectRoot, 'artifacts')
  requireValue(
    inside(artifactsRoot, outputPath) && outputPath !== artifactsRoot,
    'Output must be a private directory under artifacts/',
  )
  requireValue(
    !inside(outputPath, reportPath) && !inside(outputPath, protocolPath),
    'Output overlaps source report/protocol',
  )
  const loaded = await loadBoards(reportPath, protocolPath, outputPath)
  // A fresh leaf directory prevents overwriting retained evidence, including failed runs.
  await mkdir(outputPath, { recursive: false })
  const boards = []
  for (const { entry, region, crops, nativeSourceSize } of loaded.boards) {
    const composites = []
    for (const [index, crop] of crops.entries()) {
      const left = (index % 3) * CROP_SIZE
      const top = Math.floor(index / 3) * ROW_HEIGHT
      composites.push({ input: header(crop.name, crop.controls), left, top })
      composites.push({ input: crop.bytes, left, top: top + HEADER_HEIGHT })
    }
    composites.push({
      input: header('Evidence scope', { amount: 'varied', radius: 'varied', threshold: 'varied' }),
      left: CROP_SIZE * 2,
      top: ROW_HEIGHT,
    })
    composites.push({
      input: scopePanel(entry, region),
      left: CROP_SIZE * 2,
      top: ROW_HEIGHT + HEADER_HEIGHT,
    })
    composites.push({ input: footer(entry), left: 0, top: ROW_HEIGHT * 2 })
    const file = `${entry.id}--${region.name}.png`
    const bytes = await sharp({
      create: { width: BOARD_WIDTH, height: BOARD_HEIGHT, channels: 4, background: '#181818' },
    })
      .composite(composites)
      .png()
      .toBuffer()
    await writeFile(join(outputPath, file), bytes, { flag: 'wx' })
    boards.push({
      caseId: entry.id,
      region,
      credit: entry.credit,
      sourceUrl: entry.sourceUrl,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
      notice: entry.notice,
      file,
      path: join(outputPath, file),
      sha256: sha256(bytes),
      width: BOARD_WIDTH,
      height: BOARD_HEIGHT,
      nativeSourceSize,
      variants: crops.map((crop) => {
        const record = { ...crop }
        delete record.bytes
        return record
      }),
    })
  }
  const index = {
    version: 1,
    status: 'rendered-awaiting-visual-review',
    reportPath,
    reportSha256: loaded.reportSha256,
    protocolPath,
    protocolSha256: loaded.protocolSha256,
    processingOnly: true,
    sourcePixelsPerCropPixel: 1,
    boardResampling: false,
    selfContainedHtml: true,
    nativeCrop: { width: CROP_SIZE, height: CROP_SIZE },
    boards,
  }
  await writeFile(join(outputPath, 'index.html'), await gallery(boards, loaded.protocol, index), {
    flag: 'wx',
  })
  await writeFile(join(outputPath, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, {
    flag: 'wx',
  })
  console.log(
    JSON.stringify({
      status: index.status,
      boards: boards.length,
      index: join(outputPath, 'index.json'),
      gallery: join(outputPath, 'index.html'),
    }),
  )
}

main().catch((error) => {
  console.error(error.stack ?? String(error))
  process.exitCode = 1
})
