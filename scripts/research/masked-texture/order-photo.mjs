// One prospective ordered-mask photograph after the small proof gates pass.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
import { PreviewProcess } from '../../../src/main/preview-process.ts'
import { prepareNativeRawExecutable } from '../../../src/main/native-raw-executable.ts'
import { validateWorkingAsset, workingSourceIdentity } from '../../../src/main/working-assets.ts'
import { neutralAdjustments } from '../../../src/shared/adjustments.ts'
import { noLensSettings } from '../../../src/shared/lens.ts'
import { neutralMaskLight, neutralMaskColor } from '../../../src/shared/masks.ts'
import { identityMaskGeometry } from '../../../src/shared/mask-geometry.ts'
import { observeResourceHardware } from '../../../src/main/resource-settings.ts'
import {
  DEFAULT_RESOURCE_SETTINGS,
  resolveResourcePolicy,
} from '../../../src/shared/resource-policy.ts'

const check = (condition, message) => {
  if (!condition) throw new Error(`Ordered Texture photograph: ${message}`)
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const hash = async (path) => {
  const value = createHash('sha256')
  for await (const part of createReadStream(path)) value.update(part)
  return value.digest('hex')
}
const pin = async (path) => ({
  path: resolve(path),
  sha256: await hash(path),
  bytes: (await stat(path)).size,
})
async function tracked(path, expected) {
  await promisify(execFile)('git', ['ls-files', '--error-unmatch', '--', path])
  await promisify(execFile)('git', ['diff', '--quiet', 'HEAD', '--', path])
  const value = await pin(path)
  check(!expected || value.sha256 === expected, `tracked source/notice changed: ${path}`)
  return value
}
const contains = (parent, child) => {
  const value = relative(resolve(parent), resolve(child))
  return value === '' || (!value.startsWith('..') && !value.startsWith('/'))
}
const summary = (value) =>
  JSON.parse(
    JSON.stringify(value, (_, item) =>
      ArrayBuffer.isView(item)
        ? { type: item.constructor.name, bytes: item.byteLength, sha256: digest(bytesOf(item)) }
        : item,
    ),
  )

function resolveMasks(entry, photo, asset) {
  check(
    JSON.stringify(photo.roots.map((x) => x.id)) === JSON.stringify(entry.maskOrder),
    'prospective top-first roots differ from source order',
  )
  const controls = new Map(photo.roots.map((x) => [x.id, x])),
    shapes = new Map(entry.masks.map((x) => [x.id, x]))
  check(controls.size === 3 && shapes.size === 3, 'expected the three unchanged manual regions')
  const localMasks = entry.maskOrder.map((id) => {
    const mask = shapes.get(id),
      control = controls.get(id),
      shape = mask.coverage
    check(
      shape.kind === 'radial' && mask.partialManualRegion,
      'only the frozen partial radials are selected',
    )
    return {
      id,
      name: mask.label,
      enabled: true,
      inverted: false,
      head: null,
      gradient: {
        kind: 'radial',
        center: { x: shape.centerPx.x / asset.width, y: shape.centerPx.y / asset.height },
        radiusX: shape.radiusPx.x / asset.width,
        radiusY: shape.radiusPx.y / asset.height,
        rotation: shape.rotationDegrees,
        feather: shape.featherPercent,
      },
      edge: { featherPx: 0, shiftPx: 0 },
      strokes: [],
      operands: [],
      resultStrokes: [],
      light: { ...neutralMaskLight, ...control.light },
      color: { ...neutralMaskColor, ...control.color },
    }
  })
  return {
    localMasks,
    maskGeometry: asset.maskGeometry ?? identityMaskGeometry(asset.width, asset.height),
  }
}

function inspectProof(source, stack, legacy, selected, regions, width, signal) {
  const pixels = source.length / 4
  check(
    stack.data instanceof Float32Array && stack.data.length === source.length,
    'invalid ordered working frame',
  )
  check(
    stack.coverage instanceof Float32Array && stack.coverage.length === pixels,
    'invalid native union',
  )
  check(
    legacy instanceof Uint32Array &&
      selected instanceof Uint32Array &&
      legacy.length === pixels &&
      selected.length === pixels,
    'expected packed native RGBA8 outputs',
  )
  const sourceWords = new Uint32Array(source.buffer, source.byteOffset, source.length),
    stackWords = new Uint32Array(stack.data.buffer, stack.data.byteOffset, stack.data.length)
  const result = {
    pixels,
    zeroUnionPixels: 0,
    alphaWordsChanged: 0,
    nonFinite: 0,
    invalidCoverage: 0,
    unmaskedProofPixelsChanged: 0,
    transparentProofPixelsChanged: 0,
    packedAlphaChanged: 0,
    allProofPixelsChanged: 0,
    untouchedControls: [],
  }
  for (let i = 0; i < pixels; i++) {
    if ((i & 65535) === 0) signal.throwIfAborted()
    const value = stack.coverage[i]
    if (!Number.isFinite(value) || value < 0 || value > 1) result.invalidCoverage++
    if (sourceWords[i * 4 + 3] !== stackWords[i * 4 + 3]) result.alphaWordsChanged++
    for (let c = 0; c < 4; c++) if (!Number.isFinite(stack.data[i * 4 + c])) result.nonFinite++
    if (legacy[i] !== selected[i]) result.allProofPixelsChanged++
    if (value === 0) {
      result.zeroUnionPixels++
      if (legacy[i] !== selected[i]) result.unmaskedProofPixelsChanged++
    }
    if (source[i * 4 + 3] === 0 && legacy[i] !== selected[i]) result.transparentProofPixelsChanged++
    if (legacy[i] >>> 24 !== selected[i] >>> 24) result.packedAlphaChanged++
  }
  for (const region of regions) {
    let nonzeroCoverage = 0,
      changedProofPixels = 0
    for (let y = region.top; y < region.top + region.height; y++)
      for (let x = region.left; x < region.left + region.width; x++) {
        const i = y * width + x
        if (stack.coverage[i] !== 0) nonzeroCoverage++
        if (legacy[i] !== selected[i]) changedProofPixels++
      }
    result.untouchedControls.push({ name: region.name, nonzeroCoverage, changedProofPixels })
  }
  check(
    !result.alphaWordsChanged &&
      !result.nonFinite &&
      !result.invalidCoverage &&
      !result.unmaskedProofPixelsChanged &&
      !result.transparentProofPixelsChanged &&
      !result.packedAlphaChanged &&
      result.untouchedControls.every((x) => !x.nonzeroCoverage && !x.changedProofPixels),
    'exact alpha/union/actual-legacy photographic gate failed',
  )
  return {
    ...result,
    status: 'passed',
    workingZeroCoverage:
      'Per-step preceding-word checks belong to the callback; active globals/local point edits legitimately change original source words.',
  }
}

async function images(directory, pixels, entry) {
  await mkdir(directory)
  check(pixels.byteLength === entry.width * entry.height * 4, 'incomplete native proof')
  const rgbaPath = join(directory, 'full.rgba')
  await writeFile(rgbaPath, pixels, { flag: 'wx' })
  const crops = []
  for (const region of entry.regions) {
    check(
      region.width === 512 &&
        region.height === 512 &&
        region.left >= 0 &&
        region.top >= 0 &&
        region.left + 512 <= entry.width &&
        region.top + 512 <= entry.height,
      'fixed native crop outside source',
    )
    const path = join(directory, `${region.name}.png`)
    await sharp(pixels, { raw: { width: entry.width, height: entry.height, channels: 4 } })
      .extract({ left: region.left, top: region.top, width: 512, height: 512 })
      .png()
      .toFile(path)
    crops.push({ region, ...(await pin(path)), sourcePixelsPerPngPixel: 1 })
  }
  const fitPath = join(directory, 'fit.png'),
    fitInfo = await sharp(pixels, {
      raw: { width: entry.width, height: entry.height, channels: 4 },
    })
      .resize({ width: 1100, height: 800, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(fitPath)
  return {
    native: await pin(rgbaPath),
    crops,
    fit: { ...(await pin(fitPath)), width: fitInfo.width, height: fitInfo.height },
  }
}

async function gallery(directory, report, sourceBytes, protocolBytes) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    )
  const embedded = async (item) => {
    const bytes = await readFile(item.path)
    check(digest(bytes) === item.sha256, 'proof PNG changed before embedding')
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  const receiptBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(directory, 'technical-receipt.json'), receiptBytes, { flag: 'wx' })
  const records = [
      ['Original Neutral', report.neutral],
      ['Active Light/Color · legacy', report.legacy],
      ['Active Light/Color + ordered Texture', report.ordered],
    ],
    sections = []
  for (const region of report.sourceCase.regions) {
    const cards = []
    for (const [label, record] of records) {
      const item = record.crops.find((x) => x.region.name === region.name)
      check(item, 'missing frozen native region')
      cards.push(
        `<article><h3>${escape(label)}</h3><img class="native" width="512" height="512" src="${await embedded(item)}" alt="${escape(`${label} / ${region.name}`)}"></article>`,
      )
    }
    sections.push(
      `<section><h2>${escape(region.name)}</h2><p>${escape(region.purpose)}</p><div class="scroll" tabindex="0"><div class="row">${cards.join('')}</div></div></section>`,
    )
  }
  const fits = []
  for (const [label, record] of records)
    fits.push(
      `<article><h3>${escape(label)} / Fit</h3><img class="fit" src="${await embedded(record.fit)}" alt="${escape(label)} / Fit"></article>`,
    )
  const download = (bytes, name, label) =>
    `<a download="${name}" href="data:application/json;base64,${Buffer.from(bytes).toString('base64')}">${label}</a>`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ordered masked Texture · active Light/Color</title><style>html{color-scheme:dark}body{margin:24px;background:#191a1b;color:#ddd;font:15px system-ui;line-height:1.5}h1{font-size:24px}h2{font-size:21px}h3{font-size:15px}section{margin-top:36px}button,a{color:#eee}button{padding:8px 12px;background:#303235;border:1px solid #666;border-radius:4px}a{margin-right:20px}.scroll{overflow:auto;outline-offset:4px}.row{display:flex;gap:16px;width:max-content}.row article{width:512px;flex:none}.native{display:block;width:512px;height:512px;max-width:none}.fit-crops .row{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.fit-crops .row article{width:auto}.fit-crops .native{width:100%;height:auto}.fit-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.fit{width:100%;height:auto}p{max-width:1100px;color:#bbb}</style><h1>Ordered masked Texture · active Light/Color</h1><p>Research-only integration proof. Compare the active Light/Color legacy image with active Light/Color + ordered Texture to isolate Texture. Original Neutral also omits the selected Light/Color edits and is context only. Native mode uses one source pixel per CSS pixel; Fit is viewing scale only.</p><p>Texture amounts in top-first order: ripples −25, reflected legs +25, plumage +25. The complete stack executes bottom-to-top, with one coverage blend per root. Manual regions are partial treatment regions, not segmentation. No app feature, general edit-stack, physical HDR or new image-quality adoption is claimed.</p><button id="fit-toggle" aria-pressed="false">Fit crop comparisons</button><p>${download(protocolBytes, 'order-protocol.json', 'Frozen protocol')}${download(sourceBytes, 'source-cases.json', 'Frozen source cases')}${download(receiptBytes, 'technical-receipt.json', 'Technical receipt')}</p><p>${escape(report.sourceCase.credit)} <a href="${escape(report.sourceCase.sourceUrl)}">Original source</a><a href="${escape(report.sourceCase.licenseUrl)}">${escape(report.sourceCase.license)}</a>Filtering, cropping and comparison presentation are derived changes; retain applicable attribution/share-alike terms.</p>${sections.join('')}<section><h2>Fit appearance</h2><div class="fit-row">${fits.join('')}</div></section><script>document.getElementById('fit-toggle').addEventListener('click',event=>{const fit=document.body.classList.toggle('fit-crops');event.currentTarget.setAttribute('aria-pressed',String(fit));event.currentTarget.textContent=fit?'Show native 1× crops':'Fit crop comparisons';});</script></html>`
  const path = join(directory, 'gallery.html')
  await writeFile(path, html, { flag: 'wx' })
  return {
    ...(await pin(path)),
    nativeCrops: 9,
    fitImages: 3,
    embeddedTechnicalReceiptSha256: digest(receiptBytes),
  }
}

/** Caller owns the prospective protocol, successful small proof gate and timeout. */
export async function runOrderedPhotograph({
  output,
  protocol,
  signal,
  runStack,
  renderCompatible,
}) {
  signal ??= new AbortController().signal
  signal.throwIfAborted()
  check(
    typeof runStack === 'function' && typeof renderCompatible === 'function',
    'missing gated GPU callbacks',
  )
  const protocolPath = 'assets/tests/references/masked-texture/order-protocol-v2.json',
    protocolBytes = await readFile(protocolPath),
    current = JSON.parse(protocolBytes)
  check(
    protocol.id === 'masked-texture-order-proof-v2' &&
      JSON.stringify(protocol) === JSON.stringify(current),
    'parent/frozen ordered protocol differ',
  )
  const photo = protocol.photo,
    sourceBytes = await readFile(photo.caseFile)
  check(digest(sourceBytes) === photo.caseSha256, 'source-only case manifest changed')
  const cases = JSON.parse(sourceBytes),
    entry = cases.cases.find((x) => x.id === photo.caseId)
  check(
    entry?.enabled &&
      entry.kind === 'raster' &&
      entry.id === 'flamingo-plumage-ripples-reflected-legs',
    'only the original frozen flamingo is selected',
  )
  const directory = join(resolve(output), 'photograph')
  check(
    !contains(dirname(entry.source), directory) && !contains(directory, entry.source),
    'output overlaps immutable original',
  )
  await mkdir(directory, { recursive: false })
  await writeFile(join(directory, 'protocol.json'), protocolBytes, { flag: 'wx' })
  await writeFile(join(directory, 'source-cases.json'), sourceBytes, { flag: 'wx' })
  const codePaths = [
    'scripts/research/masked-texture/order-photo.mjs',
    'scripts/research/masked-texture/ordered-point.mjs',
    'scripts/research/masked-texture/ordered-consumer.mjs',
    'scripts/research/masked-texture/gpu.mjs',
    'src/main/gpu/point-renderer.ts',
    'src/shared/authored-output-wgsl.ts',
    'src/shared/masks-gpu.ts',
    'out/main/preview-worker.js',
    'package-lock.json',
  ]
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    scope:
      'One unchanged flamingo source; prospective active globals/local Light/Color and ordered Texture; research callback at the explicit consumed-point seam, not app integration.',
    protocol: await pin(protocolPath),
    sourceCases: await pin(photo.caseFile),
    sourceCase: entry,
    photoControls: photo,
    foreground: false,
    productionEnabled: false,
    code: await Promise.all(codePaths.map(pin)),
  }
  const reportPath = join(directory, 'result.json'),
    processor = new PreviewProcess(resolve('out/main/preview-worker.js'), 240000, 30000, () =>
      prepareNativeRawExecutable(resolve('out/main')),
    )
  const started = performance.now()
  let failure
  try {
    report.source = await tracked(entry.source, entry.sha256)
    report.notice = await tracked(entry.notice)
    report.licenseNotice = await tracked(entry.licenseNotice)
    check(report.source.bytes === entry.bytes, 'original photographic byte count changed')
    const hardware = await observeResourceHardware(),
      policy = resolveResourcePolicy(
        DEFAULT_RESOURCE_SETTINGS,
        { ram: hardware.ram, gpu: { status: 'unknown', reason: 'adapter-unverified' } },
        0,
      ),
      pixels = entry.width * entry.height,
      rgbaBytes = pixels * 4,
      floatBytes = pixels * 16
    const reservation = {
      ramBytes: floatBytes * 9 + rgbaBytes * 8 + pixels * 4 * 4 + 128 * 1024 ** 2,
      vramBytes: 0,
    }
    report.hardware = hardware
    report.admission = { policy, reservation }
    report.diskEstimateBytes =
      floatBytes * 2 +
      rgbaBytes * 4 +
      pixels * 4 +
      entry.regions.length * 512 * 512 * 16 +
      64 * 1024 ** 2
    check(
      reservation.ramBytes < policy.ram.effectiveBytes && report.diskEstimateBytes <= 2 * 1024 ** 3,
      'native photo ownership exceeds unchanged budgets',
    )
    const metadata = await processor.inspect(resolve(entry.source), signal),
      neutralOptions = {
        metadata,
        settings: { ...noLensSettings },
        revision: 0,
        processing: 'display-referred-v1',
        adjustments: structuredClone(neutralAdjustments),
        prepareLinear: true,
      },
      sourceDirectory = join(directory, 'source-neutral-preparation')
    await mkdir(sourceDirectory)
    const frame = await processor.renderFull(
      resolve(entry.source),
      sourceDirectory,
      signal,
      neutralOptions,
    )
    check(
      frame.linear &&
        frame.width === entry.width &&
        frame.height === entry.height &&
        (frame.diagnostics?.proofBackend ?? frame.diagnostics?.backend) === 'gpu',
      'production native Neutral preparation differs',
    )
    const asset = {
      ...frame.linear,
      width: frame.width,
      height: frame.height,
      path: join(sourceDirectory, 'linear.f32'),
    }
    await validateWorkingAsset(asset, signal)
    const sourceDataBytes = await readFile(asset.path),
      data = new Float32Array(
        sourceDataBytes.buffer,
        sourceDataBytes.byteOffset,
        sourceDataBytes.byteLength / 4,
      ),
      neutralPixels = await readFile(join(sourceDirectory, 'full.rgba'))
    check(
      digest(bytesOf(data)) === asset.sha256 &&
        neutralPixels.byteLength === rgbaBytes &&
        digest(neutralPixels) === frame.sha256,
      'prepared native/Neutral bytes changed',
    )
    report.asset = asset
    report.sourceIdentity = workingSourceIdentity(entry.sha256, neutralOptions, false)
    report.neutral = {
      label: 'Original Neutral; no active global/local Light/Color or Texture',
      ...(await images(join(directory, 'neutral'), neutralPixels, entry)),
    }
    const maskParameters = resolveMasks(entry, photo, asset),
      adjustments = { ...structuredClone(neutralAdjustments), ...photo.globals, ...maskParameters },
      amounts = photo.roots.map((x) => x.amount)
    report.maskParameters = maskParameters
    check(
      JSON.stringify(amounts) === JSON.stringify([-25, 25, 25]),
      'prospective top-first Texture strengths changed',
    )
    await save(reportPath, report)
    const job = {
        data,
        width: entry.width,
        height: entry.height,
        domain: 'raster',
        adjustments,
        maskParameters,
        amounts,
        transform: asset.transform,
        admission: report.admission,
      },
      stack = await runStack(job, signal)
    const rendered = await renderCompatible({ ...job, stack, packed: true }, signal)
    check(
      rendered.data instanceof Uint32Array && rendered.legacyData instanceof Uint32Array,
      'actual consumer callback did not return native packed outputs',
    )
    report.qa = inspectProof(
      data,
      stack,
      rendered.legacyData,
      rendered.data,
      entry.unaffectedControls,
      entry.width,
      signal,
    )
    const stackPath = join(directory, 'ordered-point-rgb.f32'),
      coveragePath = join(directory, 'texture-union.f32')
    await writeFile(stackPath, bytesOf(stack.data), { flag: 'wx' })
    await writeFile(coveragePath, bytesOf(stack.coverage), { flag: 'wx' })
    report.stack = {
      ...summary(stack),
      data: await pin(stackPath),
      coverage: await pin(coveragePath),
      ordinaryWorkingAsset: false,
      consumption:
        'Global and local point edits consumed; only existing rendition follows through the research callback.',
    }
    report.actualConsumer = summary({ ...rendered, data: undefined, legacyData: undefined })
    report.legacy = {
      label: 'Same active global/local Light/Color; Texture0 unchanged production consumer',
      ...(await images(
        join(directory, 'active-point-legacy'),
        Buffer.from(bytesOf(rendered.legacyData)),
        entry,
      )),
    }
    report.ordered = {
      label: 'Same active Light/Color + ordered Texture via explicit consumed-point seam',
      ...(await images(
        join(directory, 'ordered-texture'),
        Buffer.from(bytesOf(rendered.data)),
        entry,
      )),
    }
    await validateWorkingAsset(asset, signal)
    await tracked(entry.source, entry.sha256)
    check(
      (await hash(join(sourceDirectory, 'full.rgba'))) === frame.sha256,
      'original Neutral proof was overwritten',
    )
    check(
      (await hash(entry.notice)) === report.notice.sha256 &&
        (await hash(entry.licenseNotice)) === report.licenseNotice.sha256,
      'source notices changed during proof',
    )
    report.codeAfter = await Promise.all(codePaths.map(pin))
    check(
      JSON.stringify(report.codeAfter) === JSON.stringify(report.code),
      'processing code changed during photograph',
    )
    check(
      (await hash(protocolPath)) === report.protocol.sha256 &&
        (await hash(photo.caseFile)) === photo.caseSha256,
      'frozen order/source protocol changed during photograph',
    )
    report.status = 'generated-awaiting-visual-review'
  } catch (error) {
    failure = error
    report.status = 'failed'
    report.error = String(error.stack ?? error)
  } finally {
    try {
      await processor.close(true)
    } catch (error) {
      report.cleanupError = String(error)
      report.status = 'failed'
      failure ??= error
    }
    report.durationMs = performance.now() - started
    report.finishedAt = new Date().toISOString()
    await save(reportPath, report)
    await writeFile(
      join(directory, 'summary.md'),
      `# Ordered Texture photograph: ${report.status}\n\n${report.error ?? 'Native active-Light/Color legacy and ordered Texture proofs generated. Visual quality remains separate.'}\n\n${(report.durationMs / 1000).toFixed(2)}s; original native source/masks/crops unchanged. BackgroundGPU; no CPU feature fallback, new app integration or physical HDR acceptance. Read result.json.\n`,
    )
  }
  if (failure) throw failure
  report.gallery = await gallery(directory, report, sourceBytes, protocolBytes)
  await save(reportPath, report)
  return { ...report, reportPath }
}
