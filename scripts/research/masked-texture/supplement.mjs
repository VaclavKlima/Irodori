// Bounded supplemental research after useful primary photographic feedback.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// Load TypeScript only in the esbuild-bundled isolated worker.
let PreviewProcess,
  prepareNativeRawExecutable,
  validateWorkingAsset,
  workingSourceIdentity,
  neutralAdjustments,
  srgbTransform,
  noLensSettings,
  neutralMaskColor,
  neutralMaskLight,
  identityMaskGeometry,
  observeResourceHardware,
  DEFAULT_RESOURCE_SETTINGS,
  resolveResourcePolicy,
  createTextureGpu,
  detailProofMemoryPlan,
  detailPreviewMemoryPlan,
  verifyMaster,
  MERGE_VERSION
async function loadPipeline() {
  ;({ PreviewProcess } = await import('../../../src/main/preview-process.ts'))
  ;({ prepareNativeRawExecutable } = await import('../../../src/main/native-raw-executable.ts'))
  ;({ validateWorkingAsset, workingSourceIdentity } =
    await import('../../../src/main/working-assets.ts'))
  ;({ neutralAdjustments, srgbTransform } = await import('../../../src/shared/adjustments.ts'))
  ;({ noLensSettings } = await import('../../../src/shared/lens.ts'))
  ;({ neutralMaskColor, neutralMaskLight } = await import('../../../src/shared/masks.ts'))
  ;({ identityMaskGeometry } = await import('../../../src/shared/mask-geometry.ts'))
  ;({ observeResourceHardware } = await import('../../../src/main/resource-settings.ts'))
  ;({ DEFAULT_RESOURCE_SETTINGS, resolveResourcePolicy } =
    await import('../../../src/shared/resource-policy.ts'))
  ;({ detailProofMemoryPlan, detailPreviewMemoryPlan } =
    await import('../../../src/shared/detail-resources.ts'))
  ;({ createTextureGpu } = await import('./gpu.mjs'))
  ;({ verifyMaster } = await import('../../../src/main/merge/store.ts'))
  ;({ MERGE_VERSION } = await import('../../../src/shared/merge.ts'))
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const bytesOf = (data) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
const wordsOf = (data) => new Uint32Array(data.buffer, data.byteOffset, data.length)
const hash = async (path) => {
  const result = createHash('sha256')
  for await (const bytes of createReadStream(path)) result.update(bytes)
  return result.digest('hex')
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
  check(!expected || value.sha256 === expected, `Tracked source/notice hash mismatch: ${path}`)
  return value
}

function masksFor(entry, asset) {
  const byId = new Map(entry.masks.map((item) => [item.id, item]))
  check(byId.size === 1 && entry.maskOrder.length === 1, 'Expected one frozen partial manual mask')
  return entry.maskOrder.map((id) => {
    const item = byId.get(id)
    check(item?.coverage.kind === 'radial', `Missing frozen radial mask: ${id}`)
    const shape = item.coverage
    return {
      id,
      name: item.label,
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
      light: { ...neutralMaskLight },
      color: { ...neutralMaskColor },
    }
  })
}

function inspectCandidate(source, candidate, coverage, signal) {
  check(
    candidate instanceof Float32Array && candidate.length === source.length,
    'Invalid native candidate frame',
  )
  check(
    coverage instanceof Float32Array && coverage.length * 4 === source.length,
    'Invalid native coverage frame',
  )
  const original = wordsOf(source),
    result = wordsOf(candidate)
  const counts = {
    pixels: coverage.length,
    zero: 0,
    full: 0,
    partial: 0,
    changed: 0,
    alphaWordsChanged: 0,
    hiddenRgbWordsChanged: 0,
    zeroCoverageWordsChanged: 0,
    nonFinite: 0,
  }
  let sum = 0
  for (let pixel = 0; pixel < coverage.length; pixel++) {
    if ((pixel & 65535) === 0) signal.throwIfAborted()
    const amount = coverage[pixel],
      start = pixel * 4
    check(Number.isFinite(amount) && amount >= 0 && amount <= 1, 'Coverage is outside [0,1]')
    sum += amount
    if (amount === 0) counts.zero++
    else if (amount === 1) counts.full++
    else counts.partial++
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const index = start + channel,
        differs = original[index] !== result[index]
      if (!Number.isFinite(candidate[index])) counts.nonFinite++
      if (differs) changed = true
      if (differs && amount === 0) counts.zeroCoverageWordsChanged++
      if (differs && channel === 3) counts.alphaWordsChanged++
      if (differs && channel < 3 && source[start + 3] === 0) counts.hiddenRgbWordsChanged++
    }
    if (changed) counts.changed++
  }
  check(
    !counts.nonFinite &&
      !counts.alphaWordsChanged &&
      !counts.hiddenRgbWordsChanged &&
      !counts.zeroCoverageWordsChanged,
    `Native identity/finite gate failed: ${JSON.stringify(counts)}`,
  )
  return {
    ...counts,
    meanCoverage: sum / counts.pixels,
    zeroFraction: counts.zero / counts.pixels,
    partialFraction: counts.partial / counts.pixels,
    fullFraction: counts.full / counts.pixels,
    exactIdentityGates: 'passed',
  }
}

