import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (condition, message) => {
  if (!condition) throw new Error(`Masked Texture gallery: ${message}`)
}
const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  })
const jsonUrl = (bytes) => `data:application/json;base64,${bytes.toString('base64')}`
const inside = (parent, path) => {
  const part = relative(parent, path)
  return (
    part !== '..' &&
    !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(part)
  )
}
const sameRegion = (a, b) =>
  ['name', 'left', 'top', 'width', 'height'].every((field) => a?.[field] === b?.[field])
const amountText = (amount) => (amount > 0 ? `+${amount}` : String(amount).replace('-', '−'))

function externalLink(url, label) {
  const parsed = new URL(url)
  check(['https:', 'http:'].includes(parsed.protocol), 'Source/license link must use HTTP(S)')
  return `<a href="${escape(parsed.href)}" rel="noreferrer">${escape(label)}</a>`
}

/**
 * Build the portable research gallery after runPhotographs has completed.
 *
 * API: await renderGallery({ output: '/absolute/path/to/private-run-directory' }).
 * Input: output/photographs/{result,protocol,photo-cases}.json and their recorded PNGs.
 * Output: output/gallery.html, created exclusively; an existing gallery is never replaced.
 * Return: { path, sha256, bytes, regions, variantsPerRegion, combinedNativeCrops }.
 * This reads/embeds existing evidence only: no decoding, filtering, inference, GPU or app launch.
 * CLI: node scripts/research/masked-texture/gallery.mjs <private-run-directory>
 */