function compareProof(original, candidate, coverage, signal) {
  check(
    candidate.length === original.length && candidate.length === coverage.length * 4,
    'Proof size differs from the original production proof',
  )
  let zeroPixels = 0,
    changedPixels = 0,
    changedBytes = 0,
    allChangedPixels = 0
  for (let pixel = 0; pixel < coverage.length; pixel++) {
    if ((pixel & 65535) === 0) signal.throwIfAborted()
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const index = pixel * 4 + channel
      if (original[index] !== candidate[index]) {
        changed = true
        if (coverage[pixel] === 0) changedBytes++
      }
    }
    if (changed) allChangedPixels++
    if (coverage[pixel] === 0) {
      zeroPixels++
      if (changed) changedPixels++
    }
  }
  return { zeroPixels, changedPixels, changedBytes, allChangedPixels, passed: changedBytes === 0 }
}

async function readProof(directory, frame, asset) {
  check(
    frame.format === 'rgba8-srgb' &&
      frame.width === asset.width &&
      frame.height === asset.height &&
      frame.byteLength === asset.width * asset.height * 4,
    'Production proof format/native dimensions changed',
  )
  check(
    (frame.diagnostics?.proofBackend ?? frame.diagnostics?.backend) === 'gpu',
    'Proof did not use the production GPU owner',
  )
  const pixels = await readFile(join(directory, 'full.rgba'))
  check(
    pixels.length === frame.byteLength && digest(pixels) === frame.sha256,
    'Production proof hash mismatch',
  )
  return pixels
}

async function imageEvidence(directory, pixels, asset, regions, fit = false) {
  const crops = []
  for (const region of regions) {
    check(
      [region.left, region.top, region.width, region.height].every(Number.isSafeInteger) &&
        region.left >= 0 &&
        region.top >= 0 &&
        region.width === 512 &&
        region.height === 512 &&
        region.left + 512 <= asset.width &&
        region.top + 512 <= asset.height,
      'Frozen native crop is outside decoded source',
    )
    const path = join(directory, `${region.name}.png`)
    await sharp(pixels, { raw: { width: asset.width, height: asset.height, channels: 4 } })
      .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .png()
      .toFile(path)
    crops.push({ region, ...(await pin(path)), sourcePixelsPerPngPixel: 1 })
  }
  let fitImage
  if (fit) {
    const path = join(directory, 'fit.png')
    const info = await sharp(pixels, {
      raw: { width: asset.width, height: asset.height, channels: 4 },
    })
      .resize({ width: 1100, height: 800, fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(path)
    fitImage = {
      ...(await pin(path)),
      width: info.width,
      height: info.height,
      purpose: 'Fit-scale SDR appearance only; deliberately resized, never an exact-pixel gate',
    }
  }
  return { crops, fit: fitImage }
}

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  check(args[index + 1], `Missing ${name}`)
  return args[index + 1]
}
const codePaths = [
  'scripts/research/masked-texture/supplement.mjs',
  'scripts/research/masked-texture/gpu.mjs',
  'src/main/gpu/raw-renderer.ts',
  'src/shared/spatial-detail.ts',
  'src/shared/masks-gpu.ts',
  'package-lock.json',
  'out/main/preview-worker.js',
  'src/main/preview-engine.ts',
  'src/main/processing/hdr-processing.ts',
  'src/main/gpu/point-renderer.ts',
  'src/main/processing/detail-preview.ts',
]
const isContained = (parent, child) => {
  const value = relative(resolve(parent), resolve(child))
  return value === '' || (!value.startsWith('..') && !value.startsWith('/'))
}

function refuseSourceOverlap(manifest, output) {
  for (const entry of manifest.cases) {
    const protectedPaths = [
      entry.source,
      entry.notice,
      entry.licenseNotice,
      entry.masterDirectory,
      ...(entry.sourceOriginals ?? []),
    ].filter(Boolean)
    for (const path of protectedPaths) {
      const protectedDirectory = path === entry.masterDirectory ? path : dirname(path)
      check(
        !isContained(protectedDirectory, output) && !isContained(output, path),
        'Output overlaps a source, notice, original directory or retained master',
      )
    }
  }
}

async function numericPrerequisite(path) {
  const receipt = JSON.parse(await readFile(join(path, 'result.json')))
  check(
    receipt.status === 'passed' && receipt.stage === 'numeric',
    'A passed numeric receipt is required',
  )
  check(
    receipt.cases.length === 19 && receipt.qualityGates.every((gate) => gate.pass),
    'Numeric gates incomplete',
  )
  for (const file of [
    'scripts/research/masked-texture/gpu.mjs',
    'src/main/gpu/raw-renderer.ts',
    'src/shared/spatial-detail.ts',
    'src/shared/masks-gpu.ts',
    'package-lock.json',
  ]) {
    const before = receipt.code.find((entry) => entry.path === file)
    check(before && before.sha256 === (await hash(file)), `Numeric dependency changed: ${file}`)
  }
  // Recreate the original entry in memory to cover its transitive bundled math too.
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [resolve('scripts/research/masked-texture/run.mjs')],
    outfile: join(resolve(path), 'worker.mjs'),
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  check(
    result.outputFiles.length === 1 &&
      digest(result.outputFiles[0].contents) === receipt.bundleSha256,
    'Original numeric bundle no longer matches current transitive implementation',
  )
  return { receipt, pin: await pin(join(path, 'result.json')) }
}

async function sourceFor(entry, processor, destination, signal, output) {
  const notice = await tracked(entry.notice, entry.noticeSha256)
  const licenseNotice = entry.licenseNotice
    ? await tracked(entry.licenseNotice, entry.licenseNoticeSha256)
    : undefined
  let source, options, asset, master, sourceIdentity
  const originalDirectory = join(destination, 'original-source-proof')
  await mkdir(originalDirectory)
  if (entry.kind === 'raster') {
    check(!isContained(resolve(entry.source), output), 'Output overlaps source')
    source = await tracked(entry.source, entry.sha256)
    const metadata = await processor.inspect(resolve(entry.source), signal)
    options = {
      metadata,
      settings: { ...noLensSettings },
      revision: 0,
      processing: 'display-referred-v1',
      adjustments: structuredClone(neutralAdjustments),
      prepareLinear: true,
    }
    const frame = await processor.renderFull(
      resolve(entry.source),
      originalDirectory,
      signal,
      options,
    )
    check(frame.linear, 'Native raster preparation is missing')
    asset = {
      ...frame.linear,
      width: frame.width,
      height: frame.height,
      path: join(originalDirectory, 'linear.f32'),
    }
    sourceIdentity = workingSourceIdentity(entry.sha256, options, false)
    return {
      source,
      notice,
      licenseNotice,
      options,
      asset,
      sourceIdentity,
      originalDirectory,
      originalFrame: frame,
    }
  }
  check(entry.kind === 'merge', 'Only frozen raster/merge supplements are supported')
  const masterDirectory = resolve(entry.masterDirectory)
  check(
    !isContained(masterDirectory, output) && !isContained(output, masterDirectory),
    'Output overlaps immutable master',
  )
  const manifestPath = join(masterDirectory, 'manifest.json')
  check((await hash(manifestPath)) === entry.manifestSha256, 'Retained merge manifest changed')
  master = JSON.parse(await readFile(manifestPath))
  check(
    master.version === MERGE_VERSION &&
      master.asset.sha256 === entry.assetSha256 &&
      master.recipe.maskSha256 === entry.maskSha256,
    'Retained current merge identity changed',
  )
  await verifyMaster(masterDirectory, master)
  const manifest = JSON.parse(await readFile(entry.notice)),
    originals = []
  for (const original of manifest.files)
    originals.push(await tracked(join(dirname(entry.notice), original.path), original.sha256))
  check(
    JSON.stringify(originals.map((x) => x.sha256).sort()) ===
      JSON.stringify(master.recipe.sources.map((x) => x.id).sort()),
    'Master source set differs from tracked originals',
  )
  source = {
    manifest: await pin(manifestPath),
    linear: await pin(join(masterDirectory, 'linear.f32')),
    motion: await pin(join(masterDirectory, 'motion.mask')),
    originals,
  }
  asset = {
    path: join(masterDirectory, 'linear.f32'),
    width: master.asset.width,
    height: master.asset.height,
    byteLength: master.asset.byteLength,
    sha256: master.asset.sha256,
    hdr: master.asset,
    transform: srgbTransform,
  }
  options = {
    metadata: { ...master.metadata, mergeMaster: { asset: master.asset, recipe: master.recipe } },
    settings: { ...noLensSettings },
    revision: 0,
    processing: 'hdr-v1',
    adjustments: structuredClone(neutralAdjustments),
    workingAsset: asset,
    prepareLinear: false,
  }
  sourceIdentity = workingSourceIdentity(master.photo.id, options, true)
  const originalFrame = await processor.renderPreparedFull(
    originalDirectory,
    options,
    signal,
    'gpu',
  )
  return {
    source,
    notice,
    licenseNotice,
    options,
    asset,
    sourceIdentity,
    originalDirectory,
    originalFrame,
    master,
    masterDirectory,
  }
}

async function derivedAsset(asset, path, data) {
  const bytes = bytesOf(data),
    sha256 = digest(bytes)
  await writeFile(path, bytes, { flag: 'wx' })
  let hdr
  if (asset.hdr) {
    const strips = []
    for (let y = 0; y < asset.height; y += 64) {
      const strip = bytes.subarray(
        y * asset.width * 16,
        Math.min(asset.height, y + 64) * asset.width * 16,
      )
      strips.push({ byteLength: strip.byteLength, sha256: digest(strip) })
    }
    hdr = { ...asset.hdr, sha256, strips }
  }
  return { ...asset, path, sha256, ...(hdr ? { hdr } : {}) }
}

async function runCase(entry, report, output, signal, persist) {
  check(
    entry.masks.length === 1 && entry.maskOrder.length === 1,
    'Only one prospectively frozen region per source',
  )
  const destination = join(output, entry.id)
  await mkdir(destination)
  const processor = new PreviewProcess(resolve('out/main/preview-worker.js'), 240000, 30000, () =>
    prepareNativeRawExecutable(resolve('out/main')),
  )
  let gpu, source
  const item = { id: entry.id, status: 'running', case: entry, variants: [] }
  report.cases.push(item)
  try {
    source = await sourceFor(entry, processor, destination, signal, output)
    const { asset, options, originalFrame, originalDirectory, sourceIdentity } = source
    check(
      asset.width === entry.width &&
        asset.height === entry.height &&
        asset.width * asset.height <= 24000000,
      'Frozen authoritative dimensions or native pixel bound changed',
    )
    await validateWorkingAsset(asset, signal)
    item.source = source.source
    item.notice = source.notice
    item.licenseNotice = source.licenseNotice
    item.asset = asset
    const originalPixels = await readProof(originalDirectory, originalFrame, asset)
    item.original = {
      directory: originalDirectory,
      frame: originalFrame,
      ...(await imageEvidence(originalDirectory, originalPixels, asset, entry.regions, true)),
    }
    const sourceBytes = await readFile(asset.path),
      data = new Float32Array(
        sourceBytes.buffer,
        sourceBytes.byteOffset,
        sourceBytes.byteLength / 4,
      )
    check(digest(bytesOf(data)) === asset.sha256, 'Native source changed')
    const hardware = await observeResourceHardware()
    const policy = resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      { ram: hardware.ram, gpu: { status: 'unknown', reason: 'adapter-unverified' } },
      0,
    )
    const reservation = {
      ramBytes:
        asset.byteLength * 5 +
        originalPixels.byteLength * 4 +
        asset.width * asset.height * 4 * 3 +
        32 * 1024 ** 2,
      vramBytes: 0,
    }
    const admission = { policy, reservation }
    item.hardware = hardware
    item.admission = admission
    const proofOptions = {
      ...options,
      prepareLinear: false,
      workingOnly: false,
      crop: undefined,
      workingAsset: asset,
      adjustments: structuredClone(neutralAdjustments),
    }
    const baselineDirectory = join(destination, 'prepared-neutral-baseline')
    await mkdir(baselineDirectory)
    const baselineFrame = await processor.renderPreparedFull(
      baselineDirectory,
      proofOptions,
      signal,
      'gpu',
    )
    const baselinePixels = await readProof(baselineDirectory, baselineFrame, asset)
    const originalProofDifferentBytes = baselinePixels.reduce(
      (sum, value, i) => sum + Number(value !== originalPixels[i]),
      0,
    )
    item.baseline = {
      directory: baselineDirectory,
      frame: baselineFrame,
      originalProofDifferentBytes,
      ...(await imageEvidence(baselineDirectory, baselinePixels, asset, entry.regions, true)),
    }
    await persist()
    check(originalProofDifferentBytes === 0, 'Original versus prepared Neutral proof changed')
    gpu = await createTextureGpu()
    const primaries = entry.kind === 'merge' ? 'rec2020' : 'srgb'
    item.preparation = await gpu.prepare(
      { data, width: asset.width, height: asset.height, primaries, admission },
      signal,
    )
    const concurrentAdmission = {
      policy,
      reservation: {
        ramBytes: reservation.ramBytes + item.preparation.estimatedRamBytes,
        vramBytes: item.preparation.estimatedGpuBytes,
      },
    }
    const planOptions = {
      hdr: Boolean(asset.hdr),
      authoredHdr: Boolean(asset.hdr?.source.display),
      preferGpu: true,
    }
    item.concurrentProofPlan = detailProofMemoryPlan(asset, concurrentAdmission, planOptions)
    item.concurrentComparatorPlan = detailPreviewMemoryPlan(asset, concurrentAdmission, {
      ...planOptions,
      workingOnly: false,
    })
    check(
      item.concurrentProofPlan.accepted &&
        item.concurrentComparatorPlan.filter.gpuAccepted &&
        item.concurrentComparatorPlan.peakGpuBytes <= policy.vram.effectiveBytes,
      'Concurrent owners exceed unchanged Automatic policy',
    )
    const maskParameters = {
      localMasks: masksFor(entry, asset),
      maskGeometry: asset.maskGeometry ?? identityMaskGeometry(asset.width, asset.height),
    }
    item.maskParameters = maskParameters
    let coverageHash
    for (const amount of [-25, 25, -100, 100]) {
      const result = await gpu.apply({ amount, maskParameters, maskIndex: 0 }, signal)
      const qa = inspectCandidate(data, result.data, result.coverage, signal)
      const controls = entry.unaffectedControls.map((region) => {
        let nonzeroCoverage = 0
        for (let y = region.top; y < region.top + region.height; y++)
          for (let x = region.left; x < region.left + region.width; x++)
            if (result.coverage[y * asset.width + x] !== 0) nonzeroCoverage++
        check(nonzeroCoverage === 0, `Frozen unaffected control has coverage: ${region.name}`)
        return { region, nonzeroCoverage }
      })
      const candidateCoverageHash = digest(bytesOf(result.coverage))
      check(
        !coverageHash || coverageHash === candidateCoverageHash,
        'Frozen coverage changed between strengths',
      )
      if (!coverageHash) {
        const path = join(destination, 'coverage.f32')
        await writeFile(path, bytesOf(result.coverage), { flag: 'wx' })
        item.coverage = { ...(await pin(path)), width: asset.width, height: asset.height }
        coverageHash = candidateCoverageHash
      }
      const name = `texture-${amount < 0 ? 'minus' : 'plus'}${Math.abs(amount)}`,
        directory = join(destination, name)
      await mkdir(directory)
      const working = await derivedAsset(asset, join(directory, 'linear.f32'), result.data)
      await validateWorkingAsset(working, signal)
      const frame = await processor.renderPreparedFull(
        directory,
        { ...proofOptions, workingAsset: working },
        signal,
        'gpu',
      )
      const pixels = await readProof(directory, frame, asset),
        unmaskedProof = compareProof(originalPixels, pixels, result.coverage, signal)
      const variant = {
        name,
        amount,
        adapter: result.adapter,
        asset: working,
        frame,
        qa,
        controls,
        unmaskedProof,
        ...(await imageEvidence(directory, pixels, asset, entry.regions, true)),
      }
      item.variants.push(variant)
      await persist()
      check(
        unmaskedProof.passed,
        `${entry.id}/${name}: unchanged original production proof gate failed`,
      )
      console.log(`${entry.id}/${name}: generated-unreviewed`)
    }
    const comparatorDirectory = join(destination, 'global-sharpen-50-1-50')
    await mkdir(comparatorDirectory)
    const frame = await processor.prepareDetailPreview(
      asset.path,
      comparatorDirectory,
      {
        ...concurrentAdmission,
        asset,
        sourceIdentity,
        noiseReduction: { version: 1, luminance: 0, chroma: 0 },
        detailSharpening: { version: 1, amount: 50, radius: 1, threshold: 50 },
        options: proofOptions,
        workingOnly: false,
        backend: 'gpu',
      },
      signal,
    )
    check(
      frame.detail?.backend === 'gpu' &&
        frame.detail.cpuTiles === 0 &&
        frame.detail.precisionRecoveryTiles === 0 &&
        frame.detail.gpuTiles > 0 &&
        frame.detail.sourceSha256 === asset.sha256,
      'Comparator did not prove unchanged GPU detail owner',
    )
    const pixels = await readProof(comparatorDirectory, frame, asset)
    item.comparator = {
      name: 'global-sharpen-50-1-50',
      scope: 'Global saved-detail reference; not a mask-local operation',
      directory: comparatorDirectory,
      frame,
      ...(await imageEvidence(comparatorDirectory, pixels, asset, entry.regions, true)),
    }
    await validateWorkingAsset(asset, signal)
    if (source.master) await verifyMaster(source.masterDirectory, source.master)
    else await tracked(entry.source, entry.sha256)
    check(
      (await hash(join(originalDirectory, 'full.rgba'))) === originalFrame.sha256,
      'Original proof was overwritten',
    )
    check(
      (await tracked(entry.notice, entry.noticeSha256)).sha256 === source.notice.sha256,
      'Source notice changed',
    )
    item.status = 'generated-awaiting-visual-review'
  } catch (error) {
    item.status = 'failed'
    item.error = String(error.stack ?? error)
    throw error
  } finally {
    const cleanup = await Promise.allSettled([gpu?.close(), processor.close(true)])
    item.cleanupErrors = cleanup.filter((x) => x.status === 'rejected').map((x) => String(x.reason))
    if (item.cleanupErrors.length) item.status = 'failed'
    await persist()
  }
  check(!item.cleanupErrors.length, `Supplement cleanup failed: ${item.cleanupErrors.join('; ')}`)
}