export async function renderGallery({ output }) {
  check(typeof output === 'string' && output.length > 0, 'Provide the owned run output directory')
  const artifactsRoot = await realpath(join(projectRoot, 'artifacts'))
  const outputDirectory = await realpath(resolve(output))
  check(
    inside(artifactsRoot, outputDirectory) && outputDirectory !== artifactsRoot,
    'Output must be an existing private run directory under artifacts/',
  )
  const photographs = await realpath(join(outputDirectory, 'photographs'))
  check(inside(outputDirectory, photographs), 'Photographs directory escapes the owned run')
  const reportBytes = await readFile(join(photographs, 'result.json'))
  const report = JSON.parse(reportBytes)
  check(report.version === 1, 'Unsupported photographic receipt version')
  check(report.status === 'generated-unreviewed', 'Require complete generated-unreviewed evidence')
  check(!report.error && !report.cleanupErrors?.length, 'Photographic generation or cleanup failed')
  check(report.foreground === false, 'Receipt does not identify a background research run')

  const protocolBytes = await readFile(join(photographs, 'protocol.json'))
  const casesBytes = await readFile(join(photographs, 'photo-cases.json'))
  check(digest(protocolBytes) === report.protocol?.sha256, 'Frozen protocol hash mismatch')
  check(
    digest(casesBytes) === report.photoCases?.sha256,
    'Frozen photographic selection hash mismatch',
  )
  const protocol = JSON.parse(protocolBytes)
  const cases = JSON.parse(casesBytes)
  check(protocol.id === 'masked-texture-llf-residual-v1', 'Unexpected candidate protocol')
  check(
    protocol.photoCases.sha256 === digest(casesBytes),
    'Protocol photographic selection changed',
  )
  const selected = cases.cases.filter((entry) => entry.enabled)
  check(selected.length === 1, 'Require only the frozen first photograph')
  const source = selected[0]
  check(
    source.id === 'flamingo-plumage-ripples-reflected-legs' &&
      JSON.stringify(source) === JSON.stringify(report.case),
    'Receipt and frozen first photograph differ',
  )
  check(
    report.source?.sha256 === source.sha256 &&
      report.asset?.width === source.width &&
      report.asset?.height === source.height,
    'Receipt source identity/native dimensions differ',
  )
  check(
    report.baseline?.exactOriginalProductionProof === true &&
      report.baseline.originalProofDifferentBytes === 0,
    'Prepared Neutral did not retain the original production proof',
  )
  check(
    report.comparator?.name === 'global-sharpen-50-1-50',
    'Missing existing global saved-detail comparator',
  )
  const regions = source.regions
  check(regions.length === 3, 'Require the three frozen photographic regions')
  check(
    JSON.stringify(regions.map((region) => region.name).sort()) ===
      JSON.stringify(['plumage-native', 'reflected-legs-native', 'ripples-native'].sort()),
    'Unexpected native region names',
  )

  const images = new Map()
  async function png(record, expectedWidth, expectedHeight) {
    check(
      record && typeof record.path === 'string' && /^[a-f0-9]{64}$/.test(record.sha256),
      'Missing pinned PNG evidence',
    )
    const path = await realpath(resolve(photographs, record.path))
    check(inside(photographs, path), 'PNG evidence escapes the photograph directory')
    if (images.has(path)) {
      const cached = images.get(path)
      check(
        cached.width === expectedWidth && cached.height === expectedHeight,
        'PNG reused with inconsistent dimensions',
      )
      return cached
    }
    const bytes = await readFile(path)
    check(
      bytes.length === record.bytes && digest(bytes) === record.sha256,
      `PNG changed: ${basename(path)}`,
    )
    check(
      bytes.length >= 33 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) === expectedWidth &&
        bytes.readUInt32BE(20) === expectedHeight,
      `PNG dimensions/format differ: ${basename(path)}`,
    )
    const result = {
      url: `data:image/png;base64,${bytes.toString('base64')}`,
      width: expectedWidth,
      height: expectedHeight,
      name: `${basename(dirname(path))}-${basename(path)}`,
    }
    images.set(path, result)
    return result
  }
  async function crop(record, region) {
    check(
      region.width === 512 &&
        region.height === 512 &&
        [region.left, region.top].every(Number.isSafeInteger) &&
        region.left >= 0 &&
        region.top >= 0 &&
        region.left + 512 <= source.width &&
        region.top + 512 <= source.height,
      'Native crop is outside the frozen source grid',
    )
    const matches = record?.crops?.filter((item) => sameRegion(item.region, region)) ?? []
    check(matches.length === 1, `Missing or duplicate native crop: ${region.name}`)
    check(matches[0].sourcePixelsPerPngPixel === 1, 'Native crop was resampled')
    return png(matches[0], 512, 512)
  }
  async function fit(record) {
    const item = record?.fit
    check(
      Number.isSafeInteger(item?.width) &&
        Number.isSafeInteger(item?.height) &&
        item.width > 0 &&
        item.width <= 1100 &&
        item.height > 0 &&
        item.height <= 800,
      'Missing bounded Fit evidence',
    )
    return png(item, item.width, item.height)
  }
  function candidate(maskId, amount) {
    const matches = report.variants.filter(
      (record) => record.controls?.maskId === maskId && record.controls.amount === amount,
    )
    check(matches.length === 1, `Missing or duplicate Texture ${maskId} ${amount}`)
    const record = matches[0]
    check(
      record.qa?.exactIdentityGates === 'passed' && record.unmaskedProof?.passed === true,
      `Native identity/original-proof gate did not pass: ${record.name}`,
    )
    return record
  }
  function imageTag(item, alt, native = false) {
    return `<img class="${native ? 'native-image' : 'fit-image'}" src="${item.url}" width="${item.width}" height="${item.height}" alt="${escape(alt)}" decoding="async"/>`
  }
  function card(item, title, description, { stress = false, native = true } = {}) {
    return `<article class="${native ? 'native-card' : 'fit-card'}"><div class="caption"><h3>${escape(title)}${stress ? '<span class="stress">Stress</span>' : ''}</h3><p>${escape(description)}</p></div>${imageTag(item, title, native)}<a class="image-save" href="${item.url}" download="${escape(item.name)}">Save PNG</a></article>`
  }

  const sections = []
  for (const region of regions) {
    const maskId = region.name.replace(/-native$/, '')
    const mask = source.masks.find((item) => item.id === maskId)
    check(mask, `Missing frozen manual mask: ${maskId}`)
    const cards = [
      card(await crop(report.baseline, region), 'Neutral', 'No Texture; no detail sharpening.'),
      card(
        await crop(report.comparator, region),
        'Global sharpening 50 / 1 / 50',
        'Existing saved-detail comparator; affects the whole photograph.',
      ),
    ]
    for (const amount of [-25, 25, -100, 100]) {
      cards.push(
        card(
          await crop(candidate(maskId, amount), region),
          `Texture ${amountText(amount)}`,
          Math.abs(amount) === 100
            ? 'Stress setting; not a recommended default. Only this partial manual region is active.'
            : 'Modest setting; only this partial manual region is active.',
          { stress: Math.abs(amount) === 100 },
        ),
      )
    }
    sections.push(
      `<section id="${escape(maskId)}"><h2>${escape(mask.label)}</h2><p>${escape(region.purpose)} Native source crop: (${region.left}, ${region.top}), 512 × 512. This is a deliberately partial manual region, not segmentation or recovered alpha.</p><div class="native-viewport" tabindex="0" role="region" aria-label="${escape(mask.label)} six-variant native comparison"><div class="variant-row">${cards.join('\n')}</div></div></section>`,
    )
  }

  const combined = report.combined
  check(
    combined?.name === 'texture-independent-combined' &&
      combined.qa?.exactIdentityGates === 'passed' &&
      combined.unmaskedProof?.passed === true,
    'Missing sequential combined evidence or its identity gates',
  )
  check(
    JSON.stringify(combined.controls.order) ===
      JSON.stringify(
        [...source.maskOrder].reverse().map((maskId) => ({
          maskId,
          amount: protocol.variants.independentAmounts[maskId],
        })),
      ),
    'Combined order/strengths differ from the frozen protocol',
  )
  const combinedAmounts = combined.controls.order
    .map(({ maskId, amount }) => `${maskId} ${amountText(amount)}`)
    .join(' → ')
  const fitCards = [
    card(await fit(report.baseline), 'Neutral / Fit', 'Resized SDR appearance reference.', {
      native: false,
    }),
    card(
      await fit(report.comparator),
      'Global sharpening / Fit',
      'Amount 50, Radius 1, Threshold 50; neutral NR.',
      { native: false },
    ),
    card(await fit(combined), 'Independent Texture / Fit', combinedAmounts, { native: false }),
  ]
  const combinedCrops = []
  for (const region of regions) {
    combinedCrops.push(
      card(
        await crop(combined, region),
        region.name,
        `Combined result; native origin (${region.left}, ${region.top}).`,
      ),
    )
  }
  const reportUrl = jsonUrl(reportBytes)
  const protocolUrl = jsonUrl(protocolBytes)
  const casesUrl = jsonUrl(casesBytes)
  const reportHash = digest(reportBytes)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"/>