async function worker() {
  await loadPipeline()
  const output = resolve(option('--output')),
    casesPath = resolve(option('--cases')),
    casesBytes = await readFile(casesPath),
    manifest = JSON.parse(casesBytes),
    protocolBytes = await readFile('assets/tests/references/masked-texture/protocol.json'),
    protocol = JSON.parse(protocolBytes)
  check(
    digest(casesBytes) === option('--cases-sha256'),
    'Prospectively frozen supplemental manifest changed',
  )
  check(protocol.id === 'masked-texture-llf-residual-v1', 'Wrong frozen operator')
  check(
    manifest.id === 'masked-texture-supplemental-source-cases-v1' && manifest.cases.length === 2,
    'Wrong supplemental matrix',
  )
  const prerequisite = await numericPrerequisite(resolve(option('--numeric')))
  check(prerequisite.receipt.protocolSha256 === digest(protocolBytes), 'Numeric protocol differs')
  refuseSourceOverlap(manifest, output)
  const selected = manifest.cases.filter((entry) => entry.enabled && entry.id === option('--case'))
  check(selected.length === 1, 'Select exactly one frozen supplemental case')
  await writeFile(join(output, 'cases.json'), casesBytes, { flag: 'wx' })
  await writeFile(join(output, 'protocol.json'), protocolBytes, { flag: 'wx' })
  const report = {
    version: 1,
    status: 'running',
    startedAt: new Date().toISOString(),
    foreground: false,
    productionEnabled: false,
    cpuFeatureFallback: false,
    scope:
      'Fixed-method skin/foliage research after useful primary feedback; neutral point edits and partial manual masks only.',
    manifest: await pin(casesPath),
    protocolSha256: digest(protocolBytes),
    numericPrerequisite: prerequisite.pin,
    bundle: await pin(process.argv[1]),
    code: await Promise.all(codePaths.map(pin)),
    cases: [],
  }
  const persist = () => save(join(output, 'result.json'), report),
    controller = new AbortController(),
    started = performance.now()
  const timer = setTimeout(
    () => controller.abort(new Error('Owned supplement exceeded ten minutes')),
    600000,
  )
  try {
    await persist()
    for (const entry of selected) await runCase(entry, report, output, controller.signal, persist)
    report.codeAfter = await Promise.all(codePaths.map(pin))
    check(
      JSON.stringify(report.code) === JSON.stringify(report.codeAfter),
      'Processing sources changed during supplement',
    )
    check(
      (await hash(casesPath)) === report.manifest.sha256,
      'Frozen manifest changed during supplement',
    )
    report.status = 'generated-awaiting-visual-review'
    // Freeze an exact downloadable receipt before adding the gallery's own hash.
    report.durationMs = performance.now() - started
    report.finishedAt = new Date().toISOString()
    await save(join(output, 'technical-receipt.json'), report)
    report.technicalReceipt = await pin(join(output, 'technical-receipt.json'))
    report.gallery = await renderGallery(output, report, manifest)
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.stack ?? error)
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    report.durationMs = performance.now() - started
    report.finishedAt = new Date().toISOString()
    await persist()
    await writeFile(
      join(output, 'summary.md'),
      `# Texture supplements: ${report.status}\n\n${report.error ?? 'Fixed native proofs generated; user photographic review remains pending.'}\n\n${report.cases.length} sources; ${(report.durationMs / 1000).toFixed(2)} s. No foreground, CPU feature fallback, app enablement or physical HDR acceptance. Read result.json and gallery.html.\n`,
    )
  }
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
async function renderGallery(output, report, manifest) {
  const embedded = async (item) => {
    const bytes = await readFile(item.path)
    check(digest(bytes) === item.sha256, 'Gallery PNG hash changed')
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  const card = async (record, region, label, stress = false) => {
    const image = record.crops.find((x) => x.region.name === region.name)
    check(image, 'Missing gallery crop')
    return `<article><h3>${escape(label)}${stress ? ' · Stress' : ''}</h3><img class="native" src="${await embedded(image)}" width="512" height="512" alt="${escape(label)}"></article>`
  }
  const sections = []
  for (const item of report.cases) {
    check(
      item.status === 'generated-awaiting-visual-review',
      'Gallery requires a complete technical result',
    )
    let content = `<h2>${escape(item.id)}</h2><p>${escape(item.case.credit)} ${escape(item.case.limitations ?? '')} These are partial manual radial regions.</p>`
    for (const region of item.case.regions) {
      const records = [
        [item.baseline, 'Neutral'],
        [item.comparator, 'Global sharpening 50 / 1 / 50'],
        ...item.variants.map((x) => [x, `Texture ${x.amount > 0 ? '+' : ''}${x.amount}`]),
      ]
      const cards = await Promise.all(
        records.map(([record, label]) =>
          card(record, region, label, Math.abs(record.amount ?? 0) === 100),
        ),
      )
      content += `<h3>${escape(region.name)} · native 512 × 512</h3><p>${escape(region.purpose ?? '')}</p><div class="scroll" tabindex="0"><div class="row">${cards.join('')}</div></div>`
    }
    const fits = []
    for (const [record, label] of [
      [item.baseline, 'Neutral / Fit'],
      [item.variants.find((x) => x.amount === -25), 'Texture −25 / Fit'],
      [item.variants.find((x) => x.amount === 25), 'Texture +25 / Fit'],
    ])
      fits.push(
        `<article><h3>${escape(label)}</h3><img class="fit" src="${await embedded(record.fit)}" alt="${escape(label)}"></article>`,
      )
    content += `<h3>Fit appearance</h3><div class="fit-row">${fits.join('')}</div>`
    sections.push(`<section>${content}</section>`)
  }
  const frozenBytes = await readFile(join(output, 'cases.json'))
  const receiptBytes = await readFile(join(output, 'technical-receipt.json'))
  check(
    digest(frozenBytes) === report.manifest.sha256 &&
      digest(receiptBytes) === report.technicalReceipt.sha256 &&
      JSON.parse(frozenBytes).id === manifest.id,
    'Gallery frozen receipt hashes changed',
  )
  const download = (bytes, name, label) =>
    `<a download="${name}" href="data:application/json;base64,${bytes.toString('base64')}">${label}</a>`
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Masked Texture · skin and foliage</title><style>html{color-scheme:dark}body{margin:24px;background:#191a1b;color:#ddd;font:15px system-ui;line-height:1.5}h1{font-size:24px}h2{font-size:21px}h3{font-size:15px}section{margin-top:42px}button,a{color:#eee}button{padding:8px 12px;background:#303235;border:1px solid #666;border-radius:4px}a{margin-right:20px}.scroll{overflow:auto;outline-offset:4px}.row{display:flex;gap:16px;width:max-content}article{margin:0}.native{display:block;width:512px;height:512px;max-width:none}.fit-crops .row{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.fit-crops .native{width:100%;height:auto}.fit-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.fit{width:100%;height:auto}p{max-width:1100px;color:#bbb}</style><h1>Masked Texture · skin and foliage</h1><p>One frozen GPU method. Compare Neutral with −25 / +25 first; ±100 are stress settings. Native mode is one source pixel per CSS pixel. Fit is viewing scale only. Global sharpening is a comparison, not a local Texture treatment. Neutral point edits only; photographic benefit remains unreviewed. This does not add a feature to Irodori or establish physical HDR quality.</p><button id="fit-toggle" aria-pressed="false">Fit crop comparisons</button><p>${download(frozenBytes, 'supplemental-cases.json', 'Frozen cases')}${download(receiptBytes, 'technical-receipt.json', 'Technical receipt')}</p>${sections.join('')}<script>document.getElementById('fit-toggle').addEventListener('click',event=>{const fit=document.body.classList.toggle('fit-crops');event.currentTarget.setAttribute('aria-pressed',String(fit));event.currentTarget.textContent=fit?'Show native 1× crops':'Fit crop comparisons';});</script></html>`
  const path = join(output, 'gallery.html')
  await writeFile(path, html, { flag: 'wx' })
  return {
    ...(await pin(path)),
    nativeCrops: report.cases.reduce((n, item) => n + item.case.regions.length * 6, 0),
    fitImages: report.cases.length * 3,
  }
}

async function main() {
  check(
    option('--output') &&
      option('--cases') &&
      /^[a-f0-9]{64}$/.test(option('--cases-sha256', '')) &&
      option('--numeric') &&
      ['forearm-skin-hair', 'forest-merge'].includes(option('--case')),
    'Usage: node supplement.mjs --output NEW_DIRECTORY --cases MANIFEST --cases-sha256 SHA256 --numeric PASSED_NUMERIC_DIRECTORY --case forearm-skin-hair|forest-merge',
  )
  if (args.includes('--worker')) return worker()
  const output = resolve(option('--output'))
  const manifestBytes = await readFile(resolve(option('--cases')))
  check(
    digest(manifestBytes) === option('--cases-sha256'),
    'Frozen manifest changed before owner creation',
  )
  refuseSourceOverlap(JSON.parse(manifestBytes), output)
  await mkdir(output, { recursive: false })
  await copyFile(fileURLToPath(import.meta.url), join(output, 'generator.mjs'))
  const { build } = await import('esbuild'),
    bundle = join(output, 'worker.mjs')
  await build({
    entryPoints: [fileURLToPath(import.meta.url)],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  const require = createRequire(import.meta.url),
    executable = join(
      dirname(require.resolve(`node-${process.platform}-${process.arch}/package.json`)),
      'bin/node',
    )
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [bundle, ...args, '--worker'], {
    env,
    detached: true,
    stdio: 'inherit',
  })
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  const timer = setTimeout(stop, 610000)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const outcome = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => accept({ code, signal }))
    })
    await save(join(output, 'worker-exit.json'), outcome)
    if (outcome.code !== 0) process.exitCode = 1
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    stop()
  }
}
await main()