<title>Masked Texture — first photographic proof</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:24px;background:#191919;color:#e7e7e7;font:15px/1.5 system-ui,sans-serif}h1{font-size:25px;line-height:1.3;margin-bottom:12px}h2{font-size:20px;margin:30px 0 8px}h3{font-size:14px;line-height:1.4;margin:0 0 5px}p{max-width:1120px;margin:8px 0 12px}a{color:#bad4ed}code{overflow-wrap:anywhere}nav{display:flex;gap:18px;flex-wrap:wrap}.notice{padding:12px 16px;border:1px solid #555;border-radius:5px;background:#232323;max-width:1120px}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 0;position:sticky;top:0;background:#191919;z-index:1;border-bottom:1px solid #444}button{font:inherit;padding:7px 12px;border:1px solid #777;border-radius:4px;background:#303030;color:inherit;cursor:pointer}button[aria-pressed=true]{background:#4a4a4a}button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:2px solid #d4dce5;outline-offset:3px}.native-viewport{max-width:100%;overflow:auto;border:1px solid #454545;background:#101010}.variant-row{display:flex;align-items:flex-start;gap:12px;width:max-content;padding:12px}.native-card{width:512px;flex:0 0 512px;min-width:0}.caption{min-height:96px;padding:4px 4px 10px}.caption p{font-size:13px;color:#c5c5c5;margin:0}.native-image{display:block;width:512px;height:512px;max-width:none}.stress{display:inline-block;margin-left:8px;padding:1px 7px;border:1px solid #aaa;border-radius:3px;font-size:11px;font-weight:500}.image-save{display:inline-block;font-size:12px;margin:6px 4px}.fit-crops .variant-row{width:100%;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.fit-crops .native-card{width:auto}.fit-crops .native-image{width:100%;height:auto;max-width:512px}.fit-crops .combined-row{grid-template-columns:repeat(3,minmax(0,1fr))}.fit-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;max-width:1500px}.fit-card{min-width:0}.fit-image{display:block;width:auto;height:auto;max-width:100%;max-height:800px}.fit-card .caption{min-height:110px}details{margin:16px 0;max-width:1120px}summary{cursor:pointer}footer{margin:28px 0;color:#c5c5c5;font-size:13px}@media(max-width:750px){body{margin:14px}.fit-grid{grid-template-columns:1fr}.fit-card .caption{min-height:0}.fit-crops .variant-row{grid-template-columns:repeat(2,minmax(0,1fr))}.fit-crops .combined-row{grid-template-columns:1fr}}
</style></head><body>
<h1>Masked Texture — first photographic proof</h1>
<div class="notice"><strong>Research output: generated, visually unreviewed.</strong> One fixed candidate and one authored-SDR photograph. These partial manual regions are not segmentation, Refine Edge, recovered feathers or physical transparency. Stress amounts ±100 are diagnostic cases, not defaults. No application feature, general mask-stack, tiled, export or physical HDR acceptance is claimed.</div>
<p>Native crops are shown at <strong>one PNG pixel per CSS pixel</strong> by default. Use browser zoom 100% and scroll each comparison horizontally. The source has been processed at its complete native resolution before crop extraction. Browser/device pixel density does not establish physical display calibration. Optional Fit reduces crops for overview and must not be used as the native-detail gate.</p>
<p>${escape(source.credit)} ${externalLink(source.sourceUrl, 'Source')}. ${externalLink(source.licenseUrl, source.license)}. Changes: declared Texture or saved-detail filtering, native cropping and separate resized Fit views. Preserve attribution, source/license links, change descriptions and applicable ShareAlike terms when distributing these adaptations.</p>
<nav aria-label="Photographic regions"><a href="#plumage">Plumage</a><a href="#ripples">Ripples</a><a href="#reflected-legs">Reflected legs</a><a href="#combined">Independent combined result</a></nav>
<div class="toolbar"><button id="crop-fit-toggle" type="button" aria-pressed="false">Fit crop comparisons</button><span id="crop-scale-status" role="status">Native 1× · each crop is 512 × 512 CSS pixels</span></div>
${sections.join('\n')}
<section id="combined"><h2>Independent combined treatment</h2><p>Frozen sequential order: <strong>${escape(combinedAmounts)}</strong>. Each field was prepared from the preceding Float32 result. These particular supports are disjoint, so this photograph does not qualify overlapping-mask order semantics. The reflection receives its own restrained strength rather than inheriting the bird's amount.</p><h3>Fit overview — resized appearance only</h3><div class="fit-grid">${fitCards.join('\n')}</div><h3>Combined native crops</h3><p>Same frozen crop origins as the individual comparisons above; three different regions of the one combined result.</p><div class="native-viewport" tabindex="0" role="region" aria-label="Three combined-result native crops"><div class="variant-row combined-row">${combinedCrops.join('\n')}</div></div></section>
<details><summary>Scope, identity receipts and reproducibility</summary><p>${escape(report.scope)}</p><p>${escape(report.preparation)} Exact zero-coverage/alpha/hidden-RGB gates and the original-production-proof comparison are recorded independently of visual quality. The global sharpening comparator affects the whole photograph and is not an unchanged-unmasked Texture comparator.</p><p>Original source SHA-256: <code>${escape(source.sha256)}</code>. Receipt SHA-256: <code>${reportHash}</code>.</p><p><a href="${reportUrl}" download="masked-texture-photo-result.json">Save photographic receipt</a> · <a href="${protocolUrl}" download="masked-texture-protocol.json">Save frozen numeric protocol</a> · <a href="${casesUrl}" download="masked-texture-photo-cases.json">Save frozen sources, masks and crops</a></p><p>Every displayed PNG and downloadable JSON document is embedded in this HTML. No sibling file, server, application or network access is needed to inspect the gallery.</p></details>
<footer>Source limits: processed published JPEG; no clean/noisy truth, full reflected bird, skin, foliage, camera RAW or true HDR reference. Supplemental sources remain inactive. Exact working-grid preservation does not mean resized or JPEG output pixels outside a geometric mask remain identical.</footer>
<script>
const toggle=document.getElementById('crop-fit-toggle');
toggle.addEventListener('click',()=>{const fit=document.body.classList.toggle('fit-crops');toggle.setAttribute('aria-pressed',String(fit));toggle.textContent=fit?'Show native 1× crops':'Fit crop comparisons';document.getElementById('crop-scale-status').textContent=fit?'Fit overview · crops reduced to available width':'Native 1× · each crop is 512 × 512 CSS pixels';});
</script></body></html>\n`
  const path = join(outputDirectory, 'gallery.html')
  await writeFile(path, html, { flag: 'wx' })
  return {
    path,
    sha256: digest(Buffer.from(html)),
    bytes: Buffer.byteLength(html),
    regions: regions.length,
    variantsPerRegion: 6,
    combinedNativeCrops: combinedCrops.length,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  check(
    process.argv.length === 3,
    'Usage: node scripts/research/masked-texture/gallery.mjs <run-output>',
  )
  console.log(JSON.stringify(await renderGallery({ output: process.argv[2] })))
}
